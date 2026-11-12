-- A durable per-link lease on the amendment of a warehouse order. ADDITIVE ONLY: two nullable columns, no default, no backfill.
--
-- The order-push sweep is not single-flight (the cron route only rate-limits it), so two sweeps could amend the same warehouse order.
-- The lease is taken by compare-and-set before the remote call and released after the line snapshot is written; while another owner's
-- lease is live the link is skipped, and an expired lease leaves the "line ids untrustworthy" mark set.
ALTER TABLE "wms_order_push_links" ADD COLUMN "amend_lease_owner" TEXT;
ALTER TABLE "wms_order_push_links" ADD COLUMN "amend_lease_expires_at" TIMESTAMP(3);
