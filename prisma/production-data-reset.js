const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const deleted = await prisma.$transaction(async (tx) => {
    const counts = {};

    counts.receivablePayments = (await tx.receivablePayment.deleteMany({})).count;
    counts.receivables = (await tx.receivable.deleteMany({})).count;
    counts.invoiceCancellations = (await tx.invoiceCancellation.deleteMany({})).count;
    counts.returns = (await tx.storeReturn.deleteMany({})).count;
    counts.invoicePayments = (await tx.invoicePayment.deleteMany({})).count;
    counts.invoiceLines = (await tx.invoiceLine.deleteMany({})).count;
    counts.invoices = (await tx.invoice.deleteMany({})).count;

    counts.cashClosures = (await tx.cashClosure.deleteMany({})).count;
    counts.cashExpenses = (await tx.cashExpense.deleteMany({})).count;
    counts.cashOpenings = (await tx.cashOpening.deleteMany({})).count;
    counts.storePayments = (await tx.storePayment.deleteMany({})).count;

    const variants = await tx.variant.findMany({ select: { barcodeId: true } });
    counts.variants = (await tx.variant.deleteMany({})).count;
    counts.barcodes = (
      await tx.barcode.deleteMany({
        where: { id: { in: variants.map((variant) => variant.barcodeId) } },
      })
    ).count;
    counts.products = (await tx.product.deleteMany({})).count;
    counts.customers = (await tx.customer.deleteMany({})).count;

    counts.files = (await tx.fileAsset.deleteMany({})).count;
    counts.auditLogs = (await tx.auditLog.deleteMany({})).count;

    await tx.documentSequence.updateMany({
      data: { currentValue: 0, updatedAt: new Date() },
    });

    return counts;
  });

  console.log('Production operational data reset completed.', deleted);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
