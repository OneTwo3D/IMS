-- The Xero tax-rate master store: the FULL list of tax rates Xero holds, per organisation, kept current by the
-- xero-tax-rate-drift sweep (Xero is the tax-rate master; IMS reads it).
--
-- ADDITIVE ONLY. Two new tables that nothing deployed before this migration reads or writes. Safe to apply to a
-- populated database while the previous build is still serving. No backfill: the first sweep of the new build fills
-- them, and until it has, the reconciliation pack reports the Xero leg of R13 as unproven.
--
-- xero_tax_rates       one row per (connector, organisation, Xero TaxType)
-- xero_tax_rate_lists  one header per (connector, organisation): when the list was read, its row count and a digest of
--                      its rows. It is replaced in the same transaction as the rows, so the header either describes
--                      the rows beside it or does not exist.

-- CreateTable
CREATE TABLE "xero_tax_rates" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL DEFAULT 'xero',
    "tenantId" TEXT NOT NULL,
    "taxType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reportTaxType" TEXT,
    "effectiveRate" DECIMAL(18,6),
    "displayTaxRate" DECIMAL(18,6),
    "components" JSONB NOT NULL,
    "canApplyToAssets" BOOLEAN,
    "canApplyToEquity" BOOLEAN,
    "canApplyToExpenses" BOOLEAN,
    "canApplyToLiabilities" BOOLEAN,
    "canApplyToRevenue" BOOLEAN,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xero_tax_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "xero_tax_rates_tax_type_not_blank" CHECK (length(btrim("taxType")) > 0),
    CONSTRAINT "xero_tax_rates_tenant_not_blank" CHECK (length(btrim("tenantId")) > 0),
    CONSTRAINT "xero_tax_rates_components_is_array" CHECK (jsonb_typeof("components") = 'array')
);

-- CreateTable
CREATE TABLE "xero_tax_rate_lists" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL DEFAULT 'xero',
    "tenantId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,

    CONSTRAINT "xero_tax_rate_lists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "xero_tax_rate_lists_row_count_positive" CHECK ("rowCount" > 0),
    CONSTRAINT "xero_tax_rate_lists_digest_hex" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "xero_tax_rate_lists_tenant_not_blank" CHECK (length(btrim("tenantId")) > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "xero_tax_rates_connector_tenantId_taxType_key" ON "xero_tax_rates"("connector", "tenantId", "taxType");

-- CreateIndex
CREATE UNIQUE INDEX "xero_tax_rate_lists_connector_tenantId_key" ON "xero_tax_rate_lists"("connector", "tenantId");
