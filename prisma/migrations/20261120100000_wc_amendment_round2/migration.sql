-- Intentionally idempotent no-op. This folder name was committed on the (unmerged, never deployed) branch before the migration was moved back to 20261120000000_wc_amendment_round2, and a committed migration may never be removed. The DDL and the data backfill live there.
ALTER TABLE "sales_orders" ADD COLUMN IF NOT EXISTS "wc_seen_lines" JSONB;
