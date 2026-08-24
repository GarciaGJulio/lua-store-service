import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { Prisma } from '@prisma/client';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PrismaService } from '@/database/prisma.service';

class AnalyticsDashboardQueryDto {
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  subcategoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  topLimit?: number = 5;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  lowStockThreshold?: number = 3;
}

type AnalyticsFilters = {
  categoryId?: string;
  dateFrom: string;
  dateTo: string;
  endExclusive: Date;
  lowStockThreshold: number;
  startAt: Date;
  subcategoryId?: string;
  topLimit: number;
};

type SalesAggregateRow = {
  gross_margin: Prisma.Decimal | number | null;
  invoices_count: bigint | number | null;
  sales_total: Prisma.Decimal | number | null;
  units_sold: bigint | number | null;
};

type ReturnsAggregateRow = {
  returns_margin_total: Prisma.Decimal | number | null;
  returns_quantity: bigint | number | null;
  returns_total: Prisma.Decimal | number | null;
};

type DailySalesRow = {
  day_key: Date | string;
  gross_margin: Prisma.Decimal | number | null;
  sales_total: Prisma.Decimal | number | null;
  units_sold: bigint | number | null;
};

type DailyReturnsRow = {
  day_key: Date | string;
  returns_margin_total: Prisma.Decimal | number | null;
  returns_total: Prisma.Decimal | number | null;
};

type MonthlySalesRow = {
  month_key: Date | string;
  gross_margin: Prisma.Decimal | number | null;
  invoice_count: bigint | number | null;
  sales_total: Prisma.Decimal | number | null;
  units_sold: bigint | number | null;
};

type MonthlyReturnsRow = {
  month_key: Date | string;
  returns_margin_total: Prisma.Decimal | number | null;
  returns_total: Prisma.Decimal | number | null;
};

type PaymentMethodRow = {
  amount_total: Prisma.Decimal | number | null;
  payment_method: string;
};

type ProductRankingRow = {
  category_name: string;
  gross_margin: Prisma.Decimal | number | null;
  product_id: string;
  product_name: string;
  product_sku: string;
  revenue_total: Prisma.Decimal | number | null;
  subcategory_name: string;
  units_sold: bigint | number | null;
};

type VariantRankingRow = {
  barcode: string;
  category_name: string;
  color_label: string;
  gross_margin: Prisma.Decimal | number | null;
  product_name: string;
  product_sku: string;
  revenue_total: Prisma.Decimal | number | null;
  size_label: string;
  subcategory_name: string;
  units_sold: bigint | number | null;
  variant_id: string;
};

type SlowProductRow = {
  category_name: string;
  last_sold_at: Date | string | null;
  product_id: string;
  product_name: string;
  product_sku: string;
  reference_date: Date | string;
  stock_total: bigint | number | null;
  subcategory_name: string;
};

type SlowVariantRow = {
  barcode: string;
  category_name: string;
  color_label: string;
  last_sold_at: Date | string | null;
  product_name: string;
  product_sku: string;
  reference_date: Date | string;
  size_label: string;
  stock_total: bigint | number | null;
  subcategory_name: string;
  variant_id: string;
};

type StockRow = {
  barcode: string;
  category_name: string;
  color_label: string;
  product_name: string;
  product_sku: string;
  size_label: string;
  stock_total: bigint | number | null;
  subcategory_name: string;
  variant_id: string;
};

type CustomerRow = {
  customer_key: string;
  customer_name: string;
  identification: string | null;
  invoices_count: bigint | number | null;
  revenue_total: Prisma.Decimal | number | null;
  units_sold: bigint | number | null;
};

type ReceivableSummaryRow = {
  open_count: bigint | number | null;
  pending_balance: Prisma.Decimal | number | null;
};

type ReceivableCollectionsRow = {
  collections_total: Prisma.Decimal | number | null;
};

const paymentMethodLabels: Record<string, string> = {
  CASH: 'Efectivo',
  CREDITO_MONSE: 'Credito Monse',
  DE_UNA: 'De Una',
  TRANSFER: 'Transferencia',
};

@Injectable()
class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(query: AnalyticsDashboardQueryDto) {
    const filters = this.normalizeFilters(query);

    const [
      salesAggregate,
      returnsAggregate,
      issuedInvoiceCount,
      voidedInvoiceCount,
      dailySalesRows,
      dailyReturnsRows,
      monthlySalesRows,
      monthlyReturnsRows,
      paymentMethodRows,
      topProductsByUnitsRows,
      topProductsByRevenueRows,
      topVariantsByUnitsRows,
      topVariantsByRevenueRows,
      slowProductsRows,
      slowVariantsRows,
      lowStockRows,
      outOfStockRows,
      topCustomersRows,
      receivablesSummaryRows,
      receivableCollectionsRows,
    ] = await Promise.all([
      this.getSalesAggregate(filters),
      this.getReturnsAggregate(filters),
      this.getInvoiceCount(filters, false),
      this.getInvoiceCount(filters, true),
      this.getDailySalesRows(filters),
      this.getDailyReturnsRows(filters),
      this.getMonthlySalesRows(filters),
      this.getMonthlyReturnsRows(filters),
      this.getPaymentMethodRows(filters),
      this.getTopProductsRows(filters, 'units'),
      this.getTopProductsRows(filters, 'revenue'),
      this.getTopVariantsRows(filters, 'units'),
      this.getTopVariantsRows(filters, 'revenue'),
      this.getSlowProductsRows(filters),
      this.getSlowVariantsRows(filters),
      this.getStockRows(filters, false),
      this.getStockRows(filters, true),
      this.getTopCustomersRows(filters),
      this.getReceivablesSummary(filters),
      this.getReceivableCollections(filters),
    ]);

    const grossSales = this.toNumber(salesAggregate[0]?.sales_total);
    const unitsSold = this.toInteger(salesAggregate[0]?.units_sold);
    const grossMargin = this.toNumber(salesAggregate[0]?.gross_margin);
    const invoiceCount = this.toInteger(issuedInvoiceCount[0]?.invoices_count);
    const returnsTotal = this.toNumber(returnsAggregate[0]?.returns_total);
    const returnsMarginTotal = this.toNumber(returnsAggregate[0]?.returns_margin_total);
    const returnsQuantity = this.toInteger(returnsAggregate[0]?.returns_quantity);
    const pendingBalance = this.toNumber(receivablesSummaryRows[0]?.pending_balance);
    const openReceivablesCount = this.toInteger(receivablesSummaryRows[0]?.open_count);
    const collectionsTotal = this.toNumber(receivableCollectionsRows[0]?.collections_total);
    const netSales = this.roundCurrency(grossSales - returnsTotal);
    const netGrossMargin = this.roundCurrency(grossMargin - returnsMarginTotal);
    const averageTicket = invoiceCount > 0 ? this.roundCurrency(netSales / invoiceCount) : 0;

    return {
      customers: {
        topCustomers: topCustomersRows.map((row) => ({
          customerKey: row.customer_key,
          customerName: row.customer_name,
          identification: row.identification ?? 'Consumidor final',
          invoiceCount: this.toInteger(row.invoices_count),
          revenue: this.toNumber(row.revenue_total),
          unitsSold: this.toInteger(row.units_sold),
        })),
      },
      filters: {
        categoryId: filters.categoryId ?? null,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        lowStockThreshold: filters.lowStockThreshold,
        subcategoryId: filters.subcategoryId ?? null,
        topLimit: filters.topLimit,
      },
      inventory: {
        lowStock: lowStockRows.map((row) => this.mapStockRow(row)),
        outOfStock: outOfStockRows.map((row) => this.mapStockRow(row)),
        slowProducts: slowProductsRows.map((row) => ({
          categoryName: row.category_name,
          daysWithoutSale: this.getDaysBetween(row.reference_date),
          lastSoldAt: row.last_sold_at ? this.toIsoString(row.last_sold_at) : null,
          productId: row.product_id,
          productName: row.product_name,
          productSku: row.product_sku,
          stockTotal: this.toInteger(row.stock_total),
          subcategoryName: row.subcategory_name,
        })),
        slowVariants: slowVariantsRows.map((row) => ({
          barcode: row.barcode,
          categoryName: row.category_name,
          colorLabel: row.color_label,
          daysWithoutSale: this.getDaysBetween(row.reference_date),
          lastSoldAt: row.last_sold_at ? this.toIsoString(row.last_sold_at) : null,
          productName: row.product_name,
          productSku: row.product_sku,
          sizeLabel: row.size_label,
          stockTotal: this.toInteger(row.stock_total),
          subcategoryName: row.subcategory_name,
          variantId: row.variant_id,
        })),
        topProductsByRevenue: topProductsByRevenueRows.map((row) =>
          this.mapProductRankingRow(row),
        ),
        topProductsByUnits: topProductsByUnitsRows.map((row) =>
          this.mapProductRankingRow(row),
        ),
        topVariantsByRevenue: topVariantsByRevenueRows.map((row) =>
          this.mapVariantRankingRow(row),
        ),
        topVariantsByUnits: topVariantsByUnitsRows.map((row) =>
          this.mapVariantRankingRow(row),
        ),
      },
      overview: {
        averageTicket,
        grossMargin: netGrossMargin,
        invoicesCount: invoiceCount,
        netSales,
        openReceivablesCount,
        pendingBalance,
        returnsQuantity,
        returnsTotal,
        unitsSold,
        voidedInvoicesCount: this.toInteger(voidedInvoiceCount[0]?.invoices_count),
      },
      receivables: {
        collectionsTotal,
        openCount: openReceivablesCount,
        pendingBalance,
      },
      sales: {
        daily: this.buildDailySeries(filters, dailySalesRows, dailyReturnsRows),
        monthly: this.buildMonthlySeries(filters, monthlySalesRows, monthlyReturnsRows),
        paymentMethods: this.buildPaymentMethods(paymentMethodRows),
      },
    };
  }

  async getOverview() {
    return this.getDashboard({});
  }

  private async getSalesAggregate(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<SalesAggregateRow>>(Prisma.sql`
      SELECT
        COALESCE(SUM(il.quantity), 0) AS units_sold,
        COALESCE(SUM(il.line_total), 0) AS sales_total,
        COALESCE(SUM((il.unit_price - pv.cost) * il.quantity), 0) AS gross_margin,
        COUNT(DISTINCT i.id) AS invoices_count
        FROM lua_store.invoices i
        INNER JOIN lua_store.invoice_items il
                ON il.invoice_id = i.id
        INNER JOIN lua_store.product_variants pv
                ON pv.id = il.variant_id
        INNER JOIN lua_store.products p
                ON p.id = il.product_id
       WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
         AND i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
    `);
  }

  private async getReturnsAggregate(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<ReturnsAggregateRow>>(Prisma.sql`
      SELECT
        COALESCE(SUM(sr.refunded_total), 0) AS returns_total,
        COALESCE(SUM(sr.quantity), 0) AS returns_quantity,
        COALESCE(SUM((sr.refunded_unit_price - pv.cost) * sr.quantity), 0) AS returns_margin_total
        FROM lua_store.store_returns sr
        INNER JOIN lua_store.product_variants pv
                ON pv.id = sr.variant_id
        INNER JOIN lua_store.products p
                ON p.id = sr.product_id
       WHERE sr.return_date >= ${filters.startAt}
         AND sr.return_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
    `);
  }

  private async getInvoiceCount(filters: AnalyticsFilters, onlyVoided: boolean) {
    return this.prisma.$queryRaw<Array<SalesAggregateRow>>(Prisma.sql`
      SELECT COUNT(DISTINCT i.id) AS invoices_count
        FROM lua_store.invoices i
       WHERE i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         AND i.status ${onlyVoided
           ? Prisma.sql`= 'CANCELLED'::lua_store.invoice_status`
           : Prisma.sql`<> 'CANCELLED'::lua_store.invoice_status`}
         ${this.buildInvoiceProductExistsSql(filters)}
    `);
  }

  private async getDailySalesRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<DailySalesRow>>(Prisma.sql`
      SELECT
        DATE(i.issue_date) AS day_key,
        COALESCE(SUM(il.line_total), 0) AS sales_total,
        COALESCE(SUM(il.quantity), 0) AS units_sold,
        COALESCE(SUM((il.unit_price - pv.cost) * il.quantity), 0) AS gross_margin
        FROM lua_store.invoices i
        INNER JOIN lua_store.invoice_items il
                ON il.invoice_id = i.id
        INNER JOIN lua_store.product_variants pv
                ON pv.id = il.variant_id
        INNER JOIN lua_store.products p
                ON p.id = il.product_id
       WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
         AND i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY DATE(i.issue_date)
       ORDER BY DATE(i.issue_date) ASC
    `);
  }

  private async getDailyReturnsRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<DailyReturnsRow>>(Prisma.sql`
      SELECT
        DATE(sr.return_date) AS day_key,
        COALESCE(SUM(sr.refunded_total), 0) AS returns_total,
        COALESCE(SUM((sr.refunded_unit_price - pv.cost) * sr.quantity), 0) AS returns_margin_total
        FROM lua_store.store_returns sr
        INNER JOIN lua_store.product_variants pv
                ON pv.id = sr.variant_id
        INNER JOIN lua_store.products p
                ON p.id = sr.product_id
       WHERE sr.return_date >= ${filters.startAt}
         AND sr.return_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY DATE(sr.return_date)
       ORDER BY DATE(sr.return_date) ASC
    `);
  }

  private async getMonthlySalesRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<MonthlySalesRow>>(Prisma.sql`
      SELECT
        DATE_TRUNC('month', i.issue_date) AS month_key,
        COALESCE(SUM(il.line_total), 0) AS sales_total,
        COALESCE(SUM(il.quantity), 0) AS units_sold,
        COALESCE(SUM((il.unit_price - pv.cost) * il.quantity), 0) AS gross_margin,
        COUNT(DISTINCT i.id) AS invoice_count
        FROM lua_store.invoices i
        INNER JOIN lua_store.invoice_items il
                ON il.invoice_id = i.id
        INNER JOIN lua_store.product_variants pv
                ON pv.id = il.variant_id
        INNER JOIN lua_store.products p
                ON p.id = il.product_id
       WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
         AND i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY DATE_TRUNC('month', i.issue_date)
       ORDER BY DATE_TRUNC('month', i.issue_date) ASC
    `);
  }

  private async getMonthlyReturnsRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<MonthlyReturnsRow>>(Prisma.sql`
      SELECT
        DATE_TRUNC('month', sr.return_date) AS month_key,
        COALESCE(SUM(sr.refunded_total), 0) AS returns_total,
        COALESCE(SUM((sr.refunded_unit_price - pv.cost) * sr.quantity), 0) AS returns_margin_total
        FROM lua_store.store_returns sr
        INNER JOIN lua_store.product_variants pv
                ON pv.id = sr.variant_id
        INNER JOIN lua_store.products p
                ON p.id = sr.product_id
       WHERE sr.return_date >= ${filters.startAt}
         AND sr.return_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY DATE_TRUNC('month', sr.return_date)
       ORDER BY DATE_TRUNC('month', sr.return_date) ASC
    `);
  }

  private async getPaymentMethodRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<PaymentMethodRow>>(Prisma.sql`
      WITH scoped_invoices AS (
        SELECT
          i.id AS invoice_id,
          i.total AS invoice_total,
          COALESCE(SUM(il.line_total), 0) AS scoped_total
          FROM lua_store.invoices i
          INNER JOIN lua_store.invoice_items il
                  ON il.invoice_id = i.id
          INNER JOIN lua_store.products p
                  ON p.id = il.product_id
         WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
           AND i.issue_date >= ${filters.startAt}
           AND i.issue_date < ${filters.endExclusive}
           ${this.buildProductScopeSql(filters)}
         GROUP BY i.id, i.total
      )
      SELECT
        ip.payment_method,
        COALESCE(
          SUM(
            CASE
              WHEN si.invoice_total = 0 THEN 0
              ELSE ip.amount * (si.scoped_total / si.invoice_total)
            END
          ),
          0
        ) AS amount_total
        FROM scoped_invoices si
        INNER JOIN lua_store.invoice_payments ip
                ON ip.invoice_id = si.invoice_id
       GROUP BY ip.payment_method
    `);
  }

  private async getTopProductsRows(
    filters: AnalyticsFilters,
    metric: 'revenue' | 'units',
  ) {
    return this.prisma.$queryRaw<Array<ProductRankingRow>>(Prisma.sql`
      SELECT
        p.id AS product_id,
        p.internal_code AS product_sku,
        p.name AS product_name,
        c.name AS category_name,
        s.name AS subcategory_name,
        COALESCE(SUM(il.quantity), 0) AS units_sold,
        COALESCE(SUM(il.line_total), 0) AS revenue_total,
        COALESCE(SUM((il.unit_price - pv.cost) * il.quantity), 0) AS gross_margin
        FROM lua_store.invoices i
        INNER JOIN lua_store.invoice_items il
                ON il.invoice_id = i.id
        INNER JOIN lua_store.products p
                ON p.id = il.product_id
        INNER JOIN lua_store.product_variants pv
                ON pv.id = il.variant_id
        INNER JOIN lua_store.categories c
                ON c.id = p.category_id
        INNER JOIN lua_store.subcategories s
                ON s.id = p.subcategory_id
       WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
         AND i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY p.id, p.internal_code, p.name, c.name, s.name
       ORDER BY ${metric === 'units'
         ? Prisma.sql`units_sold DESC`
         : Prisma.sql`revenue_total DESC`}, product_name ASC
       LIMIT ${filters.topLimit}
    `);
  }

  private async getTopVariantsRows(
    filters: AnalyticsFilters,
    metric: 'revenue' | 'units',
  ) {
    return this.prisma.$queryRaw<Array<VariantRankingRow>>(Prisma.sql`
      SELECT
        pv.id AS variant_id,
        p.internal_code AS product_sku,
        p.name AS product_name,
        c.name AS category_name,
        s.name AS subcategory_name,
        pv.size_label,
        pv.color_label,
        b.code AS barcode,
        COALESCE(SUM(il.quantity), 0) AS units_sold,
        COALESCE(SUM(il.line_total), 0) AS revenue_total,
        COALESCE(SUM((il.unit_price - pv.cost) * il.quantity), 0) AS gross_margin
        FROM lua_store.invoices i
        INNER JOIN lua_store.invoice_items il
                ON il.invoice_id = i.id
        INNER JOIN lua_store.product_variants pv
                ON pv.id = il.variant_id
        INNER JOIN lua_store.products p
                ON p.id = pv.product_id
        INNER JOIN lua_store.barcodes b
                ON b.id = pv.barcode_id
        INNER JOIN lua_store.categories c
                ON c.id = p.category_id
        INNER JOIN lua_store.subcategories s
                ON s.id = p.subcategory_id
       WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
         AND i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY pv.id, p.internal_code, p.name, c.name, s.name, pv.size_label, pv.color_label, b.code
       ORDER BY ${metric === 'units'
         ? Prisma.sql`units_sold DESC`
         : Prisma.sql`revenue_total DESC`}, product_name ASC
       LIMIT ${filters.topLimit}
    `);
  }

  private async getSlowProductsRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<SlowProductRow>>(Prisma.sql`
      SELECT
        p.id AS product_id,
        p.internal_code AS product_sku,
        p.name AS product_name,
        c.name AS category_name,
        s.name AS subcategory_name,
        p.total_stock AS stock_total,
        MAX(i.issue_date) AS last_sold_at,
        COALESCE(MAX(i.issue_date), p.created_at) AS reference_date
        FROM lua_store.products p
        INNER JOIN lua_store.categories c
                ON c.id = p.category_id
        INNER JOIN lua_store.subcategories s
                ON s.id = p.subcategory_id
        LEFT JOIN lua_store.invoice_items il
               ON il.product_id = p.id
        LEFT JOIN lua_store.invoices i
               ON i.id = il.invoice_id
              AND i.status <> 'CANCELLED'::lua_store.invoice_status
       WHERE p.total_stock > 0
         ${this.buildProductScopeSql(filters)}
       GROUP BY p.id, p.internal_code, p.name, c.name, s.name, p.total_stock, p.created_at
       ORDER BY reference_date ASC, product_name ASC
       LIMIT ${filters.topLimit}
    `);
  }

  private async getSlowVariantsRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<SlowVariantRow>>(Prisma.sql`
      SELECT
        pv.id AS variant_id,
        p.internal_code AS product_sku,
        p.name AS product_name,
        c.name AS category_name,
        s.name AS subcategory_name,
        pv.size_label,
        pv.color_label,
        b.code AS barcode,
        pv.stock AS stock_total,
        MAX(i.issue_date) AS last_sold_at,
        COALESCE(MAX(i.issue_date), pv.created_at) AS reference_date
        FROM lua_store.product_variants pv
        INNER JOIN lua_store.products p
                ON p.id = pv.product_id
        INNER JOIN lua_store.barcodes b
                ON b.id = pv.barcode_id
        INNER JOIN lua_store.categories c
                ON c.id = p.category_id
        INNER JOIN lua_store.subcategories s
                ON s.id = p.subcategory_id
        LEFT JOIN lua_store.invoice_items il
               ON il.variant_id = pv.id
        LEFT JOIN lua_store.invoices i
               ON i.id = il.invoice_id
              AND i.status <> 'CANCELLED'::lua_store.invoice_status
       WHERE pv.stock > 0
         ${this.buildProductScopeSql(filters)}
       GROUP BY pv.id, p.internal_code, p.name, c.name, s.name, pv.size_label, pv.color_label, b.code, pv.stock, pv.created_at
       ORDER BY reference_date ASC, product_name ASC
       LIMIT ${filters.topLimit}
    `);
  }

  private async getStockRows(filters: AnalyticsFilters, onlyOutOfStock: boolean) {
    return this.prisma.$queryRaw<Array<StockRow>>(Prisma.sql`
      SELECT
        pv.id AS variant_id,
        p.internal_code AS product_sku,
        p.name AS product_name,
        c.name AS category_name,
        s.name AS subcategory_name,
        pv.size_label,
        pv.color_label,
        b.code AS barcode,
        pv.stock AS stock_total
        FROM lua_store.product_variants pv
        INNER JOIN lua_store.products p
                ON p.id = pv.product_id
        INNER JOIN lua_store.barcodes b
                ON b.id = pv.barcode_id
        INNER JOIN lua_store.categories c
                ON c.id = p.category_id
        INNER JOIN lua_store.subcategories s
                ON s.id = p.subcategory_id
       WHERE pv.stock ${onlyOutOfStock
         ? Prisma.sql`= 0`
         : Prisma.sql`BETWEEN 1 AND ${filters.lowStockThreshold}`}
         ${this.buildProductScopeSql(filters)}
       ORDER BY pv.stock ASC, product_name ASC
       LIMIT ${filters.topLimit}
    `);
  }

  private async getTopCustomersRows(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<CustomerRow>>(Prisma.sql`
      SELECT
        COALESCE(c.id::text, i.customer_name_snapshot) AS customer_key,
        COALESCE(c.full_name, i.customer_name_snapshot) AS customer_name,
        COALESCE(c.identification_number, i.customer_identification_snapshot) AS identification,
        COUNT(DISTINCT i.id) AS invoices_count,
        COALESCE(SUM(il.quantity), 0) AS units_sold,
        COALESCE(SUM(il.line_total), 0) AS revenue_total
        FROM lua_store.invoices i
        INNER JOIN lua_store.invoice_items il
                ON il.invoice_id = i.id
        INNER JOIN lua_store.products p
                ON p.id = il.product_id
        LEFT JOIN lua_store.customers c
               ON c.id = i.customer_id
       WHERE i.status <> 'CANCELLED'::lua_store.invoice_status
         AND i.issue_date >= ${filters.startAt}
         AND i.issue_date < ${filters.endExclusive}
         ${this.buildProductScopeSql(filters)}
       GROUP BY COALESCE(c.id::text, i.customer_name_snapshot), COALESCE(c.full_name, i.customer_name_snapshot), COALESCE(c.identification_number, i.customer_identification_snapshot)
       ORDER BY revenue_total DESC, units_sold DESC
       LIMIT ${filters.topLimit}
    `);
  }

  private async getReceivablesSummary(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<ReceivableSummaryRow>>(Prisma.sql`
      SELECT
        COUNT(DISTINCT ar.id) AS open_count,
        COALESCE(SUM(ar.pending_amount), 0) AS pending_balance
        FROM lua_store.accounts_receivable ar
        INNER JOIN lua_store.invoices i
                ON i.id = ar.invoice_id
       WHERE ar.status IN ('PENDING'::lua_store.receivable_status, 'PARTIAL'::lua_store.receivable_status)
         ${this.buildInvoiceProductExistsSql(filters)}
    `);
  }

  private async getReceivableCollections(filters: AnalyticsFilters) {
    return this.prisma.$queryRaw<Array<ReceivableCollectionsRow>>(Prisma.sql`
      SELECT
        COALESCE(SUM(rp.amount), 0) AS collections_total
        FROM lua_store.receivable_payments rp
        INNER JOIN lua_store.accounts_receivable ar
                ON ar.id = rp.account_receivable_id
        INNER JOIN lua_store.invoices i
                ON i.id = ar.invoice_id
       WHERE rp.paid_at >= ${filters.startAt}
         AND rp.paid_at < ${filters.endExclusive}
         ${this.buildInvoiceProductExistsSql(filters)}
    `);
  }

  private buildDailySeries(
    filters: AnalyticsFilters,
    salesRows: Array<DailySalesRow>,
    returnsRows: Array<DailyReturnsRow>,
  ) {
    const salesMap = new Map(
      salesRows.map((row) => [
        this.toDateKey(row.day_key),
        {
          grossMargin: this.toNumber(row.gross_margin),
          grossSales: this.toNumber(row.sales_total),
          unitsSold: this.toInteger(row.units_sold),
        },
      ]),
    );
    const returnsMap = new Map(
      returnsRows.map((row) => [
        this.toDateKey(row.day_key),
        {
          returnsMargin: this.toNumber(row.returns_margin_total),
          returnsTotal: this.toNumber(row.returns_total),
        },
      ]),
    );

    return this.buildDateSeries(filters.dateFrom, filters.dateTo).map((dateKey) => {
      const sales = salesMap.get(dateKey) ?? {
        grossMargin: 0,
        grossSales: 0,
        unitsSold: 0,
      };
      const returns = returnsMap.get(dateKey) ?? {
        returnsMargin: 0,
        returnsTotal: 0,
      };

      return {
        date: dateKey,
        grossMargin: this.roundCurrency(sales.grossMargin - returns.returnsMargin),
        grossSales: sales.grossSales,
        netSales: this.roundCurrency(sales.grossSales - returns.returnsTotal),
        returnsTotal: returns.returnsTotal,
        unitsSold: sales.unitsSold,
      };
    });
  }

  private buildMonthlySeries(
    filters: AnalyticsFilters,
    salesRows: Array<MonthlySalesRow>,
    returnsRows: Array<MonthlyReturnsRow>,
  ) {
    const salesMap = new Map(
      salesRows.map((row) => [
        this.toMonthKey(row.month_key),
        {
          grossMargin: this.toNumber(row.gross_margin),
          invoiceCount: this.toInteger(row.invoice_count),
          grossSales: this.toNumber(row.sales_total),
          unitsSold: this.toInteger(row.units_sold),
        },
      ]),
    );
    const returnsMap = new Map(
      returnsRows.map((row) => [
        this.toMonthKey(row.month_key),
        {
          returnsMargin: this.toNumber(row.returns_margin_total),
          returnsTotal: this.toNumber(row.returns_total),
        },
      ]),
    );

    return this.buildMonthSeries(filters.dateFrom, filters.dateTo).map((monthKey) => {
      const sales = salesMap.get(monthKey) ?? {
        grossMargin: 0,
        grossSales: 0,
        invoiceCount: 0,
        unitsSold: 0,
      };
      const returns = returnsMap.get(monthKey) ?? {
        returnsMargin: 0,
        returnsTotal: 0,
      };

      return {
        grossMargin: this.roundCurrency(sales.grossMargin - returns.returnsMargin),
        grossSales: sales.grossSales,
        invoiceCount: sales.invoiceCount,
        month: monthKey,
        netSales: this.roundCurrency(sales.grossSales - returns.returnsTotal),
        returnsTotal: returns.returnsTotal,
        unitsSold: sales.unitsSold,
      };
    });
  }

  private buildPaymentMethods(rows: Array<PaymentMethodRow>) {
    const rowsMap = new Map(
      rows.map((row) => [row.payment_method, this.toNumber(row.amount_total)]),
    );

    return Object.entries(paymentMethodLabels).map(([method, label]) => ({
      amount: rowsMap.get(method) ?? 0,
      label,
      method,
    }));
  }

  private mapProductRankingRow(row: ProductRankingRow) {
    return {
      categoryName: row.category_name,
      grossMargin: this.toNumber(row.gross_margin),
      productId: row.product_id,
      productName: row.product_name,
      productSku: row.product_sku,
      revenue: this.toNumber(row.revenue_total),
      subcategoryName: row.subcategory_name,
      unitsSold: this.toInteger(row.units_sold),
    };
  }

  private mapVariantRankingRow(row: VariantRankingRow) {
    return {
      barcode: row.barcode,
      categoryName: row.category_name,
      colorLabel: row.color_label,
      grossMargin: this.toNumber(row.gross_margin),
      productName: row.product_name,
      productSku: row.product_sku,
      revenue: this.toNumber(row.revenue_total),
      sizeLabel: row.size_label,
      subcategoryName: row.subcategory_name,
      unitsSold: this.toInteger(row.units_sold),
      variantId: row.variant_id,
    };
  }

  private mapStockRow(row: StockRow) {
    return {
      barcode: row.barcode,
      categoryName: row.category_name,
      colorLabel: row.color_label,
      productName: row.product_name,
      productSku: row.product_sku,
      sizeLabel: row.size_label,
      stockTotal: this.toInteger(row.stock_total),
      subcategoryName: row.subcategory_name,
      variantId: row.variant_id,
    };
  }

  private buildProductScopeSql(filters: AnalyticsFilters, productAlias = 'p') {
    const clauses: Array<Prisma.Sql> = [];

    if (filters.categoryId) {
      clauses.push(
        Prisma.sql`${Prisma.raw(`${productAlias}.category_id`)} = ${filters.categoryId}::uuid`,
      );
    }

    if (filters.subcategoryId) {
      clauses.push(
        Prisma.sql`${Prisma.raw(`${productAlias}.subcategory_id`)} = ${filters.subcategoryId}::uuid`,
      );
    }

    if (clauses.length === 0) {
      return Prisma.sql``;
    }

    return Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}`;
  }

  private buildInvoiceProductExistsSql(filters: AnalyticsFilters) {
    if (!filters.categoryId && !filters.subcategoryId) {
      return Prisma.sql``;
    }

    return Prisma.sql`
      AND EXISTS (
        SELECT 1
          FROM lua_store.invoice_items il
          INNER JOIN lua_store.products p
                  ON p.id = il.product_id
         WHERE il.invoice_id = i.id
           ${this.buildProductScopeSql(filters)}
      )
    `;
  }

  private normalizeFilters(query: AnalyticsDashboardQueryDto): AnalyticsFilters {
    const todayKey = this.getTodayDateKey();
    const dateTo = query.dateTo?.slice(0, 10) ?? todayKey;
    const dateFrom =
      query.dateFrom?.slice(0, 10) ?? this.addDaysToKey(dateTo, -13);

    if (dateFrom > dateTo) {
      throw new BadRequestException(
        'La fecha inicial no puede ser mayor a la fecha final.',
      );
    }

    return {
      categoryId:
        query.categoryId && query.categoryId !== 'all'
          ? query.categoryId
          : undefined,
      dateFrom,
      dateTo,
      endExclusive: this.buildUtcDate(this.addDaysToKey(dateTo, 1)),
      lowStockThreshold: query.lowStockThreshold ?? 3,
      startAt: this.buildUtcDate(dateFrom),
      subcategoryId:
        query.subcategoryId && query.subcategoryId !== 'all'
          ? query.subcategoryId
          : undefined,
      topLimit: query.topLimit ?? 5,
    };
  }

  private buildDateSeries(dateFrom: string, dateTo: string) {
    const items: Array<string> = [];
    let cursor = dateFrom;

    while (cursor <= dateTo) {
      items.push(cursor);
      cursor = this.addDaysToKey(cursor, 1);
    }

    return items;
  }

  private buildMonthSeries(dateFrom: string, dateTo: string) {
    const items: Array<string> = [];
    let cursor = `${dateFrom.slice(0, 7)}-01`;
    const limit = `${dateTo.slice(0, 7)}-01`;

    while (cursor <= limit) {
      items.push(cursor.slice(0, 7));
      cursor = this.addMonthsToKey(cursor, 1);
    }

    return items;
  }

  private addDaysToKey(dateKey: string, days: number) {
    const date = this.buildUtcDate(dateKey);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  private addMonthsToKey(dateKey: string, months: number) {
    const date = this.buildUtcDate(dateKey);
    date.setUTCMonth(date.getUTCMonth() + months);
    return date.toISOString().slice(0, 10);
  }

  private buildUtcDate(dateKey: string) {
    return new Date(`${dateKey}T00:00:00.000Z`);
  }

  private getTodayDateKey() {
    return new Date().toISOString().slice(0, 10);
  }

  private toDateKey(value: Date | string) {
    return this.toIsoString(value).slice(0, 10);
  }

  private toMonthKey(value: Date | string) {
    return this.toIsoString(value).slice(0, 7);
  }

  private toIsoString(value: Date | string) {
    return (typeof value === 'string' ? new Date(value) : value)
      .toISOString();
  }

  private toInteger(value: Prisma.Decimal | bigint | number | string | null | undefined) {
    if (typeof value === 'bigint') {
      return Number(value);
    }

    return Math.trunc(this.toNumber(value));
  }

  private toNumber(value: Prisma.Decimal | number | string | null | undefined) {
    if (value instanceof Prisma.Decimal) {
      return value.toNumber();
    }

    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return Number(value);
    }

    return 0;
  }

  private roundCurrency(value: number) {
    return Number(value.toFixed(2));
  }

  private getDaysBetween(value: Date | string) {
    const reference = this.buildUtcDate(this.toDateKey(value));
    const today = this.buildUtcDate(this.getTodayDateKey());
    const diff = today.getTime() - reference.getTime();

    return Math.max(0, Math.floor(diff / 86_400_000));
  }
}

@Controller('analytics')
class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  getOverview() {
    return this.analyticsService.getOverview();
  }

  @Get('dashboard')
  getDashboard(@Query() query: AnalyticsDashboardQueryDto) {
    return this.analyticsService.getDashboard(query);
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
