BEGIN;
-- AlterTable
ALTER TABLE "cash_closures" ADD COLUMN     "refunds_total" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "store_returns" ADD COLUMN     "invoice_line_id" UUID,
ADD COLUMN     "operation_id" UUID;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "return_status" VARCHAR(10) NOT NULL DEFAULT 'NONE',
ADD COLUMN     "returned_total" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "accounts_receivable" ADD COLUMN     "returned_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "return_operations" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "debt_reduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refund_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refund_paid_at" TIMESTAMPTZ(6),
    "refund_cash_register_id" UUID,
    "requires_review" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_operations_invoice_id_idx" ON "return_operations"("invoice_id");

-- CreateIndex
CREATE INDEX "return_operations_refund_cash_register_id_refund_paid_at_idx" ON "return_operations"("refund_cash_register_id", "refund_paid_at");

-- CreateIndex
CREATE INDEX "store_returns_invoice_id_idx" ON "store_returns"("invoice_id");

-- CreateIndex
CREATE INDEX "store_returns_operation_id_idx" ON "store_returns"("operation_id");

-- AddForeignKey
ALTER TABLE "store_returns" ADD CONSTRAINT "store_returns_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_returns" ADD CONSTRAINT "store_returns_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "return_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_operations" ADD CONSTRAINT "return_operations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_operations" ADD CONSTRAINT "return_operations_refund_cash_register_id_fkey" FOREIGN KEY ("refund_cash_register_id") REFERENCES "cash_registers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Payment validation and balances are now handled under row locks in the service.
-- Old triggers validate against an already reduced balance and recompute it
-- without return adjustments. Do not execute the operation in two places.
DROP TRIGGER IF EXISTS trg_validate_receivable_payment ON receivable_payments;
DROP TRIGGER IF EXISTS trg_refresh_accounts_receivable ON receivable_payments;
-- The cancellation service explicitly changes status and restores stock.
DROP TRIGGER IF EXISTS trg_restore_stock_on_invoice_cancellation ON invoice_cancellations;

ALTER TABLE invoices ADD CONSTRAINT invoices_return_status_check CHECK (return_status IN ('NONE', 'PARTIAL', 'TOTAL'));
ALTER TABLE invoices ADD CONSTRAINT invoices_returned_total_check CHECK (returned_total >= 0 AND returned_total <= total);
ALTER TABLE accounts_receivable ADD CONSTRAINT receivable_returned_amount_check CHECK (returned_amount >= 0 AND returned_amount <= original_amount);
ALTER TABLE return_operations ADD CONSTRAINT return_operation_amounts_check CHECK (debt_reduction >= 0 AND refund_amount >= 0);
COMMIT;
