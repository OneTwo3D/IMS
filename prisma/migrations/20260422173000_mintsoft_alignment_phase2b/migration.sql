ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'WMS_RECEIPT_RECONCILIATION';
ALTER TYPE "WmsSyncLogAction" ADD VALUE IF NOT EXISTS 'corrected';

ALTER TABLE "purchase_receipts"
  ADD COLUMN "externalKey" TEXT;

ALTER TABLE "purchase_receipt_lines"
  ADD COLUMN "coveredBySnapshotQty" DECIMAL(12, 4) NOT NULL DEFAULT 0;

ALTER TABLE "external_wms_bindings"
  ADD COLUMN "alignmentConfirmedAt" TIMESTAMP(3);

ALTER TABLE "wms_asn_line_maps"
  ADD COLUMN "note" TEXT;

CREATE UNIQUE INDEX "purchase_receipts_externalKey_key"
ON "purchase_receipts"("externalKey");

