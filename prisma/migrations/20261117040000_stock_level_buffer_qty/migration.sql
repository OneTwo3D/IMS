-- Additive: per-location buffer, the quantity held back from connected sales channels. A table of its own (not a stock_levels
-- column) so that setting a buffer never creates a stock row. No rows means no buffer anywhere: every push stays exactly as before.
-- Channel availability control only: allocation, on-hand, reserved and the WMS alignment never read it.
CREATE TABLE "location_stock_buffers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "bufferQty" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_stock_buffers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_stock_buffers_buffer_qty_check" CHECK ("bufferQty" >= 0)
);

CREATE UNIQUE INDEX "location_stock_buffers_productId_warehouseId_key" ON "location_stock_buffers"("productId", "warehouseId");

CREATE INDEX "location_stock_buffers_warehouseId_idx" ON "location_stock_buffers"("warehouseId");

ALTER TABLE "location_stock_buffers" ADD CONSTRAINT "location_stock_buffers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "location_stock_buffers" ADD CONSTRAINT "location_stock_buffers_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
