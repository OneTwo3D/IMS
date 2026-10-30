-- The record of the IMS to WooCommerce tax-rate writer (lib/connectors/woocommerce/tax-rate-writer.ts).
--
-- ADDITIVE ONLY: one new table that nothing deployed before this migration reads or writes. Safe to apply to a populated
-- database while the previous build is still serving. NOTHING IN THIS MIGRATION TURNS THE WRITER ON: while the WooCommerce
-- producer hold stands the writer records shadows in outbound_shadow_writes and writes no row here.

-- CreateTable
CREATE TABLE "woo_tax_rate_writes" (
    "id" TEXT NOT NULL,
    "plan_digest" CHAR(64) NOT NULL,
    "kind" TEXT NOT NULL,
    "change_key" TEXT NOT NULL,
    "woo_tax_rate_id" TEXT,
    "ims_tax_rate_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "change" JSONB NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "woo_tax_rate_writes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "woo_tax_rate_writes_woo_idx" ON "woo_tax_rate_writes"("woo_tax_rate_id");

-- CreateIndex
CREATE INDEX "woo_tax_rate_writes_digest_idx" ON "woo_tax_rate_writes"("plan_digest");

-- Checks held by the database rather than by the writer.
ALTER TABLE "woo_tax_rate_writes" ADD CONSTRAINT "woo_tax_rate_writes_kind_check" CHECK ("kind" IN ('CREATE', 'UPDATE', 'DELETE', 'REFRESH_MAPPING'));
ALTER TABLE "woo_tax_rate_writes" ADD CONSTRAINT "woo_tax_rate_writes_status_check" CHECK ("status" IN ('APPLIED', 'FAILED'));
