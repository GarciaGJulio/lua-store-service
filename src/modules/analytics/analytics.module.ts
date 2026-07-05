import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { InvoiceStatus, ReceivableStatus } from '@prisma/client';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      customerCount,
      invoiceCountToday,
      activeCashRegisters,
      openReceivablesCount,
      productCount,
      receivablesBalance,
      salesToday,
    ] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.invoice.count({
        where: {
          issuedAt: { gte: today },
          status: { not: InvoiceStatus.VOIDED },
        },
      }),
      this.prisma.cashRegister.count({
        where: {
          isActive: true,
        },
      }),
      this.prisma.receivable.count({
        where: {
          status: {
            in: [ReceivableStatus.OPEN, ReceivableStatus.PARTIAL],
          },
        },
      }),
      this.prisma.product.count(),
      this.prisma.receivable.aggregate({
        _sum: { balance: true },
        where: {
          status: {
            in: [ReceivableStatus.OPEN, ReceivableStatus.PARTIAL],
          },
        },
      }),
      this.prisma.invoice.aggregate({
        _sum: { total: true },
        where: {
          issuedAt: { gte: today },
          status: { not: InvoiceStatus.VOIDED },
        },
      }),
    ]);

    return {
      cash: {
        activeRegisters: activeCashRegisters,
      },
      catalog: {
        customers: customerCount,
        products: productCount,
      },
      receivables: {
        openCount: openReceivablesCount,
        pendingBalance: receivablesBalance._sum.balance ?? 0,
      },
      sales: {
        invoiceCountToday,
        totalToday: salesToday._sum.total ?? 0,
      },
    };
  }
}

@Controller('analytics')
class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  getOverview() {
    return this.analyticsService.getOverview();
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
