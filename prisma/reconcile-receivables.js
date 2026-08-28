const { InvoiceStatus, PrismaClient, ReceivableStatus } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const receivables = await prisma.receivable.findMany({
    include: { payments: { orderBy: { paidAt: 'desc' } } },
  });

  await prisma.$transaction(async (tx) => {
    for (const receivable of receivables) {
      const originalAmount = Number(receivable.originalAmount);
      const registeredTotal = Number(
        receivable.payments.reduce((sum, payment) => sum + Number(payment.amount), 0).toFixed(2),
      );

      if (registeredTotal > originalAmount) {
        console.warn(`Receivable ${receivable.id} exceeds its original amount; skipped.`);
        continue;
      }

      const balance = Number((originalAmount - registeredTotal).toFixed(2));
      const status =
        balance === 0
          ? ReceivableStatus.PAID
          : registeredTotal > 0
            ? ReceivableStatus.PARTIAL
            : ReceivableStatus.OPEN;
      const lastPaymentAt = receivable.payments[0]?.paidAt ?? receivable.lastPaymentAt;

      await tx.receivable.update({
        where: { id: receivable.id },
        data: {
          balance,
          lastPaymentAt,
          paidAmount: registeredTotal,
          paidAt: balance === 0 ? lastPaymentAt : null,
          status,
        },
      });

      if (receivable.invoiceId) {
        await tx.invoice.update({
          where: { id: receivable.invoiceId },
          data: {
            status:
              status === ReceivableStatus.PAID
                ? InvoiceStatus.CREDIT_PAID
                : status === ReceivableStatus.PARTIAL
                  ? InvoiceStatus.CREDIT_PARTIAL
                  : InvoiceStatus.CREDIT_PENDING,
          },
        });
      }
    }
  });

  console.log('Receivables reconciliation completed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
