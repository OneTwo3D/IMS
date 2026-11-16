-- Additive: per-warehouse (StockLevel) overrides for the Product replenishment thresholds. NULL means the
-- warehouse inherits the Product value, so every existing row keeps behaving exactly as before. Planning-only
-- fields; nothing reads them outside Reorder Planning.
ALTER TABLE "stock_levels" ADD COLUMN "reorderPointOverride" DECIMAL(12,4);
ALTER TABLE "stock_levels" ADD COLUMN "safetyStockQtyOverride" DECIMAL(12,4);
ALTER TABLE "stock_levels" ADD COLUMN "reorderQtyOverride" DECIMAL(12,4);

ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_reorder_point_override_check" CHECK ("reorderPointOverride" IS NULL OR "reorderPointOverride" >= 0);
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_safety_stock_override_check" CHECK ("safetyStockQtyOverride" IS NULL OR "safetyStockQtyOverride" >= 0);
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_reorder_qty_override_check" CHECK ("reorderQtyOverride" IS NULL OR "reorderQtyOverride" >= 0);
