-- Mirror of the wclc EU customs fee metadata (nullable, new imports only; existing rows are not backfilled).
-- Which wclc fee a mirrored WooCommerce fee line is (duty_flat | uhf | duty_fee).
ALTER TABLE "sales_order_lines" ADD COLUMN "wclc_fee_kind" TEXT;
-- The order-level duty / import-VAT / handling split, in the order currency.
ALTER TABLE "sales_orders" ADD COLUMN "wclc_duty_component" DECIMAL(18,4);
ALTER TABLE "sales_orders" ADD COLUMN "wclc_tax_component" DECIMAL(18,4);
ALTER TABLE "sales_orders" ADD COLUMN "wclc_handling_component" DECIMAL(18,4);
