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
-- deploy and safe to leave in place if the deploy is rolled back. WHAT THE GAP THAT OPENS BETWEEN
-- THE TWO COSTS — and, since round 3, what it does NOT cost — is the whole of the next section.

-- AlterTable
ALTER TABLE "sales_order_refunds" ADD COLUMN "reversal_staging_state" TEXT;

-- =================================================================================================
-- ROUND 3, Codex CRITICAL: A TRIGGER CAN ONLY WITNESS AN EVENT THE WRITER IN FRONT OF IT ACTUALLY
-- PERFORMS — AND THE BINARY THIS WINDOW IS ABOUT PERFORMS NEITHER OF THE TWO ROUND 2 CHOSE.
-- =================================================================================================
--
-- ROUND 2 SHIPPED TWO TRIGGERS: a BEFORE INSERT that stamped 'NOT_STAGED' on any row arriving
-- without one, and a BEFORE UPDATE that stamps 'STAGED' when `accounting_allocated_relief_amount`
-- MOVES. Its argument was that these cover the old binary that keeps serving between
-- `prisma migrate deploy` and the new build: "old binaries stage through that same statement, which
-- is why this catches them."
--
-- THAT SENTENCE IS FALSE, and the way it is false decides the design.
--
--   `accounting_allocated_relief_amount` was added by o3d-o97 (#635), merged 2026-08-21 and NOT YET
--   DEPLOYED. So the binary that will be serving while this migration is applied is one that
--   PREDATES #635. Check for yourself: `git log origin/development -S accounting_allocated_relief_amount`
--   names exactly one commit, and `git show 02169995^:lib/domain/sales/refund-service.ts` is the
--   staging path as that binary runs it. It writes NOTHING AT ALL to `sales_order_refunds` inside
--   the staging transaction — its only write is the un-stage of `sales_orders`. It does not know
--   the relief column exists.
--
--   A trigger keyed on that column MOVING therefore CANNOT FIRE for it, ever. The one deploy the
--   round-2 trigger was written to survive is the one deploy it is blind to.
--
-- AND THE INSERT TRIGGER WAS NOT MERELY USELESS THERE, IT WAS THE DANGEROUS HALF. Note which
-- writers it could ever fire for: its WHEN clause required `reversal_staging_state IS NULL`, and the
-- new build ALWAYS supplies the value explicitly, so the trigger stood down for it. Its entire
-- firing population was writers that do not set the column — the pre-#635 binary, a repair script,
-- `psql`, a COPY. For every one of those the database then has no way to witness a staging. So it
-- stamped 'NOT_STAGED' on exactly the rows whose staging it would never see, and `reversalRecordVerdict`
-- reads 'NOT_STAGED' as `nothing-lost`. An old binary that staged mid-window and died before
-- recording its syncs — THE FAILURE THIS ENTIRE ISSUE IS ABOUT — came out of that trigger stamped
-- as fine. It did not fail to help; it converted a real loss into a clean bill of health, which is
-- strictly worse than the bug the branch fixes.
--
-- SO THE INSERT TRIGGER IS GONE. Not narrowed, not made conditional on some property of the row —
-- removed, because there is no version of it that is safe: the set of writers it fires for is
-- precisely the set of writers whose subsequent staging is invisible to this database. A row it
-- would have stamped now lands NULL and reads as `undecidable`, and undecidable is a SAFE answer
-- here: `retrySalesOrderRefundAccounting` refuses it (it does not proceed and let its caller clear
-- the flag), and the invariant raises `refund_reversal_record_undecidable` for a human to settle
-- against the ledger. Nothing is dropped and nothing is laundered; what is lost is an automatic
-- answer the database was never entitled to give.
--
-- THAT ALSO CLOSES THE ROUND 3 HIGH, structurally rather than by cleverness. Round 2 tried to keep
-- restores out of the INSERT mint by requiring `accounting_allocated_relief_amount IS NULL` — a
-- guess at "is this a reload?" read off the row's own contents, and a wrong one: this branch's own
-- fixture `sm1PreWitnessLostRow` is a genuinely staged, genuinely LOST row with a NULL relief
-- amount, because it predates that column too. It would have sailed through that test and been
-- stamped 'NOT_STAGED' by a `pg_restore` or a repair INSERT — laundering the one row the critical
-- exists to catch. With no INSERT mint at all there is nothing left to launder: a COPY of a
-- pre-migration dump lands its rows exactly as they were, unwitnessed, and they stay undecidable.
-- That is the same outcome, in the same direction, that 20260821090000 chose for `pg_restore`.
--
-- WHAT THE SURVIVING TRIGGER IS FOR, STATED HONESTLY. The BEFORE UPDATE mint covers ONE writer: a
-- build that writes `accounting_allocated_relief_amount` but has never heard of this column. That is
-- a #635-era build, and it is a real possibility rather than a hypothetical — #635 is merged to
-- development and undeployed, so a release between now and this branch's merge makes it the
-- immediate predecessor. For that binary the guarantee is STRUCTURAL: its staging UPDATE moves the
-- relief amount in the same transaction as, and one statement before, the un-stage, so the mint
-- commits with the un-stage or rolls back with it, exactly as the application's own write does.
--
-- IT DOES NOT COVER A PRE-#635 PREDECESSOR, AND NOTHING ON THIS TABLE CAN. That binary's staging
-- transaction touches only `sales_orders`. The one event that separates "staged and lost" from
-- "never staged" for it is the un-stage itself — and a trigger on `sales_orders` cannot attribute
-- an ORDER-level event to a REFUND row: the refund's INSERT committed in an earlier transaction, so
-- there is no handle in scope, and picking the refund by its contents (`accounting_retry_required`
-- with a NULL `accounting_retry_syncs`) is the same inference-from-contents that produced the
-- laundering above, one level along — it would falsely accuse any earlier refund on the order
-- sitting in that state. For a pre-#635 predecessor the guarantee across the window is therefore
-- OPERATIONAL and WEAKER, and it is stated rather than assumed: rows minted in it are undecidable
-- rather than decided.
--
-- ROUND 3 WENT ON TO SAY THOSE ROWS ARE "refused by the retry and named by the invariant, never
-- silently decided", AND ARGUED FROM THAT THAT NO WRITE OUTAGE WAS WORTH ASKING FOR. THAT WAS WRONG,
-- and round 4 at the foot of this file is the correction: the retry that refuses and the invariant
-- that names both live in the NEW binary, while across the window it is the PREDECESSOR's retry that
-- runs -- and it clears the very flag the invariant is bounded by. Read the round 4 section for what
-- the database now refuses, what is merely documented, and which half of this window is still open.
--
-- DIRECTION, WHICH IS WHAT MAKES THE SURVIVING MINT ADMISSIBLE. 20260821090000 and 20260819210000
-- only ever CLEAR, because both vouch for an event the trigger did not execute and a laundered
-- claim is bit-identical to a minted one. This one mints, and it may, because it can only ever move
-- a row from `undecidable` TOWARDS AN ACCUSATION — NULL becomes 'STAGED', which reads as
-- `staged-never-recorded` and costs a human an investigation. It can never produce `nothing-lost`:
-- that verdict comes only from 'NOT_STAGED' (which nothing in this file writes any more), from a
-- recorded sync list, or from a cleared flag. A wrong mint here therefore costs an investigation.
-- A wrong mint in the direction round 2 chose cost a reversal.
--
-- AND IT STANDS DOWN RATHER THAN OVERWRITING: the WHEN clause requires that the statement have no
-- opinion of its own (`NEW ... IS NOT DISTINCT FROM OLD`), so the new build's explicit write wins
-- and the trigger is a no-op for it, and 'STAGED' is never re-minted over itself and never cleared.
--
-- WHY IT TESTS THE MOVEMENT AND NOT THE STORED VALUE. `NEW ... IS DISTINCT FROM OLD` is the whole
-- point: firing on "the row currently has a relief amount" would stamp 'STAGED' from a value the
-- trigger did not see written, on any unrelated later UPDATE — inheriting a claim rather than
-- witnessing an event, which is the thing both precedents forbid. A legacy row staged before this
-- migration therefore stays NULL and stays undecidable, which is correct: nothing witnessed it.
--
-- PROVENANCE FOR RESTORES AND IMPORTS (Codex r3, HIGH — the half that survives the deletion). A
-- `pg_restore` cannot reach the surviving trigger, because it loads with COPY and this fires on
-- UPDATE. A repair or import that RE-WRITES a relief amount can, and such a statement is a value
-- being replaced, not a staging being performed — so those operations declare themselves:
--
--     SET LOCAL ims.unwitnessed_write = 'on';
--
-- inside their transaction (the application's restore endpoint sets it for the whole psql session
-- via PGOPTIONS; see app/api/backup/restore/route.ts). While it is on, the trigger mints nothing and
-- the rows land unwitnessed — undecidable, which is the honest state for a row whose history came
-- out of a file. This is provenance DECLARED BY THE OPERATION, never inferred from what the row
-- happens to contain; that inference is what round 2 got wrong, and repeating it one level down
-- would fail the same way. An operation that does not declare itself is treated as an ordinary
-- write, which is the safe default: it gets the accusatory mint, not the exonerating one.
--
-- STILL NO BACKFILL. Rows written before this migration remain legitimately unknown, and the
-- invariant's `refund_reversal_record_undecidable` warning is how they are named.
--
-- IT IS IN THIS MIGRATION, BESIDE THE COLUMN, so there is no ordering in which a database holds the
-- column without the rule.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule must bind writers outside this repository — a build that writes the relief amount without knowing this column above all

-- ROUND 2'S INSERT MINT, REMOVED. Dropped by name as well as never created, so a database that had
-- an earlier revision of this file applied to it loses the trigger rather than keeping a stamp
-- nothing in this repository still stands behind.
DROP TRIGGER IF EXISTS sales_order_refund_witness_birth ON "sales_order_refunds";
DROP FUNCTION IF EXISTS sales_order_refund_witness_birth();

CREATE OR REPLACE FUNCTION sales_order_refund_witness_staging()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The declared-provenance escape above. `true` as the second argument makes the setting's absence
  -- a NULL rather than an error, so an ordinary write — which never sets it — falls straight
  -- through to the mint.
  IF current_setting('ims.unwitnessed_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW."reversal_staging_state" := 'STAGED';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_refund_witness_staging ON "sales_order_refunds";

-- BEFORE, because the value has to be on the row on its way in rather than corrected afterwards.
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

-- =================================================================================================
-- ROUND 4, Codex CRITICAL: THE PREDECESSOR CAN EXONERATE A WITNESSED ROW BEFORE THE REFUSING CODE
-- EVER SHIPS — SO THE REFUSAL HAS TO EXIST SOMEWHERE THE PREDECESSOR CANNOT BYPASS.
-- =================================================================================================
--
-- ROUND 3 ENDED ON THIS SENTENCE: rows minted in the window "are undecidable, refused by the retry
-- and named by the invariant, never silently decided". BOTH OF THOSE PROTECTIONS LIVE ONLY IN THE
-- NEW BINARY. Across the window it is the PREDECESSOR that is serving, and its retry is the buggy
-- one: it reads the nulled deferral as "this order never owed a reversal", returns success having
-- queued nothing, and its caller then writes
--
--     accounting_retry_required = false, accounting_warning = NULL, accounting_retry_syncs = NULL
--
-- (`retryRefundAccounting`, app/actions/sales.ts). `accounting_retry_required` is the ONLY bound the
-- accounting invariant's query has. So this is not the ordinary "the old binary keeps losing
-- reversals until it is replaced" — that is true of every fix and no migration can repair the past.
-- It is the predecessor ACTIVELY DESTROYING THE EVIDENCE the new code would have used, on a row this
-- branch's own witness had already accused. Once the flag is gone the row falls outside the bound
-- and cannot be found again. The round 3 guarantee was false for exactly the interval it described.
--
-- SEQUENCING VERSUS A RULE IN THE DATABASE. Stopping the predecessor, applying this, then starting
-- the new build does close the window — but it is OPERATIONAL: nothing in this repository enforces
-- it, nobody is obliged to read it, and the single occasion it is skipped costs a reversal that can
-- never be found again. A trigger is refused by the database itself and the predecessor does not
-- know the rule exists, which is precisely the property that made a trigger the right answer for the
-- witness. So the rule goes here, for the third time on this file.
--
-- WHAT IT REFUSES — and note that the first three terms are `reversalRecordVerdict(OLD) ===
-- 'staged-never-recorded'` TERM FOR TERM:
--
--     OLD.accounting_retry_required IS TRUE    the row still owes accounting
--     OLD.reversal_staging_state = 'STAGED'    a witness says its staging COMMITTED
--     OLD.accounting_retry_syncs IS NULL       and no record of what it produced exists
--     NEW.accounting_retry_required IS FALSE   and this statement is clearing the flag
--     NEW.accounting_retry_syncs IS NULL       while recording nothing in its place
--
-- That identity is deliberate. This is not a second, database-flavoured rule that could drift from
-- the application's; it is THE SAME RULE, put where a binary that has never heard of it still obeys
-- it. It tests MOVEMENT and not the stored value, exactly as the mint above does: it fires on the
-- flag going true -> false, never on a row that merely has it clear. And every accusing term reads
-- OLD, so the mint firing on the same statement cannot manufacture the accusation the guard refuses.
--
-- WHAT HAPPENS TO A LEGITIMATE CLEAR, checked against every statement in the NEW build that clears
-- the flag — because a guard that strands ordinary work is worse than the hole it plugs:
--
--   createSalesOrderRefund's staging clear writes accounting_retry_syncs IN THE SAME STATEMENT, and
--   the serialiser writes '[]' rather than NULL for an empty stage. NEW is therefore never NULL there
--   and the guard stands down.
--
--   retryRefundAccounting's clear does write NULL — but it is reached only when the retry SUCCEEDED,
--   and success means either the syncs were already on the row (OLD not NULL) or the retry re-staged
--   and wrote them inside its own transaction (OLD not NULL, '[]' at worst). The one success path
--   that arrives with OLD NULL is the `nothing-lost` short-circuit, and that one requires
--   'NOT_STAGED', which this guard does not fire on.
--
--   SO IN THE NEW BUILD THIS TRIGGER IS UNREACHABLE. The only statements it can fire on are ones the
--   new build's own retry refuses long before reaching them. It cannot turn an ordinary successful
--   retry into a refusal; it can only refuse an actor that never made the check.
--
-- IT REFUSES RATHER THAN NEUTRALISING. Silently pinning the flag back would leave an operator
-- watching a row that will not clear with nothing anywhere to read, and clicking retry again. The
-- exception is caught by the predecessor's own error path, which re-asserts the flag and writes the
-- message into `accounting_warning`, where that operator is already looking. The credit note the
-- predecessor queues just before the clear carries a fixed idempotency key, so a retry after the
-- refusal does not duplicate it.
--
-- A DELIBERATE MANUAL CLEAR IS STILL POSSIBLE, and has to be: both refusal messages in
-- `retrySalesOrderRefundAccounting` end by telling an operator to settle the reversal against the
-- ledger and clear the flag by hand. DECLARED BY THE OPERATION, NEVER INFERRED, like the mint's:
--
--     SET LOCAL ims.reversal_settled_manually = 'on';
--
-- A SEPARATE SETTING FROM `ims.unwitnessed_write`, deliberately. That one says "this write is not an
-- event anybody witnessed" and the restore endpoint sets it for a whole psql session; this one says
-- "a human has settled these reversals against the ledger". A restore must never be able to make the
-- second claim, so it does not get to.
--
-- THE RESIDUAL, STATED EXACTLY, BECAUSE HALF OF THIS WINDOW IS STILL OPEN:
--
--   A PRE-#635 PREDECESSOR'S WINDOW ROWS REMAIN EXONERABLE, AND UNRECOVERABLY SO. That binary writes
--   nothing to this table while staging, so no witness is ever minted; the row is NULL, `undecidable`,
--   and this guard has no accusation to stand on. Its retry clears the flag, the row leaves the
--   invariant's bound, and NOTHING CAN FIND IT AGAIN — not this guard, not the invariant, not a later
--   sweep. The guard does not fire on NULL ON PURPOSE: a rule keyed on "the flag is set and there are
--   no syncs" is the same inference-from-contents that round 2's INSERT mint got wrong, one level
--   along, and it would refuse the clear on every legacy row an operator legitimately settles, on no
--   evidence at all. The database refuses to exonerate where it holds a witness and admits it cannot
--   speak where it does not. For this half the only closure is operational — drain and stop the
--   predecessor, apply this, start the new build — and that is offered here as an option, NOT claimed
--   as a guarantee, because nothing in this repository can enforce it.
--
--   A #635-ERA PREDECESSOR THAT STAGED NOTHING IS FALSELY ACCUSED. It moves the relief amount (so the
--   witness says 'STAGED'), stages an empty list, and its serialiser writes NULL for empty — the
--   o3d-clxw defect this branch fixed one level down. Its legitimate clear is refused. The database
--   genuinely cannot tell that row from a lost one: under that serialiser both are STAGED with a NULL
--   syncs column. The cost is one investigation and one declared manual clear, on a window-length
--   set, and the direction is the one this branch has taken every time: accuse where it cannot tell,
--   because the other error drops a reversal.

CREATE OR REPLACE FUNCTION sales_order_refund_guard_witnessed_clear()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The declared manual settle. `true` as the second argument makes an unset value a NULL rather
  -- than an error, so an ordinary write — which never sets it — falls straight through to the
  -- refusal below.
  IF current_setting('ims.reversal_settled_manually', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Refusing to clear accounting_retry_required on sales order refund %: its staging is witnessed as committed and no record of what that staging produced was ever written, and this statement records none either. Raise the COGS/unearned/allocated-inventory reversals by hand from the refund''s own cost snapshots, reconcile the order, then clear the flag in a transaction that declares itself with SET LOCAL ims.reversal_settled_manually = ''on''.',
    OLD.id
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS sales_order_refund_guard_witnessed_clear ON "sales_order_refunds";

-- BEFORE, so the write is stopped rather than reported after the fact. Named to sort ahead of the
-- mint (Postgres fires row triggers in name order) purely for readability — every accusing term
-- reads OLD, so the two cannot interact whichever order they run in.
CREATE TRIGGER sales_order_refund_guard_witnessed_clear
BEFORE UPDATE ON "sales_order_refunds"
FOR EACH ROW
WHEN (
  OLD."accounting_retry_required" IS TRUE
  AND NEW."accounting_retry_required" IS FALSE
  AND OLD."reversal_staging_state" = 'STAGED'
  AND OLD."accounting_retry_syncs" IS NULL
  AND NEW."accounting_retry_syncs" IS NULL
)
EXECUTE FUNCTION sales_order_refund_guard_witnessed_clear();
