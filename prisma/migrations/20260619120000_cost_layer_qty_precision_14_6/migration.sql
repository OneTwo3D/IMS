-- cogs-audit scjz.1: cost_layers.receivedQty/remainingQty were numeric(12,4) but
-- the FIFO engine writes/consumes them at 6dp (createCostLayer .toFixed(6),
-- consumeFifoLayers decrements at 6dp) and cogs_entries/cost-layer snapshots are
-- 6dp. Postgres silently rounded layer quantities to 4dp on write, so the layer
-- pool drifted from the COGS ledger and from stock-on-hand on sub-unit quantities.
-- Widen to numeric(14,6) to match the engine and the COGS subledger.
--
-- ROLLOUT NOTE: changing numeric scale rewrites the table under an ACCESS
-- EXCLUSIVE lock (Postgres has no concurrent path for a scale change). This is
-- fine on staging; in production run it in a maintenance window. Widening is
-- lossless (existing 4dp values become x.xxxx00). No data backfill required.
ALTER TABLE "cost_layers"
  ALTER COLUMN "receivedQty" TYPE numeric(14,6),
  ALTER COLUMN "remainingQty" TYPE numeric(14,6);
