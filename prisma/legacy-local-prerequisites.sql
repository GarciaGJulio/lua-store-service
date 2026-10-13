-- Compatibility ONLY for installations missing columns already required by
-- the pre-existing application. Additive; does not remove legacy tables/data.
BEGIN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS alias varchar(100);
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS is_initial_debt boolean NOT NULL DEFAULT false;
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
UPDATE accounts_receivable SET last_payment_at = COALESCE(paid_at, updated_at, created_at) WHERE last_payment_at IS NULL;
ALTER TABLE accounts_receivable ALTER COLUMN last_payment_at SET DEFAULT now(), ALTER COLUMN last_payment_at SET NOT NULL;
ALTER TABLE cash_closures ADD COLUMN IF NOT EXISTS expected_bank_total numeric(12,2),
 ADD COLUMN IF NOT EXISTS counted_bank_total numeric(12,2),
 ADD COLUMN IF NOT EXISTS bank_difference_amount numeric(12,2),
 ADD COLUMN IF NOT EXISTS total_difference_amount numeric(12,2);
COMMIT;
