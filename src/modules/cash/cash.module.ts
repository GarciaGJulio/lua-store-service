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
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsDateString, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class OpenCashRegisterDto {
  @IsNumber()
  @Min(0)
  openingAmount!: number;

  @IsOptional()
  @IsDateString()
  openingDate?: string;
}

class CreateCashExpenseDto {
  @IsString()
  @MaxLength(200)
  detail!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

class UpdateCashExpenseDto {
  @IsString()
  @MaxLength(200)
  detail!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

class CloseCashRegisterDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  countedCashTotal?: number;

  @IsNumber()
  @Min(0)
  nextDayOpeningAmount!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

type InvoiceSummaryRow = {
  cash_sales_total: Prisma.Decimal | number | null;
  credit_sales_total: Prisma.Decimal | number | null;
  de_una_sales_total: Prisma.Decimal | number | null;
  non_cash_sales_total: Prisma.Decimal | number | null;
  transfer_sales_total: Prisma.Decimal | number | null;
};

type ReceivableCollectionSummaryRow = {
  receivable_collections_total: Prisma.Decimal | number | null;
};

type ExpenseSummaryRow = {
  expenses_total: Prisma.Decimal | number | null;
};

type ReturnSummaryRow = {
  returns_total: Prisma.Decimal | number | null;
};

type CashRegisterWithLatestMoves = Prisma.CashRegisterGetPayload<{
  include: {
    closures: {
      orderBy: { createdAt: 'desc' };
      take: 1;
    };
    openings: {
      orderBy: { createdAt: 'desc' };
      take: 1;
    };
  };
}>;

type CashSessionWindow = {
  closure: CashRegisterWithLatestMoves['closures'][number] | null;
  endAt: Date | null;
  isActive: boolean;
  opening: CashRegisterWithLatestMoves['openings'][number];
  operatingDate: Date;
  startAt: Date;
};

type CashSessionSummary = {
  cashSalesTotal: number;
  creditSalesTotal: number;
  deUnaSalesTotal: number;
  expectedCashTotal: number;
  expensesTotal: number;
  nonCashSalesTotal: number;
  openingAmount: number;
  receivableCollectionsTotal: number;
  returnsTotal: number;
  transferSalesTotal: number;
};

type RegisterState = {
  canInvoice: boolean;
  dayClosedToday: boolean;
  hasPendingClosure: boolean;
  isOpenToday: boolean;
  needsOpeningToday: boolean;
  openingSuggestionAmount: number;
  pendingOpeningDate: Date | null;
  warningMessage: string | null;
};

@Injectable()
export class CashService {
  constructor(private readonly prisma: PrismaService) {}

  async findRegisters() {
    const registers = await this.prisma.cashRegister.findMany({
      include: {
        closures: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        openings: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });

    return registers.map((register) => {
      const state = this.computeRegisterState(register);

      return {
        ...register,
        state,
      };
    });
  }

  async getRegisterSummary(
    registerId: string,
    transaction?: Prisma.TransactionClient,
  ) {
    const register = await this.getRegisterWithLatestMoves(registerId, transaction);
    const state = this.computeRegisterState(register);
    const latestOpening = register.openings[0] ?? null;
    const latestClosure = register.closures[0] ?? null;
    const session = this.getLatestSessionWindow(register);
    const summary = session
      ? session.isActive
        ? await this.getSessionSummary(registerId, session, transaction)
        : this.getClosedSessionSummary(session)
      : this.getEmptyDailySummary();
    const expenses = session
      ? await this.getSessionExpenses(registerId, session, transaction)
      : [];
    const operatingDate = session?.operatingDate ?? null;

    return {
      expenses,
      latestClosure,
      latestOpening,
      register: {
        id: register.id,
        isActive: register.isActive,
        name: register.name,
      },
      state,
      summary: {
        ...summary,
        operatingDate: operatingDate?.toISOString() ?? null,
      },
    };
  }

  async openRegister(registerId: string, dto: OpenCashRegisterDto) {
    const openingDate = this.normalizeDay(dto.openingDate);

    return this.prisma.$transaction(async (transaction) => {
      const register = await this.getRegisterWithLatestMoves(registerId, transaction);
      const state = this.computeRegisterState(register);

      if (!register.isActive) {
        throw new BadRequestException('La caja seleccionada no existe o esta inactiva.');
      }

      if (state.hasPendingClosure) {
        if (state.isOpenToday) {
          throw new BadRequestException('La caja ya tiene un turno abierto en este momento.');
        }

        throw new BadRequestException(
          `Existe un turno pendiente de cierre correspondiente al ${this.formatDateLabel(
            state.pendingOpeningDate,
          )}. Debes cerrarla antes de abrir una nueva jornada.`,
        );
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
          entityId: registerId,
          entityName: 'cash_register',
          metadata: {
            openingAmount: dto.openingAmount,
            openingDate,
          },
          module: 'cash',
        },
      });

      return this.findRegisterSnapshot(registerId, transaction);
    });
  }

  async createExpense(registerId: string, dto: CreateCashExpenseDto) {
    return this.prisma.$transaction(async (transaction) => {
      const register = await this.getRegisterWithLatestMoves(registerId, transaction);
      const state = this.computeRegisterState(register);
      const session = this.getLatestSessionWindow(register);

      if (!state.hasPendingClosure || !state.pendingOpeningDate || !session?.isActive) {
        throw new BadRequestException(
          'Debes tener un turno de caja pendiente de cierre para registrar egresos.',
        );
      }

      await transaction.cashExpense.create({
        data: {
          amount: dto.amount,
          cashRegisterId: registerId,
          detail: dto.detail.trim(),
          expenseDate: session.operatingDate,
        },
      });

      await transaction.auditLog.create({
        data: {
          action: 'create_expense',
          entityId: registerId,
          entityName: 'cash_register',
          metadata: {
            amount: dto.amount,
            detail: dto.detail.trim(),
            expenseDate: session.operatingDate,
          },
          module: 'cash',
        },
      });

      return this.getRegisterSummary(registerId, transaction);
    });
  }

  async updateExpense(
    registerId: string,
    expenseId: string,
    dto: UpdateCashExpenseDto,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const register = await this.getRegisterWithLatestMoves(registerId, transaction);
      const state = this.computeRegisterState(register);
      const session = this.getLatestSessionWindow(register);

      if (!state.hasPendingClosure || !state.pendingOpeningDate || !session?.isActive) {
        throw new BadRequestException(
          'No existe una jornada activa o pendiente para editar egresos.',
        );
      }

      const expense = await transaction.cashExpense.findUnique({
        where: { id: expenseId },
      });

      if (!expense || expense.cashRegisterId !== registerId) {
        throw new BadRequestException('El egreso seleccionado no existe para esta caja.');
      }

      if (!this.isExpenseInSession(expense.createdAt, session)) {
        throw new BadRequestException(
          'Solo puedes editar egresos del turno de caja actualmente abierto.',
        );
      }

      await transaction.cashExpense.update({
        data: {
          amount: dto.amount,
          detail: dto.detail.trim(),
        },
        where: { id: expenseId },
      });

      return this.getRegisterSummary(registerId, transaction);
    });
  }

  async deleteExpense(registerId: string, expenseId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const register = await this.getRegisterWithLatestMoves(registerId, transaction);
      const state = this.computeRegisterState(register);
      const session = this.getLatestSessionWindow(register);

      if (!state.hasPendingClosure || !state.pendingOpeningDate || !session?.isActive) {
        throw new BadRequestException(
          'No existe una jornada activa o pendiente para eliminar egresos.',
        );
      }

      const expense = await transaction.cashExpense.findUnique({
        where: { id: expenseId },
      });

      if (!expense || expense.cashRegisterId !== registerId) {
        throw new BadRequestException('El egreso seleccionado no existe para esta caja.');
      }

      if (!this.isExpenseInSession(expense.createdAt, session)) {
        throw new BadRequestException(
          'Solo puedes eliminar egresos del turno de caja actualmente abierto.',
        );
      }

      await transaction.cashExpense.delete({
        where: { id: expenseId },
      });

      return this.getRegisterSummary(registerId, transaction);
    });
  }

  async closeRegister(registerId: string, dto: CloseCashRegisterDto) {
    return this.prisma.$transaction(async (transaction) => {
      const register = await this.getRegisterWithLatestMoves(registerId, transaction);
      const state = this.computeRegisterState(register);
      const session = this.getLatestSessionWindow(register);

      if (!register.isActive) {
        throw new BadRequestException('La caja seleccionada no existe o esta inactiva.');
      }

      if (!state.hasPendingClosure || !state.pendingOpeningDate || !session?.isActive) {
        throw new BadRequestException('No existe una caja abierta pendiente de cierre.');
      }

      const summary = await this.getSessionSummary(registerId, session, transaction);
      const expectedCashTotal = Number(summary.expectedCashTotal.toFixed(2));
      const countedCashTotal = Number(
        (dto.countedCashTotal ?? expectedCashTotal).toFixed(2),
      );

      if (dto.nextDayOpeningAmount > countedCashTotal) {
        throw new BadRequestException(
          'La proxima apertura no puede ser mayor al efectivo disponible en caja.',
        );
      }

      const differenceAmount = Number((countedCashTotal - expectedCashTotal).toFixed(2));
      const nextDayOpeningAmount = Number(dto.nextDayOpeningAmount.toFixed(2));
      const dailyCollectedTotal = Number(
        (
          countedCashTotal -
          nextDayOpeningAmount +
          summary.transferSalesTotal +
          summary.deUnaSalesTotal
        ).toFixed(2),
      );

      await transaction.cashClosure.create({
        data: {
          cashRegisterId: registerId,
          cashSalesTotal: summary.cashSalesTotal,
          closureDate: session.operatingDate,
          countedCashTotal,
          creditSalesTotal: summary.creditSalesTotal,
          dailyCollectedTotal,
          differenceAmount,
          expectedCashTotal,
          expensesTotal: summary.expensesTotal,
          nextDayOpeningAmount,
          nonCashSalesTotal: summary.nonCashSalesTotal,
          notes: dto.notes?.trim() || undefined,
          openingAmount: summary.openingAmount,
          receivableCollectionsTotal: summary.receivableCollectionsTotal,
        },
      });

      await transaction.auditLog.create({
        data: {
          action: 'close_register',
          entityId: registerId,
          entityName: 'cash_register',
          metadata: {
            cashSalesTotal: summary.cashSalesTotal,
            closureDate: session.operatingDate,
            countedCashTotal,
            creditSalesTotal: summary.creditSalesTotal,
            dailyCollectedTotal,
            differenceAmount,
            expensesTotal: summary.expensesTotal,
            expectedCashTotal,
            nextDayOpeningAmount,
            receivableCollectionsTotal: summary.receivableCollectionsTotal,
          },
          module: 'cash',
        },
      });

      return this.findRegisterSnapshot(registerId, transaction);
    });
  }

  async assertRegisterCanInvoice(registerId: string) {
    const register = await this.getRegisterWithLatestMoves(registerId);
    const state = this.computeRegisterState(register);

    if (!register.isActive) {
      throw new BadRequestException('La caja seleccionada no existe o esta inactiva.');
    }

    if (!state.canInvoice) {
      throw new BadRequestException(
        state.warningMessage ??
          'La caja seleccionada no tiene una apertura activa para facturar hoy.',
      );
    }

    return register;
  }

  private async findRegisterSnapshot(
    registerId: string,
    transaction: Prisma.TransactionClient,
  ) {
    const register = await this.getRegisterWithLatestMoves(registerId, transaction);
    return {
      ...register,
      state: this.computeRegisterState(register),
    };
  }

  private async getRegisterWithLatestMoves(
    registerId: string,
    transaction?: Prisma.TransactionClient,
  ) {
    const client = transaction ?? this.prisma;
    const register = await client.cashRegister.findUnique({
      include: {
        closures: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        openings: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      where: { id: registerId },
    });

    if (!register) {
      throw new BadRequestException('La caja seleccionada no existe.');
    }

    return register;
  }

  private computeRegisterState(register: CashRegisterWithLatestMoves): RegisterState {
    const session = this.getLatestSessionWindow(register);
    const latestOpening = session?.opening ?? register.openings[0] ?? null;
    const latestClosure = register.closures[0] ?? null;
    const latestOpeningDate = latestOpening?.openingDate ?? null;
    const latestClosureDate = latestClosure?.closureDate ?? null;
    const todayKey = this.getCurrentBusinessDayKey();
    const hasPendingClosure = Boolean(session?.isActive);
    const isOpenToday = Boolean(
      session?.isActive && latestOpeningDate && this.isSameDay(latestOpeningDate, todayKey),
    );
    const dayClosedToday = Boolean(
      !hasPendingClosure && latestClosureDate && this.isSameDay(latestClosureDate, todayKey),
    );
    const needsOpeningToday = !hasPendingClosure;
    const openingSuggestionAmount = Number(
      latestClosure?.nextDayOpeningAmount ?? latestOpening?.openingAmount ?? 0,
    );

    let warningMessage: string | null = null;

    if (
      hasPendingClosure &&
      latestOpeningDate &&
      !this.isSameDay(latestOpeningDate, todayKey)
    ) {
      warningMessage = `Hay un turno pendiente de cierre correspondiente al ${this.formatDateLabel(
        latestOpeningDate,
      )}.`;
    } else if (!isOpenToday) {
      warningMessage = 'Falta abrir un turno de caja para continuar.';
    }

    return {
      canInvoice: isOpenToday,
      dayClosedToday,
      hasPendingClosure,
      isOpenToday,
      needsOpeningToday,
      openingSuggestionAmount,
      pendingOpeningDate: session?.isActive ? latestOpeningDate : null,
      warningMessage,
    };
  }

  private async getSessionSummary(
    registerId: string,
    session: CashSessionWindow,
    transaction?: Prisma.TransactionClient,
  ): Promise<CashSessionSummary> {
    const client = transaction ?? this.prisma;
    const sessionFilters = this.getSessionRangeSql(session);
    const [invoiceRows, receivableCollectionRows, expenseRows, returnRows] = await Promise.all([
      client.$queryRaw<Array<InvoiceSummaryRow>>(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN ip.payment_method = 'CASH'::public.payment_method THEN ip.amount ELSE 0 END), 0) AS cash_sales_total,
          COALESCE(SUM(CASE WHEN ip.payment_method = 'CREDITO_MONSE'::public.payment_method THEN ip.amount ELSE 0 END), 0) AS credit_sales_total,
          COALESCE(SUM(CASE WHEN ip.payment_method = 'TRANSFER'::public.payment_method THEN ip.amount ELSE 0 END), 0) AS transfer_sales_total,
          COALESCE(SUM(CASE WHEN ip.payment_method = 'DE_UNA'::public.payment_method THEN ip.amount ELSE 0 END), 0) AS de_una_sales_total,
          COALESCE(SUM(CASE WHEN ip.payment_method NOT IN ('CASH'::public.payment_method, 'CREDITO_MONSE'::public.payment_method) THEN ip.amount ELSE 0 END), 0) AS non_cash_sales_total
            FROM public.invoices i
            INNER JOIN public.invoice_payments ip
                    ON ip.invoice_id = i.id
           WHERE i.cash_register_id = ${registerId}::uuid
             ${sessionFilters.invoiceRange}
             AND i.status <> 'CANCELLED'::public.invoice_status
      `),
      client.$queryRaw<Array<ReceivableCollectionSummaryRow>>(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN payment_method = 'CASH'::public.payment_method THEN amount ELSE 0 END), 0) AS receivable_collections_total
            FROM public.receivable_payments
           WHERE 1 = 1
             ${sessionFilters.receivableRange}
      `),
      client.$queryRaw<Array<ExpenseSummaryRow>>(Prisma.sql`
        SELECT COALESCE(SUM(amount), 0) AS expenses_total
          FROM public.cash_expenses
         WHERE cash_register_id = ${registerId}::uuid
           ${sessionFilters.expenseRange}
      `),
      client.$queryRaw<Array<ReturnSummaryRow>>(Prisma.sql`
        SELECT COALESCE(SUM(refunded_total), 0) AS returns_total
          FROM public.store_returns
         WHERE cash_register_id = ${registerId}::uuid
           ${sessionFilters.returnRange}
      `),
    ]);

    const openingAmount = Number(session.opening.openingAmount ?? 0);
    const cashSalesTotal = Number(invoiceRows[0]?.cash_sales_total ?? 0);
    const creditSalesTotal = Number(invoiceRows[0]?.credit_sales_total ?? 0);
    const transferSalesTotal = Number(invoiceRows[0]?.transfer_sales_total ?? 0);
    const deUnaSalesTotal = Number(invoiceRows[0]?.de_una_sales_total ?? 0);
    const nonCashSalesTotal = Number(invoiceRows[0]?.non_cash_sales_total ?? 0);
    const receivableCollectionsTotal = Number(
      receivableCollectionRows[0]?.receivable_collections_total ?? 0,
    );
    const expensesTotal = Number(expenseRows[0]?.expenses_total ?? 0);
    const returnsTotal = Number(returnRows[0]?.returns_total ?? 0);
    const expectedCashTotal = Number(
      (
        openingAmount +
        cashSalesTotal +
        receivableCollectionsTotal -
        expensesTotal -
        returnsTotal
      ).toFixed(2),
    );

    return {
      cashSalesTotal,
      creditSalesTotal,
      deUnaSalesTotal,
      expectedCashTotal,
      expensesTotal,
      nonCashSalesTotal,
      openingAmount,
      receivableCollectionsTotal,
      returnsTotal,
      transferSalesTotal,
    };
  }

  private getEmptyDailySummary() {
    return {
      cashSalesTotal: 0,
      creditSalesTotal: 0,
      deUnaSalesTotal: 0,
      expectedCashTotal: 0,
      expensesTotal: 0,
      nonCashSalesTotal: 0,
      openingAmount: 0,
      receivableCollectionsTotal: 0,
      returnsTotal: 0,
      transferSalesTotal: 0,
    };
  }

  private getClosedSessionSummary(session: CashSessionWindow): CashSessionSummary {
    return {
      cashSalesTotal: Number(session.closure?.cashSalesTotal ?? 0),
      creditSalesTotal: Number(session.closure?.creditSalesTotal ?? 0),
      deUnaSalesTotal: 0,
      expectedCashTotal: Number(session.closure?.expectedCashTotal ?? 0),
      expensesTotal: Number(session.closure?.expensesTotal ?? 0),
      nonCashSalesTotal: Number(session.closure?.nonCashSalesTotal ?? 0),
      openingAmount: Number(session.closure?.openingAmount ?? session.opening.openingAmount ?? 0),
      receivableCollectionsTotal: Number(session.closure?.receivableCollectionsTotal ?? 0),
      returnsTotal: 0,
      transferSalesTotal: 0,
    };
  }

  private getLatestSessionWindow(register: CashRegisterWithLatestMoves): CashSessionWindow | null {
    const latestOpening = register.openings[0] ?? null;
    const latestClosure = register.closures[0] ?? null;

    if (!latestOpening) {
      return null;
    }

    const isActive = Boolean(
      !latestClosure || latestOpening.createdAt.getTime() > latestClosure.createdAt.getTime(),
    );

    return {
      closure: latestClosure,
      endAt: isActive ? null : latestClosure?.createdAt ?? null,
      isActive,
      opening: latestOpening,
      operatingDate: latestOpening.openingDate,
      startAt: latestOpening.createdAt,
    };
  }

  private async getSessionExpenses(
    registerId: string,
    session: CashSessionWindow,
    transaction?: Prisma.TransactionClient,
  ) {
    const client = transaction ?? this.prisma;

    return client.cashExpense.findMany({
      orderBy: { createdAt: 'desc' },
      where: {
        cashRegisterId: registerId,
        createdAt: {
          gte: session.startAt,
          ...(session.endAt ? { lte: session.endAt } : {}),
        },
      },
    });
  }

  private isExpenseInSession(createdAt: Date, session: CashSessionWindow) {
    if (createdAt.getTime() < session.startAt.getTime()) {
      return false;
    }

    if (session.endAt && createdAt.getTime() > session.endAt.getTime()) {
      return false;
    }

    return true;
  }

  private getSessionRangeSql(session: CashSessionWindow) {
    return {
      expenseRange: session.endAt
        ? Prisma.sql`AND created_at >= ${session.startAt} AND created_at <= ${session.endAt}`
        : Prisma.sql`AND created_at >= ${session.startAt}`,
      invoiceRange: session.endAt
        ? Prisma.sql`AND i.issue_date >= ${session.startAt} AND i.issue_date <= ${session.endAt}`
        : Prisma.sql`AND i.issue_date >= ${session.startAt}`,
      receivableRange: session.endAt
        ? Prisma.sql`AND paid_at >= ${session.startAt} AND paid_at <= ${session.endAt}`
        : Prisma.sql`AND paid_at >= ${session.startAt}`,
      returnRange: session.endAt
        ? Prisma.sql`AND created_at >= ${session.startAt} AND created_at <= ${session.endAt}`
        : Prisma.sql`AND created_at >= ${session.startAt}`,
    };
  }

  private normalizeDay(value?: string | Date) {
    const dayKey = value ? this.getDateKey(value) : this.getCurrentBusinessDayKey();
    return new Date(`${dayKey}T00:00:00.000Z`);
  }

  private isSameDay(left: string | Date, right: string | Date) {
    return this.getDateKey(left) === this.getDateKey(right);
  }

  private formatDateLabel(value: Date | null) {
    if (!value) {
      return 'la jornada anterior';
    }

    const [year, month, day] = this.getDateKey(value).split('-');
    return `${day}/${month}/${year}`;
  }

  private getCurrentBusinessDayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getDateKey(value: string | Date) {
    if (typeof value === 'string') {
      return value.slice(0, 10);
    }

    return value.toISOString().slice(0, 10);
  }
}

@Controller('cash')
class CashController {
  constructor(private readonly cashService: CashService) {}

  @Get('registers')
  findRegisters() {
    return this.cashService.findRegisters();
  }

  @Get('registers/:id/summary')
  getRegisterSummary(@Param('id') id: string) {
    return this.cashService.getRegisterSummary(id);
  }

  @Post('registers/:id/open')
  openRegister(@Param('id') id: string, @Body() dto: OpenCashRegisterDto) {
    return this.cashService.openRegister(id, dto);
  }

  @Post('registers/:id/close')
  closeRegister(@Param('id') id: string, @Body() dto: CloseCashRegisterDto) {
    return this.cashService.closeRegister(id, dto);
  }

  @Post('registers/:id/expenses')
  createExpense(@Param('id') id: string, @Body() dto: CreateCashExpenseDto) {
    return this.cashService.createExpense(id, dto);
  }

  @Patch('registers/:id/expenses/:expenseId')
  updateExpense(
    @Param('id') id: string,
    @Param('expenseId') expenseId: string,
    @Body() dto: UpdateCashExpenseDto,
  ) {
    return this.cashService.updateExpense(id, expenseId, dto);
  }

  @Delete('registers/:id/expenses/:expenseId')
  deleteExpense(@Param('id') id: string, @Param('expenseId') expenseId: string) {
    return this.cashService.deleteExpense(id, expenseId);
  }
}

@Module({
  controllers: [CashController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
