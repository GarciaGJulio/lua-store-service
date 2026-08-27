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
import {
  InvoiceStatus,
  PaymentMethod,
  Prisma,
  ReceivableStatus,
} from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { PrismaService } from '@/database/prisma.service';
import { ReceiptPdfService } from './receipt-pdf.service';

class CreateReceivablePaymentDto {
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional()
  @IsString()
  notes?: string;
}

class CreateInitialDebtDto {
  @IsUUID()
  customerId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsDateString()
  lastPaymentAt!: string;
}

const receivableDetailsInclude = {
  customer: true,
  invoice: true,
  payments: {
    orderBy: { paidAt: 'desc' },
  },
} satisfies Prisma.ReceivableInclude;

type SequencedDocument = {
  current_value: bigint;
  padding: number;
  prefix: string;
};

@Injectable()
class ReceivablesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.receivable.findMany({
      include: receivableDetailsInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createInitialDebt(dto: CreateInitialDebtDto) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, isActive: true },
    });

    if (!customer) {
      throw new BadRequestException(
        'El cliente seleccionado no existe o esta inactivo.',
      );
    }

    const lastPaymentAt = new Date(dto.lastPaymentAt);
    if (Number.isNaN(lastPaymentAt.getTime())) {
      throw new BadRequestException('La fecha de ultimo abono no es valida.');
    }

    return this.prisma.$transaction(async (transaction) => {
      const receivable = await transaction.receivable.create({
        data: {
          balance: dto.amount,
          customerId: customer.id,
          isInitialDebt: true,
          lastPaymentAt,
          originalAmount: dto.amount,
          paidAmount: 0,
        },
        include: receivableDetailsInclude,
      });

      await transaction.auditLog.create({
        data: {
          action: 'create_initial_debt',
          entityName: 'receivable',
          entityId: receivable.id,
          metadata: {
            amount: dto.amount,
            customerId: customer.id,
            lastPaymentAt,
          },
          module: 'receivables',
        },
      });

      return receivable;
    });
  }

  async recordPayment(receivableId: string, dto: CreateReceivablePaymentDto) {
    if (dto.method === PaymentMethod.CREDITO_MONSE) {
      throw new BadRequestException(
        'Credito Monse no es un metodo valido para registrar abonos.',
      );
    }

    return this.prisma.$transaction(async (transaction) => {
      const receivable = await transaction.receivable.findUnique({
        where: { id: receivableId },
        include: {
          invoice: true,
          payments: true,
        },
      });

      if (!receivable) {
        throw new BadRequestException('Cuenta por cobrar no encontrada.');
      }

      if (receivable.status === ReceivableStatus.PAID) {
        throw new BadRequestException('La cuenta ya se encuentra pagada.');
      }

      if (dto.amount > Number(receivable.balance)) {
        throw new BadRequestException(
          'El abono no puede superar el saldo pendiente.',
        );
      }

      const paymentNumber = await this.getNextDocumentNumber(
        transaction,
        'RECEIVABLE_PAYMENT',
      );

      const payment = await transaction.receivablePayment.create({
        data: {
          amount: dto.amount,
          method: dto.method,
          notes: dto.notes?.trim() || undefined,
          paymentNumber,
          receivableId,
        },
      });

      await transaction.receivable.update({
        where: { id: receivableId },
        data: { lastPaymentAt: payment.paidAt },
      });

      const updatedReceivable = await transaction.receivable.findUniqueOrThrow({
        where: { id: receivableId },
        include: receivableDetailsInclude,
      });

      if (updatedReceivable.invoiceId) {
        const nextInvoiceStatus =
          updatedReceivable.status === ReceivableStatus.PAID
            ? InvoiceStatus.CREDIT_PAID
            : InvoiceStatus.CREDIT_PARTIAL;

        await transaction.invoice.update({
          where: { id: updatedReceivable.invoiceId },
          data: { status: nextInvoiceStatus },
        });
      }

      await transaction.auditLog.create({
        data: {
          action: 'receivable_payment',
          entityName: 'receivable',
          entityId: receivableId,
          metadata: {
            amount: dto.amount,
            paymentId: payment.id,
            paymentNumber,
          },
          module: 'receivables',
        },
      });

      return transaction.receivable.findUniqueOrThrow({
        where: { id: receivableId },
        include: receivableDetailsInclude,
      });
    });
  }

  private async getNextDocumentNumber(
    transaction: Prisma.TransactionClient,
    documentType: string,
  ) {
    const sequenceRows = await transaction.$queryRaw<
      Array<SequencedDocument>
    >(Prisma.sql`
      UPDATE public.document_sequences
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
}

@Controller('receivables')
class ReceivablesController {
  constructor(
    private readonly receiptPdfService: ReceiptPdfService,
    private readonly receivablesService: ReceivablesService,
  ) {}

  @Get()
  findAll() {
    return this.receivablesService.findAll();
  }

  @Post('initial-debts')
  createInitialDebt(@Body() dto: CreateInitialDebtDto) {
    return this.receivablesService.createInitialDebt(dto);
  }

  @Post(':id/payments')
  recordPayment(
    @Param('id') id: string,
    @Body() dto: CreateReceivablePaymentDto,
  ) {
    return this.receivablesService.recordPayment(id, dto);
  }

  @Get('payments/:paymentId/receipt/pdf')
  async renderReceipt(@Param('paymentId') paymentId: string) {
    const buffer = await this.receiptPdfService.renderPaymentReceipt(paymentId);

    return new StreamableFile(buffer, {
      disposition: `inline; filename="receivable-payment-${paymentId}.pdf"`,
      type: 'application/pdf',
    });
  }
}

@Module({
  controllers: [ReceivablesController],
  providers: [ReceivablesService, ReceiptPdfService],
})
export class ReceivablesModule {}
