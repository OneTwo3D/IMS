-- The credit note IMS raised for a partial payment removal. ADDITIVE ONLY: one nullable column and one index on payment_removal_reconciliations.
-- NULL = no credit note raised (every existing row, and every row while the setting xero_partial_payment_removal_credit_note_enabled is off). No backfill.
ALTER TABLE "payment_removal_reconciliations" ADD COLUMN "refund_id" TEXT;
CREATE INDEX "payment_removal_reconciliations_refund_id_idx" ON "payment_removal_reconciliations"("refund_id");
