-- Mirror of WooCommerce's duty / tax results (nullable, additive; existing rows are not backfilled, the next import/update fills them).
-- The shop's IOSS number WooCommerce applied to the order, and the delivery term (IOSS_DDP | DDP | DDU_DAP).
ALTER TABLE "sales_orders" ADD COLUMN "ioss_number" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "delivery_term" TEXT;
-- The per-unit customs value override (line meta _wc_label_customs_unit_value), order currency.
ALTER TABLE "sales_order_lines" ADD COLUMN "wc_customs_unit_value" DECIMAL(18,6);
-- The WooCommerce tariff codes: pa_us_hs_code, and the per-destination _dutify_hs_codes map. Separate from the IMS-owned hs_code.
ALTER TABLE "products" ADD COLUMN "wc_us_hs_code" TEXT;
ALTER TABLE "products" ADD COLUMN "wc_dutify_hs_codes" JSONB;
