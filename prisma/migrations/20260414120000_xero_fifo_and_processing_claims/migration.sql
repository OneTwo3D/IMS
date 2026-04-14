ALTER TYPE "XeroSyncStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TABLE "xero_sync_logs"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);

ALTER TABLE "order_allocations"
  ADD COLUMN "costLayerSnapshot" JSONB;

ALTER TABLE "shipment_lines"
  ADD COLUMN "costLayerSnapshot" JSONB;

ALTER TABLE "sales_order_refund_lines"
  ADD COLUMN "costLayerSnapshot" JSONB;

CREATE INDEX "xero_sync_logs_status_processingStartedAt_idx"
  ON "xero_sync_logs"("status", "processingStartedAt");
