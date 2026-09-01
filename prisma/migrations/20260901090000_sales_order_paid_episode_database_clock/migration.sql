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
-- ON `TG_OP = 'INSERT'` AND `IS DISTINCT FROM`. A write that leaves the value alone must not re-mint
-- it: the episode began when the flag was set, and re-stamping it on an unrelated UPDATE would push
-- the fence forward past registrations that had already completed under it — unbinding them, which is
-- the failure this migration exists to remove, re-created by its own fix. So only a statement that
-- actually CHANGES the value mints a new one. Clearing to NULL is left alone entirely: no episode, no
-- fence.
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
  IF NEW."unregistered_paid_at" IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD."unregistered_paid_at" IS DISTINCT FROM NEW."unregistered_paid_at")
  THEN
    -- `clock_timestamp()` and NOT `now()`: `now()` is transaction-start time, and the paid transition
    -- rides inside a transaction that also locks the order and reads it. `clock_timestamp()` is read
    -- at the statement. AT TIME ZONE 'UTC' because the column is TIMESTAMP WITHOUT TIME ZONE holding
    -- UTC — the identical expression `readDatabaseLedgerFence` and `stampSyncedAtFromDatabaseClock`
    -- use, so the fence's two ends are directly comparable whatever the session TimeZone is.
    NEW."unregistered_paid_at" := clock_timestamp() AT TIME ZONE 'UTC';
  END IF;
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

DROP TRIGGER IF EXISTS sales_order_mint_paid_episode_clock_update ON "sales_orders";

-- `UPDATE OF` so every write that does not mention the column — status changes, allocation stamps,
-- the accounting sub-ledger columns — never reaches the function at all.
CREATE TRIGGER sales_order_mint_paid_episode_clock_update
BEFORE UPDATE OF "unregistered_paid_at" ON "sales_orders"
FOR EACH ROW
EXECUTE FUNCTION sales_order_mint_paid_episode_clock();

-- AND NO HOST-CLOCK VALUE SURVIVES THE MIGRATION.
--
-- 20260830090000 added this column and backfilled it from `paidAt` — an application clock, by
-- definition, since that is what wrote `paidAt`. The trigger above governs every value written from
-- here on; these are the ones already stored, and leaving them would make the column half-minted with
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
-- The trigger fires on this statement and mints each row's own `clock_timestamp()`, so the value
-- written below is replaced per row by the same rule every later writer gets. It is spelt out anyway
-- rather than written as a no-op update: a migration that depends on a trigger to supply the value it
-- claims to write is a migration that reads as doing nothing.
UPDATE "sales_orders"
SET "unregistered_paid_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE "unregistered_paid_at" IS NOT NULL;
