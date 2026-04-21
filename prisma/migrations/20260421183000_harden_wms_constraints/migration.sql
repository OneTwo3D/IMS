DROP INDEX IF EXISTS "external_wms_bindings_connector_warehouseId_key";

DELETE FROM "external_wms_bindings"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "connector", "warehouseId"
        ORDER BY "createdAt" ASC, "id" ASC
      ) AS "row_num"
    FROM "external_wms_bindings"
  ) ranked
  WHERE ranked."row_num" > 1
);

CREATE UNIQUE INDEX "external_wms_bindings_connector_warehouseId_key"
  ON "external_wms_bindings"("connector", "warehouseId");

CREATE INDEX IF NOT EXISTS "external_wms_bindings_warehouseId_idx"
  ON "external_wms_bindings"("warehouseId");

DELETE FROM "wms_asn_line_maps"
WHERE NOT EXISTS (
  SELECT 1
  FROM "wms_asn_maps"
  WHERE "wms_asn_maps"."id" = "wms_asn_line_maps"."asnMapId"
);

DELETE FROM "wms_asn_line_maps"
WHERE NOT EXISTS (
  SELECT 1
  FROM "products"
  WHERE "products"."id" = "wms_asn_line_maps"."productId"
);

DELETE FROM "wms_asn_maps"
WHERE NOT EXISTS (
  SELECT 1
  FROM "warehouses"
  WHERE "warehouses"."id" = "wms_asn_maps"."warehouseId"
);

UPDATE "wms_sync_jobs"
SET "warehouseId" = NULL
WHERE "warehouseId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "warehouses"
    WHERE "warehouses"."id" = "wms_sync_jobs"."warehouseId"
  );

UPDATE "wms_sync_logs"
SET "productId" = NULL
WHERE "productId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "products"
    WHERE "products"."id" = "wms_sync_logs"."productId"
  );

DELETE FROM "wms_stock_snapshots"
WHERE NOT EXISTS (
  SELECT 1
  FROM "warehouses"
  WHERE "warehouses"."id" = "wms_stock_snapshots"."warehouseId"
)
OR NOT EXISTS (
  SELECT 1
  FROM "products"
  WHERE "products"."id" = "wms_stock_snapshots"."productId"
);

UPDATE "wms_stock_discrepancies"
SET "productId" = NULL
WHERE "productId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "products"
    WHERE "products"."id" = "wms_stock_discrepancies"."productId"
  );

DELETE FROM "wms_stock_discrepancies"
WHERE NOT EXISTS (
  SELECT 1
  FROM "warehouses"
  WHERE "warehouses"."id" = "wms_stock_discrepancies"."warehouseId"
);

UPDATE "wms_returns_inbox"
SET "orderId" = NULL
WHERE "orderId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "sales_orders"
    WHERE "sales_orders"."id" = "wms_returns_inbox"."orderId"
  );

UPDATE "wms_returns_inbox"
SET "productId" = NULL
WHERE "productId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "products"
    WHERE "products"."id" = "wms_returns_inbox"."productId"
  );

UPDATE "wms_returns_inbox"
SET "warehouseId" = NULL
WHERE "warehouseId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "warehouses"
    WHERE "warehouses"."id" = "wms_returns_inbox"."warehouseId"
  );

ALTER TABLE "wms_asn_maps"
  ADD CONSTRAINT "wms_asn_maps_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wms_asn_line_maps"
  ADD CONSTRAINT "wms_asn_line_maps_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wms_sync_jobs"
  ADD CONSTRAINT "wms_sync_jobs_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wms_sync_logs"
  ADD CONSTRAINT "wms_sync_logs_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wms_stock_snapshots"
  ADD CONSTRAINT "wms_stock_snapshots_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_stock_snapshots"
  ADD CONSTRAINT "wms_stock_snapshots_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_stock_discrepancies"
  ADD CONSTRAINT "wms_stock_discrepancies_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wms_stock_discrepancies"
  ADD CONSTRAINT "wms_stock_discrepancies_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wms_returns_inbox"
  ADD CONSTRAINT "wms_returns_inbox_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wms_returns_inbox"
  ADD CONSTRAINT "wms_returns_inbox_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wms_returns_inbox"
  ADD CONSTRAINT "wms_returns_inbox_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
