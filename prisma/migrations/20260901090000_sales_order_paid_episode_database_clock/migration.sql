-- o3d-psrx r5, Codex HIGH 1: THE PAID-EPISODE FENCE MUST BE MEASURED BY THE DATABASE.
--
-- Round 4 gave the reversal evidence a second binding test: a registration may speak for the current
-- paid flag only if it COMPLETED AFTER the episode that flag belongs to
-- (`registrationBindsToPaidState`, lib/connectors/xero/invoice-delta.ts). The completion instant is
-- `accounting_sync_logs."syncedAt"`, which round 4 and round 5 spent two whole rounds making
-- database-minted and provably so. The other end — `sales_orders.unregistered_paid_at` — was written
-- by whichever APPLICATION HOST set the paid flag:
--
--   markSalesOrderPaid              `new Date()` on the app instance serving the click.
--   the WooCommerce order importer  `date_paid_gmt`, which is a THIRD machine's clock — the shop's.
--   the 20260830090000 backfill     `paidAt`, i.e. whichever of the two wrote the row originally.
--
-- So the comparison spanned two clocks, and it is the SAME class of defect the whole branch exists to
-- delete. Its dangerous direction: a host running AHEAD of the database stamps a marker in the
-- database's future, the registration that legitimately follows it completes at a database instant
-- BELOW the marker, and the fence reads a real, posted, ledger-visible receipt as belonging to some
-- earlier episode. The registration is then unbound for ever — the comparison is over two immutable
-- values, so every recheck reaches the identical answer — and the order sits `PAID_WITHOUT_LEDGER_
-- RECEIPT`: a genuine chargeback against it is never recognised and the revenue is never unwound.
--
-- THE FIX IS AT THE SOURCE, NOT IN THE COMPARISON. Round 4's instinct was right — the marker IS
-- written by the same statement as `paidAt`, so there is no instant at which a reader can see one
-- without the other, and no second column is needed to say when the episode began. What was wrong is
-- WHOSE CLOCK produced the value. This trigger takes that decision away from every writer: whatever
-- instant a caller supplies, the value stored is `clock_timestamp()` read by this database at the
-- moment of the write. Both ends of the fence are then readings of one clock, exactly as
-- `syncedAtDatabaseClock` made the other end, and no application host takes part in the ordering.
--
-- A TRIGGER RATHER THAN A RULE IN THE WRITERS, for the reason 20260821090000 and 20260827120000 both
-- give: the rule has to bind writers this repository does not contain — the previous release across a
-- deploy, a repair script, a seed, psql — and evidence maintained by hand by every writer is evidence
-- the writers who do not know about it destroy silently. `tests/accounting/paid-provenance-writers.
-- test.ts` polices that every `paidAt` write NAMES this column; nothing in a source census can police
-- which clock the value came from.
--
-- WHY OVERWRITING THE CALLER'S VALUE LOSES NOTHING. This column has exactly two readers and neither
-- wants a business date: `unregisteredPaidAt != null` is the provenance marker ("this paid flag was
-- never going to have a ledger receipt"), and its instant is the episode's LOWER BOUND. The paid date
-- an operator sees is `sales_orders."paidAt"`, which this trigger does not touch. A WooCommerce order
-- imported a week after it was paid keeps `date_paid_gmt` in `paidAt` and gets an episode fence of
-- "when IMS came to believe it", which is the only instant any registration of ours can follow.
--
-- WHEN A NEW FENCE IS MINTED, AND WHY IT IS A TRANSITION AND NOT A DIFFERENCE (r6, Codex HIGH 1).
--
-- The rule above needs a companion: a write that does not BEGIN an episode must not re-mint. Round 5
-- said so and then wrote the test as `OLD IS DISTINCT FROM NEW` — a comparison between the value the
-- DATABASE minted and the value the CALLER supplied. After the first write those two necessarily
-- differ, because the first write is precisely what replaced the caller's value with the database's.
-- So the guard passed on every subsequent write, and there IS a subsequent write on the hot path:
-- `updateExistingWcOrderFromPayload` re-sends the shop's `date_paid_gmt` on EVERY webhook redelivery
-- and every `modified_after` poll that sees the order again. The fence therefore advanced on each
-- delivery, past INVOICE_PAYMENT registrations that had already completed under it, unbinding them
-- for ever and parking the order on PAID_WITHOUT_LEDGER_RECEIPT — the exact defect this migration
-- exists to remove, re-created by its own fix. Round 5 named that hazard in this comment block and
-- then built the comparison that causes it.
--
-- WHAT ACTUALLY MARKS A NEW EPISODE IS A TRANSITION THE DATABASE CAN SEE FOR ITSELF: the PAID FLAG
-- going from ABSENT to PRESENT. Nothing a caller supplies is consulted at all.
--
-- r6 said that transition about THIS COLUMN, and r8 corrects it to `paidAt` — see the arm's own note
-- below. The two differ on exactly one row of this table, and it is the row a covering receipt
-- produces:
--
--   NEW."paidAt" NULL                    the flag is being cleared. The episode is over: the marker is
--                                        forced to NULL whether or not the writer named it.
--   NEW."unregistered_paid_at" NULL      the caller is CLEARING the marker while the flag stands —
--                                        `addPayment` on coverage. Allowed, and it is the ONLY value
--                                        a caller may still put in this column.
--   INSERT with a marker                 the row arrives already inside an episode. Mint.
--   UPDATE, OLD."paidAt" non-null        an episode is already under way. THE STORED VALUE STANDS,
--                                        INCLUDING ITS ABSENCE, whatever the caller supplied — this
--                                        is the redelivery case, before AND after a coverage clear.
--   UPDATE, OLD."paidAt" NULL            no episode was under way and the flag has just been set with
--                                        nothing to register. Mint.
--
-- AND THE END OF AN EPISODE IS A FACT ABOUT `paidAt`, NOT A COURTESY FROM ITS WRITERS (r7, Codex
-- HIGH 2).
--
-- Round 6 wrote the paragraph below and it was half true. "A genuine re-payment still mints, because
-- ending an episode is what clears the column" was justified by a CENSUS OF TODAY'S WRITERS — every
-- one of them clears `paidAt` and this column in a single statement. That is exactly the kind of
-- evidence this trigger exists BECAUSE IT CANNOT RELY ON. The reason given for choosing a trigger
-- over a rule in the writers, two paragraphs up, is that it "has to bind writers this repository does
-- not contain — the previous release across a deploy, a repair script, a seed, psql". A repair script
-- that runs `UPDATE sales_orders SET "paidAt" = NULL WHERE ...` and does not know this column exists
-- is precisely that writer, and round 6's trigger never saw the statement at all: `UPDATE OF
-- unregistered_paid_at` does not fire for it. The marker then outlived the episode it describes, the
-- next paid transition found `OLD."unregistered_paid_at"` already non-null and PRESERVED the dead
-- fence, and a registration that completed under the PREVIOUS episode bound to the new one — which is
-- r4's finding, reached through the door r6 left open.
--
-- SO THE EPISODE'S END IS OBSERVED WHERE IT ACTUALLY HAPPENS. `unregistered_paid_at` is a statement
-- ABOUT `paidAt` ("this paid flag was entered with no ledger receipt behind it"). With no paid flag
-- there is no flag for it to be about, so `paidAt IS NULL AND unregistered_paid_at IS NOT NULL` is not
-- a state this column has a meaning in — it is the wreckage of a half-observed transition. The
-- trigger now fires on `paidAt` as well, and forces the marker to NULL whenever the paid flag is
-- NULL. Two consequences, both wanted:
--
--   the clearing case   a statement that clears `paidAt` alone ends the episode whether or not it has
--                       ever heard of this column.
--   the minting case    `OLD."paidAt" IS NULL` means no episode was under way, so a marker found
--                       beside it is not a fence to preserve. A new one is minted.
--
-- AND THE INVARIANT IS STATED TO THE DATABASE AS WELL AS ENFORCED BY IT: the CHECK constraint at the
-- foot of this migration. The trigger REPAIRS (it cannot reject: rejecting a previous release's write
-- mid-deploy is worse than correcting it); the constraint is what holds on the paths a BEFORE trigger
-- does not run on at all — `session_replication_role = replica`, an explicitly disabled trigger, a
-- restore. Neither is redundant: enforcement without a stated invariant is a rule nobody can find,
-- and a stated invariant without enforcement is a rule that fails at 3am on a repair script.
--
-- AND A MID-EPISODE CLEAR IS NOT THE END OF THE EPISODE (r8, Codex HIGH 1).
--
-- r6 and r7 between them made two writes legal that r6's preserve arm could not tell apart, because
-- it tested the MARKER and the thing that separates them is the FLAG:
--
--   the marker cleared, `paidAt` cleared      the episode ENDED. A new fence may be minted.
--   the marker cleared, `paidAt` standing     a covering receipt was recorded (`addPayment`, r6). The
--                                             episode is still running and now has a ledger receipt.
--
-- r6's arm preserved only an already-non-null marker, so the second row fell through to the mint on
-- the very next write that named the column — and `updateExistingWcOrderFromPayload` names it on
-- every webhook redelivery and every `modified_after` poll. The order got a brand-new fence for an
-- episode it never left, minted AFTER the registration that had just discharged it, and that
-- registration was unbound permanently. r8's arm therefore preserves OLD whenever `OLD."paidAt"` is
-- non-null, absence included, and keeps the clearing arm above it so the legitimate clear still runs.
--
-- WHAT THAT REFUSES, STATED. A writer that wants to put a marker ON an order whose paid flag already
-- stands is now silently ignored. No writer in this tree does it — `markSalesOrderPaid` writes the
-- pair on the unpaid→paid transition, the WooCommerce importer writes `undefined` for an unpaid
-- payload, and every clear names `paidAt` — and one that did would be asserting that an episode which
-- began earlier had no ledger receipt behind it, which is a claim about the past that this column,
-- whose whole job is to be the episode's LOWER BOUND, cannot honestly carry. The way to say it is to
-- end the episode and begin a new one, which is what a genuine re-payment already does.
--
-- A GENUINE RE-PAYMENT STILL MINTS. Ending an episode clears the column — now by the database's own
-- doing and not only by every writer remembering to, which is the whole of this round's change here.
-- Paid → unpaid → paid again therefore passes through NULL however the unpaid step was spelt, and the
-- second `paid` is a NULL-to-non-null transition that mints a second, strictly later fence. What can
-- no longer happen is a fence moving WITHOUT the flag having been cleared, and no legitimate episode
-- begins that way.
--
-- IT ONLY EVER NARROWS. A minted marker is at or after the caller's, so the set of registrations that
-- bind can only shrink relative to trusting the host — and shrinking withholds, which costs a warning
-- a human clears. The other direction costs a chargeback credit note against a paid sale.
--
-- prisma-schema-scope-ok: db-native trigger | reason: Prisma cannot represent triggers, and the rule must bind writers outside this repository, including a previous release serving across a deploy
CREATE OR REPLACE FUNCTION sales_order_mint_paid_episode_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- THE EPISODE HAS ENDED, HOWEVER THE STATEMENT WAS SPELT (r7, Codex HIGH 2). Above every other rule
  -- here, because it is the one that does not depend on the writer naming this column: with no paid
  -- flag there is nothing for the marker to be a statement about, so it is forced to NULL rather than
  -- left to a writer that may never have heard of it. This is what makes the NEXT paid transition a
  -- NULL-to-non-null one, and therefore a mint.
  IF NEW."paidAt" IS NULL THEN
    NEW."unregistered_paid_at" := NULL;
    RETURN NEW;
  END IF;

  -- THE MARKER IS BEING CLEARED WHILE THE FLAG STANDS — a ledger receipt has been recorded for a paid
  -- state that had none (`addPayment` on coverage). The episode's fence goes with it.
  --
  -- THE ONE VALUE A CALLER MAY STILL PUT IN THIS COLUMN, and it must stay above the preserve arm
  -- below or it can never take effect: preserving OLD over a deliberate clear would write the marker
  -- straight back and `addPayment`'s coverage clear would be a no-op. The asymmetry is deliberate and
  -- it is the safe one — clearing SAYS "this paid flag now has a ledger receipt behind it", which
  -- makes the reversal reader trust the ledger; nothing may SET a marker on a flag that already
  -- stands, because that is minting a fence for an episode that began earlier.
  IF NEW."unregistered_paid_at" IS NULL THEN
    RETURN NEW;
  END IF;

  -- AN EPISODE ALREADY UNDER WAY. The stored value stands — INCLUDING ITS ABSENCE (r8, Codex HIGH 1).
  --
  -- r7 wrote this arm as `OLD."unregistered_paid_at" IS NOT NULL AND OLD."paidAt" IS NOT NULL`, so it
  -- preserved only an already-non-null marker and everything else fell through to the mint. THE ARM
  -- ABOVE IS WHAT MADE THAT WRONG, and r6 is what put it there: `addPayment` legitimately clears this
  -- column when a receipt comes to COVER an order that was already paid off-ledger, and `paidAt` is
  -- deliberately left alone by that write because re-stamping it would move a settlement date an
  -- operator can see. The order is then paid, mid-episode, with NO marker — and the next WooCommerce
  -- redelivery re-sends `date_paid_gmt` in both columns, finds `OLD."unregistered_paid_at"` NULL,
  -- skips this arm and MINTS. A fence for an episode that never restarted, minted after the very
  -- registration that discharged it completed, which unbinds that registration for ever
  -- (`registrationBindsToPaidState` compares two immutable values, so every recheck repeats the
  -- answer) and parks the order on PAID_WITHOUT_LEDGER_RECEIPT. That is r4's finding again, reached
  -- through the door r6's own fix opened.
  --
  -- SO THE RULE IS SAID ABOUT `paidAt` AND NOTHING ELSE: while the paid flag STANDS, this column's
  -- value is settled, and its absence is a value. An episode ends by `paidAt` going NULL — the arm at
  -- the top of this function, which no writer has to know about — and only then may a new fence be
  -- minted. Nothing later in an episode moves it: not a WooCommerce redelivery, not a repair script,
  -- not a previous release across a deploy.
  --
  -- `OLD."paidAt" IS NOT NULL` IS WHAT MAKES THIS TRIGGER CORRECT ON ITS OWN (r7, kept in r8). An
  -- episode is a period during which the flag STANDS, so a marker sitting beside a NULL `paidAt` is
  -- not one and is not a fence to preserve. While the CHECK at the foot of this migration stands that
  -- state cannot be reached, so this clause's FALSE branch never fires — the constraint bolts the
  -- same door. It is here because the two mechanisms must not depend on each other: drop the
  -- constraint and the trigger still refuses to preserve a dead fence; disable the trigger and the
  -- constraint still refuses the state. A guard that is only correct because a DIFFERENT guard is also
  -- present is one deployment away from being wrong, and this file's whole subject is guards that
  -- turned out to rest on something else being true. The test that proves it is not vacuous drops the
  -- constraint to reach it.
  IF TG_OP = 'UPDATE' AND OLD."paidAt" IS NOT NULL THEN
    NEW."unregistered_paid_at" := OLD."unregistered_paid_at";
    RETURN NEW;
  END IF;

  -- A NEW EPISODE: an insert that arrives inside one, or NULL -> non-null.
  --
  -- `clock_timestamp()` and NOT `now()`: `now()` is transaction-start time, and the paid transition
  -- rides inside a transaction that also locks the order and reads it. `clock_timestamp()` is read
  -- at the statement. AT TIME ZONE 'UTC' because the column is TIMESTAMP WITHOUT TIME ZONE holding
  -- UTC — the identical expression `readDatabaseLedgerFence` and `stampSyncedAtFromDatabaseClock`
  -- use, so the fence's two ends are directly comparable whatever the session TimeZone is.
  NEW."unregistered_paid_at" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_mint_paid_episode_clock_insert ON "sales_orders";

CREATE TRIGGER sales_order_mint_paid_episode_clock_insert
BEFORE INSERT ON "sales_orders"
FOR EACH ROW
-- WHEN, so the ordinary insert of an unpaid order — this is a hot table — pays one NULL test.
WHEN (NEW."unregistered_paid_at" IS NOT NULL)
EXECUTE FUNCTION sales_order_mint_paid_episode_clock();

-- DROPPED BEFORE THE BACKFILL AND CREATED AFTER IT, and the order is load-bearing (r6). The rule
-- above preserves OLD whenever an episode is already under way, which is exactly what every row the
-- backfill below is about looks like — so with the UPDATE trigger in place the backfill would be a
-- silent no-op and the host-clock values it exists to delete would survive it. Both statements run
-- inside this migration's transaction, so there is no window in which the table is unguarded.
DROP TRIGGER IF EXISTS sales_order_mint_paid_episode_clock_update ON "sales_orders";

-- AND NO HOST-CLOCK VALUE SURVIVES THE MIGRATION.
--
-- 20260830090000 added this column and backfilled it from `paidAt` — an application clock, by
-- definition, since that is what wrote `paidAt`. The trigger governs every value written from here
-- on; these are the ones already stored, and leaving them would make the column half-minted with
-- nothing in the row to say which half a given value is in. That is precisely the "laundered pair"
-- objection round 6 raised against `syncedAtDatabaseClock`, and the answer here is simpler than a
-- second column because the direction is not symmetric: re-minting moves every historical marker
-- FORWARD to this instant, and a later episode fence binds strictly FEWER registrations. It can only
-- withhold.
--
-- What it costs, stated plainly: for the backfilled population — shopping-linked, paid, no local
-- receipt — a registration that completed BEFORE this migration no longer binds. That population by
-- construction has no registration (the backfill excluded orders with a `Payment` row, and nothing
-- registers a WooCommerce `date_paid_gmt`), and where one does exist the verdict is
-- PAID_WITHOUT_LEDGER_RECEIPT either way, which withholds. So the observable change is none, and the
-- invariant it buys is total: AFTER THIS MIGRATION EVERY NON-NULL VALUE IN THIS COLUMN WAS MINTED BY
-- THIS DATABASE.
--
-- THE MARKERS THAT ALREADY OUTLIVED THEIR EPISODE GO FIRST (r7, Codex HIGH 2). 20260830090000's
-- backfill wrote this column from `paidAt` for the shopping-linked paid population, and every release
-- since has cleared the pair together — but "every release since" is a census, and the state this
-- migration now forbids is reachable from anything that cleared `paidAt` without naming this column.
-- Re-minting such a row would preserve the wreckage with a fresh timestamp on it; the row has no
-- episode, so it gets no fence. Run BEFORE the re-mint below so the re-mint has nothing dead left to
-- move forward, and before the CHECK at the foot, which these rows would otherwise fail.
UPDATE "sales_orders"
SET "unregistered_paid_at" = NULL
WHERE "paidAt" IS NULL AND "unregistered_paid_at" IS NOT NULL;

UPDATE "sales_orders"
SET "unregistered_paid_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE "unregistered_paid_at" IS NOT NULL;

-- `UPDATE OF` so every write that does not mention EITHER column — status changes, allocation stamps,
-- the accounting sub-ledger columns — never reaches the function at all.
--
-- `"paidAt"` IS IN THE LIST BECAUSE THE EPISODE'S END IS A FACT ABOUT `paidAt` (r7, Codex HIGH 2).
-- `UPDATE OF` fires on the columns a statement MENTIONS, not on the ones whose value changes — and a
-- statement that clears the paid flag must mention `paidAt` to do it, whatever else it does or does
-- not know about. That is what makes this half of the rule total where a census of writers was not.
CREATE TRIGGER sales_order_mint_paid_episode_clock_update
BEFORE UPDATE OF "unregistered_paid_at", "paidAt" ON "sales_orders"
FOR EACH ROW
EXECUTE FUNCTION sales_order_mint_paid_episode_clock();

-- THE INVARIANT, SAID TO THE DATABASE (r7, Codex HIGH 2).
--
-- The three legal states, and the one that is not:
--
--   paidAt NULL,     marker NULL      not paid. Nothing to say.
--   paidAt non-null, marker NULL      paid, and a ledger receipt is behind it (or is expected to be).
--   paidAt non-null, marker non-null  paid off-ledger; the marker is that episode's own fence.
--   paidAt NULL,     marker non-null  ILLEGAL. A fence for an episode that is not running — the
--                                     stale-fence state r4 found and r6 left one door open to.
--
-- VALIDATED, not NOT VALID: the repair above leaves no row that can fail it, and a constraint that has
-- never looked at the table is a claim rather than a fact. It is deliberately the WEAKER of the two
-- mechanisms in normal operation — the BEFORE trigger repairs the write before this ever sees it, so
-- in production this fires only where a BEFORE trigger does not run at all (`session_replication_role
-- = replica`, a disabled trigger, a restore). Its other job is to be readable: `\d sales_orders` now
-- states the rule, which no amount of PL/pgSQL does.
--
-- prisma-schema-scope-ok: db-native check constraint | reason: Prisma cannot represent a cross-column CHECK, and the invariant must bind writers outside this repository
ALTER TABLE "sales_orders"
DROP CONSTRAINT IF EXISTS "sales_orders_paid_episode_marker_needs_paid_at";

ALTER TABLE "sales_orders"
ADD CONSTRAINT "sales_orders_paid_episode_marker_needs_paid_at"
CHECK ("paidAt" IS NOT NULL OR "unregistered_paid_at" IS NULL);
