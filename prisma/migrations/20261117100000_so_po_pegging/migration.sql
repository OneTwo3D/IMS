-- Additive: SO-to-PO pegging. Stock received on a PO line is held for, and allocated to, the pegged sales-order line first.
-- No rows means no peg anywhere: allocation behaves exactly as before. IMS-internal allocation ordering; nothing is pushed anywhere.
CREATE TYPE "SalesOrderLinePegEndReason" AS ENUM ('FULLY_ALLOCATED', 'SALES_ORDER_CANCELLED', 'SALES_LINE_REMOVED', 'SALES_ORDER_ADVANCED', 'PURCHASE_ORDER_CANCELLED', 'PURCHASE_LINE_REMOVED', 'PURCHASE_LINE_RECEIVED_ELSEWHERE', 'REMOVED_BY_USER');

CREATE TABLE "sales_order_line_pegs" (
    "id" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "qty" DECIMAL(12,4) NOT NULL,
    "receivedQty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "allocatedQty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "baselineAllocatedQty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "seenLandedQty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "receivedByWarehouse" JSONB NOT NULL DEFAULT '{}',
    "seenLandedByWarehouse" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "endedAt" TIMESTAMP(3),
    "endReason" "SalesOrderLinePegEndReason",
    "endedById" TEXT,

    CONSTRAINT "sales_order_line_pegs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_order_line_pegs_qty_check" CHECK ("qty" > 0 AND "receivedQty" >= 0 AND "receivedQty" <= "qty" AND "allocatedQty" >= 0 AND "allocatedQty" <= "receivedQty"),
    CONSTRAINT "sales_order_line_pegs_end_check" CHECK (("endedAt" IS NULL) = ("endReason" IS NULL))
);

CREATE INDEX "sales_order_line_pegs_purchaseOrderLineId_idx" ON "sales_order_line_pegs"("purchaseOrderLineId");

CREATE INDEX "sales_order_line_pegs_salesOrderLineId_idx" ON "sales_order_line_pegs"("salesOrderLineId");

-- One LIVE peg per (sales line, purchase line) pair; ended pegs stay as history.
CREATE UNIQUE INDEX "sales_order_line_pegs_live_pair_key" ON "sales_order_line_pegs"("salesOrderLineId", "purchaseOrderLineId") WHERE "endedAt" IS NULL;

ALTER TABLE "sales_order_line_pegs" ADD CONSTRAINT "sales_order_line_pegs_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "sales_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sales_order_line_pegs" ADD CONSTRAINT "sales_order_line_pegs_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
