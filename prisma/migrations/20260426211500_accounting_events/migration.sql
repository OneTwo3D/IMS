-- Append-only accounting event ledger groundwork.
-- This migration only adds tables; existing accounting sync behavior is unchanged.

CREATE TABLE "accounting_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceEntityType" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "linesJson" JSONB NOT NULL,
    "externalSystem" TEXT,
    "externalId" TEXT,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounting_event_logs" (
    "id" TEXT NOT NULL,
    "accountingEventId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_event_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_events_idempotencyKey_key" ON "accounting_events"("idempotencyKey");
CREATE INDEX "accounting_events_sourceEntityType_sourceEntityId_idx" ON "accounting_events"("sourceEntityType", "sourceEntityId");
CREATE INDEX "accounting_events_status_businessDate_idx" ON "accounting_events"("status", "businessDate");
CREATE INDEX "accounting_events_externalSystem_externalId_idx" ON "accounting_events"("externalSystem", "externalId");
CREATE INDEX "accounting_events_reversalOfId_idx" ON "accounting_events"("reversalOfId");
CREATE INDEX "accounting_event_logs_accountingEventId_createdAt_idx" ON "accounting_event_logs"("accountingEventId", "createdAt");

ALTER TABLE "accounting_events"
  ADD CONSTRAINT "accounting_events_reversalOfId_fkey"
  FOREIGN KEY ("reversalOfId") REFERENCES "accounting_events"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "accounting_event_logs"
  ADD CONSTRAINT "accounting_event_logs_accountingEventId_fkey"
  FOREIGN KEY ("accountingEventId") REFERENCES "accounting_events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
