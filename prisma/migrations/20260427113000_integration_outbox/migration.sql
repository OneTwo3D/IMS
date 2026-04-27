CREATE TABLE "integration_outbox" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_outbox_idempotencyKey_key" ON "integration_outbox"("idempotencyKey");
CREATE INDEX "integration_outbox_status_nextAttemptAt_idx" ON "integration_outbox"("status", "nextAttemptAt");
CREATE INDEX "integration_outbox_connector_operation_status_nextAttemptAt_idx" ON "integration_outbox"("connector", "operation", "status", "nextAttemptAt");
CREATE INDEX "integration_outbox_lockedAt_idx" ON "integration_outbox"("lockedAt");
