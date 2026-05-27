ALTER TABLE "wms_inbound_receipt_events"
  ADD COLUMN "reviewDetails" JSONB,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  -- Intentionally not a foreign key: review audit history must survive user deletion.
  ADD COLUMN "reviewedBy" TEXT;

ALTER TABLE "wms_inbound_receipt_events"
  DROP CONSTRAINT "wms_inbound_receipt_events_processing_status_check";

ALTER TABLE "wms_inbound_receipt_events"
  ADD CONSTRAINT "wms_inbound_receipt_events_processing_status_check"
  CHECK ("processingStatus" IN ('PENDING', 'PENDING_RETRY', 'FAILED_RETRY', 'REQUIRES_REVIEW', 'DEAD', 'PROCESSED')) NOT VALID;

-- Existing Mintsoft webhook rows may be present. VALIDATE scans the table, so deploy during a
-- normal migration window if this inbox has grown large.
ALTER TABLE "wms_inbound_receipt_events"
  VALIDATE CONSTRAINT "wms_inbound_receipt_events_processing_status_check";
