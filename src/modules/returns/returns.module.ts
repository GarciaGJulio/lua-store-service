import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  InvoiceStatus,
  Prisma,
  ReceivableStatus,
  UserRole,
} from '@prisma/client';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import { CashModule, CashService } from '@/modules/cash/cash.module';
import { PrismaService } from '@/database/prisma.service';

import { createHash } from 'node:crypto';
import {
  allocateReturnedLines,
  returnLineAmount,
  settleReturn,
} from './return-accounting';
import { getEcuadorBusinessDayKey } from '../cash/business-time';

class FindReturnsQueryDto extends PaginationQueryDto {}

class CreateReturnItemDto {
  @IsUUID()
  invoiceLineId!: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity!: number;

  @IsString()
  @MaxLength(250)
  reason!: string;

  @IsBoolean()
  returnToStock!: boolean;
}

class CreateReturnDto {
  @IsUUID()
  requestId!: string;

  @IsString()
  cashRegisterId!: string;

  @IsString()
  invoiceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  customerName?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateReturnItemDto)
  items!: CreateReturnItemDto[];
}

const returnDetailsInclude = {
  cashRegister: true,
  customer: true,
  invoice: true,
  product: true,
  variant: {
    include: {
      barcode: true,
    },
  },
} satisfies Prisma.StoreReturnInclude;

type ReturnRecord = Prisma.StoreReturnGetPayload<{
  include: typeof returnDetailsInclude;
}>;

@Injectable()
export class ReturnsService {
  constructor(
    private readonly cashService: CashService,
    private readonly prisma: PrismaService,
  ) {}

  async findPage(query: FindReturnsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const where = this.buildWhere(query);

    const [items, totalItems, aggregate] = await this.prisma.$transaction([
      this.prisma.storeReturn.findMany({
        include: returnDetailsInclude,
        orderBy: [{ returnDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        where,
      }),
      this.prisma.storeReturn.count({ where }),
      this.prisma.storeReturn.aggregate({
        _sum: {
          quantity: true,
          refundedTotal: true,
        },
        where,
      }),
    ]);

    return {
      items: items.map((item) => this.mapReturn(item)),
      meta: {
        limit,
        page,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
      summary: {
        totalAmount: Number(aggregate._sum.refundedTotal ?? 0),
        totalReturns: totalItems,
        totalUnits: Number(aggregate._sum.quantity ?? 0),
      },
    };
  }

  async create(dto: CreateReturnDto) {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          invoiceId: dto.invoiceId,
          cashRegisterId: dto.cashRegisterId,
          customerName: dto.customerName?.trim() ?? '',
          items: [...dto.items].sort((a, b) =>
            a.invoiceLineId.localeCompare(b.invoiceLineId),
          ),
        }),
      )
      .digest('hex');
    return this.prisma.$transaction(async (transaction) => {
      const replay = await transaction.returnOperation.findUnique({
        where: { id: dto.requestId },
      });
      if (replay) {
        if (replay.requestHash !== requestHash)
          throw new BadRequestException(
            'La solicitud ya fue utilizada con otros datos.',
          );
        return this.operationResult(transaction, replay.id);
      }
      // Same lock order as refunds and closing: register, invoice, receivable.
      await this.cashService.assertRegisterCanInvoice(
        dto.cashRegisterId,
        transaction,
      );
      await transaction.$queryRaw`SELECT id FROM invoices WHERE id = ${dto.invoiceId}::uuid FOR UPDATE`;
      const previous = await transaction.returnOperation.findUnique({
        where: { id: dto.requestId },
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new BadRequestException(
            'La solicitud ya fue utilizada con otros datos.',
          );
        return this.operationResult(transaction, previous.id);
      }
      const invoice = await transaction.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: {
          receivable: { include: { payments: true } },
          returns: true,
          lines: { include: { product: true, variant: true } },
        },
      });
      if (!invoice)
        throw new BadRequestException('La factura seleccionada no existe.');
      if (
        invoice.status === InvoiceStatus.VOIDED ||
        invoice.returnStatus === 'TOTAL'
      ) {
        throw new BadRequestException(
          'No puedes devolver una factura anulada o devuelta completamente.',
        );
      }
      if (invoice.returns.some((row) => !row.operationId)) {
        throw new BadRequestException(
          'Esta factura tiene devoluciones historicas pendientes de conciliacion.',
        );
      }
      const customerName = invoice.customerId
        ? invoice.customerNameSnapshot
        : dto.customerName?.trim();
      if (!customerName)
        throw new BadRequestException(
          'Registra el nombre del cliente que devuelve.',
        );
      const receivable = invoice.receivable;
      if (receivable) {
        await transaction.$queryRaw`SELECT id FROM accounts_receivable WHERE id = ${receivable.id}::uuid FOR UPDATE`;
        const paymentsTotal = receivable.payments.reduce(
          (sum, payment) => sum + Number(payment.amount),
          0,
        );
        if (
          Math.abs(paymentsTotal - Number(receivable.paidAmount)) > 0.01 ||
          Math.abs(
            Number(receivable.originalAmount) -
              Number(receivable.paidAmount) -
              Number(receivable.returnedAmount) -
              Number(receivable.balance),
          ) > 0.01
        ) {
          throw new BadRequestException(
            'La cartera requiere conciliacion antes de registrar una devolucion.',
          );
        }
      }
      const returnedLines = allocateReturnedLines(
        invoice.lines,
        invoice.returns,
      );
      const seen = new Set<string>();
      const entries = dto.items.map((item) => {
        const line = invoice.lines.find(
          (line) => line.id === item.invoiceLineId,
        );
        if (!line || seen.has(item.invoiceLineId) || !item.reason.trim()) {
          throw new BadRequestException(
            'Selecciona lineas de esta factura, sin repetirlas y con un motivo.',
          );
        }
        seen.add(item.invoiceLineId);
        const returned = returnedLines.get(line.id)!;
        if (item.quantity > line.quantity - returned.quantity) {
          throw new BadRequestException(
            'La cantidad supera las unidades disponibles para devolver. Recarga la factura.',
          );
        }
        const amount = returnLineAmount(
          Number(line.lineTotal),
          line.quantity,
          returned.quantity,
          returned.amount,
          item.quantity,
        );
        returned.quantity += item.quantity;
        return { item, line, amount };
      });
      const total = Number(
        entries.reduce((sum, entry) => sum + entry.amount, 0).toFixed(2),
      );
      const settlement = settleReturn(total, Number(receivable?.balance ?? 0));
      await transaction.returnOperation.create({
        data: {
          id: dto.requestId,
          invoiceId: invoice.id,
          requestHash,
          debtReduction: settlement.debtReduction,
          refundAmount: settlement.refundAmount,
        },
      });
      const affectedProducts = new Set<string>();
      for (const { item, line, amount } of entries) {
        if (item.returnToStock) {
          await transaction.variant.update({
            where: { id: line.variantId },
            data: { stock: { increment: item.quantity } },
          });
          affectedProducts.add(line.productId);
        }
        await transaction.storeReturn.create({
          data: {
            operationId: dto.requestId,
            invoiceLineId: line.id,
            invoiceId: invoice.id,
            cashRegisterId: dto.cashRegisterId,
            customerId: invoice.customerId,
            customerNameSnapshot: customerName,
            invoiceSequentialSnapshot: invoice.sequential,
            productId: line.productId,
            variantId: line.variantId,
            barcodeSnapshot: line.barcode,
            productNameSnapshot: line.product.name,
            productSkuSnapshot: line.product.sku,
            sizeLabelSnapshot: line.variant.sizeLabel,
            colorLabelSnapshot: line.variant.colorLabel,
            quantity: item.quantity,
            reason: item.reason.trim(),
            returnToStock: item.returnToStock,
            refundedTotal: amount,
            refundedUnitPrice: Number((amount / item.quantity).toFixed(2)),
            returnDate: new Date(`${getEcuadorBusinessDayKey()}T00:00:00.000Z`),
          },
        });
      }
      for (const productId of affectedProducts) {
        const aggregate = await transaction.variant.aggregate({
          where: { productId },
          _sum: { stock: true },
        });
        await transaction.product.update({
          where: { id: productId },
          data: { totalStock: aggregate._sum.stock ?? 0 },
        });
      }
      const returnStatus = invoice.lines.every(
        (line) => returnedLines.get(line.id)!.quantity >= line.quantity,
      )
        ? 'TOTAL'
        : 'PARTIAL';
      await transaction.invoice.update({
        where: { id: invoice.id },
        data: {
          returnedTotal: { increment: total },
          returnStatus,
        },
      });
      if (receivable) {
        await transaction.receivable.update({
          where: { id: receivable.id },
          data: {
            returnedAmount: { increment: settlement.debtReduction },
            balance: settlement.balance,
            status:
              settlement.balance === 0
                ? ReceivableStatus.PAID
                : Number(receivable.paidAmount) > 0
                  ? ReceivableStatus.PARTIAL
                  : ReceivableStatus.OPEN,
          },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: 'create_return',
          entityId: dto.requestId,
          entityName: 'return_operation',
          module: 'returns',
          metadata: {
            invoiceId: invoice.id,
            total,
            ...settlement,
            returnStatus,
          },
        },
      });
      return this.operationResult(transaction, dto.requestId);
    });
  }

  private async operationResult(
    transaction: Prisma.TransactionClient,
    id: string,
  ) {
    const operation = await transaction.returnOperation.findUniqueOrThrow({
      where: { id },
      include: { items: { include: returnDetailsInclude } },
    });
    return {
      items: operation.items.map((item) => this.mapReturn(item)),
      settlement: {
        id: operation.id,
        debtReduction: Number(operation.debtReduction),
        refundAmount: Number(operation.refundAmount),
        refundPaidAt: operation.refundPaidAt,
      },
    };
  }

  async findRefunds() {
    const operations = await this.prisma.returnOperation.findMany({
      where: { refundAmount: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      include: { invoice: true, refundCashRegister: true, items: { take: 1 } },
    });
    return operations.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoice.sequential,
      customerName:
        row.items[0]?.customerNameSnapshot ?? row.invoice.customerNameSnapshot,
      amount: Number(row.refundAmount),
      paidAt: row.refundPaidAt,
      cashRegisterName: row.refundCashRegister?.name ?? null,
      requiresReview: row.requiresReview,
    }));
  }

  async payRefund(id: string, cashRegisterId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await this.cashService.assertRegisterCanInvoice(
        cashRegisterId,
        transaction,
      );
      await transaction.$queryRaw`SELECT id FROM return_operations WHERE id = ${id}::uuid FOR UPDATE`;
      const operation = await transaction.returnOperation.findUnique({
        where: { id },
      });
      if (!operation || Number(operation.refundAmount) <= 0)
        throw new BadRequestException('No existe un reembolso pendiente.');
      if (operation.refundPaidAt) return operation; // Repeating confirmation never pays twice.
      if (operation.requiresReview)
        throw new BadRequestException(
          'Este reembolso historico requiere verificar si el dinero ya fue entregado.',
        );
      const result = await transaction.returnOperation.update({
        where: { id },
        data: {
          refundPaidAt: new Date(),
          refundCashRegisterId: cashRegisterId,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: 'pay_refund',
          entityId: id,
          entityName: 'return_operation',
          module: 'returns',
          metadata: {
            amount: Number(operation.refundAmount),
            cashRegisterId,
            method: 'CASH',
            invoiceId: operation.invoiceId,
          },
        },
      });
      return result;
    });
  }

  async reviewLegacyRefund(id: string, alreadyPaid: boolean) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM return_operations WHERE id = ${id}::uuid FOR UPDATE`;
      const operation = await transaction.returnOperation.findUnique({
        where: { id },
      });
      if (!operation || !operation.requiresReview || operation.refundPaidAt) {
        throw new BadRequestException(
          'El reembolso no tiene una revision historica pendiente.',
        );
      }
      // A historical payment is a reconciliation, not a new withdrawal today.
      const result = await transaction.returnOperation.update({
        where: { id },
        data: {
          requiresReview: false,
          ...(alreadyPaid ? { refundPaidAt: new Date() } : {}),
        },
      });
      await transaction.auditLog.create({
        data: {
          action: alreadyPaid
            ? 'legacy_refund_already_paid'
            : 'legacy_refund_confirmed_pending',
          entityName: 'return_operation',
          entityId: id,
          module: 'returns',
          metadata: {
            amount: Number(operation.refundAmount),
            invoiceId: operation.invoiceId,
            alreadyPaid,
            noNewCashMovement: true,
          },
        },
      });
      return result;
    });
  }

  private buildWhere(query: FindReturnsQueryDto): Prisma.StoreReturnWhereInput {
    const search = query.search?.trim();

    if (!search) {
      return {};
    }

    return {
      OR: [
        { barcodeSnapshot: { contains: search, mode: 'insensitive' } },
        { colorLabelSnapshot: { contains: search, mode: 'insensitive' } },
        { customerNameSnapshot: { contains: search, mode: 'insensitive' } },
        {
          invoiceSequentialSnapshot: { contains: search, mode: 'insensitive' },
        },
        { productNameSnapshot: { contains: search, mode: 'insensitive' } },
        { productSkuSnapshot: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
        { sizeLabelSnapshot: { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  private mapReturn(item: ReturnRecord) {
    return {
      barcode: item.barcodeSnapshot,
      colorLabel: item.colorLabelSnapshot,
      createdAt: item.createdAt,
      customer: {
        id: item.customer?.id ?? null,
        identificationNumber: item.customer?.identificationNumber ?? null,
        name: item.customerNameSnapshot,
      },
      id: item.id,
      invoice: item.invoiceSequentialSnapshot
        ? {
            id: item.invoice?.id ?? null,
            sequential: item.invoiceSequentialSnapshot,
            status: item.invoice?.status ?? null,
          }
        : null,
      product: {
        id: item.productId,
        name: item.productNameSnapshot,
        sku: item.productSkuSnapshot,
      },
      quantity: item.quantity,
      reason: item.reason,
      refundedTotal: Number(item.refundedTotal),
      refundedUnitPrice: Number(item.refundedUnitPrice),
      returnDate: item.returnDate,
      returnToStock: item.returnToStock,
      sizeLabel: item.sizeLabelSnapshot,
      variant: {
        id: item.variantId,
      },
    };
  }
}

class PayRefundDto {
  @IsUUID()
  cashRegisterId!: string;
}

class ReviewLegacyRefundDto {
  @IsBoolean()
  alreadyPaid!: boolean;
}

@Controller('returns')
class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Get()
  findPage(@Query() query: FindReturnsQueryDto) {
    return this.returnsService.findPage(query);
  }

  @Get('refunds')
  findRefunds() {
    return this.returnsService.findRefunds();
  }

  @Post('refunds/:id/pay')
  @UseGuards(AuthGuard('jwt'))
  payRefund(@Param('id') id: string, @Body() dto: PayRefundDto) {
    return this.returnsService.payRefund(id, dto.cashRegisterId);
  }

  @Post('refunds/:id/review')
  @UseGuards(AuthGuard('jwt'))
  reviewLegacyRefund(
    @Req() request: Request & { user: { role: UserRole } },
    @Param('id') id: string,
    @Body() dto: ReviewLegacyRefundDto,
  ) {
    if (
      request.user.role !== UserRole.ADMIN &&
      request.user.role !== UserRole.MANAGER
    ) {
      throw new ForbiddenException(
        'Solo administracion puede conciliar reembolsos historicos.',
      );
    }
    return this.returnsService.reviewLegacyRefund(id, dto.alreadyPaid);
  }

  @Post()
  create(@Body() dto: CreateReturnDto) {
    return this.returnsService.create(dto);
  }
}

@Module({
  imports: [CashModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
})
export class ReturnsModule {}
