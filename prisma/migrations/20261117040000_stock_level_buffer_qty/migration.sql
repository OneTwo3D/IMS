-- Additive: per-location (StockLevel) buffer, the quantity held back from connected sales channels.
-- Default 0 means every existing row keeps pushing exactly what it pushed before. Channel availability
-- control only: allocation, on-hand, reserved and the WMS alignment never read it.
ALTER TABLE "stock_levels" ADD COLUMN "bufferQty" DECIMAL(14,6) NOT NULL DEFAULT 0;

ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_buffer_qty_check" CHECK ("bufferQty" >= 0);
