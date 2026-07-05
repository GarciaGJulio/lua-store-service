import * as bcrypt from 'bcrypt';
import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('123456', 10);

  await prisma.user.upsert({
    where: {
      email: 'admin@luastore.local',
    },
    update: {
      fullName: 'Admin Lua Store',
      passwordHash,
      role: UserRole.ADMIN,
      username: 'admin.lua.store',
    },
    create: {
      email: 'admin@luastore.local',
      fullName: 'Admin Lua Store',
      passwordHash,
      role: UserRole.ADMIN,
      username: 'admin.lua.store',
    },
  });

  const tax = await prisma.tax.upsert({
    where: {
      code: 'IVA15',
    },
    update: {
      effectiveFrom: new Date(),
      name: 'IVA 15%',
      rate: 15,
    },
    create: {
      code: 'IVA15',
      effectiveFrom: new Date(),
      name: 'IVA 15%',
      rate: 15,
    },
  });

  const category = await prisma.category.upsert({
    where: {
      name: 'General',
    },
    update: {
      description: 'Categoria base para inicializar el catalogo.',
    },
    create: {
      description: 'Categoria base para inicializar el catalogo.',
      name: 'General',
    },
  });

  const subcategory = await prisma.subcategory.upsert({
    where: {
      categoryId_name: {
        categoryId: category.id,
        name: 'Basicos',
      },
    },
    update: {
      description: 'Subcategoria base para ventas de mostrador.',
    },
    create: {
      categoryId: category.id,
      description: 'Subcategoria base para ventas de mostrador.',
      name: 'Basicos',
    },
  });

  await prisma.documentSequence.upsert({
    where: {
      documentType: 'INVOICE',
    },
    update: {
      isActive: true,
      padding: 6,
      prefix: 'FAC-',
    },
    create: {
      documentType: 'INVOICE',
      padding: 6,
      prefix: 'FAC-',
    },
  });

  await prisma.documentSequence.upsert({
    where: {
      documentType: 'RECEIVABLE_PAYMENT',
    },
    update: {
      isActive: true,
      padding: 6,
      prefix: 'ABN-',
    },
    create: {
      documentType: 'RECEIVABLE_PAYMENT',
      padding: 6,
      prefix: 'ABN-',
    },
  });

  await prisma.cashRegister.upsert({
    where: {
      name: 'Caja Principal',
    },
    update: {
      isActive: true,
    },
    create: {
      name: 'Caja Principal',
    },
  });

  const sampleProducts = [
    {
      barcode: '7790000000001',
      defaultPrice: 3.95,
      colorLabel: 'Base',
      name: 'Arroz Premium 2kg',
      sizeLabel: 'UNICA',
      sku: 'LUA-001',
      stock: 12,
    },
    {
      barcode: '7790000000002',
      defaultPrice: 4.6,
      colorLabel: 'Citrus',
      name: 'Detergente Citrus',
      sizeLabel: 'UNICA',
      sku: 'LUA-014',
      stock: 8,
    },
    {
      barcode: '7790000000003',
      defaultPrice: 1.25,
      colorLabel: 'Tradicional',
      name: 'Galleta avena',
      sizeLabel: 'UNICA',
      sku: 'LUA-037',
      stock: 20,
    },
  ];

  for (const product of sampleProducts) {
    const storedProduct = await prisma.product.upsert({
      where: {
        sku: product.sku,
      },
      update: {
        categoryId: category.id,
        defaultPrice: product.defaultPrice,
        name: product.name,
        subcategoryId: subcategory.id,
        taxId: tax.id,
      },
      create: {
        categoryId: category.id,
        defaultPrice: product.defaultPrice,
        name: product.name,
        sku: product.sku,
        subcategoryId: subcategory.id,
        taxId: tax.id,
      },
    });

    const barcode = await prisma.barcode.upsert({
      where: {
        code: product.barcode,
      },
      update: {
        description: `${product.name} ${product.sizeLabel} ${product.colorLabel}`,
        publicPrice: product.defaultPrice,
      },
      create: {
        code: product.barcode,
        description: `${product.name} ${product.sizeLabel} ${product.colorLabel}`,
        publicPrice: product.defaultPrice,
      },
    });

    await prisma.variant.upsert({
      where: {
        productId_sizeLabel_colorLabel: {
          colorLabel: product.colorLabel,
          productId: storedProduct.id,
          sizeLabel: product.sizeLabel,
        },
      },
      update: {
        barcodeId: barcode.id,
        cost: 0,
        price: product.defaultPrice,
        stock: product.stock,
      },
      create: {
        barcodeId: barcode.id,
        colorLabel: product.colorLabel,
        cost: 0,
        price: product.defaultPrice,
        productId: storedProduct.id,
        sizeLabel: product.sizeLabel,
        stock: product.stock,
      },
    });
  }

  const sampleCustomers = [
    {
      email: 'maria@demo.ec',
      fullName: 'Maria Garces',
      identificationNumber: '0102030405',
      phone: '0990000001',
    },
    {
      email: 'sol@demo.ec',
      fullName: 'Distribuidora Sol',
      identificationNumber: '1790011223',
      phone: '0980000002',
    },
    {
      email: 'andrade@demo.ec',
      fullName: 'Comercial Andrade',
      identificationNumber: '0912345678',
      phone: '0970000003',
    },
  ];

  for (const customer of sampleCustomers) {
    await prisma.customer.upsert({
      where: {
        identificationNumber: customer.identificationNumber,
      },
      update: {
        email: customer.email,
        fullName: customer.fullName,
        phone: customer.phone,
      },
      create: {
        email: customer.email,
        fullName: customer.fullName,
        identificationNumber: customer.identificationNumber,
        identificationType: 'CEDULA',
        phone: customer.phone,
      },
    });
  }

  console.log('Seed inicial completado.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
