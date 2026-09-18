-- o3d-j625 r5 (independent review HIGH 3) — THE ROW'S KEY MUST BE THE POSTING'S KEY.
--
-- r4 keyed an outstanding refusal on (type, referenceType, referenceId). Several postings are finer than
-- their document: an INVOICE_PAYMENT is one RECEIPT against one invoice, a stock receipt is one receipt of
-- a purchase order, a landed-cost journal is one adjustment run. Keyed on the document alone, a refused
-- deposit's row was resolved by a later balance succeeding — the ledger short, the inbox empty.
--
-- `scope` is the obligation discriminator the ENQUEUE itself already carries (its idempotency key, or the
-- receipt named in an INVOICE_PAYMENT payload), or '' where the document IS the obligation. It is derived
-- by one function that both the writer and the clear call, so a row cannot be recorded under a key its own
-- clear will not match.
--
-- Nullable-with-default rather than NOT NULL: no marker is needed, and every writer sets it explicitly.
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "scope" TEXT DEFAULT '';
UPDATE "accounting_posting_refusals" SET "scope" = '' WHERE "scope" IS NULL;

DROP INDEX IF EXISTS "accounting_posting_refusals_type_referenceType_referenceId_key";
CREATE UNIQUE INDEX "accounting_posting_refusals_type_referenceType_referenceId_scope_key"
    ON "accounting_posting_refusals"("type", "referenceType", "referenceId", "scope");

-- The section lists OLDEST DEBT FIRST, so the index that serves it is the one on (resolvedAt, firstRefusedAt).
DROP INDEX IF EXISTS "accounting_posting_refusals_resolvedAt_lastRefusedAt_idx";
CREATE INDEX "accounting_posting_refusals_resolvedAt_firstRefusedAt_idx"
    ON "accounting_posting_refusals"("resolvedAt", "firstRefusedAt");
