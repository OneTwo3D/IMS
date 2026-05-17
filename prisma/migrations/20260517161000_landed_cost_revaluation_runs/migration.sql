-- ActivityEntityType value added for PR #61
-- (AccountingReconciliationFinding model); the landed_cost_revaluation_runs
-- table below is this PR's primary change.
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'AccountingReconciliationFinding';

CREATE TABLE "landed_cost_revaluation_runs" (
  "id" TEXT NOT NULL,
  "freightPoId" TEXT,
  "primaryPoId" TEXT,
  "triggeredById" TEXT,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "beforeJson" JSONB NOT NULL,
  "afterJson" JSONB NOT NULL,
  "accountingJson" JSONB,
  "warningsJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "landed_cost_revaluation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "landed_cost_revaluation_runs_freightPoId_createdAt_idx"
  ON "landed_cost_revaluation_runs" ("freightPoId", "createdAt");

CREATE INDEX "landed_cost_revaluation_runs_primaryPoId_createdAt_idx"
  ON "landed_cost_revaluation_runs" ("primaryPoId", "createdAt");

CREATE INDEX "landed_cost_revaluation_runs_status_createdAt_idx"
  ON "landed_cost_revaluation_runs" ("status", "createdAt");

-- Forward-compatible with future dry-run or failed audit rows while the
-- current recalculation path writes COMPLETED rows only.
ALTER TABLE "landed_cost_revaluation_runs"
  ADD CONSTRAINT "landed_cost_revaluation_runs_status_check"
  CHECK ("status" IN ('COMPLETED', 'FAILED', 'DRY_RUN')) NOT VALID;

ALTER TABLE "landed_cost_revaluation_runs"
  VALIDATE CONSTRAINT "landed_cost_revaluation_runs_status_check";
