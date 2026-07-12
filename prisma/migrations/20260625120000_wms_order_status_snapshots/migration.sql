-- Cached live WMS order status per sales order, populated by the WMS order-status
-- sweep cron and read by the sales-list chips. Additive: a brand-new table with a
-- FK to sales_orders (ON DELETE CASCADE). No changes to existing tables.
CREATE TABLE "wms_order_status_snapshots" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "connectorLabel" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "externalOrderNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusLabel" TEXT NOT NULL,
    "isSplit" BOOLEAN NOT NULL DEFAULT false,
    "partCount" INTEGER,
    "isMerged" BOOLEAN NOT NULL DEFAULT false,
    "mergedOrderNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deepLinkUrl" TEXT,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "wms_order_status_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wms_order_status_snapshots_orderId_key" ON "wms_order_status_snapshots"("orderId");
CREATE INDEX "wms_order_status_snapshots_connector_idx" ON "wms_order_status_snapshots"("connector");
CREATE INDEX "wms_order_status_snapshots_fetchedAt_idx" ON "wms_order_status_snapshots"("fetchedAt");

ALTER TABLE "wms_order_status_snapshots"
    ADD CONSTRAINT "wms_order_status_snapshots_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
