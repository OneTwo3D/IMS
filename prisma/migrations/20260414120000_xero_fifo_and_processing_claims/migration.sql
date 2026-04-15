ALTER TYPE "AccountingSyncStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TABLE "accounting_sync_logs"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);

ALTER TABLE "order_allocations"
  ADD COLUMN "costLayerSnapshot" JSONB;

ALTER TABLE "shipment_lines"
  ADD COLUMN "costLayerSnapshot" JSONB;

ALTER TABLE "sales_order_refund_lines"
  ADD COLUMN "costLayerSnapshot" JSONB;

CREATE INDEX "accounting_sync_logs_status_processingStartedAt_idx"
  ON "accounting_sync_logs"("status", "processingStartedAt");
