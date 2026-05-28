-- Denormalised stock movement value fields for reporting.
--
-- The reporting indexes for these columns live in the following
-- single-statement migrations so Prisma runs each CREATE INDEX CONCURRENTLY
-- outside a transaction:
--   20260528162501_stock_movement_values_createdat_index
--   20260528162502_stock_movement_values_product_createdat_index
--   20260528162503_stock_movement_values_type_createdat_index
-- If any concurrent index build is interrupted, drop the INVALID index reported
-- by pg_index/psql and rerun migrate deploy. The data backfill below remains
-- idempotent through NULL guards.

ALTER TABLE "stock_movements"
  ADD COLUMN IF NOT EXISTS "unitCostBase" DECIMAL(18,6),
  ADD COLUMN IF NOT EXISTS "totalValueBase" DECIMAL(18,6);

CREATE TABLE IF NOT EXISTS "stock_movement_backfill_audit" (
  "id" TEXT PRIMARY KEY,
  "movementType" "StockMovementType" NOT NULL,
  "count" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "firstRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE "stock_movement_backfill_audit" IS 'Per-migration stock movement value backfill audit. id format: <migration_name>:<movementType>:<reason>; firstRunAt is immutable on retry and runAt records the latest run.';

-- Derivable outbound/write-off movements already have COGS entries linked by movement id.
WITH cogs_totals AS (
  SELECT
    "movementId",
    SUM("qty") AS qty,
    SUM("totalCostBase") AS total_value
  FROM "cogs_entries"
  GROUP BY "movementId"
)
UPDATE "stock_movements" sm
SET
  "unitCostBase" = ROUND((ct.total_value / NULLIF(ct.qty, 0))::numeric, 6),
  "totalValueBase" = ROUND(ct.total_value::numeric, 6)
FROM cogs_totals ct
WHERE sm.id = ct."movementId"
  AND ct.qty > 0
  AND sm."unitCostBase" IS NULL
  AND sm."totalValueBase" IS NULL;

-- Opening stock and positive manual adjustments have a direct cost-layer link.
WITH layer_totals AS (
  SELECT
    "adjustment_movement_id" AS movement_id,
    SUM("receivedQty") AS qty,
    SUM("receivedQty" * "unitCostBase") AS total_value
  FROM "cost_layers"
  WHERE "adjustment_movement_id" IS NOT NULL
  GROUP BY "adjustment_movement_id"
)
UPDATE "stock_movements" sm
SET
  "unitCostBase" = ROUND((lt.total_value / NULLIF(lt.qty, 0))::numeric, 6),
  "totalValueBase" = ROUND(lt.total_value::numeric, 6)
FROM layer_totals lt
WHERE sm.id = lt.movement_id
  AND lt.qty > 0
  AND sm."unitCostBase" IS NULL;

DO $$
DECLARE
  row record;
  unresolved_reason text := 'source_cost_not_derivable_from_existing_links';
BEGIN
  FOR row IN
    SELECT type, COUNT(*) AS count
    FROM "stock_movements"
    WHERE "unitCostBase" IS NULL OR "totalValueBase" IS NULL
    GROUP BY type
    ORDER BY type
  LOOP
    INSERT INTO "stock_movement_backfill_audit" ("id", "movementType", "count", "reason", "firstRunAt", "runAt")
    VALUES (
      '20260528162500_stock_movement_values:' || row.type::text || ':' || unresolved_reason,
      row.type,
      row.count::integer,
      unresolved_reason,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("id") DO UPDATE SET
      "count" = EXCLUDED."count",
      "runAt" = EXCLUDED."runAt";

    RAISE LOG 'stock_movement_values_backfill_unresolved type=% count=% reason=%', row.type, row.count, unresolved_reason;
  END LOOP;
END $$;
