-- Outbound WMS order-push state per sales order (Phase 8). Additive: a new enum,
-- a new table with a unique FK to sales_orders (ON DELETE CASCADE), and indexes.
-- No changes to existing tables.
CREATE TYPE "WmsOrderPushState" AS ENUM ('PENDING_CREATE', 'SYNCED', 'PENDING_CANCEL', 'CANCELLED', 'DEAD_LETTER');

CREATE TABLE "wms_order_push_links" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "externalOrderId" TEXT,
    "externalOrderNumber" TEXT,
    "state" "WmsOrderPushState" NOT NULL DEFAULT 'PENDING_CREATE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wms_order_push_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_order_push_links_orderId_key" ON "wms_order_push_links"("orderId");
CREATE INDEX "wms_order_push_links_connector_state_idx" ON "wms_order_push_links"("connector", "state");

ALTER TABLE "wms_order_push_links"
    ADD CONSTRAINT "wms_order_push_links_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
