-- Replace WC tax class mapping with WC tax rate mapping.
-- Classes are coarse (standard / reduced / zero) whereas rates are per-country
-- and per-bracket, so the new model maps WC rate IDs directly to IMS TaxRate rows.

DROP TABLE IF EXISTS "wc_tax_mappings";

CREATE TABLE "wc_tax_rate_mappings" (
    "id" TEXT NOT NULL,
    "wcTaxRateId" INTEGER NOT NULL,
    "wcName" TEXT NOT NULL,
    "wcCountry" TEXT,
    "wcRatePct" DECIMAL(7,4) NOT NULL,
    "wcClass" TEXT,
    "taxRateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wc_tax_rate_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wc_tax_rate_mappings_wcTaxRateId_key" ON "wc_tax_rate_mappings"("wcTaxRateId");

ALTER TABLE "wc_tax_rate_mappings"
    ADD CONSTRAINT "wc_tax_rate_mappings_taxRateId_fkey"
    FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
