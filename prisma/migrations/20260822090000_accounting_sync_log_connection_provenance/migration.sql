-- o3d-dzip — WHICH ACCOUNTING ORGANISATION THIS ROW WAS RAISED AGAINST, IN A PLACE RETENTION CANNOT
-- REACH.
--
-- WHAT ALREADY EXISTS, AND WHY IT IS NOT ENOUGH. o3d-s36z (merged, #632) stamps every queued row with
-- `_connectionProvenance: "<connector>:<tenantId>"` IN ITS PAYLOAD, at enqueue, from the connection
-- that resolved every external id the payload carries; the processor compares it against the tenant
-- the request is about to be addressed to and refuses a mismatch before anything is sent. That is the
-- right fact recorded by the right writer at the right moment. It is stored in the one column that is
-- DELIBERATELY DESTROYED: `backReferenceEvidenceTombstone` compacts an expired-but-unresolved row to
-- `payload: {}` while KEEPING `externalTransactionId`, so the rows whose realm is least knowable —
-- old, unresolved, still naming a live document in somebody's ledger — are exactly the rows that lose
-- the stamp. A payload key cannot answer a question that is only ever asked after the payload is
-- gone.
--
-- SO THE SAME FACT GETS A COLUMN. Not a second, independent record maintained in parallel: it is
-- MINTED FROM THE PAYLOAD STAMP, in the same INSERT statement, by the same code that observed the
-- connection. The two cannot disagree at birth, and after birth only one of them can move (see the
-- trigger). A reader combines them:
--
--   column present, payload silent    the column is the record — BUT ONLY where the row also carries
--                                     `back_reference_evidence_compacted_at` and an empty payload,
--                                     i.e. where RETENTION is provably what took the stamp away. THIS
--                                     IS THE POINT: a compacted tombstone still names its
--                                     organisation. A payload that merely lacks the key — rewritten
--                                     by a repair, a seed, a psql session, an older release still
--                                     rolling — is NOT that row, and letting the column speak for it
--                                     would have the column vouch for content it never saw. That case
--                                     is undecidable and refuses.
--   column silent, payload stamped    the payload is the record. Rows queued before this migration
--                                     keep working exactly as they do today; there is no rollout
--                                     cliff and no in-flight queue to drain.
--   both, and equal                   the record.
--   both, and DIFFERENT               undecidable. Refuse. Two records of one fact that disagree mean
--                                     something rewrote one of them without knowing about the other,
--                                     and "I cannot tell" is never "the same".
--   neither                           `no-origin-recorded`, which already refuses.
--
-- NULLABLE, NO DEFAULT, AND NOT BACKFILLED. `UPDATE ... SET connection_provenance = payload ->>
-- '_connectionProvenance'` is the obvious one line and it is forbidden, for the reason o3d-s36z gave
-- when it refused the same shortcut: it would be the DATABASE vouching for every historical stamp at
-- once, promoting values it did not witness into the column whose whole authority is that only the
-- enqueue that observed the connection can write it. A clearing backfill would be legitimate; a
-- vouching one is the defect wearing the fix's clothes. Existing rows therefore answer NULL, which is
-- the truth, and they fall back to their payload exactly as before.
--
-- ADDITIVE AND NON-BLOCKING: one nullable TEXT column with no default, so the ALTER is a
-- catalogue-only change on Postgres 11+ — no table rewrite, no long lock on a hot table. No index:
-- the column is only ever read on a row already located by its primary key.
ALTER TABLE "accounting_sync_logs" ADD COLUMN "connection_provenance" TEXT;

-- ---------------------------------------------------------------------------------------------
-- THE COLUMN IS MINTED ONCE AND CAN NEVER BE RE-MINTED, AND THAT IS A RULE THE DATABASE KEEPS.
-- ---------------------------------------------------------------------------------------------
--
-- A value in this column is a claim about an act — "this row was raised against organisation X" —
-- and the only party entitled to make it is the enqueue that performed the act. Everything else that
-- could write here is one step out from something it did not witness, and the most natural thing for
-- such a writer to put here is `activeAccountingIdProvenance()`: the organisation connected RIGHT
-- NOW. That does not merely lose evidence, it FORGES agreement — the post-time guard then compares
-- the current tenant against the current tenant and cannot fail. `carryAccountingOriginRecord` makes
-- exactly this argument for the payload stamp and answers it by INHERITING rather than re-reading.
--
-- NO READER CAN ENFORCE THAT. A re-stamped value is byte-identical to a minted one; there is nothing
-- left in the row to look at. So the rule runs at WRITE time, and it has to bind writers this
-- repository does not contain — the previous release, a repair script, a seed, `psql`. That is the
-- argument 20260819210000 made for the release receipt and 20260821090000 made for the completion
-- stamp, and this is the same shape of problem: provenance maintained by hand by every writer is
-- provenance the writers who have not heard of it destroy, or counterfeit, in silence.
--
-- THE RULE. An UPDATE may not change this column. If a statement tries, the column is CLEARED rather
-- than kept, and the direction is deliberate: this value is a PERMISSION (it is what lets a row post
-- at all), so the fail-safe direction is to withhold it. Clearing turns a forged re-stamp into
-- `no-origin-recorded`, which refuses at the socket with an operator remedy — cancel the row and
-- re-queue the work, which rebuilds the payload against the organisation connected now and mints a
-- fresh column beside it. Keeping OLD would be defensible for an honest restore and indefensible for
-- a forger, and nothing in the row distinguishes the two.
--
-- IT ONLY EVER NARROWS: it can clear provenance, never create it. The worst it can do is refuse a
-- post that a counterfeit would have let through, which is the outcome being asked for.
--
-- INSERT IS ALLOWED, unlike the completion-stamp trigger it is modelled on, and the difference is
-- which statement does the minting. A completion time is stamped by an UPDATE inside the SYNCED
-- transaction, so a marker arriving with an INSERT can only have come from a copy. An ORIGIN is
-- established by the INSERT — that is the act — so refusing it there would refuse the only writer
-- entitled to write it. A `pg_restore` therefore carries these values in, exactly as it already
-- carries in the payload stamps they were minted from; the restore is no more and no less
-- trustworthy than it was before this column existed.
--
-- WHY IT DOES NOT FIRE ON A PAYLOAD REWRITE. Two statements rewrite a stored payload and both are
-- right to leave this column alone. Retention's compaction (`payload: {}`) is the case the column
-- exists for, and it stamps `back_reference_evidence_compacted_at` in the same statement, which is
-- what the reader requires before it will decide from the column alone. The follow-up REVIVAL
-- (`plan.action === 'reuse'`) rewrites a FAILED row's payload with one built by
-- `withStoredOriginRecord`, which copies the stored origin VERBATIM — a revival inherits, it does not
-- re-observe — so the payload it writes agrees with the column by construction. A writer that
-- rewrites the payload with a DIFFERENT origin and leaves the column alone is caught by the reader as
-- a disagreement; a writer that rewrites it with NO origin and leaves the column alone is caught as
-- an unexplained silence, because it wrote no compaction record either. Both refuse.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule has to bind writers outside this repository
CREATE OR REPLACE FUNCTION accounting_sync_log_clear_connection_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."connection_provenance" := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_sync_log_connection_provenance_update ON "accounting_sync_logs";

-- BEFORE, because the value has to be changed on its way in rather than reported afterwards. FOR EACH
-- ROW with a WHEN clause, so every ordinary write to this hot table — a claim, a release, a settle —
-- pays one IS DISTINCT FROM test and nothing else.
CREATE TRIGGER accounting_sync_log_connection_provenance_update
BEFORE UPDATE ON "accounting_sync_logs"
FOR EACH ROW
WHEN (NEW."connection_provenance" IS DISTINCT FROM OLD."connection_provenance")
EXECUTE FUNCTION accounting_sync_log_clear_connection_provenance();
