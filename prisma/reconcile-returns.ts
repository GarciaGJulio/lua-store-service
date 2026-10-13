import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  allocateReturnedLines,
  settleReturn,
} from '../src/modules/returns/return-accounting';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
// Dry run by default. Stock, payment history and closed cash sessions are never changed.
async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { returns: { some: { operationId: null } } },
    select: { id: true },
  });
  for (const { id } of invoices) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id },
        include: {
          lines: true,
          returns: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          receivable: { include: { payments: true } },
        },
      });
      const legacy = invoice.returns.filter((row) => !row.operationId);
      if (!legacy.length) return;
      const debt = invoice.receivable;
      if (debt)
        await tx.$queryRaw`SELECT id FROM accounts_receivable WHERE id = ${debt.id}::uuid FOR UPDATE`;
      const amount = Number(
        legacy
          .reduce((sum, row) => sum + Number(row.refundedTotal), 0)
          .toFixed(2),
      );
      const allAmount = Number(
        invoice.returns
          .reduce((sum, row) => sum + Number(row.refundedTotal), 0)
          .toFixed(2),
      );
      const quantities = allocateReturnedLines(invoice.lines, invoice.returns);
      const soldByVariant = new Map<string, number>();
      const returnedByVariant = new Map<string, number>();
      invoice.lines.forEach((line) =>
        soldByVariant.set(
          line.variantId,
          (soldByVariant.get(line.variantId) ?? 0) + line.quantity,
        ),
      );
      invoice.returns.forEach((row) =>
        returnedByVariant.set(
          row.variantId,
          (returnedByVariant.get(row.variantId) ?? 0) + row.quantity,
        ),
      );
      const invalid =
        invoice.status === 'VOIDED' ||
        allAmount > Number(invoice.total) ||
        [...returnedByVariant].some(
          ([variant, quantity]) => quantity > (soldByVariant.get(variant) ?? 0),
        ) ||
        (debt &&
          (Math.abs(
            debt.payments.reduce((sum, row) => sum + Number(row.amount), 0) -
              Number(debt.paidAmount),
          ) > 0.01 ||
            Math.abs(
              Number(debt.originalAmount) -
                Number(debt.paidAmount) -
                Number(debt.returnedAmount) -
                Number(debt.balance),
            ) > 0.01));
      if (invalid) {
        console.log(
          JSON.stringify({
            invoice: invoice.sequential,
            result: 'REQUIERE_REVISION',
            reason: 'Anulacion, cantidades o saldos inconsistentes.',
          }),
        );
        return;
      }
      const settlement = settleReturn(amount, Number(debt?.balance ?? 0));
      const returnStatus = invoice.lines.every(
        (line) => quantities.get(line.id)!.quantity >= line.quantity,
      )
        ? 'TOTAL'
        : 'PARTIAL';
      console.log(
        JSON.stringify({
          invoice: invoice.sequential,
          mode: apply ? 'APLICADO' : 'SIMULACION',
          ...settlement,
          returnStatus,
          refundRequiresReview: settlement.refundAmount > 0,
        }),
      );
      if (!apply) return;
      const operation = await tx.returnOperation.create({
        data: {
          id: randomUUID(),
          invoiceId: id,
          requestHash: 'legacy-reconciliation',
          debtReduction: settlement.debtReduction,
          refundAmount: settlement.refundAmount,
          requiresReview: settlement.refundAmount > 0,
        },
      });
      await tx.storeReturn.updateMany({
        where: { id: { in: legacy.map((row) => row.id) } },
        data: { operationId: operation.id },
      });
      await tx.invoice.update({
        where: { id },
        data: { returnedTotal: allAmount, returnStatus },
      });
      if (debt)
        await tx.receivable.update({
          where: { id: debt.id },
          data: {
            returnedAmount: { increment: settlement.debtReduction },
            balance: settlement.balance,
            status:
              settlement.balance === 0
                ? 'PAID'
                : Number(debt.paidAmount) > 0
                  ? 'PARTIAL'
                  : 'OPEN',
          },
        });
      await tx.auditLog.create({
        data: {
          action: 'reconcile_legacy_returns',
          entityName: 'return_operation',
          entityId: operation.id,
          module: 'returns',
          metadata: {
            invoiceId: id,
            ...settlement,
            returnIds: legacy.map((row) => row.id),
            requiresReview: operation.requiresReview,
          },
        },
      });
    });
  }
  const orphanCount = await prisma.storeReturn.count({
    where: { invoiceId: null },
  });
  if (orphanCount)
    console.log(JSON.stringify({ orphanReturnsRequiringReview: orphanCount }));
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
