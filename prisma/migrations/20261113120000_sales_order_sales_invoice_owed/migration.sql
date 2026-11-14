-- Records that a sales invoice is OWED by an imported order until it is queued or parked. ADDITIVE ONLY: one nullable column, no default, no backfill.
--
-- Set in the transaction that creates a WooCommerce-imported order the import will invoice; cleared in the transaction that queues the invoice or parks it as a held
-- invoice. NULL for every order that exists today, so an existing order behaves exactly as before.
ALTER TABLE "sales_orders" ADD COLUMN "sales_invoice_owed_at" TIMESTAMP(3);
