-- Generic inbound webhook event staging for push-primary WMS connectors (ShipHero).
-- Mintsoft is poll-only and uses wms_inbound_receipt_events (ASN-specific); ShipHero
-- pushes order/shipment/inventory webhooks, so this table stages them by event type
-- with idempotent dedupe on (connector, externalEventId), retry/dead-letter state,
-- and a monotonic status rank for the out-of-order writeback guard.
CREATE TABLE "wms_webhook_events" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "externalOrderId" TEXT,
    "statusRank" INTEGER,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wms_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_webhook_events_connector_externalEventId_key" ON "wms_webhook_events"("connector", "externalEventId");
CREATE INDEX "wms_webhook_events_processingStatus_nextRetryAt_idx" ON "wms_webhook_events"("processingStatus", "nextRetryAt");
CREATE INDEX "wms_webhook_events_connector_externalOrderId_idx" ON "wms_webhook_events"("connector", "externalOrderId");
CREATE INDEX "wms_webhook_events_deadLetteredAt_idx" ON "wms_webhook_events"("deadLetteredAt");
