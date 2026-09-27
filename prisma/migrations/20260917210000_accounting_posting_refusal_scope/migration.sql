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
-- o3d-j625 r6 (review H1) — EDITED IN PLACE, BEFORE ANY PERSISTENT DATABASE APPLIED IT. As first written
-- this added `scope` NULLABLE while the schema declares it required, and created the unique index under a
-- 68-character name that Postgres truncates to 63 (`…_scop`) while Prisma expects its own truncation
-- (`…_referenceId__key`); `scripts/check-prisma-drift.mjs` failed on both a fresh and a dev-first database,
-- which stops deploy.sh / update.sh / install.sh. Only throwaway `ims_scratch_*` databases (all dropped)
-- ever ran the first version: onetwo3d_ims_dev has no 2026-09 j625 migration. NOT NULL with a default
-- fills existing rows in the same statement, and the index carries the explicit name the schema maps.
ALTER TABLE "accounting_posting_refusals" ADD COLUMN "scope" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "accounting_posting_refusals_type_referenceType_referenceId_key";
CREATE UNIQUE INDEX "accounting_posting_refusals_posting_key"
    ON "accounting_posting_refusals"("type", "referenceType", "referenceId", "scope");

-- The section lists OLDEST DEBT FIRST, so the index that serves it is the one on (resolvedAt, firstRefusedAt).
DROP INDEX IF EXISTS "accounting_posting_refusals_resolvedAt_lastRefusedAt_idx";
CREATE INDEX "accounting_posting_refusals_resolvedAt_firstRefusedAt_idx"
    ON "accounting_posting_refusals"("resolvedAt", "firstRefusedAt");
