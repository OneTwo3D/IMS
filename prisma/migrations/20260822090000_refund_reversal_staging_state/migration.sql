-- o3d-2sm1 (Codex r1, CRITICAL) — A WITNESS FOR WHETHER A REFUND'S REVERSAL STAGING COMMITTED.
--
-- WITHOUT THIS FILE THE BRANCH IS WORSE THAN THE BUG. `prisma migrate deploy` applies migrations,
-- not schema.prisma, so on production this column would not exist: the INSERT in
-- createSalesOrderRefund and the staging UPDATE both throw on an unknown column — the first kills
-- every refund, the second rolls back inside the staging transaction and takes the un-stage with
-- it. Nothing degrades quietly here; it stops.
--
-- WHAT IT IS FOR (the full argument lives in lib/domain/sales/refund-reversal-record.ts).
--
--   sales_order_refunds.reversal_staging_state
--     The state this whole issue is about — reversals STAGED and never recorded — was decided until
--     now by `accounting_allocated_relief_amount IS NOT NULL AND accounting_retry_syncs IS NULL`.
--     Both of those columns are nullable, were never backfilled, and were both added AFTER the
--     two-commit window they were being asked about. On a row written before them the answer is
--     NULL/NULL, which that predicate read as "staging never committed" — so a genuinely lost
--     legacy reversal, the exact row it exists to catch, was reported as fine, and a legacy row
--     that never staged at all was reported the same way. It could not distinguish the two in
--     either direction.
--
--     Three states, each written by a transaction that actually sees the event:
--       'NOT_STAGED'  by the INSERT that creates the refund, in the transaction that creates it.
--       'STAGED'      by stageRefundAccountingReversals, in the same UPDATE as
--                     accounting_allocated_relief_amount and the statement immediately before the
--                     un-stage of sales_orders.revenue_deferred_date — so it commits with the
--                     un-stage or rolls back with it.
--       NULL          nobody spoke for this row. UNDECIDABLE, and each reader says so: the retry
--                     refuses rather than reporting success and letting its caller clear the flag,
--                     and the invariant reports it as its own warning, never as a confirmed loss.
--                     Since the triggers at the foot of this file, this can ONLY be a row written
--                     before the column existed — see ROUND 2 below for why the application writes
--                     alone were not enough to make that sentence true.
--
-- NULLABLE WITH NO DEFAULT, deliberately. Postgres would fill every existing row with a default,
-- and that value would be the database vouching for a staging it never witnessed — which is exactly
-- how `reversal_staged BOOLEAN NOT NULL DEFAULT false` came to be useless for this question. The
-- same refusal o3d-s36z made, and the same one this branch made when it started writing '[]' for an
-- empty stage without promoting the historical NULLs.
--
-- NO BACKFILL STATEMENT IN THIS FILE, and none should be added later. The pre-fix set is bounded
-- (rows still carrying accounting_retry_required with a NULL accounting_retry_syncs) and cannot be
-- reconstructed; it can only be named, which the accounting invariant now does.
--
-- DEPLOY ORDER: this migration must be applied BEFORE the application code that writes either
-- value. It adds a nullable column and touches no existing row, so it is safe to apply ahead of the
-- deploy and safe to leave in place if the deploy is rolled back. The gap that opens between the two
-- — the old binary still creating refunds against the new schema — is what the triggers below exist
-- to close, and it is why they ship in THIS file rather than a later one.

-- AlterTable
ALTER TABLE "sales_order_refunds" ADD COLUMN "reversal_staging_state" TEXT;

-- =================================================================================================
-- ROUND 2, Codex HIGH: THE COLUMN'S ABSENCE ONLY MEANS "WRITTEN BEFORE THE COLUMN EXISTED" IF THE
-- DATABASE — NOT THE APPLICATION — IS THE ONE THAT FILLS IT IN.
-- =================================================================================================
--
-- Everything above rests on one sentence: a NULL here is a row the column did not exist for. Round 1
-- argued that because every row minted from now on speaks for itself from birth. IT IS NOT TRUE
-- ACROSS A DEPLOY, and the deploy is the normal case, not the exotic one.
--
-- `prisma migrate deploy` runs BEFORE the new build is serving — it has to, or the two writes above
-- throw on an unknown column. So there is a window, minutes long on every release and longer on a
-- staged rollout, in which THIS MIGRATION IS APPLIED AND THE OLD BINARY IS STILL CREATING REFUNDS.
-- That binary does not know the column exists, so its INSERT omits it and the row lands NULL. NULL
-- therefore also means "written AFTER the migration by a build that did not know about it" — and
-- those rows are created by exactly the code that still has the two-commit bug, so the undecidable
-- set GROWS precisely where the round-1 reasoning said it could not, and grows fastest in the
-- population most likely to contain a real loss. A crash in that window produces a refund that
-- `reversalRecordVerdict` can only call `undecidable`: the retry refuses it and the invariant reports
-- a warning a human has to settle against the ledger, when the database could simply have known.
--
-- THE RULE THEREFORE RUNS AT WRITE TIME, IN THE DATABASE. That is the mechanism this repository has
-- already chosen twice for this exact shape of problem — evidence maintained by hand by every writer
-- is evidence the writers who do not know about it destroy silently (20260819210000, three writers
-- found maintaining a release receipt by hand; 20260821090000, which put the stamp-provenance rule on
-- a trigger BECAUSE it has to cover writers this repository does not contain: the previous release, a
-- repair script, a seed, `psql`). An old binary is precisely "a writer this repository does not
-- contain": it runs its own application code, but it does not bring its own database.
--
-- DIRECTION — AND IT IS THE OPPOSITE OF BOTH PRECEDENTS, DELIBERATELY. Those two triggers only ever
-- CLEAR: 20260821090000 destroys a marker any write could have laundered, 20260819210000 destroys an
-- exemption. Both had to, because both vouch for an event the trigger did not itself execute — a
-- timestamp's provenance, a release — and a laundered claim is bit-identical to a minted one, so the
-- only safe move is to narrow. THIS TRIGGER MINTS, because it is not repeating a claim about the
-- past: it is the witness to the statement it is running inside.
--
--   BEFORE INSERT   an INSERT *is* the row's birth. Nothing can have been staged for a refund that
--                   did not exist one statement ago, so 'NOT_STAGED' is true by construction at the
--                   instant it is written — the database is stating what it is doing, not vouching
--                   for something it was told.
--   BEFORE UPDATE   the statement that writes `accounting_allocated_relief_amount` *is* the staging.
--                   That column has exactly ONE writer on this table (the update inside
--                   `stageRefundAccountingReversals`, one statement before the un-stage and in the
--                   same transaction), so a statement moving it is the staging event happening, and
--                   'STAGED' commits or rolls back with the un-stage exactly as the application's own
--                   write does. Old binaries stage through that same statement, which is why this
--                   catches them.
--
-- MINTING IS SAFE HERE BECAUSE IT CAN ONLY EVER MOVE A ROW TOWARDS BEING DECIDABLE, never back, and
-- never over the top of a value somebody else wrote:
--   * neither trigger overwrites a state supplied by its own statement (the WHEN clauses stand down
--     the moment the statement has an opinion), so the new build's explicit writes are untouched and
--     the trigger is a no-op for them;
--   * 'NOT_STAGED' is written only where there is no state at all, and only at INSERT;
--   * 'STAGED' is written only over NULL or 'NOT_STAGED' — it is never cleared, and 'NOT_STAGED' is
--     never written over 'STAGED'.
-- The worst it can do is report a refund as decidable when the alternative was a human deciding it by
-- hand, and it can do that only for a row whose deciding event the database itself executed.
--
-- WHY THE UPDATE TRIGGER TESTS THE MOVEMENT AND NOT THE STORED VALUE. `NEW ... IS DISTINCT FROM OLD`
-- is the whole point: firing on "the row currently has a relief amount" would stamp 'STAGED' from a
-- value the trigger did not see written, on any unrelated later UPDATE — inheriting a claim rather
-- than witnessing an event, which is the thing the two precedents forbid. A legacy row that was
-- staged before this migration therefore stays NULL and stays UNDECIDABLE, which is correct: nothing
-- witnessed it.
--
-- WHY THE INSERT TRIGGER ALSO REQUIRES `accounting_allocated_relief_amount IS NULL`. A genuine birth
-- cannot carry a relief amount — only staging writes one, and staging cannot have run for a row that
-- does not exist. A row arriving at INSERT already holding one is not being born, it is being
-- RELOADED (`pg_restore`, a COPY of a pre-migration dump, a repair script), and stamping 'NOT_STAGED'
-- on it would be the database vouching for a staging it never saw — worse, it would launder the exact
-- row the critical finding exists to catch (relief written, syncs never recorded) into 'nothing-lost'
-- and delete the accusation. Such rows land NULL and stay undecidable, the same direction as the
-- deliberate absence of a backfill above. The residual is a reload of a pre-migration row that never
-- staged: it is stamped 'NOT_STAGED', which is what it would have been stamped had it been created
-- under this schema, and the reload is a deliberate one-off human act rather than the routine,
-- invisible thing a rolling deploy is.
--
-- STILL NO BACKFILL. The trigger fixes the FORWARD window only: from the moment this migration
-- commits, no writer — this build, the previous build, a script, `psql` — can create a refund row
-- that cannot say what happened to it. Rows written before it remain legitimately unknown, and the
-- invariant's `refund_reversal_record_undecidable` warning is how they are named.
--
-- IT IS IN THIS MIGRATION, BESIDE THE COLUMN, so there is no ordering in which a database holds the
-- column without the rule.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule must bind writers outside this repository — an old binary mid-deploy above all

CREATE OR REPLACE FUNCTION sales_order_refund_witness_birth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."reversal_staging_state" := 'NOT_STAGED';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_refund_witness_birth ON "sales_order_refunds";

-- BEFORE, because the value has to be on the row on its way in rather than corrected afterwards.
-- FOR EACH ROW with a WHEN clause, so a refund created by the new build pays two null tests.
CREATE TRIGGER sales_order_refund_witness_birth
BEFORE INSERT ON "sales_order_refunds"
FOR EACH ROW
WHEN (
  NEW."reversal_staging_state" IS NULL
  AND NEW."accounting_allocated_relief_amount" IS NULL
)
EXECUTE FUNCTION sales_order_refund_witness_birth();

CREATE OR REPLACE FUNCTION sales_order_refund_witness_staging()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."reversal_staging_state" := 'STAGED';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_refund_witness_staging ON "sales_order_refunds";

CREATE TRIGGER sales_order_refund_witness_staging
BEFORE UPDATE ON "sales_order_refunds"
FOR EACH ROW
WHEN (
  NEW."accounting_allocated_relief_amount" IS NOT NULL
  AND NEW."accounting_allocated_relief_amount" IS DISTINCT FROM OLD."accounting_allocated_relief_amount"
  AND NEW."reversal_staging_state" IS NOT DISTINCT FROM OLD."reversal_staging_state"
  AND NEW."reversal_staging_state" IS DISTINCT FROM 'STAGED'
)
EXECUTE FUNCTION sales_order_refund_witness_staging();
