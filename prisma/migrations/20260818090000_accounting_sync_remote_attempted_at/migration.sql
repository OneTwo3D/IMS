-- o3d-0m56: when this sync row first made a REMOTE money call.
--
-- A FAILED status does not mean the ledger never saw the request: a call that committed and then
-- lost its response lands as a failure too. Every path that re-posts a money row therefore has to
-- establish what the ledger actually holds first — but "is this a re-post?" was not a question the
-- row could answer. retryCount is reset to 0 by both the manual retry and the automatic revival, so
-- it forgets, and the payload says nothing about attempts.
--
-- This column is set once, immediately BEFORE the first remote money call, and never cleared. It is
-- what makes the check at the posting site itself possible: with it set, no INVOICE_PAYMENT,
-- BILL_PAYMENT or PURCHASE_CREDIT_NOTE_ALLOCATION is sent again without a positive reading of the
-- target document.
--
-- NULLABLE on purpose. NULL has to keep meaning "no remote call has been attempted from this row",
-- or every newly queued row would look like a repeat and pay for a ledger read it has no reason to
-- make. That is why the column is added without a default and claimed by an explicit conditional
-- write, and why the backfill below sets a value only for the rows that need one.
--
-- ONE TRANSACTION, and it is not decoration. Prisma's runner does not wrap a migration file, so
-- without this an interruption between the two statements below leaves the column added and every
-- pre-existing money row unstamped — which is exactly the free-first-post hole the backfill exists
-- to close, and it would look like a completed migration.
BEGIN;

ALTER TABLE "accounting_sync_logs" ADD COLUMN "remoteAttemptedAt" TIMESTAMP(3);

-- BACKFILL, conservatively (Codex round 3, critical).
--
-- Leaving existing rows NULL would hand every one of them a free first post: a PENDING row mid-retry,
-- a stale PROCESSING row, or a historical FAILED row may already have reached the ledger, and the
-- first execution after this deploy would claim the NULL stamp and send again without asking. That is
-- precisely the lost-response duplicate this column exists to stop, reintroduced at rollout.
--
-- So every pre-existing money-moving row is stamped. "It might have been attempted" is the only
-- honest reading of a row this code has never seen, and the cost of being wrong is one extra GET
-- before its next post. The value is the best lower bound the row itself carries — when it synced,
-- when it was last picked up, or failing both when it was created — never now(), which would claim
-- an attempt happened at deploy time.
UPDATE "accounting_sync_logs"
SET "remoteAttemptedAt" = COALESCE("syncedAt", "processingStartedAt", "createdAt")
WHERE "type" IN ('INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION');

COMMIT;
