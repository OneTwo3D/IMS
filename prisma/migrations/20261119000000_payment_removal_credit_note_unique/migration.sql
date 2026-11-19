-- One credit note per payment removal record: refund_id is unique where set (NULLs are distinct, so every record without a credit note is unaffected). ADDITIVE ONLY: one unique index, no data change.
CREATE UNIQUE INDEX "payment_removal_reconciliations_refund_id_key" ON "payment_removal_reconciliations"("refund_id");
