CREATE TABLE "accounting_reconciliation_runs" (
  "id" TEXT NOT NULL,
  "fromDate" TIMESTAMP(3),
  "toDate" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "totalCount" INTEGER NOT NULL,
  "warningCount" INTEGER NOT NULL,
  "criticalCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "accounting_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounting_reconciliation_findings" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "message" TEXT NOT NULL,
  "details" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "accounting_reconciliation_findings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "accounting_reconciliation_runs_status_createdAt_idx"
  ON "accounting_reconciliation_runs" ("status", "createdAt");

CREATE INDEX "accounting_reconciliation_runs_createdAt_idx"
  ON "accounting_reconciliation_runs" ("createdAt");

CREATE INDEX "accounting_reconciliation_findings_runId_status_idx"
  ON "accounting_reconciliation_findings" ("runId", "status");

CREATE INDEX "accounting_reconciliation_findings_status_createdAt_idx"
  ON "accounting_reconciliation_findings" ("status", "createdAt");

CREATE INDEX "accounting_reconciliation_findings_code_status_idx"
  ON "accounting_reconciliation_findings" ("code", "status");

CREATE INDEX "accounting_reconciliation_findings_entityType_entityId_idx"
  ON "accounting_reconciliation_findings" ("entityType", "entityId");

ALTER TABLE "accounting_reconciliation_findings"
  ADD CONSTRAINT "accounting_reconciliation_findings_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "accounting_reconciliation_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
