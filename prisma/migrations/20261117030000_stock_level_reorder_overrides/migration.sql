-- Additive: per-warehouse overrides for the Product replenishment thresholds, in their own table so that saving one
-- never creates or changes a stock_levels row (a stock row changes what stock sync and availability see). A row exists
-- only while an operator has set a value; NULL inherits the Product value. Planning-only; nothing outside Reorder
-- Planning reads it.
CREATE TABLE "reorder_threshold_overrides" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "reorderPoint" DECIMAL(12,4),
    "safetyStockQty" DECIMAL(12,4),
    "reorderQty" DECIMAL(12,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reorder_threshold_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reorder_threshold_overrides_productId_warehouseId_key" ON "reorder_threshold_overrides"("productId", "warehouseId");

ALTER TABLE "reorder_threshold_overrides" ADD CONSTRAINT "reorder_threshold_overrides_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reorder_threshold_overrides" ADD CONSTRAINT "reorder_threshold_overrides_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reorder_threshold_overrides" ADD CONSTRAINT "reorder_threshold_overrides_reorder_point_check" CHECK ("reorderPoint" IS NULL OR "reorderPoint" >= 0);
ALTER TABLE "reorder_threshold_overrides" ADD CONSTRAINT "reorder_threshold_overrides_safety_stock_check" CHECK ("safetyStockQty" IS NULL OR "safetyStockQty" >= 0);
ALTER TABLE "reorder_threshold_overrides" ADD CONSTRAINT "reorder_threshold_overrides_reorder_qty_check" CHECK ("reorderQty" IS NULL OR "reorderQty" >= 0);
