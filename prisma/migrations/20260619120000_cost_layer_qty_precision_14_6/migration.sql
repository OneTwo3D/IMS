-- cogs-audit scjz.1: cost_layers.receivedQty/remainingQty were numeric(12,4) but
-- the FIFO engine writes/consumes them at 6dp (createCostLayer .toFixed(6),
-- consumeFifoLayers decrements at 6dp) and cogs_entries/cost-layer snapshots are
-- 6dp. Postgres silently rounded layer quantities to 4dp on write, so the layer
-- pool drifted from the COGS ledger and from stock-on-hand on sub-unit quantities.
--
-- Widen the whole on-hand conservation chain to numeric(14,6) so the
-- stock_cost_layer_quantity_mismatch invariant (stock_levels.quantity vs
-- SUM(cost_layers.remainingQty)) and the receipt-time movement/layer pair stay
-- scale-consistent:
--   * cost_layers.receivedQty / remainingQty
--   * stock_levels.quantity / reservedQty
--   * stock_movements.qty
--
-- ROLLOUT NOTE: changing numeric scale rewrites each table under an ACCESS
-- EXCLUSIVE lock (Postgres has no concurrent path for a scale change). Widening
-- is lossless (existing 4dp values become x.xxxx00) and needs no backfill. This
-- is fine on staging; in production run it in a maintenance window. stock_movements
-- is the largest (append-only) table here, so its rewrite is the heaviest step.
ALTER TABLE "cost_layers"
  ALTER COLUMN "receivedQty" TYPE numeric(14,6),
  ALTER COLUMN "remainingQty" TYPE numeric(14,6);

ALTER TABLE "stock_levels"
  ALTER COLUMN "quantity" TYPE numeric(14,6),
  ALTER COLUMN "reservedQty" TYPE numeric(14,6);

-- The stock_movements_reporting_evidence_guard constraint trigger (migration
-- 20260602103000) lists qty in its "UPDATE OF ... qty ..." column set, so Postgres
-- refuses to alter qty's type while it exists ("cannot alter type of a column used
-- in a trigger definition"). Drop the trigger, rewrite the column, then recreate it
-- identically — the trigger FUNCTION (assert_stock_movement_reporting_evidence) is
-- unchanged, so only the trigger binding is recreated.
-- prisma-schema-scope-ok: db-native constraint trigger drop/recreate around the qty column rewrite; constraint triggers are not modeled in prisma/schema.prisma, so there is no matching schema change
DROP TRIGGER IF EXISTS stock_movements_reporting_evidence_guard ON "stock_movements";

ALTER TABLE "stock_movements"
  ALTER COLUMN "qty" TYPE numeric(14,6);

CREATE CONSTRAINT TRIGGER stock_movements_reporting_evidence_guard
AFTER INSERT OR UPDATE OF type, "productId", "fromWarehouseId", "toWarehouseId", qty, "referenceType", "referenceId"
ON "stock_movements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION assert_stock_movement_reporting_evidence();

-- Persisted daily snapshots and reservation snapshots derive from the live
-- quantities above; widen them (and roundQty now persists 6dp) so as-of/turnover
-- reports don't disagree with live stock at the 5th/6th dp.
ALTER TABLE "inventory_snapshots"
  ALTER COLUMN "qty" TYPE numeric(14,6);

ALTER TABLE "inventory_reservation_snapshots"
  ALTER COLUMN "reservedQty" TYPE numeric(14,6),
  ALTER COLUMN "availableQty" TYPE numeric(14,6);
