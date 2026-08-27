ALTER TABLE "accounts_receivable"
  ALTER COLUMN "invoice_id" DROP NOT NULL,
  ADD COLUMN "is_initial_debt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_payment_at" TIMESTAMPTZ(6);

UPDATE "accounts_receivable"
SET "last_payment_at" = COALESCE("paid_at", "updated_at", "created_at")
WHERE "last_payment_at" IS NULL;

ALTER TABLE "accounts_receivable"
  ALTER COLUMN "last_payment_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "last_payment_at" SET NOT NULL;
