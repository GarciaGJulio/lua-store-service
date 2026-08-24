import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsDateString, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '@/common/dto/pagination-query.dto';
import { PrismaService } from '@/database/prisma.service';

class FindPaymentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

class CreatePaymentDto {
  @IsDateString()
  paymentDate!: string;

  @IsString()
  @MaxLength(200)
  detail!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

class UpdatePaymentDto {
  @IsDateString()
  paymentDate!: string;

  @IsString()
  @MaxLength(200)
  detail!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

const EDITABLE_WINDOW_DAYS = 15;

@Injectable()
class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(query: FindPaymentsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 15;
    const where = this.buildWhere(query);

    const [items, totalItems, aggregate] = await this.prisma.$transaction([
      this.prisma.storePayment.findMany({
        orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        where,
      }),
      this.prisma.storePayment.count({ where }),
      this.prisma.storePayment.aggregate({
        _sum: { amount: true },
        where,
      }),
    ]);

    return {
      items: items.map((payment) => this.mapPayment(payment)),
      meta: {
        limit,
        page,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
      },
      summary: {
        totalAmount: Number(aggregate._sum.amount ?? 0),
        totalPayments: totalItems,
      },
    };
  }

  async create(dto: CreatePaymentDto) {
    const payment = await this.prisma.storePayment.create({
      data: {
        amount: dto.amount,
        detail: dto.detail.trim(),
        paymentDate: this.normalizeDay(dto.paymentDate),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'create_payment',
        entityId: payment.id,
        entityName: 'store_payment',
        metadata: {
          amount: dto.amount,
          detail: dto.detail.trim(),
          paymentDate: payment.paymentDate,
        },
        module: 'payments',
      },
    });

    return this.mapPayment(payment);
  }

  async update(paymentId: string, dto: UpdatePaymentDto) {
    const payment = await this.prisma.storePayment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new BadRequestException('El gasto seleccionado no existe.');
    }

    this.assertPaymentEditable(payment.createdAt);

    const updatedPayment = await this.prisma.storePayment.update({
      data: {
        amount: dto.amount,
        detail: dto.detail.trim(),
        paymentDate: this.normalizeDay(dto.paymentDate),
      },
      where: { id: paymentId },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'update_payment',
        entityId: paymentId,
        entityName: 'store_payment',
        metadata: {
          amount: dto.amount,
          detail: dto.detail.trim(),
          paymentDate: updatedPayment.paymentDate,
        },
        module: 'payments',
      },
    });

    return this.mapPayment(updatedPayment);
  }

  async remove(paymentId: string) {
    const payment = await this.prisma.storePayment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new BadRequestException('El gasto seleccionado no existe.');
    }

    this.assertPaymentEditable(payment.createdAt);

    await this.prisma.storePayment.delete({
      where: { id: paymentId },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'delete_payment',
        entityId: paymentId,
        entityName: 'store_payment',
        metadata: {
          amount: payment.amount,
          detail: payment.detail,
          paymentDate: payment.paymentDate,
        },
        module: 'payments',
      },
    });

    return { success: true };
  }

  private buildWhere(query: FindPaymentsQueryDto) {
    const where: {
      paymentDate?: {
        gte?: Date;
        lte?: Date;
      };
    } = {};

    if (query.dateFrom || query.dateTo) {
      where.paymentDate = {};

      if (query.dateFrom) {
        where.paymentDate.gte = this.normalizeDay(query.dateFrom);
      }

      if (query.dateTo) {
        where.paymentDate.lte = this.normalizeDay(query.dateTo);
      }
    }

    return where;
  }

  private mapPayment(payment: {
    amount: unknown;
    createdAt: Date;
    detail: string;
    id: string;
    paymentDate: Date;
    updatedAt: Date;
  }) {
    return {
      amount: Number(payment.amount),
      canManage: this.isPaymentEditable(payment.createdAt),
      createdAt: payment.createdAt,
      detail: payment.detail,
      id: payment.id,
      paymentDate: payment.paymentDate,
      updatedAt: payment.updatedAt,
    };
  }

  private normalizeDay(value: string | Date) {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  }

  private assertPaymentEditable(createdAt: Date) {
    if (!this.isPaymentEditable(createdAt)) {
      throw new BadRequestException(
        'Solo puedes editar o eliminar gastos creados dentro de los ultimos 15 dias.',
      );
    }
  }

  private isPaymentEditable(createdAt: Date) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - EDITABLE_WINDOW_DAYS);
    return createdAt.getTime() >= threshold.getTime();
  }
}

@Controller('expenses')
class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  findPage(@Query() query: FindPaymentsQueryDto) {
    return this.paymentsService.findPage(query);
  }

  @Post()
  create(@Body() dto: CreatePaymentDto) {
    return this.paymentsService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePaymentDto) {
    return this.paymentsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paymentsService.remove(id);
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
