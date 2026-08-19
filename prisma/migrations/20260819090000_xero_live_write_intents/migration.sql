-- o3d-t74p Codex r7 finding 1: the live-Xero cleanup's coordination was HOST-LOCAL while the thing
-- it protects is ONE LEDGER.
--
-- scripts/remove-xero-live-e2e-footprint.ts voids invoices, archives contacts and deletes items in a
-- REAL Xero organisation, irreversibly. Two guarantees stand between it and a second, concurrent,
-- unaccounted-for apply:
--
--   • SINGLE APPLY  — only one run at a time may mutate the ledger;
--   • RECOVERY FENCE — a run that dispatched a write and died before recording the outcome leaves
--                      evidence, and the NEXT run refuses to start until a human has accounted for it.
--
-- Round 6 keyed both on the tenant id, at an absolute path under /var/lib/o3d/xero-cleanup, so no
-- flag and no cwd could move them. That closed the "two paths on one host" hole and left the bigger
-- one open, which round 6 stated and filed rather than fixed: a lock file and a log file coordinate
-- ONE FILESYSTEM. A second host, a container, or a VM restored from a snapshot finds no lock and an
-- empty log — it takes the fence for free and plans over a ledger another machine's dead run may
-- already have changed. That is precisely the scenario the fence exists for, and the fence was blind
-- to it.
--
-- This table puts the same record where every host that can run the script already shares state: the
-- IMS database. It is ADDITIONAL to the fsynced file, not a replacement — the file survives the
-- DATABASE going away, the row survives the HOST going away, and the run refuses if either one
-- cannot be written. Mutual exclusion comes from a PostgreSQL session advisory lock in the
-- XERO_LIVE_CLEANUP namespace (see lib/db/advisory-locks.ts), keyed on the same tenant id; it needs
-- no table, but it dies with its session, which is why the durable evidence is these rows.
--
-- WHY NOT A MARKER IN XERO ITSELF, which is the other place both runs can see. Three reasons, all
-- disqualifying: taking the lock would mean WRITING to the live ledger, and this whole incident is
-- test artefacts contaminating a real organisation; the write gate refuses every non-GET without
-- --apply, so a dry run — which must consult the fence, because its plan is what authorises the next
-- apply — could not take one; and Xero's API offers no conditional create, no If-Match and no
-- compare-and-swap, so two hosts POSTing a marker both succeed and there is no total order in which
-- to arbitrate. See scripts/lib/xero-live-safety.ts, "WHERE THE COORDINATION LIVES", for the full
-- statement.
--
-- STATE IS NULLABLE ON PURPOSE, and NULL is the dangerous value: it means the intent was recorded,
-- the request was dispatched, and nothing ever came back to settle it. `unknown` means the answer
-- was lost. Both are unresolved as far as the next run is concerned; only `committed` and
-- `not-committed` account for a row.
--
-- NOTHING DELETES THESE ROWS. Resolution is a human reading the ledger and settling the row, exactly
-- as the file-based fence requires, because the only thing that can say what happened to a
-- dispatched write is Xero. A sweep that expired them would hand the next run the empty fence this
-- migration exists to abolish.
--
-- ONE EXPLICIT TRANSACTION, for the reason 20260721150000_refund_park_unique_index documents: Prisma
-- does NOT auto-wrap a migration file, so anything added here later inherits the guarantee instead of
-- quietly not having it.
--
-- New table, no backfill and none possible: before this migration no host recorded anything a second
-- host could read, and a dispatched write that was invisible cannot be reconstructed after the fact.
-- From here forward the window is closed; before it, it is not.
BEGIN;

CREATE TABLE "xero_live_write_intents" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "intendedAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT,
    "reason" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "xero_live_write_intents_pkey" PRIMARY KEY ("id")
);

-- The fence's only query: every write against this ledger that nobody has accounted for.
CREATE INDEX "xero_live_write_intents_tenantId_state_idx"
    ON "xero_live_write_intents"("tenantId", "state");

COMMIT;
