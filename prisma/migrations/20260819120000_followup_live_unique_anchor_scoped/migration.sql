-- prisma-schema-scope-ok: db-native partial UNIQUE index over JSONB expressions — Prisma can represent
-- neither a WHERE predicate nor an expression key, so this cannot live in schema.prisma.
--
-- o3d-a3wx / o3d-cjt8 / o3d-hbgo: make the live-follow-up uniqueness key name THE THING IT MAKES UNIQUE.
--
-- THE RULE. A follow-up's live-row key must identify the REMOTE ARTEFACT its handler would create, and
-- nothing else: the connection, the type, the local reference, EXACTLY the anchor fields that type's
-- handler dereferences to address the remote system, plus a per-instance term for the one type whose
-- artefact is per-receipt rather than per-document. That is the row-level twin of the rule o3d-h2wx
-- settled for the remote idempotency TOKEN ("a type's anchors are exactly the payload fields its probe
-- dereferences") — and it has to be, because a row-level dedup scoped MORE COARSELY than the token it
-- would post under can only ever discard work the token was already able to tell apart.
--
-- Measured against that rule, the audit-42co / audit-w77e key (connector, type, referenceType,
-- referenceId) named too little in three separate ways:
--
--   o3d-a3wx  BILL_PAYMENT was not covered AT ALL, though its handler posts a real supplier payment
--             (xero/sync-processor.ts case 'BILL_PAYMENT' -> POST Payments). Errs PERMISSIVE: nothing
--             below the application guard stopped two live rows, i.e. two supplier payments.
--   o3d-cjt8  INVOICE_PAYMENT was keyed per ORDER, but a Xero Payment is per RECEIPT: a deposit and a
--             balance are two artefacts, not one. Errs RESTRICTIVE: the second receipt is stranded and
--             has to be keyed into Xero by hand.
--   o3d-hbgo  No arm named the TARGET DOCUMENT. An order whose invoice is deleted and re-posted keeps
--             the SYNCED row from the first invoice, so the payment (and the PDF) for the replacement
--             is skipped as already-done. Errs RESTRICTIVE, and silently: a skip logs nothing.
--
-- THE KEY, per type. The COALESCE(...,'') terms are the whole key for types that carry no such field,
-- so their behaviour is unchanged:
--
--   INVOICE_PAYMENT                  + accountingInvoiceId + paymentId   (per receipt, per document)
--   BILL_PAYMENT                     + accountingInvoiceId               (per bill settlement)
--   INVOICE_PDF, BILL_ATTACHMENT     + accountingInvoiceId               (per document)
--   PURCHASE_CREDIT_NOTE_ALLOCATION  + creditNoteId + accountingInvoiceId (per credit, per bill)
--   INVOICE_EMAIL, WC_INVOICE_NOTE   unchanged — their handlers dereference NO external document
--                                    (payload is { referenceId, sourceEntryId }), so per-order is right.
--
-- WHAT THIS DELIBERATELY STOPS ENFORCING. Splitting INVOICE_PAYMENT by paymentId means the database no
-- longer prevents an ORDER being over-settled by several receipts; it only prevents the SAME receipt
-- being registered twice. That is not a regression in rigour, it is a correction of category: "the parts
-- must not exceed the whole" is arithmetic and no unique index can express it. The arithmetic moved to
-- decideInvoicePaymentRegistration (capacity = ledger total - live registrations against THIS document),
-- which is also where an unreadable amount now fails closed.
--
-- PRE-EXISTING VIOLATORS. For the six types already covered, the new key is the old key plus extra
-- columns — strictly MORE permissive — so no row that satisfied the old index can violate this one. The
-- only new exposure is BILL_PAYMENT, which was never constrained. Unlike 20260613020000 and
-- 20260615000000, this migration does NOT delete the losers: those are rows recording money that may
-- already have moved in the ledger, and "keep the highest id" is a guess about which payment is real.
-- It refuses to deploy instead, naming how many groups collide, and leaves the old index in place. Run
-- this first to see them:
--
--   SELECT connector, type, "referenceType", "referenceId",
--          COALESCE(payload ->> 'accountingInvoiceId', '') AS doc,
--          COALESCE(payload ->> 'paymentId', '')           AS receipt,
--          count(*), array_agg(id ORDER BY "createdAt")
--   FROM "accounting_sync_logs"
--   WHERE status IN ('PENDING','PROCESSING','SYNCED')
--     AND type IN ('INVOICE_PAYMENT','BILL_PAYMENT','BILL_ATTACHMENT','INVOICE_PDF','INVOICE_EMAIL',
--                  'WC_INVOICE_NOTE','PURCHASE_CREDIT_NOTE_ALLOCATION')
--   GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1;
--
-- Resolve each by hand — reconcile the payments in the ledger, then CANCEL the superseded row (which
-- takes it out of the live predicate without destroying the evidence that it was posted) — and re-run.
--
-- WHY NOT CREATE INDEX CONCURRENTLY. The dedup pre-check and the build must see the same table state, so
-- they are wrapped in one explicit transaction holding SHARE ROW EXCLUSIVE (Prisma 7.8's runner does not
-- auto-wrap a migration file; 20260721150000 established this shape). CONCURRENTLY cannot run inside a
-- transaction at all, and Postgres would put a multi-statement simple-query string into an implicit one
-- regardless — and a concurrent build that fails its second pass leaves an INVALID index behind, which
-- the planner ignores while INSERTs still maintain it. On a UNIQUE index that is the worst of both: an
-- index nobody plans with that still rejects money rows. This table is small and writers block only for
-- the brief non-concurrent build.
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
                   'WC_INVOICE_NOTE', 'PURCHASE_CREDIT_NOTE_ALLOCATION')
    GROUP BY connector, type, "referenceType", "referenceId",
             COALESCE(payload ->> 'accountingInvoiceId', ''),
             COALESCE(payload ->> 'creditNoteId', ''),
             COALESCE(payload ->> 'paymentId', '')
    HAVING count(*) > 1
  ) x;
  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Refusing to build accounting_sync_logs_followup_live_unique: % group(s) of live follow-up rows already share the new key (expected only for BILL_PAYMENT, which was previously unconstrained). These rows record money that may already have moved in the ledger, so this migration will not pick a survivor for you. Reconcile each group in the ledger, CANCEL the superseded rows, and re-run. The query that lists them is in this migration''s header.',
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
  -- COALESCE, not the bare expression: a bare NULL never conflicts in a unique index, so unanchored
  -- rows would each get their own free slot and the one-live-row rule would quietly stop applying to
  -- exactly the legacy rows that most need it. '' collapses them into a single shared slot instead.
  (COALESCE("payload" ->> 'accountingInvoiceId', '')),
  (COALESCE("payload" ->> 'creditNoteId', '')),
  (COALESCE("payload" ->> 'paymentId', ''))
)
WHERE "status" IN ('PENDING', 'PROCESSING', 'SYNCED')
  AND "type" IN ('INVOICE_PAYMENT', 'BILL_PAYMENT', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'INVOICE_EMAIL',
                 'WC_INVOICE_NOTE', 'PURCHASE_CREDIT_NOTE_ALLOCATION');

COMMIT;
