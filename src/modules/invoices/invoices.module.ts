import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
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
import { InvoiceStatus, PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';
import { InvoicePdfService } from './invoice-pdf.service';

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

const invoiceDetailsInclude = {
  cashRegister: true,
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

type SequencedDocument = {
  current_value: bigint;
  padding: number;
  prefix: string;
};

@Injectable()
class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.invoice.findMany({
      include: invoiceDetailsInclude,
      orderBy: { issuedAt: 'desc' },
    });
  }

  async create(dto: CreateInvoiceDto) {
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
        const variantsById = new Map(variants.map((variant) => [variant.id, variant]));

        if (variants.length !== uniqueVariantIds.length) {
          throw new BadRequestException('Una o mas variantes no existen.');
        }

        let subtotal = 0;
        let taxTotal = 0;

        const normalizedLines = dto.lines.map((line) => {
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
          const grossLineAmount = Number((line.quantity * unitPrice).toFixed(2));
          const taxFactor = 1 + taxRate / 100;

          const lineSubtotal = variant.product.taxIncluded
            ? Number((grossLineAmount / taxFactor).toFixed(2))
            : grossLineAmount;
          const lineTax = variant.product.taxIncluded
            ? Number((grossLineAmount - lineSubtotal).toFixed(2))
            : Number((lineSubtotal * (taxRate / 100)).toFixed(2));
          const lineTotal = variant.product.taxIncluded
            ? grossLineAmount
            : Number((lineSubtotal + lineTax).toFixed(2));

          subtotal += lineSubtotal;
          taxTotal += lineTax;

          return {
            barcode: variant.barcode.code,
            description: `${variant.product.name} / ${variant.sizeLabel} / ${variant.colorLabel}`,
            lineSubtotal,
            lineTax,
            lineTotal,
            productId: variant.productId,
            quantity: line.quantity,
            taxRate,
            unitPrice,
            variantId: variant.id,
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
              hasCreditPayment,
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
          reason: dto.reason.trim(),
        },
      });

      await transaction.auditLog.create({
        data: {
          action: 'void',
          entityName: 'invoice',
          entityId: invoiceId,
          metadata: { reason: dto.reason.trim() },
          module: 'invoices',
        },
      });

      return transaction.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: invoiceDetailsInclude,
      });
    });
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

@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoicePdfService],
})
export class InvoicesModule {}
