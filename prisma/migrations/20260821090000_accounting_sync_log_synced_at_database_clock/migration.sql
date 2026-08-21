-- o3d-clxw round 5, Codex finding 1: A ROW STAMPED BY A HOST CLOCK MUST BE TELLABLE FROM ONE
-- STAMPED BY THE DATABASE.
--
-- Round 4 removed the two application clocks from the payment-reversal fence: the registration end
-- (`accounting_sync_logs."syncedAt"`) became `clock_timestamp()` written inside the SYNCED
-- transaction, and the poller end became `clock_timestamp()` read from the same database before the
-- ledger was asked. Two readings of one clock.
--
-- THE ROLLOUT PUTS THE SECOND CLOCK BACK. During a deploy both builds run at once, and a worker on
-- the OLD build still writes `syncedAt` from its own host's `new Date()`. A poller on the NEW build
-- compares that value against a database fence — which is the cross-host comparison round 4 deleted,
-- reintroduced by the release rather than by the code. Its dangerous direction is the one this whole
-- branch exists to prevent: the fence reads an in-flight registration as finished, the ledger's
-- (correct) silence about it is read as proof the payment was removed, `paidAt` is cleared, Mark Paid
-- re-arms, and the supplier is paid a second time.
--
-- Round 4 wrote the residual down and proposed to let it age out. Ageing out is not a fence: it is an
-- assumption about how far apart two clocks can be, which is exactly the assumption that was removed.
--
-- SO THE MARKER RIDES INSIDE THE VALUE. This column holds the SAME instant as `syncedAt`, written by
-- the same statement from a SINGLE evaluation of `clock_timestamp()`. The reader accepts a
-- registration as fenced only when this column is present AND equal to `syncedAt`; anything else
-- withholds and decides nothing at all. That makes both mixed-version writes announce themselves:
--
--   an old build creating the row      never sets this column, so it is NULL — undecidable.
--   an old build REWRITING `syncedAt`  moves `syncedAt` and leaves this column where it was, so the
--                                      two disagree — undecidable.
--
-- A separate column that could be read on its own would not do either job: a stale value left behind
-- by a host-clock rewrite of `syncedAt` would vouch for an instant that is no longer the row's. It is
-- the EQUALITY that is the marker, not the column's presence.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED. `UPDATE ... SET "syncedAtDatabaseClock" = "syncedAt"`
-- would be the database vouching for a value it did not produce — every historical host-clock stamp
-- promoted to a database stamp in one statement, which is the defect this column exists to detect,
-- applied to the entire table. Existing rows therefore stay undecidable for good, which means a
-- reversal on a bill whose registration predates this release is WITHHELD and reported for a human to
-- reconcile instead of being decided from a clock nobody can identify. That is the intended cost.
--
-- Nothing reads this column except the reversal fence, and no write path other than
-- `stampSyncedAtFromDatabaseClock` sets it, so an old build deployed on top of this schema behaves
-- exactly as it did before: it writes `syncedAt`, ignores this column, and its rows read as
-- undecidable to any new poller.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "syncedAtDatabaseClock" TIMESTAMP(3);

-- ---------------------------------------------------------------------------------------------
-- ROUND 6, Codex finding 1: EQUALITY IS NOT PROOF UNLESS THE DATABASE REFUSES TO LET ANYONE ELSE
-- PRODUCE IT.
-- ---------------------------------------------------------------------------------------------
--
-- Everything above is still true, and still not enough. The reader accepts a completion time when
-- the two columns hold the same stored millisecond, and round 5 argued that only the stamping
-- statement can produce that. It cannot: `syncedAt` is `TIMESTAMP(3)`, so ANY writer that lands a
-- value on the same millisecond satisfies the equality, and a writer does not have to be lucky to do
-- it. The old build's completion write is a read-modify-write — it reads the row, posts to Xero, and
-- writes the row back — so it can carry the DATABASE'S OWN STAMP FORWARD onto a registration that
-- completed thirty seconds later, and the pair still agrees. The row then reads as decidable while
-- stating a completion time that belongs to a different registration, which is the fence the branch
-- has spent five rounds removing, arriving through the one door left open.
--
-- NO READER CAN CLOSE THIS. Both columns are timestamps; a laundered pair is bit-identical to a
-- minted one, so there is nothing left in the row for `databaseStampedCompletion` to look at. The
-- rule therefore has to run at WRITE time, and it has to cover writers this repository does not
-- contain — the previous release, a repair script, a seed, `psql`. That is exactly the argument
-- 20260819210000 made for putting the release-receipt rule on a trigger rather than in the code
-- paths that happen to write one, and it is the same shape of problem: evidence maintained by hand
-- by every writer is evidence the writers who do not know about it destroy silently.
--
-- THE RULE. The marker vouches for the COMPLETION FACTS IT WAS MINTED WITH. If a statement changes
-- any of them without minting a new marker in the same statement, it is not the stamp, and the
-- provenance it did not produce is cleared. Deterministic, not probabilistic: an old build's write
-- invalidates the marker because of WHAT IT TOUCHED, never because of what value it happened to
-- write, so landing on the same millisecond buys it nothing.
--
--   status                 a completion recorded by anyone but the stamp. The claim is in here too:
--                          the old build cannot re-sync a row without first claiming it (PROCESSING),
--                          so its rewrite is disarmed one statement before it happens.
--   syncedAt               moved out from under a marker that stayed where it was.
--   externalTransactionId  a different registration on the row than the one the stamp measured.
--   processingStartedAt    a re-claim that did not change the status word.
--
-- WHY THE STAMP ITSELF SURVIVES IT. `stampSyncedAtFromDatabaseClock` assigns the marker in the same
-- statement, so `NEW."syncedAtDatabaseClock" IS DISTINCT FROM OLD` and the trigger does not fire.
-- The processor's Prisma write lands FIRST and the stamp LAST, which is load-bearing: the first
-- statement changes `status`/`externalTransactionId` and clears whatever marker was there, and the
-- second mints the new one. Reversed, the stamp would be erased by its own transaction.
--
-- WHY IT IS SCOPED TO THOSE FOUR COLUMNS RATHER THAN FIRING ON EVERY WRITE. A rule of "any update
-- clears the marker" would also fire on `releaseFollowUpObligation`, which clears
-- `backReferenceFollowUpsPendingAt` on the row moments after the stamp — every registration in the
-- system would end up undecidable, the reversal verdict would be withheld for ever, and NOTHING
-- WOULD SAY SO. Safe-direction breakage is still breakage when it is total and silent. The residual
-- is a write that changes none of the four: such a write leaves every fact the marker was minted
-- with exactly as the database wrote it, so there is nothing new for the marker to vouch for.
--
-- ON INSERT the marker is simply refused. Nothing creates an already-stamped row — the stamp is an
-- UPDATE inside the SYNCED transaction — so a marker arriving with an INSERT came from a copy, a
-- seed or a restore, none of which is this database minting a completion time. (A `pg_restore` of a
-- dump therefore lands with the markers cleared and its historical registrations undecidable. That
-- is the same cost, and the same direction, as the deliberate absence of a backfill above.)
--
-- IT ONLY EVER NARROWS, like the trigger it is modelled on: it can clear provenance, never create
-- it, so the worst it can do is withhold a reversal that a laundered marker would have let through
-- — which is the outcome being asked for. And it is in THIS migration, beside the column it guards,
-- so there is no ordering in which a database has the column and not the rule: no marker can ever
-- have been written anywhere without this trigger already watching it.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule has to bind writers outside this repository
CREATE OR REPLACE FUNCTION accounting_sync_log_clear_stamp_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."syncedAtDatabaseClock" := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_sync_log_stamp_provenance_insert ON "accounting_sync_logs";

-- BEFORE, because the value has to be changed on its way in rather than reported afterwards. FOR
-- EACH ROW with a WHEN clause, so the ordinary insert of a PENDING queue row — this is a hot table —
-- pays one NULL test and nothing else.
CREATE TRIGGER accounting_sync_log_stamp_provenance_insert
BEFORE INSERT ON "accounting_sync_logs"
FOR EACH ROW
WHEN (NEW."syncedAtDatabaseClock" IS NOT NULL)
EXECUTE FUNCTION accounting_sync_log_clear_stamp_provenance();

DROP TRIGGER IF EXISTS accounting_sync_log_stamp_provenance_update ON "accounting_sync_logs";

CREATE TRIGGER accounting_sync_log_stamp_provenance_update
BEFORE UPDATE ON "accounting_sync_logs"
FOR EACH ROW
WHEN (
  NEW."syncedAtDatabaseClock" IS NOT NULL
  AND NEW."syncedAtDatabaseClock" IS NOT DISTINCT FROM OLD."syncedAtDatabaseClock"
  AND (
    NEW."syncedAt" IS DISTINCT FROM OLD."syncedAt"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."externalTransactionId" IS DISTINCT FROM OLD."externalTransactionId"
    OR NEW."processingStartedAt" IS DISTINCT FROM OLD."processingStartedAt"
  )
)
EXECUTE FUNCTION accounting_sync_log_clear_stamp_provenance();
