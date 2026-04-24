CREATE UNIQUE INDEX IF NOT EXISTS "cost_layers_one_opening_stock_per_product_warehouse"
  ON "cost_layers" ("productId", "warehouseId")
  WHERE "isOpeningStock" = true;
