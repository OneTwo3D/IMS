-- Persist per-snapshot point-in-time reliability (cogs-audit scjz.43/.48). A
-- backfilled snapshot seeded from current cost layers that were revalued after its
-- date is not point-in-time accurate; this flag lets as-of reads surface that
-- instead of trusting a stale value. NOT NULL is safe: every existing/new row
-- defaults to true (existing live-captured snapshots are treated as reliable, the
-- prior behaviour), and the backfill sets false where revaluations make it stale.
ALTER TABLE "inventory_snapshots"
  ADD COLUMN "valueReplayReliable" boolean NOT NULL DEFAULT true;
