ALTER TABLE "wms_inbound_receipt_events"
  ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "processingAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextRetryAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT;

UPDATE "wms_inbound_receipt_events"
SET "processingStatus" = 'PROCESSED'
WHERE "processedAt" IS NOT NULL;

ALTER TABLE "wms_inbound_receipt_events"
  ADD CONSTRAINT "wms_inbound_receipt_events_processing_status_check"
  CHECK ("processingStatus" IN ('PENDING', 'PENDING_RETRY', 'FAILED_RETRY', 'DEAD', 'PROCESSED')) NOT VALID;

ALTER TABLE "wms_inbound_receipt_events"
  VALIDATE CONSTRAINT "wms_inbound_receipt_events_processing_status_check";

CREATE INDEX "wms_inbound_receipt_events_processingStatus_nextRetryAt_idx"
  ON "wms_inbound_receipt_events"("processingStatus", "nextRetryAt");

CREATE INDEX "wms_inbound_receipt_events_deadLetteredAt_idx"
  ON "wms_inbound_receipt_events"("deadLetteredAt");

ALTER TABLE "wms_inbound_receipt_events"
  DROP COLUMN "processingError";
