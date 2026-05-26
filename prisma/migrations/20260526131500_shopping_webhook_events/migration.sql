CREATE TABLE "shopping_webhook_events" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "externalEventId" TEXT,
    "topic" TEXT,
    "payloadHash" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopping_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopping_webhook_events_connector_resource_payloadHash_key"
    ON "shopping_webhook_events"("connector", "resource", "payloadHash");

CREATE INDEX "swhe_due_idx"
    ON "shopping_webhook_events"("connector", "resource", "status", "receivedAt");

CREATE INDEX "swhe_retry_idx"
    ON "shopping_webhook_events"("connector", "status", "nextAttemptAt");

CREATE INDEX "swhe_external_event_id_idx"
    ON "shopping_webhook_events"("connector", "externalEventId");

ALTER TABLE "shopping_webhook_events"
    ADD CONSTRAINT "shopping_webhook_events_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER'));
