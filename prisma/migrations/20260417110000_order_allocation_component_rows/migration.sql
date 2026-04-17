DROP INDEX IF EXISTS "order_allocations_lineId_warehouseId_key";

CREATE UNIQUE INDEX "order_allocations_lineId_warehouseId_productId_key"
ON "order_allocations" ("lineId", "warehouseId", "productId");
