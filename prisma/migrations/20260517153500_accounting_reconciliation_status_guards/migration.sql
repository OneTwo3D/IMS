ALTER TABLE "accounting_reconciliation_findings"
  ADD COLUMN "statusUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "statusUpdatedBy" TEXT;

-- Keep status values forward-compatible with retry/report lifecycle states.
-- NOT VALID mirrors the existing online-check pattern; VALIDATE is separated
-- so PostgreSQL does not hold ACCESS EXCLUSIVE while scanning existing rows.
ALTER TABLE "accounting_reconciliation_runs"
  ADD CONSTRAINT "accounting_reconciliation_runs_status_check"
  CHECK ("status" IN ('COMPLETED', 'FAILED', 'PARTIAL')) NOT VALID;

ALTER TABLE "accounting_reconciliation_findings"
  ADD CONSTRAINT "accounting_reconciliation_findings_status_check"
  CHECK ("status" IN ('OPEN', 'RESOLVED', 'ACCEPTED')) NOT VALID;

ALTER TABLE "accounting_reconciliation_runs"
  VALIDATE CONSTRAINT "accounting_reconciliation_runs_status_check";

ALTER TABLE "accounting_reconciliation_findings"
  VALIDATE CONSTRAINT "accounting_reconciliation_findings_status_check";
