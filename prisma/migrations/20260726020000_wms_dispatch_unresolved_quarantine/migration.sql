-- o3d-bjc.9: quarantine a record-local unresolved defect, separately from the
-- transport-failure counter (dispatchFailureCount). Folding the two together is
-- what let one schema change dead-letter an entire tenant.
ALTER TABLE "wms_order_push_links"
  ADD COLUMN "dispatchUnresolvedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dispatchUnresolvedError" TEXT,
  ADD COLUMN "dispatchUnresolvedAt" TIMESTAMP(3);

-- The sweep's candidate queries filter on this alongside dispatchDeadLetteredAt.
CREATE INDEX "wms_order_push_links_connector_dispatchUnresolvedAt_idx"
  ON "wms_order_push_links" ("connector", "dispatchUnresolvedAt");
