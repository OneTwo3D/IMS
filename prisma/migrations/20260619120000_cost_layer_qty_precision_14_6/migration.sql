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

ALTER TABLE "stock_movements"
  ALTER COLUMN "qty" TYPE numeric(14,6);
