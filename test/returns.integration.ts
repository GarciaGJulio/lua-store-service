/** Run only against a disposable copy using RETURNS_TEST_DATABASE_URL. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service';
import { ReturnsService } from '../src/modules/returns/returns.module';
import { CashService } from '../src/modules/cash/cash.module';
import { ReceivablesService } from '../src/modules/receivables/receivables.module';
import { InvoicesService } from '../src/modules/invoices/invoices.module';
import { AnalyticsService } from '../src/modules/analytics/analytics.module';
import { getEcuadorBusinessDayKey } from '../src/modules/cash/business-time';

const url = process.env.RETURNS_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes('returns_test'))
  throw new Error('Se requiere una base aislada returns_test.');
process.env.DATABASE_URL = url;
const prisma = new PrismaService();
const cash = new CashService(prisma);
const returns = new ReturnsService(cash, prisma);
const receivables = new ReceivablesService(prisma);
const invoices = new InvoicesService(cash, prisma);
let checks = 0;
function check(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected);
  checks++;
}
async function main() {
  const register = await prisma.cashRegister.create({
    data: { name: `TEST RETURNS ${randomUUID()}` },
  });
  await cash.openRegister(register.id, { openingAmount: 500 });
  const variant = await prisma.variant.findFirstOrThrow({
    include: { barcode: true, product: true },
  });
  await prisma.variant.update({
    where: { id: variant.id },
    data: { stock: { increment: 100 } },
  });
  const customer = await prisma.customer.findFirstOrThrow();
  async function sale(credit = true, total = 100, quantity = 1) {
    return prisma.invoice.create({
      data: {
        sequential: `TEST-${randomUUID().slice(0, 20)}`,
        customerId: customer.id,
        cashRegisterId: register.id,
        customerNameSnapshot: customer.fullName,
        customerIdentificationSnapshot: customer.identificationNumber ?? 'TEST',
        isFinalConsumer: false,
        subtotal: total,
        taxTotal: 0,
        total,
        status: credit ? 'CREDIT_PENDING' : 'ISSUED',
        lines: {
          create: {
            productId: variant.productId,
            variantId: variant.id,
            barcode: variant.barcode.code,
            description: 'Integration test',
            quantity,
            unitPrice: total / quantity,
            lineSubtotal: total,
            lineTax: 0,
            lineTotal: total,
            taxRate: 0,
          },
        },
        payments: {
          create: { amount: total, method: credit ? 'CREDITO_MONSE' : 'CASH' },
        },
        ...(credit
          ? {
              receivable: {
                create: {
                  customerId: customer.id,
                  originalAmount: total,
                  balance: total,
                },
              },
            }
          : {}),
      },
      include: { lines: true, receivable: true },
    });
  }
  function request(
    invoice: Awaited<ReturnType<typeof sale>>,
    quantity = 1,
    stock = true,
  ) {
    return {
      requestId: randomUUID(),
      invoiceId: invoice.id,
      cashRegisterId: register.id,
      items: [
        {
          invoiceLineId: invoice.lines[0].id,
          quantity,
          reason: 'Test',
          returnToStock: stock,
        },
      ],
    };
  }
  // Total credit return: debt disappears, document survives, no cash leaves.
  const full = await sale();
  const stockBefore = (
    await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } })
  ).stock;
  const cashBefore = (await cash.getRegisterSummary(register.id)).summary
    .expectedCashTotal;
  const fullRequest = request(full);
  const fullResult = await returns.create(fullRequest);
  check(fullResult.settlement.debtReduction, 100);
  check(fullResult.settlement.refundAmount, 0);
  check(
    Number(
      (
        await prisma.receivable.findUniqueOrThrow({
          where: { id: full.receivable!.id },
        })
      ).balance,
    ),
    0,
  );
  check(
    (await prisma.invoice.findUniqueOrThrow({ where: { id: full.id } }))
      .returnStatus,
    'TOTAL',
  );
  check(
    (await cash.getRegisterSummary(register.id)).summary.expectedCashTotal,
    cashBefore,
  );
  await returns.create(fullRequest);
  check(
    (await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stock,
    stockBefore + 1,
  );
  await assert.rejects(() => returns.create(request(full)));
  await assert.rejects(() =>
    invoices.voidInvoice(full.id, { reason: 'Must not restock' }),
  );

  // Partial, paid credit: first reduce debt, refund only the excess.
  const partial = await sale(true, 100, 10);
  await receivables.recordPayment(partial.receivable!.id, {
    amount: 80,
    method: 'CASH',
  });
  const beforePending = (await cash.getRegisterSummary(register.id)).summary
    .expectedCashTotal;
  const partialResult = await returns.create(request(partial, 3, false));
  check(partialResult.settlement.debtReduction, 20);
  check(partialResult.settlement.refundAmount, 10);
  check(
    (await cash.getRegisterSummary(register.id)).summary.expectedCashTotal,
    beforePending,
  );
  const beforeStock = (
    await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } })
  ).stock;
  await Promise.all([
    returns.payRefund(partialResult.settlement.id, register.id),
    returns.payRefund(partialResult.settlement.id, register.id),
  ]);
  check(
    (await cash.getRegisterSummary(register.id)).summary.expectedCashTotal,
    beforePending - 10,
  );
  check(
    (await prisma.variant.findUniqueOrThrow({ where: { id: variant.id } }))
      .stock,
    beforeStock,
  );
  const detail = await invoices.findSaleById(partial.id);
  check(detail.netTotal, 70);
  check(detail.lines[0].returnedQuantity, 3);
  check(detail.receivable?.paidAmount, 80);
  check(detail.receivable?.returnedAmount, 20);

  // A subsequent payment must not restore the debt adjustment.
  const stillOwing = await sale(true, 100, 10);
  await returns.create(request(stillOwing, 3));
  await receivables.recordPayment(stillOwing.receivable!.id, {
    amount: 70,
    method: 'CASH',
  });
  check(
    Number(
      (
        await prisma.receivable.findUniqueOrThrow({
          where: { id: stillOwing.receivable!.id },
        })
      ).balance,
    ),
    0,
  );
  await assert.rejects(() =>
    receivables.recordPayment(stillOwing.receivable!.id, {
      amount: 1,
      method: 'CASH',
    }),
  );

  // Two concurrent requests cannot return the same final unit twice.
  const concurrent = await sale();
  const results = await Promise.allSettled([
    returns.create(request(concurrent)),
    returns.create(request(concurrent)),
  ]);
  check(results.filter((result) => result.status === 'fulfilled').length, 1);

  // Same request is idempotent even when sent simultaneously.
  const retried = await sale();
  const same = request(retried);
  await Promise.all([returns.create(same), returns.create(same)]);
  check(
    await prisma.storeReturn.count({ where: { invoiceId: retried.id } }),
    1,
  );

  // Cash sale is kept in receipts, then refunded once, not removed twice.
  const paid = await sale(false, 25);
  const paidReturn = await returns.create(request(paid));
  check(paidReturn.settlement.refundAmount, 25);
  const originalCash = (await cash.getRegisterSummary(register.id)).summary
    .expectedCashTotal;
  await returns.payRefund(paidReturn.settlement.id, register.id);
  check(
    (await cash.getRegisterSummary(register.id)).summary.expectedCashTotal,
    originalCash - 25,
  );
  const salesPage = await invoices.findSalesPage({
    page: 1,
    limit: 100,
    search: paid.sequential,
  });
  check(salesPage.summary.totalAmount, 0);
  check(salesPage.summary.totalSales, 0);
  check(salesPage.items[0].total, 25);

  // Accounting by actual movement date: full cash return contributes zero net sales.
  const analytics = new AnalyticsService(prisma);
  const today = getEcuadorBusinessDayKey();
  const beforeDashboard = await analytics.getDashboard({
    dateFrom: today,
    dateTo: today,
  });
  const reportSale = await sale(false, 30);
  await returns.create(request(reportSale));
  const afterDashboard = await analytics.getDashboard({
    dateFrom: today,
    dateTo: today,
  });
  check(afterDashboard.overview.netSales, beforeDashboard.overview.netSales);
  check(
    afterDashboard.overview.invoicesCount,
    beforeDashboard.overview.invoicesCount,
  );
  check(
    afterDashboard.overview.voidedInvoicesCount,
    beforeDashboard.overview.voidedInvoicesCount + 1,
  );
  check(afterDashboard.overview.unitsSold, beforeDashboard.overview.unitsSold);
  check(
    afterDashboard.inventory.topProductsByRevenue,
    beforeDashboard.inventory.topProductsByRevenue,
  );

  // Another register can settle a pending refund; the sale register is unaffected.
  const payoutRegister = await prisma.cashRegister.create({
    data: { name: `TEST PAYOUT ${randomUUID()}` },
  });
  await cash.openRegister(payoutRegister.id, { openingAmount: 100 });
  const pendingOperation = await prisma.returnOperation.findFirstOrThrow({
    where: { invoiceId: reportSale.id },
  });
  const saleRegisterBefore = (await cash.getRegisterSummary(register.id))
    .summary.expectedCashTotal;
  const payoutBefore = (await cash.getRegisterSummary(payoutRegister.id))
    .summary.expectedCashTotal;
  await returns.payRefund(pendingOperation.id, payoutRegister.id);
  check(
    (await cash.getRegisterSummary(register.id)).summary.expectedCashTotal,
    saleRegisterBefore,
  );
  check(
    (await cash.getRegisterSummary(payoutRegister.id)).summary
      .expectedCashTotal,
    payoutBefore - 30,
  );

  // Invalid item fails the entire operation without financial or inventory effects.
  const rollbackSale = await sale();
  const rollback = request(rollbackSale);
  rollback.items.push({
    invoiceLineId: randomUUID(),
    quantity: 1,
    reason: 'Invalid',
    returnToStock: true,
  });
  await assert.rejects(() => returns.create(rollback));
  check(
    await prisma.returnOperation.count({
      where: { invoiceId: rollbackSale.id },
    }),
    0,
  );
  check(
    Number(
      (
        await prisma.receivable.findUniqueOrThrow({
          where: { id: rollbackSale.receivable!.id },
        })
      ).balance,
    ),
    100,
  );

  // Close without differences and retain the refund amount in the snapshot.
  const summary = await cash.getRegisterSummary(register.id);
  await cash.closeRegister(register.id, {
    countedCashTotal: summary.summary.expectedCashTotal,
    countedBankTotal:
      summary.summary.transferSalesTotal + summary.summary.deUnaSalesTotal,
    nextDayOpeningAmount: 0,
  });
  const closed = await cash.getRegisterSummary(register.id);
  check(Number(closed.latestClosure?.differenceAmount), 0);
  check(Number(closed.latestClosure?.totalDifferenceAmount), 0);
  check(closed.summary.returnsTotal, 35);
  const period = await cash.getPeriodReport(today, today);
  check(
    period.closures.find((row) => row.id === closed.latestClosure?.id)
      ?.refundsTotal,
    35,
  );
  check(
    period.refunds.find((row) => row.id === pendingOperation.id)?.amount,
    30,
  );
  await assert.rejects(() =>
    returns.payRefund(paidReturn.settlement.id, register.id),
  );
  console.log(
    `Integration: ${checks} assertions passed; debt, stock, retries, refund and cash closure verified.`,
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
