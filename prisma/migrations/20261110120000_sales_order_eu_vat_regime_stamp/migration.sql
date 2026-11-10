-- The EU VAT regime stamp on a sales order: nullable columns, no default, no existing row is touched.
-- euVatRegime / euVatLineAccount are NULL on an order decided to be outside the scheme; eu_vat_regime_stamped_at is the "decided" marker (NULL = never decided).
CREATE TYPE "EuVatRegime" AS ENUM ('IOSS', 'VOEC', 'DDP');
ALTER TABLE "sales_orders" ADD COLUMN "eu_vat_regime" "EuVatRegime";
ALTER TABLE "sales_orders" ADD COLUMN "eu_vat_line_account" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "eu_vat_regime_stamped_at" TIMESTAMP(3);
ALTER TABLE "sales_orders" ADD COLUMN "eu_vat_regime_basis" JSONB;
-- A regime always travels with its account and its marker.
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_eu_vat_regime_stamp_shape"
  CHECK ("eu_vat_regime" IS NULL OR ("eu_vat_line_account" IS NOT NULL AND "eu_vat_regime_stamped_at" IS NOT NULL));
