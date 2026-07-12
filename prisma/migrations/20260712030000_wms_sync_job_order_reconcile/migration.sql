-- q66in.4.4: scheduled order-level reconciliation runs get their own job type.
ALTER TYPE "WmsSyncJobType" ADD VALUE IF NOT EXISTS 'ORDER_RECONCILE';

-- Rotation stamp: the capped reconcile verifies least-recently-checked links first.
ALTER TABLE "wms_order_push_links" ADD COLUMN "reconcileCheckedAt" TIMESTAMP(3);

-- Durable order-level reconcile findings: OPEN rows persist across capped runs;
-- resolved only when the specific order re-verifies clean.
CREATE TABLE "wms_order_discrepancies" (
    "id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detail" TEXT,
    "externalOrderNumber" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "wms_order_discrepancies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wms_order_discrepancies_status_category_idx" ON "wms_order_discrepancies"("status", "category");
CREATE INDEX "wms_order_discrepancies_orderId_idx" ON "wms_order_discrepancies"("orderId");

-- One OPEN row per (order, category); resolved history may accumulate.
CREATE UNIQUE INDEX "wms_order_discrepancies_open_unique"
  ON "wms_order_discrepancies"("orderId", "category")
  WHERE "status" = 'OPEN';

ALTER TABLE "wms_order_discrepancies"
  ADD CONSTRAINT "wms_order_discrepancies_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "sales_orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
