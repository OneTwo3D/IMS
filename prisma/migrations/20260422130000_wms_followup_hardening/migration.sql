UPDATE "wms_connections"
SET "label" = 'Primary'
WHERE "label" IS NULL OR btrim("label") = '';

ALTER TABLE "wms_connections"
  ALTER COLUMN "label" SET DEFAULT 'Primary';

ALTER TABLE "wms_connections"
  ALTER COLUMN "label" SET NOT NULL;

DROP INDEX IF EXISTS "wms_connections_connector_key";

CREATE UNIQUE INDEX "wms_connections_connector_label_key"
  ON "wms_connections"("connector", "label");

ALTER TABLE "wms_asn_line_maps"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "wms_sync_logs"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "wms_bundle_links_productId_idx"
  ON "wms_bundle_links"("productId");

CREATE INDEX IF NOT EXISTS "wms_sync_jobs_warehouseId_type_startedAt_idx"
  ON "wms_sync_jobs"("warehouseId", "type", "startedAt");

CREATE INDEX IF NOT EXISTS "wms_stock_discrepancies_warehouseId_status_idx"
  ON "wms_stock_discrepancies"("warehouseId", "status");

CREATE INDEX IF NOT EXISTS "wms_inbound_receipt_events_unprocessed_idx"
  ON "wms_inbound_receipt_events"("connector", "receivedAt")
  WHERE "processedAt" IS NULL;

ALTER TABLE "wms_stock_discrepancies"
  DROP CONSTRAINT IF EXISTS "wms_stock_discrepancies_warehouseId_fkey";

ALTER TABLE "wms_stock_discrepancies"
  ADD CONSTRAINT "wms_stock_discrepancies_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
