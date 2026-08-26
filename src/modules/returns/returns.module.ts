import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import { CashModule, CashService } from '@/modules/cash/cash.module';
import { PrismaService } from '@/database/prisma.service';

class FindReturnsQueryDto extends PaginationQueryDto {}

class CreateReturnItemDto {
  @IsString()
  variantId!: string;

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
class ReturnsService {
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
    await this.cashService.assertRegisterCanInvoice(dto.cashRegisterId);

    const uniqueVariantIds = new Set<string>();

    for (const item of dto.items) {
      const reason = item.reason.trim();

      if (!reason) {
        throw new BadRequestException(
          'Cada producto seleccionado para devolucion debe registrar un motivo.',
        );
      }

      if (uniqueVariantIds.has(item.variantId)) {
        throw new BadRequestException(
          'No repitas la misma variante dentro del mismo registro de devolucion.',
        );
      }

      uniqueVariantIds.add(item.variantId);
    }

    return this.prisma.$transaction(async (transaction) => {
      const invoice = await transaction.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: {
          customer: true,
          lines: {
            include: {
              product: true,
              variant: {
                include: {
                  barcode: true,
                },
              },
            },
          },
        },
      });

      if (!invoice) {
        throw new BadRequestException('La factura seleccionada no existe.');
      }

      if (invoice.status === InvoiceStatus.VOIDED) {
        throw new BadRequestException('No puedes registrar devoluciones sobre una factura anulada.');
      }

      const effectiveCustomerName = invoice.customerId
        ? invoice.customerNameSnapshot
        : dto.customerName?.trim();

      if (!effectiveCustomerName) {
        throw new BadRequestException(
          'Debes registrar el nombre del cliente cuando la factura pertenece a consumidor final.',
        );
      }

      const returnedRows = await transaction.storeReturn.groupBy({
        by: ['variantId'],
        where: {
          invoiceId: invoice.id,
          variantId: {
            in: dto.items.map((item) => item.variantId),
          },
        },
        _sum: {
          quantity: true,
        },
      });

      const returnedByVariant = new Map(
        returnedRows.map((row) => [row.variantId, Number(row._sum.quantity ?? 0)]),
      );

      const invoiceLinesByVariant = new Map<
        string,
        {
          totalLineAmount: number;
          totalQuantity: number;
          productId: string;
          productName: string;
          productSku: string;
          sizeLabel: string;
          colorLabel: string;
          barcode: string;
        }
      >();

      for (const line of invoice.lines) {
        const current = invoiceLinesByVariant.get(line.variantId);

        if (current) {
          current.totalLineAmount = Number(
            (current.totalLineAmount + Number(line.lineTotal)).toFixed(2),
          );
          current.totalQuantity += line.quantity;
          continue;
        }

        invoiceLinesByVariant.set(line.variantId, {
          barcode: line.barcode,
          colorLabel: line.variant.colorLabel,
          productId: line.productId,
          productName: line.product.name,
          productSku: line.product.sku,
          sizeLabel: line.variant.sizeLabel,
          totalLineAmount: Number(line.lineTotal),
          totalQuantity: line.quantity,
        });
      }

      const createdReturns: Array<ReturnRecord> = [];

      for (const item of dto.items) {
        const invoiceLine = invoiceLinesByVariant.get(item.variantId);

        if (!invoiceLine) {
          throw new BadRequestException(
            'Solo puedes devolver productos que consten en la factura seleccionada.',
          );
        }

        const alreadyReturned = returnedByVariant.get(item.variantId) ?? 0;
        const remainingQuantity = invoiceLine.totalQuantity - alreadyReturned;

        if (remainingQuantity <= 0) {
          throw new BadRequestException(
            `La variante ${invoiceLine.productSku} / ${invoiceLine.sizeLabel} / ${invoiceLine.colorLabel} ya fue devuelta completamente.`,
          );
        }

        if (item.quantity > remainingQuantity) {
          throw new BadRequestException(
            `No puedes devolver mas de ${remainingQuantity} unidad(es) para ${invoiceLine.productSku} / ${invoiceLine.sizeLabel} / ${invoiceLine.colorLabel}.`,
          );
        }

        const refundedUnitPrice = Number(
          (invoiceLine.totalLineAmount / invoiceLine.totalQuantity).toFixed(2),
        );
        const refundedTotal = Number((refundedUnitPrice * item.quantity).toFixed(2));

        if (item.returnToStock) {
          await transaction.variant.update({
            where: { id: item.variantId },
            data: {
              stock: {
                increment: item.quantity,
              },
            },
          });
        }

        const createdReturn = await transaction.storeReturn.create({
          data: {
            barcodeSnapshot: invoiceLine.barcode,
            cashRegisterId: dto.cashRegisterId,
            colorLabelSnapshot: invoiceLine.colorLabel,
            customerId: invoice.customerId ?? undefined,
            customerNameSnapshot: effectiveCustomerName,
            invoiceId: invoice.id,
            invoiceSequentialSnapshot: invoice.sequential,
            productId: invoiceLine.productId,
            productNameSnapshot: invoiceLine.productName,
            productSkuSnapshot: invoiceLine.productSku,
            quantity: item.quantity,
            reason: item.reason.trim(),
            refundedTotal,
            refundedUnitPrice,
            returnToStock: item.returnToStock,
            sizeLabelSnapshot: invoiceLine.sizeLabel,
            variantId: item.variantId,
          },
          include: returnDetailsInclude,
        });

        createdReturns.push(createdReturn);
      }

      await transaction.auditLog.create({
        data: {
          action: 'create_return',
          entityId: dto.invoiceId,
          entityName: 'store_return',
          metadata: {
            cashRegisterId: dto.cashRegisterId,
            invoiceId: dto.invoiceId,
            items: dto.items.map((item) => ({
              quantity: item.quantity,
              reason: item.reason.trim(),
              returnToStock: item.returnToStock,
              variantId: item.variantId,
            })),
          },
          module: 'returns',
        },
      });

      return {
        items: createdReturns.map((item) => this.mapReturn(item)),
      };
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
        { invoiceSequentialSnapshot: { contains: search, mode: 'insensitive' } },
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

@Controller('returns')
class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Get()
  findPage(@Query() query: FindReturnsQueryDto) {
    return this.returnsService.findPage(query);
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
