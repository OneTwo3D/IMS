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
-- WHAT ACTUALLY MARKS A NEW EPISODE IS A TRANSITION THE DATABASE CAN SEE FOR ITSELF: the column going
-- from ABSENT to PRESENT. Nothing a caller supplies is consulted at all.
--
--   INSERT with a marker            the row arrives already inside an episode. Mint.
--   UPDATE, OLD NULL, NEW non-null  the paid flag has just been set with nothing to register. Mint.
--   UPDATE, OLD non-null            an episode is already under way. THE STORED VALUE STANDS,
--                                   whatever the caller supplied — this is the redelivery case.
--   NEW NULL                        the flag is being cleared. No episode, no fence, nothing to do.
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

  -- The marker is being cleared while the flag stands — a ledger receipt has been recorded for a paid
  -- state that had none (`addPayment` on coverage). The episode's fence goes with it.
  IF NEW."unregistered_paid_at" IS NULL THEN
    RETURN NEW;
  END IF;

  -- AN EPISODE ALREADY UNDER WAY. The stored fence is this episode's own start and nothing later may
  -- move it: not a WooCommerce redelivery re-sending `date_paid_gmt`, not a repair script, not a
  -- previous release. The caller's value is discarded and OLD is written back unchanged, so the
  -- statement is a no-op on this column however it was spelt.
  --
  -- `OLD."paidAt" IS NOT NULL` is the second half of r7's fix and it is not belt-and-braces: an
  -- episode is a period during which the flag STANDS, so a marker sitting beside a NULL `paidAt` is
  -- not one. Without this clause a row that reached that state — a pre-migration row, a write on a
  -- path where this trigger did not run — would have its dead fence PRESERVED across the next paid
  -- transition, which is the stale-fence defect itself.
  IF TG_OP = 'UPDATE' AND OLD."unregistered_paid_at" IS NOT NULL AND OLD."paidAt" IS NOT NULL THEN
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
