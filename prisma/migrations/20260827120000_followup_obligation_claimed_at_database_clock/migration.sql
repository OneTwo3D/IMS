-- o3d-0bfh r8, Codex HIGH: THE BACKLOG'S SETTLING GRACE WAS TWO APPLICATION CLOCKS.
--
-- A retained `backReferenceFollowUpsPendingAt` on a connector with no consumer is the only record
-- that a payment, PDF, email or attachment is owed and that nothing will ever come back for it. The
-- exception inbox lists those rows, behind a five-minute settling grace so that the moment every
-- healthy post spends claimed-but-not-yet-released is not reported as a stall.
--
-- THE MARKER ITSELF CANNOT BE THE AGE. It is a generation, minted as max(now, observed + 1ms) so two
-- writers in one TIMESTAMP(3) millisecond cannot mint the value the other holds; under contention it
-- is a value that has not happened yet. r7 established that and moved the grace onto `syncedAt`.
--
-- BUT `syncedAt` IS WRITTEN BY THE APPLICATION HOST. The connectors set it with `new Date()` in the
-- SYNCED transaction, and the backlog compared it against a cutoff derived from `new Date()` on
-- whichever host renders the inbox. Two free-running clocks again — the exact disagreement
-- `syncedAtDatabaseClock` (migration 20260821090000) was added to this same table to make visible.
-- If the minting host runs ahead, or its clock is stepped backwards afterwards, `syncedAt` stays
-- above the cutoff and a genuinely stranded payment is HIDDEN from the only surface that reports it,
-- for as long as the two hosts disagree. Hiding is the failure direction that costs money here: the
-- row is already SYNCED, already counted successful, and indistinguishable from a completed one
-- except by this marker.
--
-- SO THE CLAIM CARRIES ITS OWN DATABASE-STAMPED WALL CLOCK. `claimFollowUpObligation` writes this
-- column from `clock_timestamp()` in the same transaction as, and immediately after, the
-- compare-and-set that mints the generation; the release that clears the generation clears this too.
-- The backlog ages it against a `clock_timestamp()` read from the SAME database. Both ends of the
-- comparison are then readings of one clock, and no application `new Date()` takes part.
--
-- `clock_timestamp()` AND NOT `now()`: `now()` is transaction-start time, and the claim rides inside
-- the SYNCED transaction, which is opened before the remote post returns. `clock_timestamp()` is
-- evaluated at the statement, so it is an upper bound on when the obligation was actually taken —
-- the conservative direction for an age (it lists later, never sooner than the truth).
--
-- `AT TIME ZONE 'UTC'` is not decoration: the column is TIMESTAMP(3) WITHOUT time zone and Prisma
-- reads it back as UTC, while `clock_timestamp()` is a timestamptz that would otherwise be cast
-- using the session's TimeZone. The reader uses the identical expression, so the two are directly
-- comparable whatever the session is set to.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED. `UPDATE ... SET = "syncedAt"` would be the database
-- vouching for an instant an application host produced — promoting exactly the values this column
-- exists to stop trusting. NULL therefore means "this claim's age cannot be established from the
-- database clock", which is a real state with a defined reading: the backlog falls back to
-- `createdAt`, itself a database `now()` DEFAULT and so still not an application clock. That
-- fallback is more permissive (a row's creation always precedes its claim), which lists sooner —
-- the fail-safe direction for a surface whose failure mode is silence.
--
-- Nullable with no default, so this is metadata-only on Postgres 11+: no table rewrite, no lock held
-- for the size of accounting_sync_logs.
ALTER TABLE "accounting_sync_logs"
  ADD COLUMN "backReferenceFollowUpsClaimedAtDatabaseClock" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- THE DATABASE STAMPS IT, BECAUSE AN APPLICATION WRITER CAN FORGET AND THIS ONE ALREADY DID.
--
-- The claim is minted in three places — both connectors (inside their SYNCED transaction) and the
-- back-reference repair sweep (a standalone compare-and-set). Adding "and also stamp the clock" to
-- each of them is the shape this branch keeps having to fix: a rule restated per writer, where the
-- next writer inherits it by nobody noticing. It is also the shape with the worst failure mode
-- available here. The connectors' claim rides in the transaction that records the invoice's external
-- id; an extra statement that can fail is an extra way to abort that transaction, and a rolled-back
-- SYNCED write means the row is retried with no external id and the invoice is POSTED TO QUICKBOOKS
-- TWICE. A trigger adds no statement to that transaction at all.
--
-- So the stamp is a property of the marker column, enforced where the marker column lives:
--
--   marker becomes NULL          -> the stamp is cleared (the obligation is discharged; there is no
--                                   claim to age).
--   marker set to a NEW value    -> the stamp is `clock_timestamp()`. A re-claim by a peer is a new
--                                   claim, so its age restarts — which is what the settling grace is
--                                   asking about ("how long has the CURRENT claim been outstanding").
--   marker unchanged             -> the stamp is carried over from OLD, so a statement that tries to
--                                   supply its own value cannot. The column is not writable by any
--                                   application host, which is the whole point of it.
--
-- WHEN-less but narrowed by `UPDATE OF`: the trigger is considered only for statements that mention
-- one of the two columns, so the ordinary hot-path writes on this table (status transitions, retry
-- counts, processing custody) do not reach it. An INSERT is covered because a row could in principle
-- be created already carrying a marker.
--
-- `clock_timestamp()` AT TIME ZONE 'UTC' is the identical expression the reader uses
-- (readFollowUpObligationDatabaseNow), so the two ends of the age comparison are directly comparable
-- whatever the session's TimeZone is set to.
CREATE OR REPLACE FUNCTION accounting_sync_log_stamp_followup_claim_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."backReferenceFollowUpsPendingAt" IS NULL THEN
    NEW."backReferenceFollowUpsClaimedAtDatabaseClock" := NULL;
  ELSIF TG_OP = 'INSERT'
     OR OLD."backReferenceFollowUpsPendingAt" IS DISTINCT FROM NEW."backReferenceFollowUpsPendingAt" THEN
    NEW."backReferenceFollowUpsClaimedAtDatabaseClock" := clock_timestamp() AT TIME ZONE 'UTC';
  ELSE
    NEW."backReferenceFollowUpsClaimedAtDatabaseClock" := OLD."backReferenceFollowUpsClaimedAtDatabaseClock";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_sync_log_stamp_followup_claim_clock_insert ON "accounting_sync_logs";

CREATE TRIGGER accounting_sync_log_stamp_followup_claim_clock_insert
BEFORE INSERT ON "accounting_sync_logs"
FOR EACH ROW
EXECUTE FUNCTION accounting_sync_log_stamp_followup_claim_clock();

DROP TRIGGER IF EXISTS accounting_sync_log_stamp_followup_claim_clock_update ON "accounting_sync_logs";

CREATE TRIGGER accounting_sync_log_stamp_followup_claim_clock_update
BEFORE UPDATE OF "backReferenceFollowUpsPendingAt", "backReferenceFollowUpsClaimedAtDatabaseClock"
ON "accounting_sync_logs"
FOR EACH ROW
EXECUTE FUNCTION accounting_sync_log_stamp_followup_claim_clock();
