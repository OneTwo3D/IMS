-- 6oyu.2: first-class dispatch-reconciliation dead-letter on the push link.
-- Consecutive per-order reconcile failures are counted; at the cap the link is
-- dead-lettered and leaves the dispatch sweep's candidate set.
ALTER TABLE "wms_order_push_links" ADD COLUMN "dispatchFailureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wms_order_push_links" ADD COLUMN "dispatchLastError" TEXT;
ALTER TABLE "wms_order_push_links" ADD COLUMN "dispatchDeadLetteredAt" TIMESTAMP(3);

CREATE INDEX "wms_order_push_links_dispatchDeadLetteredAt_idx" ON "wms_order_push_links"("dispatchDeadLetteredAt");
