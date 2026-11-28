-- expand-only
-- Per-event FX rates for purchasing (switch and interlock off): when a confirmation's journal was first HELD (no Xero organisation connected, so the
-- tenant could not be compared), so the hold is reported once and visible until the journal catches up; and an index on the confirmation history by
-- order. Additive: a nullable column and an index, no backfill.

ALTER TABLE "purchase_fx_non_ims_bill_approvals" ADD COLUMN "held_since" TIMESTAMP(3);
CREATE INDEX "purchase_fx_non_ims_bill_approval_history_po_id_idx" ON "purchase_fx_non_ims_bill_approval_history"("po_id");
