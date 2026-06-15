-- audit-w77e: extend the audit-42co partial unique index to cover the new
-- PURCHASE_CREDIT_NOTE_ALLOCATION follow-up type, so two concurrent cron/manual
-- sweeps can't slip a duplicate allocation row between hasExistingSyncLog's check
-- and the create (which would risk a double credit-note allocation in Xero).
--
-- Same shape as 20260613020000: LIVE statuses only (PENDING/PROCESSING/SYNCED);
-- FAILED/CANCELLED stay excluded so a failed allocation can be re-enqueued.

-- Drop any pre-existing live duplicates for the new type before widening the index
-- (idempotent; a no-op on a clean DB). Keeps the highest id.
DELETE FROM "accounting_sync_logs" a
USING "accounting_sync_logs" b
WHERE a."status" IN ('PENDING','PROCESSING','SYNCED')
  AND b."status" IN ('PENDING','PROCESSING','SYNCED')
  AND a."type" = 'PURCHASE_CREDIT_NOTE_ALLOCATION'
  AND b."type" = 'PURCHASE_CREDIT_NOTE_ALLOCATION'
  AND a."connector" = b."connector"
  AND a."referenceType" = b."referenceType"
  AND a."referenceId" = b."referenceId"
  AND a."id" < b."id";

DROP INDEX IF EXISTS "accounting_sync_logs_followup_live_unique";

CREATE UNIQUE INDEX "accounting_sync_logs_followup_live_unique"
ON "accounting_sync_logs" ("connector", "type", "referenceType", "referenceId")
WHERE "status" IN ('PENDING','PROCESSING','SYNCED')
  AND "type" IN ('INVOICE_PAYMENT','BILL_ATTACHMENT','INVOICE_PDF','INVOICE_EMAIL','WC_INVOICE_NOTE','PURCHASE_CREDIT_NOTE_ALLOCATION');
