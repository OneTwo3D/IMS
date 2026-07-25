-- o3d-bjc: dedicated dispatch-sweep reconcile-recency cursor. The throttled
-- per-order reconcile pass orders by this (nulls first) and stamps every link it
-- verifies (via the Order/List delta or the per-order poll), so links beyond the
-- first `batchSize` rotate in instead of the same oldest orders being re-polled
-- forever. Kept separate from reconcileCheckedAt (owned by the q66in.4.4
-- order-reconcile sweep) so the two sweeps don't clobber each other's rotation.
ALTER TABLE "wms_order_push_links" ADD COLUMN "dispatchReconcileCheckedAt" TIMESTAMP(3);

CREATE INDEX "wms_order_push_links_connector_dispatchReconcileCheckedAt_idx" ON "wms_order_push_links"("connector", "dispatchReconcileCheckedAt");
