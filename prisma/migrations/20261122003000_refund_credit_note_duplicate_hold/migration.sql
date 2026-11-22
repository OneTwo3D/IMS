-- o3d-0lpnb / o3d-pnc8p (#1127 R1 M6): a credit note Xero holds that IMS did not raise, held as a possible DUPLICATE of a refund's credit note, and the operator's
-- acknowledgement that it is not. Additive, nullable JSON, no backfill.
--   credit_note_duplicate_hold     the credit notes the last check held this refund on: [{ creditNoteId, creditNoteNumber, status, total, date }] (no reference text).
--   credit_note_not_duplicate      the operator's acknowledgements: [{ creditNoteId, creditNoteNumber, by, reason, at }]; the duplicate test skips those credit notes.
ALTER TABLE "sales_order_refunds" ADD COLUMN "credit_note_duplicate_hold" JSONB;
ALTER TABLE "sales_order_refunds" ADD COLUMN "credit_note_not_duplicate" JSONB;
