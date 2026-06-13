-- audit-42co: enforce the follow-up dedup that enqueueFollowUpSyncLog/hasExistingSyncLog
-- does at the app level with a DB-level PARTIAL unique index, so two concurrent
-- cron/manual sync runs can't slip a duplicate follow-up row between the
-- check and the create (e.g. double INVOICE_PAYMENT -> double payment in Xero).
--
-- Scoped EXACTLY to hasExistingSyncLog's dedup key: the five follow-up types, and
-- only LIVE statuses (PENDING/PROCESSING/SYNCED). FAILED/CANCELLED rows are
-- excluded so a failed follow-up can still be re-enqueued, matching existing
-- behaviour. Other sync types (which legitimately have no such single-row
-- invariant) are untouched.

-- Safety net: drop any pre-existing live-follow-up duplicates (idempotent log
-- rows; the kept row — highest id — represents the work) so the unique index can
-- be created. On a clean DB this is a no-op.
DELETE FROM "accounting_sync_logs" a
USING "accounting_sync_logs" b
WHERE a."status" IN ('PENDING','PROCESSING','SYNCED')
  AND b."status" IN ('PENDING','PROCESSING','SYNCED')
  AND a."type" = b."type"
  AND a."type" IN ('INVOICE_PAYMENT','BILL_ATTACHMENT','INVOICE_PDF','INVOICE_EMAIL','WC_INVOICE_NOTE')
  AND a."connector" = b."connector"
  AND a."referenceType" = b."referenceType"
  AND a."referenceId" = b."referenceId"
  AND a."id" < b."id";

CREATE UNIQUE INDEX "accounting_sync_logs_followup_live_unique"
ON "accounting_sync_logs" ("connector", "type", "referenceType", "referenceId")
WHERE "status" IN ('PENDING','PROCESSING','SYNCED')
  AND "type" IN ('INVOICE_PAYMENT','BILL_ATTACHMENT','INVOICE_PDF','INVOICE_EMAIL','WC_INVOICE_NOTE');
