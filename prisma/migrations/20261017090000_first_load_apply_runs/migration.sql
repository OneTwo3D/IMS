-- First-load apply runner: the run record.
--
-- A new table only: no existing row, reader or writer is affected, and nothing deployed before this migration reads
-- or writes it. There is no backfill (the runner has never run, and production is unused and will be reinstalled).
--
-- ONE ROW PER DATABASE. "singleton" is always true and unique, so a second load into the same database cannot create a
-- second record: the INSERT loses. The record then moves by compare-and-swap on "version" (UPDATE ... WHERE version =
-- the one the runner read), so two runners cannot both advance it. It is audit and the "same load" identity; the runner
-- derives what to load from the data tables themselves, never from this row.
CREATE TABLE "first_load_apply_runs" (
    "id" TEXT NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL,
    "manifest_digest" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_step" TEXT,
    "steps" JSONB NOT NULL DEFAULT '{}',
    "facts" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "first_load_apply_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "first_load_apply_runs_singleton_key" ON "first_load_apply_runs"("singleton");

-- prisma-schema-scope-ok: db-native check constraints | reason: Prisma cannot represent CHECK constraints, and the closed status list and the version floor must bind every writer, including a script run by hand
ALTER TABLE "first_load_apply_runs"
    ADD CONSTRAINT "first_load_apply_runs_singleton_true" CHECK ("singleton"),
    ADD CONSTRAINT "first_load_apply_runs_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "first_load_apply_runs_status_known" CHECK ("status" IN ('RUNNING', 'STEP_FAILED', 'CONFLICT', 'APPLIED', 'VERIFIED', 'VERIFY_FAILED')),
    ADD CONSTRAINT "first_load_apply_runs_step_known" CHECK ("current_step" IS NULL OR "current_step" IN ('suppliers', 'products', 'opening-stock', 'purchase-orders'));
