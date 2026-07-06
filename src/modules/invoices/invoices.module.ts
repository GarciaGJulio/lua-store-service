import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { CouponDiscountType, CouponScope, InvoiceStatus, PaymentMethod, Prisma } from '@prisma/client';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import { PrismaService } from '@/database/prisma.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { CashModule, CashService } from '@/modules/cash/cash.module';
import { DiscountsModule } from '@/modules/discounts/discounts.module';

const FINAL_CONSUMER_NAME = 'Consumidor final';
const FINAL_CONSUMER_IDENTIFICATION = '9999999999999';

class CreateInvoiceLineDto {
  @IsString()
  variantId!: string;

  @IsNumber()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsString()
  itemCouponId?: string;
}

class CreateInvoicePaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  reference?: string;
}

class CreateInvoiceDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  cartCouponId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceLineDto)
  lines!: CreateInvoiceLineDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateInvoicePaymentDto)
  payments!: CreateInvoicePaymentDto[];
}

class VoidInvoiceDto {
  @IsString()
  reason!: string;
}

class FindSalesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;
}

const invoiceDetailsInclude = {
  cashRegister: true,
  cancellation: true,
  customer: true,
  lines: {
    include: {
      product: true,
      variant: {
        include: {
          barcode: true,
          product: true,
        },
      },
    },
  },
  payments: true,
  receivable: {
    include: {
      payments: true,
    },
  },
} satisfies Prisma.InvoiceInclude;

type InvoiceDetailsRecord = Prisma.InvoiceGetPayload<{
  include: typeof invoiceDetailsInclude;
}>;

type SequencedDocument = {
  current_value: bigint;
  padding: number;
  prefix: string;
};

@Injectable()
class InvoicesService {
  constructor(
    private readonly cashService: CashService,
    private readonly prisma: PrismaService,
  ) {}

  findAll() {
    return this.prisma.invoice.findMany({
      include: invoiceDetailsInclude,
      orderBy: { issuedAt: 'desc' },
    });
  }

  async findSalesPage(query: FindSalesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 15;
    const where = this.buildSalesWhere(query);
    const validSalesWhere: Prisma.InvoiceWhereInput = {
      ...where,
      status: {
        not: InvoiceStatus.VOIDED,
      },
    };

    const [items, totalItems, aggregate] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          customerNameSnapshot: true,
          id: true,
          issuedAt: true,
          sequential: true,
          status: true,
          total: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        where,
      }),
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.aggregate({
        _sum: { total: true },
        where: validSalesWhere,
      }),
    ]);

    return {
      items: items.map((invoice) => ({
        canVoid: invoice.status !== InvoiceStatus.VOIDED,
        customerName: invoice.customerNameSnapshot,
        id: invoice.id,
        issuedAt: invoice.issuedAt,
        sequential: invoice.sequential,
        status: invoice.status,
        total: Number(invoice.total),
      })),
      meta: {
        limit,
        page,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
      summary: {
        totalAmount: Number(aggregate._sum.total ?? 0),
        totalSales: totalItems,
      },
    };
  }

  async findSaleById(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: invoiceDetailsInclude,
    });

    if (!invoice) {
      throw new BadRequestException('El comprobante seleccionado no existe.');
    }

    const returnedQuantities = await this.getReturnedQuantities(invoice.id);
    return this.mapInvoiceDetail(invoice, returnedQuantities);
  }

  async voidSaleById(invoiceId: string, dto: VoidInvoiceDto) {
    const invoice = await this.voidInvoice(invoiceId, dto);
    const returnedQuantities = await this.getReturnedQuantities(invoice.id);
    return this.mapInvoiceDetail(invoice as InvoiceDetailsRecord, returnedQuantities);
  }

  async create(dto: CreateInvoiceDto) {
    if (!dto.cashRegisterId) {
      throw new BadRequestException(
        'Debes seleccionar una caja abierta para emitir la factura.',
      );
    }

    await this.cashService.assertRegisterCanInvoice(dto.cashRegisterId);

    const hasCreditPayment = dto.payments.some(
      (payment) => payment.method === PaymentMethod.CREDITO_MONSE,
    );

    if (hasCreditPayment && dto.payments.length > 1) {
      throw new BadRequestException(
        'Credito Monse no puede combinarse con otros metodos de pago.',
      );
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const [customer, cashRegister] = await Promise.all([
          dto.customerId
            ? transaction.customer.findUnique({
                where: { id: dto.customerId },
              })
            : null,
          dto.cashRegisterId
            ? transaction.cashRegister.findUnique({
                where: { id: dto.cashRegisterId },
              })
            : null,
        ]);

        if (dto.customerId && (!customer || !customer.isActive)) {
          throw new BadRequestException('El cliente seleccionado no existe o esta inactivo.');
        }

        if (dto.cashRegisterId && (!cashRegister || !cashRegister.isActive)) {
          throw new BadRequestException('La caja seleccionada no existe o esta inactiva.');
        }

        if (hasCreditPayment && !customer) {
          throw new BadRequestException(
            'Debes seleccionar un cliente para emitir una venta con Credito Monse.',
          );
        }

        const uniqueVariantIds = [...new Set(dto.lines.map((line) => line.variantId))];
        const uniqueCouponIds = [
          ...new Set(
            dto.lines
              .map((line) => line.itemCouponId)
              .concat(dto.cartCouponId)
              .filter((value): value is string => Boolean(value)),
          ),
        ];
        const variants = await transaction.variant.findMany({
          where: {
            id: {
              in: uniqueVariantIds,
            },
          },
          include: {
            barcode: true,
            product: {
              include: {
                tax: true,
              },
            },
          },
        });
        const coupons = uniqueCouponIds.length
          ? await transaction.storeCoupon.findMany({
              where: {
                id: {
                  in: uniqueCouponIds,
                },
              },
            })
          : [];
        const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
        const couponsById = new Map(coupons.map((coupon) => [coupon.id, coupon]));

        if (variants.length !== uniqueVariantIds.length) {
          throw new BadRequestException('Una o mas variantes no existen.');
        }

        const cartCoupon = dto.cartCouponId
          ? this.resolveCoupon(
              couponsById.get(dto.cartCouponId),
              dto.cartCouponId,
              CouponScope.CART,
            )
          : null;

        let subtotal = 0;
        let taxTotal = 0;

        const draftLines = dto.lines.map((line) => {
          const variant = variantsById.get(line.variantId);

          if (!variant) {
            throw new BadRequestException(`La variante ${line.variantId} no existe.`);
          }

          if (!variant.isActive || !variant.product.isActive || !variant.barcode.isActive) {
            throw new BadRequestException(
              `La variante ${variant.product.name} / ${variant.sizeLabel} / ${variant.colorLabel} no esta disponible para facturacion.`,
            );
          }

          const unitPrice = Number((line.unitPrice ?? Number(variant.price)).toFixed(2));
          const taxRate = Number((line.taxRate ?? Number(variant.product.tax.rate)).toFixed(4));
          const taxFactor = 1 + taxRate / 100;
          const grossLineAmount = variant.product.taxIncluded
            ? Number((line.quantity * unitPrice).toFixed(2))
            : Number((line.quantity * unitPrice * taxFactor).toFixed(2));
          const itemCoupon = line.itemCouponId
            ? this.resolveCoupon(
                couponsById.get(line.itemCouponId),
                line.itemCouponId,
                CouponScope.ITEM,
              )
            : null;
          const itemDiscount = itemCoupon
            ? this.applyCouponDiscount(itemCoupon, grossLineAmount)
            : 0;
          const grossAfterItemDiscount = Number(
            Math.max(0, grossLineAmount - itemDiscount).toFixed(2),
          );

          return {
            barcode: variant.barcode.code,
            description: `${variant.product.name} / ${variant.sizeLabel} / ${variant.colorLabel}`,
            grossAfterItemDiscount,
            itemCouponId: itemCoupon?.id ?? null,
            itemDiscount,
            productId: variant.productId,
            quantity: line.quantity,
            taxFactor,
            taxRate,
            unitPrice,
            variantId: variant.id,
          };
        });

        const grossAfterItemTotal = Number(
          draftLines.reduce((sum, line) => sum + line.grossAfterItemDiscount, 0).toFixed(2),
        );
        const cartDiscountTotal = cartCoupon
          ? this.applyCouponDiscount(cartCoupon, grossAfterItemTotal)
          : 0;
        const cartDiscountAllocation = this.allocateCartDiscount(
          draftLines.map((line) => line.grossAfterItemDiscount),
          cartDiscountTotal,
        );

        const normalizedLines = draftLines.map((line, index) => {
          const lineTotal = Number(
            Math.max(0, line.grossAfterItemDiscount - cartDiscountAllocation[index]).toFixed(2),
          );
          const lineSubtotal = Number((lineTotal / line.taxFactor).toFixed(2));
          const lineTax = Number((lineTotal - lineSubtotal).toFixed(2));

          subtotal += lineSubtotal;
          taxTotal += lineTax;

          return {
            barcode: line.barcode,
            cartDiscount: cartDiscountAllocation[index],
            description: line.description,
            itemCouponId: line.itemCouponId,
            itemDiscount: line.itemDiscount,
            lineSubtotal,
            lineTax,
            lineTotal,
            productId: line.productId,
            quantity: line.quantity,
            taxRate: line.taxRate,
            unitPrice: line.unitPrice,
            variantId: line.variantId,
          };
        });

        const normalizedSubtotal = Number(subtotal.toFixed(2));
        const normalizedTaxTotal = Number(taxTotal.toFixed(2));
        const total = Number((normalizedSubtotal + normalizedTaxTotal).toFixed(2));
        const paymentTotal = Number(
          dto.payments.reduce((sum, payment) => sum + payment.amount, 0).toFixed(2),
        );

        if (Math.abs(paymentTotal - total) > 0.01) {
          throw new BadRequestException(
            'La suma de pagos debe coincidir exactamente con el total de la factura.',
          );
        }

        const documentNumber = await this.getNextDocumentNumber(transaction, 'INVOICE');
        const invoice = await transaction.invoice.create({
          data: {
            cashRegisterId: cashRegister?.id,
            customerAddressSnapshot: customer?.address ?? null,
            customerEmailSnapshot: customer?.email ?? null,
            customerId: customer?.id,
            customerIdentificationSnapshot:
              customer?.identificationNumber ?? FINAL_CONSUMER_IDENTIFICATION,
            customerNameSnapshot: customer?.fullName ?? FINAL_CONSUMER_NAME,
            customerPhoneSnapshot: customer?.phone ?? null,
            isFinalConsumer: customer ? false : true,
            notes: dto.notes?.trim() || undefined,
            payments: {
              create: dto.payments.map((payment) => ({
                amount: payment.amount,
                method: payment.method,
                reference: payment.reference?.trim() || undefined,
              })),
            },
            lines: {
              create: normalizedLines.map((line) => ({
                barcode: line.barcode,
                description: line.description,
                lineSubtotal: line.lineSubtotal,
                lineTax: line.lineTax,
                lineTotal: line.lineTotal,
                productId: line.productId,
                quantity: line.quantity,
                taxRate: line.taxRate,
                unitPrice: line.unitPrice,
                variantId: line.variantId,
              })),
            },
            sequential: documentNumber,
            status: hasCreditPayment ? InvoiceStatus.CREDIT_PENDING : InvoiceStatus.ISSUED,
            subtotal: normalizedSubtotal,
            taxTotal: normalizedTaxTotal,
            total,
          },
        });

        if (hasCreditPayment && customer) {
          await transaction.receivable.create({
            data: {
              balance: total,
              customerId: customer.id,
              invoiceId: invoice.id,
              originalAmount: total,
              paidAmount: 0,
            },
          });
        }

        await transaction.auditLog.create({
          data: {
            action: 'create',
            entityName: 'invoice',
            entityId: invoice.id,
            metadata: {
              customerId: customer?.id ?? null,
              cartCouponId: cartCoupon?.id ?? null,
              hasCreditPayment,
              lineDiscounts: normalizedLines.map((line) => ({
                cartDiscount: line.cartDiscount,
                itemCouponId: line.itemCouponId,
                itemDiscount: line.itemDiscount,
                variantId: line.variantId,
              })),
              total,
            },
            module: 'invoices',
          },
        });

        return transaction.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          include: invoiceDetailsInclude,
        });
      });
    } catch (error) {
      throw this.mapInvoiceError(error);
    }
  }

  async voidInvoice(invoiceId: string, dto: VoidInvoiceDto) {
    return this.prisma.$transaction(async (transaction) => {
      const reason = dto.reason.trim();

      if (!reason) {
        throw new BadRequestException('Debes ingresar el motivo de anulacion del comprobante.');
      }

      const invoice = await transaction.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          cancellation: true,
          receivable: {
            include: {
              payments: true,
            },
          },
        },
      });

      if (!invoice) {
        throw new BadRequestException('La factura no existe.');
      }

      if (invoice.status === InvoiceStatus.VOIDED || invoice.cancellation) {
        throw new BadRequestException('La factura ya fue anulada.');
      }

      if (invoice.receivable?.payments.length) {
        throw new BadRequestException(
          'No se puede anular una factura que ya tiene abonos de cartera registrados.',
        );
      }

      if (invoice.receivable) {
        await transaction.receivable.delete({
          where: { id: invoice.receivable.id },
        });
      }

      await transaction.invoiceCancellation.create({
        data: {
          invoiceId,
          reason,
        },
      });

      await transaction.auditLog.create({
        data: {
          action: 'void',
          entityName: 'invoice',
          entityId: invoiceId,
          metadata: { reason },
          module: 'invoices',
        },
      });

      return transaction.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: invoiceDetailsInclude,
      });
    });
  }

  private buildSalesWhere(query: FindSalesQueryDto): Prisma.InvoiceWhereInput {
    const where: Prisma.InvoiceWhereInput = {};
    const range: Prisma.DateTimeFilter = {};
    const search = query.search?.trim();

    if (query.dateFrom?.trim()) {
      range.gte = this.normalizeDayStart(query.dateFrom);
    }

    if (query.dateTo?.trim()) {
      range.lte = this.normalizeDayEnd(query.dateTo);
    }

    if (Object.keys(range).length > 0) {
      where.issuedAt = range;
    }

    if (search) {
      where.OR = [
        { customerNameSnapshot: { contains: search, mode: 'insensitive' } },
        { customerIdentificationSnapshot: { contains: search, mode: 'insensitive' } },
        { sequential: { contains: search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private resolveCoupon(
    coupon:
      | {
          id: string;
          scope: CouponScope;
          isActive: boolean;
          validFrom: Date;
          validTo: Date;
          discountType: CouponDiscountType;
          discountValue: Prisma.Decimal;
        }
      | null
      | undefined,
    couponId: string,
    expectedScope: CouponScope,
  ) {
    if (!coupon) {
      throw new BadRequestException(`El cupon ${couponId} no existe.`);
    }

    if (coupon.scope !== expectedScope) {
      throw new BadRequestException('El cupon seleccionado no corresponde al ambito esperado.');
    }

    const today = this.normalizeDayStart(new Date().toISOString());

    if (
      !coupon.isActive ||
      coupon.validFrom.getTime() > today.getTime() ||
      coupon.validTo.getTime() < today.getTime()
    ) {
      throw new BadRequestException('El cupon seleccionado no se encuentra disponible.');
    }

    return {
      ...coupon,
      discountValue: Number(coupon.discountValue),
    };
  }

  private applyCouponDiscount(
    coupon: {
      discountType: CouponDiscountType;
      discountValue: number;
    },
    baseAmount: number,
  ) {
    const rawDiscount =
      coupon.discountType === CouponDiscountType.AMOUNT
        ? coupon.discountValue
        : baseAmount * (coupon.discountValue / 100);

    return Number(Math.min(baseAmount, rawDiscount).toFixed(2));
  }

  private allocateCartDiscount(lineAmounts: Array<number>, totalDiscount: number) {
    const lineAmountCents = lineAmounts.map((amount) => Math.max(0, Math.round(amount * 100)));
    const totalDiscountCents = Math.max(0, Math.round(totalDiscount * 100));
    const totalLineCents = lineAmountCents.reduce((sum, amount) => sum + amount, 0);

    if (totalDiscountCents === 0 || totalLineCents === 0) {
      return lineAmounts.map(() => 0);
    }

    const allocated = lineAmountCents.map((amount) =>
      Math.min(amount, Math.floor((totalDiscountCents * amount) / totalLineCents)),
    );
    let remainder = totalDiscountCents - allocated.reduce((sum, amount) => sum + amount, 0);
    const indexesByAmount = lineAmountCents
      .map((amount, index) => ({ amount, index }))
      .sort((left, right) => right.amount - left.amount)
      .map((item) => item.index);

    while (remainder > 0) {
      let allocatedThisRound = false;

      for (const index of indexesByAmount) {
        if (allocated[index] >= lineAmountCents[index]) {
          continue;
        }

        allocated[index] += 1;
        remainder -= 1;
        allocatedThisRound = true;

        if (remainder === 0) {
          break;
        }
      }

      if (!allocatedThisRound) {
        break;
      }
    }

    return allocated.map((value) => Number((value / 100).toFixed(2)));
  }

  private async getReturnedQuantities(invoiceId: string) {
    const rows = await this.prisma.storeReturn.groupBy({
      by: ['variantId'],
      where: {
        invoiceId,
      },
      _sum: {
        quantity: true,
      },
    });

    return new Map(
      rows.map((row) => [row.variantId, Number(row._sum.quantity ?? 0)]),
    );
  }

  private mapInvoiceDetail(
    invoice: InvoiceDetailsRecord,
    returnedQuantities = new Map<string, number>(),
  ) {
    const receivablePaymentsCount = invoice.receivable?.payments.length ?? 0;
    const canVoid =
      invoice.status !== InvoiceStatus.VOIDED && receivablePaymentsCount === 0;
    const voidBlockedReason =
      invoice.status === InvoiceStatus.VOIDED
        ? 'El comprobante ya fue anulado.'
        : receivablePaymentsCount > 0
          ? 'No se puede anular porque ya registra abonos de cartera.'
          : null;

    return {
      canVoid,
      cancellation: invoice.cancellation
        ? {
            cancelledAt: invoice.cancellation.cancelledAt,
            reason: invoice.cancellation.reason ?? '',
          }
        : null,
      cashRegisterName: invoice.cashRegister?.name ?? null,
      customer: {
        address: invoice.customerAddressSnapshot,
        email: invoice.customerEmailSnapshot,
        identification: invoice.customerIdentificationSnapshot,
        isFinalConsumer: invoice.isFinalConsumer,
        name: invoice.customerNameSnapshot,
        phone: invoice.customerPhoneSnapshot,
      },
      id: invoice.id,
      issuedAt: invoice.issuedAt,
      lines: invoice.lines.map((line) => ({
        barcode: line.barcode,
        colorLabel: line.variant.colorLabel,
        description: line.description,
        lineSubtotal: Number(line.lineSubtotal),
        lineTax: Number(line.lineTax),
        lineTotal: Number(line.lineTotal),
        productName: line.product.name,
        quantity: line.quantity,
        returnableQuantity: Math.max(
          0,
          line.quantity - (returnedQuantities.get(line.variantId) ?? 0),
        ),
        returnedQuantity: returnedQuantities.get(line.variantId) ?? 0,
        sizeLabel: line.variant.sizeLabel,
        taxRate: Number(line.taxRate),
        unitPrice: Number(line.unitPrice),
        variantId: line.variantId,
      })),
      notes: invoice.notes ?? '',
      payments: invoice.payments.map((payment) => ({
        amount: Number(payment.amount),
        method: payment.method,
        reference: payment.reference ?? '',
      })),
      receivable: invoice.receivable
        ? {
            balance: Number(invoice.receivable.balance),
            originalAmount: Number(invoice.receivable.originalAmount),
            paidAmount: Number(invoice.receivable.paidAmount),
            paymentsCount: receivablePaymentsCount,
            status: invoice.receivable.status,
          }
        : null,
      sequential: invoice.sequential,
      status: invoice.status,
      subtotal: Number(invoice.subtotal),
      taxTotal: Number(invoice.taxTotal),
      total: Number(invoice.total),
      voidBlockedReason,
    };
  }

  private normalizeDayStart(value: string) {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  }

  private normalizeDayEnd(value: string) {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return new Date(`${year}-${month}-${day}T23:59:59.999Z`);
  }

  private async getNextDocumentNumber(
    transaction: Prisma.TransactionClient,
    documentType: string,
  ) {
    const sequenceRows = await transaction.$queryRaw<Array<SequencedDocument>>(Prisma.sql`
      UPDATE lua_store.document_sequences
         SET current_value = current_value + 1,
             updated_at = NOW()
       WHERE document_type = ${documentType}
         AND is_active = TRUE
       RETURNING prefix, current_value, padding
    `);

    const sequence = sequenceRows[0];

    if (!sequence) {
      throw new BadRequestException(
        `No existe una secuencia documental activa para ${documentType}.`,
      );
    }

    return `${sequence.prefix}${String(Number(sequence.current_value)).padStart(
      sequence.padding,
      '0',
    )}`;
  }

  private mapInvoiceError(error: unknown) {
    if (error instanceof BadRequestException) {
      return error;
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError
    ) {
      const message = this.extractPrismaMessage(error.message);
      return new BadRequestException(message);
    }

    if (error instanceof Error) {
      return new BadRequestException(this.extractPrismaMessage(error.message));
    }

    return new BadRequestException('No se pudo emitir la factura.');
  }

  private extractPrismaMessage(message: string) {
    if (message.includes('Producto no cuenta con stock suficiente')) {
      const stockMessage = message.match(/Producto no cuenta con stock suficiente\.[^"]+/)?.[0];
      return stockMessage ?? 'Una de las variantes no cuenta con stock suficiente.';
    }

    if (message.includes('Credito Monse no puede combinarse')) {
      return 'Credito Monse no puede combinarse con otros metodos de pago.';
    }

    if (message.includes('Credito Monse no puede emitirse como consumidor final')) {
      return 'Credito Monse requiere un cliente real y no puede emitirse como consumidor final.';
    }

    if (message.includes('La suma de pagos')) {
      return 'La suma de pagos debe coincidir exactamente con el total de la factura.';
    }

    return 'No se pudo emitir la factura.';
  }
}

@Controller('invoices')
class InvoicesController {
  constructor(
    private readonly invoicePdfService: InvoicePdfService,
    private readonly invoicesService: InvoicesService,
  ) {}

  @Get()
  findAll() {
    return this.invoicesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateInvoiceDto) {
    return this.invoicesService.create(dto);
  }

  @Post(':id/void')
  voidInvoice(@Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    return this.invoicesService.voidInvoice(id, dto);
  }

  @Get(':id/pdf')
  async renderPdf(@Param('id') id: string) {
    const buffer = await this.invoicePdfService.renderInvoicePdf(id);

    return new StreamableFile(buffer, {
      disposition: `inline; filename="invoice-${id}.pdf"`,
      type: 'application/pdf',
    });
  }
}

@Controller('sales')
class SalesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  findSalesPage(@Query() query: FindSalesQueryDto) {
    return this.invoicesService.findSalesPage(query);
  }

  @Get(':id')
  findSaleById(@Param('id') id: string) {
    return this.invoicesService.findSaleById(id);
  }

  @Post(':id/void')
  voidInvoice(@Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    return this.invoicesService.voidSaleById(id, dto);
  }
}

@Module({
  imports: [CashModule, DiscountsModule],
  controllers: [InvoicesController, SalesController],
  providers: [InvoicesService, InvoicePdfService],
})
export class InvoicesModule {}
