-- Mark supplier credit notes that were auto-created by the supplier-return flow,
-- so return-credit top-ups net only against prior return credits (not manual
-- allowances). NOT NULL is safe here because every existing/new row gets the
-- DEFAULT false (existing rows are either manual or pre-flag return credits;
-- treating them as manual is the conservative choice — it never suppresses a
-- future return credit).
ALTER TABLE "supplier_credit_notes" ADD COLUMN "isReturnGenerated" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing auto-created return credits so the new return-credit netting
-- recognises them. Without this, a PO whose prior auto return credit predates
-- this column would have it treated as a manual credit (isReturnGenerated=false),
-- so the next return tops up from a zero baseline and could DOUBLE-CREDIT the same
-- returned goods. The return flow always records reason 'Supplier return …' and a
-- reference 'RTN-…', so match either.
UPDATE "supplier_credit_notes"
SET "isReturnGenerated" = true
WHERE "reason" LIKE 'Supplier return %'
   OR "reference" LIKE 'RTN-%';
