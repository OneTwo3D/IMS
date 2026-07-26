-- o3d-sref: cancelOrphanedAccountingSyncRows retires a stale PROCESSING claim. The claim having been
-- TAKEN means the processor may already have made its remote call — they post BEFORE persisting
-- SYNCED and the externalTransactionId — and then died without recording the result. Retiring it as
-- plain CANCELLED told the order delete guard the row was deliberately abandoned, so a hard delete
-- was permitted and a late remote success then stranded the external document against an order that
-- no longer existed.
--
-- A FLAG, not a new AccountingSyncStatus value. Eighteen code paths enumerate
-- ('PENDING','PROCESSING','SYNCED') and one partial unique index repeats it; several functions switch
-- on status without exhaustiveness. A new enum member forces a correct decision at every one of them
-- and fails SILENTLY wherever one is missed — by falling through to a success branch. A flag leaves
-- every existing path byte-identical until it deliberately opts in.
--
-- Additive and backfill-free: existing rows are false, which is the pre-existing behaviour.
ALTER TABLE "accounting_sync_logs"
  ADD COLUMN IF NOT EXISTS "remoteEffectUnverified" BOOLEAN NOT NULL DEFAULT false;

-- The follow-up dedup index must treat an unverified row as still-live, or a repeated follow-up
-- enqueue creates a NEW row with a NEW id — and both connectors derive their remote idempotency key
-- from the row id, so the replacement registers a SECOND payment even though the original may have
-- succeeded. That hazard predates this change (a plain CANCELLED row has always been re-enqueueable);
-- it is closed here because the flag finally makes the case identifiable.
DROP INDEX IF EXISTS "accounting_sync_logs_followup_live_unique";

CREATE UNIQUE INDEX "accounting_sync_logs_followup_live_unique"
ON "accounting_sync_logs" ("connector", "type", "referenceType", "referenceId")
WHERE ("status" IN ('PENDING','PROCESSING','SYNCED') OR "remoteEffectUnverified" = true)
  AND "type" IN ('INVOICE_PAYMENT','BILL_ATTACHMENT','INVOICE_PDF','INVOICE_EMAIL','WC_INVOICE_NOTE','PURCHASE_CREDIT_NOTE_ALLOCATION');
