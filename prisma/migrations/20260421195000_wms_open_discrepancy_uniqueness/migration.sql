WITH ranked_product_discrepancies AS (
  SELECT
    "id",
    "connector",
    "warehouseId",
    "productId",
    "category",
    "detectionCount",
    "firstSeenAt",
    "lastSeenAt",
    ROW_NUMBER() OVER (
      PARTITION BY "connector", "warehouseId", "productId", "category"
      ORDER BY "lastSeenAt" DESC, "id" DESC
    ) AS "row_num"
  FROM "wms_stock_discrepancies"
  WHERE "status" = 'OPEN'
    AND "productId" IS NOT NULL
),
product_discrepancy_keepers AS (
  SELECT
    "connector",
    "warehouseId",
    "productId",
    "category",
    MAX(CASE WHEN "row_num" = 1 THEN "id" END) AS "keeper_id",
    SUM("detectionCount") AS "total_detection_count",
    MIN("firstSeenAt") AS "first_seen_at",
    MAX("lastSeenAt") AS "last_seen_at"
  FROM ranked_product_discrepancies
  GROUP BY "connector", "warehouseId", "productId", "category"
)
UPDATE "wms_stock_discrepancies" AS target
SET
  "detectionCount" = keepers."total_detection_count",
  "firstSeenAt" = keepers."first_seen_at",
  "lastSeenAt" = keepers."last_seen_at"
FROM product_discrepancy_keepers AS keepers
WHERE target."id" = keepers."keeper_id";

WITH ranked_product_discrepancies AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "connector", "warehouseId", "productId", "category"
      ORDER BY "lastSeenAt" DESC, "id" DESC
    ) AS "row_num"
  FROM "wms_stock_discrepancies"
  WHERE "status" = 'OPEN'
    AND "productId" IS NOT NULL
)
DELETE FROM "wms_stock_discrepancies"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_product_discrepancies
  WHERE "row_num" > 1
);

WITH ranked_sku_discrepancies AS (
  SELECT
    "id",
    "connector",
    "warehouseId",
    "sku",
    "category",
    "detectionCount",
    "firstSeenAt",
    "lastSeenAt",
    ROW_NUMBER() OVER (
      PARTITION BY "connector", "warehouseId", "sku", "category"
      ORDER BY "lastSeenAt" DESC, "id" DESC
    ) AS "row_num"
  FROM "wms_stock_discrepancies"
  WHERE "status" = 'OPEN'
    AND "productId" IS NULL
    AND "sku" IS NOT NULL
),
sku_discrepancy_keepers AS (
  SELECT
    "connector",
    "warehouseId",
    "sku",
    "category",
    MAX(CASE WHEN "row_num" = 1 THEN "id" END) AS "keeper_id",
    SUM("detectionCount") AS "total_detection_count",
    MIN("firstSeenAt") AS "first_seen_at",
    MAX("lastSeenAt") AS "last_seen_at"
  FROM ranked_sku_discrepancies
  GROUP BY "connector", "warehouseId", "sku", "category"
)
UPDATE "wms_stock_discrepancies" AS target
SET
  "detectionCount" = keepers."total_detection_count",
  "firstSeenAt" = keepers."first_seen_at",
  "lastSeenAt" = keepers."last_seen_at"
FROM sku_discrepancy_keepers AS keepers
WHERE target."id" = keepers."keeper_id";

WITH ranked_sku_discrepancies AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "connector", "warehouseId", "sku", "category"
      ORDER BY "lastSeenAt" DESC, "id" DESC
    ) AS "row_num"
  FROM "wms_stock_discrepancies"
  WHERE "status" = 'OPEN'
    AND "productId" IS NULL
    AND "sku" IS NOT NULL
)
DELETE FROM "wms_stock_discrepancies"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_sku_discrepancies
  WHERE "row_num" > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "wms_stock_discrepancies_open_product_key"
  ON "wms_stock_discrepancies"("connector", "warehouseId", "productId", "category")
  WHERE "status" = 'OPEN'
    AND "productId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "wms_stock_discrepancies_open_sku_key"
  ON "wms_stock_discrepancies"("connector", "warehouseId", "sku", "category")
  WHERE "status" = 'OPEN'
    AND "productId" IS NULL
    AND "sku" IS NOT NULL;
