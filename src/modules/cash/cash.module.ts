import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class OpenCashRegisterDto {
  @IsNumber()
  @Min(0)
  openingAmount!: number;

  @IsOptional()
  @IsDateString()
  openingDate?: string;
}

class CloseCashRegisterDto {
  @IsNumber()
  @Min(0)
  countedCashTotal!: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  closureDate?: string;
}

type CashSalesSummary = {
  cash_sales_total: Prisma.Decimal | number | null;
  non_cash_sales_total: Prisma.Decimal | number | null;
};

type ExpenseSummary = {
  expenses_total: Prisma.Decimal | number | null;
};

@Injectable()
class CashService {
  constructor(private readonly prisma: PrismaService) {}

  findRegisters() {
    return this.prisma.cashRegister.findMany({
      include: {
        closures: {
          orderBy: { closureDate: 'desc' },
          take: 1,
        },
        openings: {
          orderBy: { openingDate: 'desc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async openRegister(registerId: string, dto: OpenCashRegisterDto) {
    const openingDate = this.normalizeDay(dto.openingDate);

    return this.prisma.$transaction(async (transaction) => {
      const register = await transaction.cashRegister.findUnique({
        where: { id: registerId },
      });

      if (!register || !register.isActive) {
        throw new BadRequestException('La caja seleccionada no existe o esta inactiva.');
      }

      const existingOpening = await transaction.cashOpening.findUnique({
        where: {
          cashRegisterId_openingDate: {
            cashRegisterId: registerId,
            openingDate,
          },
        },
      });

      if (existingOpening) {
        throw new BadRequestException('La caja ya tiene apertura registrada para esa fecha.');
      }

      await transaction.cashOpening.create({
        data: {
          cashRegisterId: registerId,
          openingAmount: dto.openingAmount,
          openingDate,
        },
      });

      await transaction.auditLog.create({
        data: {
          action: 'open_register',
          entityName: 'cash_register',
          entityId: registerId,
          metadata: {
            openingAmount: dto.openingAmount,
            openingDate,
          },
          module: 'cash',
        },
      });

      return transaction.cashRegister.findUniqueOrThrow({
        where: { id: registerId },
        include: {
          closures: {
            orderBy: { closureDate: 'desc' },
            take: 1,
          },
          openings: {
            orderBy: { openingDate: 'desc' },
            take: 1,
          },
        },
      });
    });
  }

  async closeRegister(registerId: string, dto: CloseCashRegisterDto) {
    const closureDate = this.normalizeDay(dto.closureDate);

    return this.prisma.$transaction(async (transaction) => {
      const register = await transaction.cashRegister.findUnique({
        where: { id: registerId },
      });

      if (!register || !register.isActive) {
        throw new BadRequestException('La caja seleccionada no existe o esta inactiva.');
      }

      const opening = await transaction.cashOpening.findUnique({
        where: {
          cashRegisterId_openingDate: {
            cashRegisterId: registerId,
            openingDate: closureDate,
          },
        },
      });

      if (!opening) {
        throw new BadRequestException(
          'No existe una apertura de caja registrada para esa fecha.',
        );
      }

      const existingClosure = await transaction.cashClosure.findUnique({
        where: {
          cashRegisterId_closureDate: {
            cashRegisterId: registerId,
            closureDate,
          },
        },
      });

      if (existingClosure) {
        throw new BadRequestException('La caja ya tiene un cierre registrado para esa fecha.');
      }

      const [salesRows, expenseRows] = await Promise.all([
        transaction.$queryRaw<Array<CashSalesSummary>>(Prisma.sql`
          SELECT
            COALESCE(SUM(CASE WHEN ip.payment_method = 'CASH' THEN ip.amount ELSE 0 END), 0) AS cash_sales_total,
            COALESCE(SUM(CASE WHEN ip.payment_method <> 'CASH' THEN ip.amount ELSE 0 END), 0) AS non_cash_sales_total
          FROM lua_store.invoices i
          INNER JOIN lua_store.invoice_payments ip
                  ON ip.invoice_id = i.id
         WHERE i.cash_register_id = ${registerId}::uuid
           AND i.issue_date::date = ${closureDate}::date
           AND i.status <> 'CANCELLED'::lua_store.invoice_status
        `),
        transaction.$queryRaw<Array<ExpenseSummary>>(Prisma.sql`
          SELECT COALESCE(SUM(amount), 0) AS expenses_total
            FROM lua_store.cash_expenses
           WHERE cash_register_id = ${registerId}::uuid
             AND expense_date = ${closureDate}::date
        `),
      ]);

      const cashSalesTotal = Number(salesRows[0]?.cash_sales_total ?? 0);
      const nonCashSalesTotal = Number(salesRows[0]?.non_cash_sales_total ?? 0);
      const expensesTotal = Number(expenseRows[0]?.expenses_total ?? 0);
      const openingAmount = Number(opening.openingAmount);
      const expectedCashTotal = Number((openingAmount + cashSalesTotal - expensesTotal).toFixed(2));
      const differenceAmount = Number((dto.countedCashTotal - expectedCashTotal).toFixed(2));

      await transaction.cashClosure.create({
        data: {
          cashRegisterId: registerId,
          cashSalesTotal,
          closureDate,
          countedCashTotal: dto.countedCashTotal,
          differenceAmount,
          expectedCashTotal,
          expensesTotal,
          nonCashSalesTotal,
          notes: dto.notes?.trim() || undefined,
          openingAmount,
        },
      });

      await transaction.auditLog.create({
        data: {
          action: 'close_register',
          entityName: 'cash_register',
          entityId: registerId,
          metadata: {
            cashSalesTotal,
            closureDate,
            countedCashTotal: dto.countedCashTotal,
            differenceAmount,
            expectedCashTotal,
            expensesTotal,
            nonCashSalesTotal,
          },
          module: 'cash',
        },
      });

      return transaction.cashRegister.findUniqueOrThrow({
        where: { id: registerId },
        include: {
          closures: {
            orderBy: { closureDate: 'desc' },
            take: 1,
          },
          openings: {
            orderBy: { openingDate: 'desc' },
            take: 1,
          },
        },
      });
    });
  }

  private normalizeDay(value?: string) {
    const day = value ? new Date(value) : new Date();
    day.setHours(0, 0, 0, 0);
    return day;
  }
}

@Controller('cash')
class CashController {
  constructor(private readonly cashService: CashService) {}

  @Get('registers')
  findRegisters() {
    return this.cashService.findRegisters();
  }

  @Post('registers/:id/open')
  openRegister(@Param('id') id: string, @Body() dto: OpenCashRegisterDto) {
    return this.cashService.openRegister(id, dto);
  }

  @Post('registers/:id/close')
  closeRegister(@Param('id') id: string, @Body() dto: CloseCashRegisterDto) {
    return this.cashService.closeRegister(id, dto);
  }
}

@Module({
  controllers: [CashController],
  providers: [CashService],
})
export class CashModule {}
