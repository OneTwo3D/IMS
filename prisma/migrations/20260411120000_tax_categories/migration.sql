-- CreateEnum
CREATE TYPE "TaxCategory" AS ENUM ('STANDARD', 'REDUCED', 'SECOND_REDUCED', 'ZERO', 'EXEMPT');

-- AlterTable
ALTER TABLE "tax_rates"
  ADD COLUMN "taxCategory" "TaxCategory" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "products"
  ADD COLUMN "taxCategory" "TaxCategory" NOT NULL DEFAULT 'STANDARD';

-- CreateIndex
CREATE INDEX "tax_rates_countryCode_taxCategory_usedFor_idx"
  ON "tax_rates"("countryCode", "taxCategory", "usedFor");
