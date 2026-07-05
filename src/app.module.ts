import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnvironment } from './config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CashModule } from './modules/cash/cash.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CustomersModule } from './modules/customers/customers.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { ProductsModule } from './modules/products/products.module';
import { ReceivablesModule } from './modules/receivables/receivables.module';
import { SubcategoriesModule } from './modules/subcategories/subcategories.module';
import { TaxesModule } from './modules/taxes/taxes.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    SubcategoriesModule,
    ProductsModule,
    TaxesModule,
    CustomersModule,
    CashModule,
    InvoicesModule,
    ReceivablesModule,
    AuditModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
