-- The tax treatment each supplier-bill line was BOOKED with (code sent, effective rate, IMS rate id, reverse-charge flag), so an edit or a supplier credit note
-- reproduces what was booked instead of re-deriving it from the purchase order's current rate, which can change afterwards. "taxBookedAt" is the marker: NULL
-- reads as a line booked before the snapshot existed.
--
-- ADDITIVE ONLY: five nullable columns on an existing table, no default, no backfill (an existing line reads as "no snapshot").
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "taxType" TEXT;
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "taxRateValue" DECIMAL(9,6);
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "taxRateId" TEXT;
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "taxReverseCharge" BOOLEAN;
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "taxBookedAt" TIMESTAMP(3);
