ALTER TABLE "products"
  ADD COLUMN "reorderPoint" DECIMAL(12,4),
  ADD COLUMN "reorderQty" DECIMAL(12,4),
  ADD COLUMN "safetyStockQty" DECIMAL(12,4),
  ADD COLUMN "abcClass" TEXT;

ALTER TABLE "supplier_products"
  ADD COLUMN "leadTimeDays" INTEGER;

ALTER TABLE "products"
  ADD CONSTRAINT "products_reorder_point_non_negative"
  CHECK ("reorderPoint" IS NULL OR "reorderPoint" >= 0) NOT VALID,
  ADD CONSTRAINT "products_reorder_qty_non_negative"
  CHECK ("reorderQty" IS NULL OR "reorderQty" >= 0) NOT VALID,
  ADD CONSTRAINT "products_safety_stock_qty_non_negative"
  CHECK ("safetyStockQty" IS NULL OR "safetyStockQty" >= 0) NOT VALID,
  ADD CONSTRAINT "products_abc_class_allowed"
  CHECK ("abcClass" IS NULL OR "abcClass" IN ('A', 'B', 'C')) NOT VALID;

ALTER TABLE "supplier_products"
  ADD CONSTRAINT "supplier_products_lead_time_days_non_negative"
  CHECK ("leadTimeDays" IS NULL OR "leadTimeDays" >= 0) NOT VALID;

ALTER TABLE "products" VALIDATE CONSTRAINT "products_reorder_point_non_negative";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_reorder_qty_non_negative";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_safety_stock_qty_non_negative";
ALTER TABLE "products" VALIDATE CONSTRAINT "products_abc_class_allowed";
ALTER TABLE "supplier_products" VALIDATE CONSTRAINT "supplier_products_lead_time_days_non_negative";
