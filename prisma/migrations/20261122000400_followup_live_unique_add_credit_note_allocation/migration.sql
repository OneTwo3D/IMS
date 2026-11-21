-- prisma-schema-scope-ok: db-native partial UNIQUE index over JSONB expressions — Prisma can represent
-- neither a WHERE predicate nor an expression key, so this cannot live in schema.prisma.
--
-- o3d-o4tkz: bring the sales credit-note settlement row (CREDIT_NOTE_ALLOCATION, behind
-- xero_credit_note_allocation_enabled, default off) under accounting_sync_logs_followup_live_unique, the way
-- 20260615000000 brought PURCHASE_CREDIT_NOTE_ALLOCATION under it. Without it the post-hook and the sweep (or cron
-- and a manual retry) could each create a live row for one refund; the double post was then stopped only by the
-- document lock, the ledger probe and Xero's idempotency window.
--
-- THE KEY is unchanged from 20260819120000 (connector, type, referenceType, referenceId, and the three
-- COALESCE'd anchors accountingInvoiceId / creditNoteId / paymentId). CREDIT_NOTE_ALLOCATION carries
-- accountingInvoiceId + creditNoteId (settlementDocumentKey anchors in money-post-document.ts), so a settlement
-- is unique per refund, per credit note, per invoice. This ONLY widens the type list, i.e. the index becomes
-- strictly MORE restrictive for the one new type and identical for every other.
--
-- EXISTING VIOLATORS. The setting is off by default and nothing creates the type while it is off, so there should
-- be none. Like 20260819120000 (and unlike 20260615000000) this migration NEVER deletes a row: a settlement row
-- records cash that may already have left the bank. If a group of live rows already shares the key it refuses to
-- deploy, names how many groups collide, and leaves the old index in place. To see them:
--
--   SELECT connector, type, "referenceType", "referenceId",
--          COALESCE(payload ->> 'accountingInvoiceId', '') AS doc,
--          COALESCE(payload ->> 'creditNoteId', '')        AS credit_note,
--          count(*), array_agg(id ORDER BY "createdAt")
--   FROM "accounting_sync_logs"
--   WHERE status IN ('PENDING','PROCESSING','SYNCED') AND type = 'CREDIT_NOTE_ALLOCATION'
--   GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1;
--
-- Reconcile each against the credit note in Xero, CANCEL the superseded row (that takes it out of the live
-- predicate without destroying the evidence), and re-run.
--
-- WHY ONE TRANSACTION, NOT CONCURRENTLY: see 20260819120000 (the pre-check and the build must see one table state,
-- and a failed concurrent UNIQUE build leaves an INVALID index that still rejects rows).
BEGIN;

LOCK TABLE "accounting_sync_logs" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  collisions int;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT 1
    FROM "accounting_sync_logs"
    WHERE status IN ('PENDING', 'PROCESSING', 'SYNCED')
      AND type IN ('INVOICE_PAYMENT', 'BILL_PAYMENT', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'INVOICE_EMAIL',
                   'WC_INVOICE_NOTE', 'PURCHASE_CREDIT_NOTE_ALLOCATION', 'CREDIT_NOTE_ALLOCATION')
    GROUP BY connector, type, "referenceType", "referenceId",
             COALESCE(payload ->> 'accountingInvoiceId', ''),
             COALESCE(payload ->> 'creditNoteId', ''),
             COALESCE(payload ->> 'paymentId', '')
    HAVING count(*) > 1
  ) x;
  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Refusing to rebuild accounting_sync_logs_followup_live_unique: % group(s) of live follow-up rows already share the key once CREDIT_NOTE_ALLOCATION is included. These rows record cash that may already have left the bank, so this migration will not pick a survivor for you. Reconcile each group in Xero, CANCEL the superseded rows, and re-run. The query that lists them is in this migration''s header.',
      collisions;
  END IF;
END $$;

DROP INDEX IF EXISTS "accounting_sync_logs_followup_live_unique";

CREATE UNIQUE INDEX "accounting_sync_logs_followup_live_unique"
ON "accounting_sync_logs" (
  "connector",
  "type",
  "referenceType",
  "referenceId",
  (COALESCE("payload" ->> 'accountingInvoiceId', '')),
  (COALESCE("payload" ->> 'creditNoteId', '')),
  (COALESCE("payload" ->> 'paymentId', ''))
)
WHERE "status" IN ('PENDING', 'PROCESSING', 'SYNCED')
  AND "type" IN ('INVOICE_PAYMENT', 'BILL_PAYMENT', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'INVOICE_EMAIL',
                 'WC_INVOICE_NOTE', 'PURCHASE_CREDIT_NOTE_ALLOCATION', 'CREDIT_NOTE_ALLOCATION');

COMMIT;
