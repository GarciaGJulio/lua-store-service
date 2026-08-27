const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const cleanupMarker = 'catalog_cleanup_20260827';
const productSkus = ['LUA-037', 'LUA-014', 'LUA-001'];
const categoryNames = ['HOMBRES', 'MUJERES', 'NIÑOS', 'NIÑAS', 'UNISEX'];
const baseSubcategories = [
  'BLUSAS',
  'VESTIDOS',
  'SHORTS',
  'ZAPATOS',
  'CAMISAS',
  'PANTALÓN',
  'MEDIAS',
  'INTERIOR',
  'ACCESORIOS',
];

async function main() {
  const alreadyApplied = await prisma.auditLog.findFirst({
    where: { action: cleanupMarker, module: 'maintenance' },
    select: { id: true },
  });

  if (alreadyApplied) {
    console.log('Catalog cleanup already applied.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const products = await tx.product.findMany({
      where: { sku: { in: productSkus } },
      select: {
        id: true,
        variants: { select: { barcodeId: true, id: true } },
      },
    });
    const productIds = products.map((product) => product.id);
    const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
    const barcodeIds = products.flatMap((product) =>
      product.variants.map((variant) => variant.barcodeId),
    );
    const invoices = await tx.invoice.findMany({
      where: { lines: { some: { productId: { in: productIds } } } },
      select: { id: true, receivable: { select: { id: true } }, returns: { select: { id: true } } },
    });
    const invoiceIds = invoices.map((invoice) => invoice.id);
    const receivableIds = invoices.flatMap((invoice) =>
      invoice.receivable ? [invoice.receivable.id] : [],
    );
    const returnIds = invoices.flatMap((invoice) => invoice.returns.map((item) => item.id));

    await tx.receivablePayment.deleteMany({ where: { receivableId: { in: receivableIds } } });
    await tx.receivable.deleteMany({ where: { id: { in: receivableIds } } });
    await tx.invoiceCancellation.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.storeReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await tx.auditLog.deleteMany({
      where: {
        entityId: {
          in: [...productIds, ...variantIds, ...barcodeIds, ...invoiceIds, ...receivableIds, ...returnIds],
        },
      },
    });
    await tx.variant.deleteMany({ where: { id: { in: variantIds } } });
    await tx.barcode.deleteMany({ where: { id: { in: barcodeIds } } });
    await tx.product.deleteMany({ where: { id: { in: productIds } } });

    await tx.subcategory.deleteMany({});
    await tx.category.deleteMany({});
    await tx.tax.deleteMany({});

    for (const categoryName of categoryNames) {
      const category = await tx.category.create({ data: { name: categoryName } });
      const subcategoryNames =
        categoryName === 'HOMBRES'
          ? baseSubcategories.filter((name) => !['BLUSAS', 'VESTIDOS'].includes(name))
          : categoryName === 'MUJERES'
            ? [...baseSubcategories, 'BODY']
            : baseSubcategories;

      await tx.subcategory.createMany({
        data: subcategoryNames.map((name) => ({ categoryId: category.id, name })),
      });
    }

    await tx.tax.createMany({
      data: [
        {
          code: 'IVA',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          isActive: false,
          isDefault: false,
          name: 'IVA',
          rate: 15,
        },
        {
          code: 'SINIVA',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          isActive: true,
          isDefault: true,
          name: 'SINIVA',
          rate: 0,
        },
      ],
    });

    await tx.auditLog.create({
      data: {
        action: cleanupMarker,
        entityName: 'catalog',
        metadata: {
          categories: categoryNames.length,
          deletedInvoices: invoiceIds.length,
          deletedProducts: productIds.length,
          subcategories: 44,
          taxes: 2,
        },
        module: 'maintenance',
      },
    });
  });

  console.log('Catalog cleanup applied successfully.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
