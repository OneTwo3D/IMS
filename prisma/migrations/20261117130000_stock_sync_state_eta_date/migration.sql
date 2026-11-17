-- Additive: the back-in-stock date last pushed to WooCommerce per product, so a changed or lapsed date is re-pushed and a cleared one is not re-sent. Nullable, no default, no row touched.
ALTER TABLE "stock_sync_states" ADD COLUMN "lastPushedEtaDate" TEXT;
