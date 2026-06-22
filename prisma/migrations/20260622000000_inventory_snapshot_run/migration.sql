-- Daily coverage marker for sparse inventory_snapshots rows (cogs-audit scjz.60.5).
-- Presence of a run row for a snapshotDate proves the daily snapshot job covered
-- that exact date, so an empty inventory_snapshots result for the date is a genuine
-- zero on-hand subledger value rather than an uncovered date. Mirrors
-- inventory_reservation_snapshot_runs.
CREATE TABLE "inventory_snapshot_runs" (
  "id" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "stockLevelCount" INTEGER NOT NULL,
  "snapshotCount" INTEGER NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'cron',
  "checkMethod" TEXT NOT NULL DEFAULT 'daily_current_state_v1',
  "cutoffAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "inventory_snapshot_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_snapshot_runs_snapshotDate_key"
  ON "inventory_snapshot_runs"("snapshotDate");

ALTER TABLE "inventory_snapshot_runs"
  ADD CONSTRAINT "inventory_snapshot_runs_stock_level_count_nonnegative"
  CHECK ("stockLevelCount" >= 0) NOT VALID;

ALTER TABLE "inventory_snapshot_runs"
  ADD CONSTRAINT "inventory_snapshot_runs_snapshot_count_nonnegative"
  CHECK ("snapshotCount" >= 0) NOT VALID;

ALTER TABLE "inventory_snapshot_runs"
  VALIDATE CONSTRAINT "inventory_snapshot_runs_stock_level_count_nonnegative";

ALTER TABLE "inventory_snapshot_runs"
  VALIDATE CONSTRAINT "inventory_snapshot_runs_snapshot_count_nonnegative";
