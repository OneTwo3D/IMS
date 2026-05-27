ALTER TABLE "wms_inbound_receipt_events"
  ADD COLUMN "reviewDetails" JSONB,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedBy" TEXT;

ALTER TABLE "wms_inbound_receipt_events"
  DROP CONSTRAINT "wms_inbound_receipt_events_processing_status_check";

ALTER TABLE "wms_inbound_receipt_events"
  ADD CONSTRAINT "wms_inbound_receipt_events_processing_status_check"
  CHECK ("processingStatus" IN ('PENDING', 'PENDING_RETRY', 'FAILED_RETRY', 'REQUIRES_REVIEW', 'DEAD', 'PROCESSED')) NOT VALID;

ALTER TABLE "wms_inbound_receipt_events"
  VALIDATE CONSTRAINT "wms_inbound_receipt_events_processing_status_check";
