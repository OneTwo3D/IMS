ALTER TABLE "inventory_reservation_snapshot_runs"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'cron',
  ADD COLUMN "checkMethod" TEXT NOT NULL DEFAULT 'daily_current_state_v1',
  ADD COLUMN "cutoffAt" TIMESTAMP(3),
  ADD COLUMN "reservationSourceCount" INTEGER;

ALTER TABLE "inventory_reservation_snapshot_runs"
  ADD CONSTRAINT "inventory_reservation_snapshot_runs_source_count_nonnegative"
  CHECK ("reservationSourceCount" IS NULL OR "reservationSourceCount" >= 0) NOT VALID;

ALTER TABLE "inventory_reservation_snapshot_runs"
  VALIDATE CONSTRAINT "inventory_reservation_snapshot_runs_source_count_nonnegative";
