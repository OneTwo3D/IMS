ALTER TABLE "sales_order_refunds"
  ADD COLUMN IF NOT EXISTS "accounting_retry_syncs" JSONB;
