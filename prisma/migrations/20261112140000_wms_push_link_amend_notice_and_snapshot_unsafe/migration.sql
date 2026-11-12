-- Two nullable markers on the warehouse push link. ADDITIVE ONLY, no default, no backfill (existing links read as "none").
--
-- amend_notice_at: IMS changed an order the warehouse had merged into another order and did not amend the merged order; shown in the
-- exception inbox until an operator acknowledges it.
-- line_snapshot_unsafe_at: set before IMS amends a warehouse order's lines and cleared only by a verified fresh snapshot of its line ids,
-- so a failed cleanup can never leave stale ids looking trustworthy (the merged-order line removal refuses while it is set).
ALTER TABLE "wms_order_push_links" ADD COLUMN "amend_notice_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "line_snapshot_unsafe_at" TIMESTAMP(3);
