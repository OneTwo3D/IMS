-- Replace WC tax class mapping with WC tax rate mapping.
-- Classes are coarse (standard / reduced / zero) whereas rates are per-country
-- and per-bracket, so the new model maps WC rate IDs directly to IMS TaxRate rows.

DROP TABLE IF EXISTS "wc_tax_mappings";

CREATE TABLE "shopping_tax_rate_mappings" (
    "id" TEXT NOT NULL,
    "externalTaxRateId" INTEGER NOT NULL,
    "externalName" TEXT NOT NULL,
    "externalCountry" TEXT,
    "externalRatePct" DECIMAL(7,4) NOT NULL,
    "externalClass" TEXT,
    "taxRateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopping_tax_rate_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopping_tax_rate_mappings_externalTaxRateId_key" ON "shopping_tax_rate_mappings"("externalTaxRateId");

ALTER TABLE "shopping_tax_rate_mappings"
    ADD CONSTRAINT "shopping_tax_rate_mappings_taxRateId_fkey"
    FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
