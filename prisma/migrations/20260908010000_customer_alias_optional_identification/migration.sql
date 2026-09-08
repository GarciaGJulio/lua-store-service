ALTER TABLE "customers"
ADD COLUMN "alias" VARCHAR(100),
ALTER COLUMN "identification_type" DROP NOT NULL,
ALTER COLUMN "identification_number" DROP NOT NULL;
