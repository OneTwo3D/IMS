-- o3d-gvzu — RELEASE A DISPATCH MARKER ON PROOF THAT NOTHING LEFT THE PROCESS.
--
-- THE DEFECT. `create_dispatched_at` / `create_dispatch_idempotency_key` are minted by the claim
-- fence, in the statement immediately before the socket. The transport then has refusals of its OWN
-- below that statement: an unresolvable connection (the token resolver returning null), a posting
-- intent refusal, the per-attempt egress authorisation, and the rate-limit budget. Every one of them
-- reports "nothing left this process" — status 0, or a 429 refused BEFORE sending — and every one of
-- them leaves the marker written. Past Xero's six-minute idempotency window the marker refuses for
-- ever, so ONE "Not connected to Xero" blip permanently wedged every manual-journal row it touched,
-- and the only exit was an operator asserting a document that does not exist.
--
-- WHY THE PAIR IS NOT SIMPLY CLEARED. The trigger installed by 20260822090100 deliberately forbids
-- clearing, moving or splitting it, and that is right. The pair is a PROHIBITION; a prohibition that
-- tampering clears hands the tamperer precisely what they wanted. The remedy for a prohibition
-- standing over nothing is not to weaken the prohibition, it is to record the fact that makes it
-- inapplicable — and to record it somewhere a later reader can tell apart from an absence.
--
-- WHY IT IS NOT A PRE-FLIGHT COPY OF THE FOUR REFUSALS EITHER. They are evaluated once, immediately
-- before the socket, against the very auth the request is built from; one of them may write the
-- database and take an exclusive slot; and o3d-batch-realm deleted exactly such a pre-check on the
-- ground that a refusal produced from a stale read is as wrong as a permission produced from one. So
-- the evidence has to be written AFTER the fact, by the attempt that has it.
--
--   create_dispatch_released_at  when a later statement PROVED that the dispatch recorded on this row
--                                put nothing on the wire.
--
-- WHAT COUNTS AS PROOF, AND WHAT EMPHATICALLY DOES NOT. Only a NAMED, enumerated refusal, written by
-- the one statement that performed it and provable from WHERE THAT STATEMENT SITS — see
-- `XeroNotSentReason` in lib/connectors/xero/api.ts, which lists all four and the position of each.
-- "We received no answer" is NOT proof: a timeout, a socket reset mid-write and a 5xx are all cases
-- where the request may have arrived, and all three deliberately KEEP the marker. The direction of
-- that asymmetry is the whole point — a marker wrongly kept costs a refusal an operator can resolve,
-- a marker wrongly released costs a duplicate journal in a live ledger that nobody will notice.
--
-- A ONE-SHOT PERMISSION, SPENT BY THE SEND IT PERMITS. The attempt that proceeds on a release clears
-- it in the very statement that re-proves the claim and sends. Left standing it would still be there
-- after a request that DID leave, and would license a third attempt on top of a document that exists.
--
-- NULLABLE, NO DEFAULT, NOT BACKFILLED. NULL means "no release stands", which is exactly what every
-- existing row means today and exactly how they all continue to behave.
--
-- ADDITIVE AND NON-BLOCKING: one nullable column, no default, catalogue-only on Postgres 11+. No
-- index — it is read only on a row already located by its primary key.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "create_dispatch_released_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------------------------
-- AND THE DATABASE HOLDS THE TWO RULES A READER CANNOT CHECK.
-- ---------------------------------------------------------------------------------------------
--
-- NOTE THE DIRECTION, BECAUSE IT IS THE REVERSE OF THE PAIR'S. That trigger PRESERVES on tampering,
-- because the marker is a prohibition and preserving is the safe move. This one is a PERMISSION, so
-- the safe move is to WITHHOLD it: every rule below can only ever remove a release, never add one,
-- and clearing is always allowed without a rule at all.
--
-- ON INSERT the release is refused. Nothing creates an already-released row — the enqueue happens
-- long before any wire, and long before any transport could refuse — so a release arriving with an
-- INSERT came from a copy, a seed or a restore, none of which is this database watching a request
-- fail to leave.
--
-- ON UPDATE a release may only be written onto a row that ALREADY carried a marker before the
-- statement. This is what makes a self-permitting write impossible: a statement that minted the
-- marker and released it at once would be evidence about a request that had not yet been attempted,
-- and it is the one shape a confused (or malicious) writer would naturally produce. `OLD` is consulted
-- rather than `NEW` precisely so the minting statement cannot vouch for itself.
--
-- What this does NOT attempt is to distinguish the honest release from a hand-written one on a row
-- that does carry a marker. No trigger can: they are byte-identical. What it can do is make the
-- release meaningless without a marker to be about, and keep the mint and the release in separate
-- statements — which is enough that a release always describes a dispatch that had already happened.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule has to bind writers outside this repository
CREATE OR REPLACE FUNCTION accounting_sync_log_hold_create_dispatch_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."create_dispatch_released_at" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."create_dispatch_released_at" IS NOT NULL AND OLD."create_dispatched_at" IS NULL THEN
    NEW."create_dispatch_released_at" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_sync_log_create_dispatch_release_insert ON "accounting_sync_logs";

CREATE TRIGGER accounting_sync_log_create_dispatch_release_insert
BEFORE INSERT ON "accounting_sync_logs"
FOR EACH ROW
WHEN (NEW."create_dispatch_released_at" IS NOT NULL)
EXECUTE FUNCTION accounting_sync_log_hold_create_dispatch_release();

DROP TRIGGER IF EXISTS accounting_sync_log_create_dispatch_release_update ON "accounting_sync_logs";

-- The WHEN clause lets the ordinary CONSUMPTION through untouched — it writes NULL, so
-- `NEW ... IS NOT NULL` is false and the trigger never fires — and it never fires on a statement that
-- does not name the column at all. This is a hot table and it pays one IS NOT NULL test.
CREATE TRIGGER accounting_sync_log_create_dispatch_release_update
BEFORE UPDATE ON "accounting_sync_logs"
FOR EACH ROW
WHEN (
  NEW."create_dispatch_released_at" IS NOT NULL
  AND NEW."create_dispatch_released_at" IS DISTINCT FROM OLD."create_dispatch_released_at"
)
EXECUTE FUNCTION accounting_sync_log_hold_create_dispatch_release();
