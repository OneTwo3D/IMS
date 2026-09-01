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
-- AND A GENUINE RE-PAYMENT STILL MINTS, because ending an episode is what clears the column, in the
-- same statement that clears `paidAt`, by every writer the census in
-- tests/accounting/paid-provenance-writers.test.ts enumerates: `markSalesOrderPaid` toggling off
-- (`paidAt: null, unregisteredPaidAt: null`), `removePaymentAndSettlePaidAt` when the remaining
-- receipts no longer settle the order, and both pollers' reversal writes. Paid → unpaid → paid again
-- therefore passes through NULL, and the second `paid` is a NULL-to-non-null transition that mints a
-- second, strictly later fence. What can no longer happen is a fence moving WITHOUT the flag having
-- been cleared, and no legitimate episode begins that way.
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
  -- The flag is being cleared. The episode is ending, not beginning; leave the NULL alone.
  IF NEW."unregistered_paid_at" IS NULL THEN
    RETURN NEW;
  END IF;

  -- AN EPISODE ALREADY UNDER WAY. The stored fence is this episode's own start and nothing later may
  -- move it: not a WooCommerce redelivery re-sending `date_paid_gmt`, not a repair script, not a
  -- previous release. The caller's value is discarded and OLD is written back unchanged, so the
  -- statement is a no-op on this column however it was spelt.
  IF TG_OP = 'UPDATE' AND OLD."unregistered_paid_at" IS NOT NULL THEN
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
UPDATE "sales_orders"
SET "unregistered_paid_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE "unregistered_paid_at" IS NOT NULL;

-- `UPDATE OF` so every write that does not mention the column — status changes, allocation stamps,
-- the accounting sub-ledger columns — never reaches the function at all.
CREATE TRIGGER sales_order_mint_paid_episode_clock_update
BEFORE UPDATE OF "unregistered_paid_at" ON "sales_orders"
FOR EACH ROW
EXECUTE FUNCTION sales_order_mint_paid_episode_clock();
