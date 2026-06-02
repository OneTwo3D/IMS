-- prisma-schema-scope-ok: db-native trigger | reason: Prisma schema cannot represent deferred constraint triggers or CHECK predicates with expression math

DO $$
DECLARE
  value_partial_count integer := 0;
  value_mismatch_count integer := 0;
  inbound_missing_layer_count integer := 0;
  outbound_missing_cogs_count integer := 0;
BEGIN
  SELECT
    COUNT(*) FILTER (
      WHERE ("unitCostBase" IS NULL AND "totalValueBase" IS NOT NULL)
         OR ("unitCostBase" IS NOT NULL AND "totalValueBase" IS NULL)
    ),
    COUNT(*) FILTER (
      WHERE "unitCostBase" IS NOT NULL
        AND "totalValueBase" IS NOT NULL
        AND "totalValueBase" <> ROUND((qty * "unitCostBase")::numeric, 6)
    ),
    COUNT(*) FILTER (
      WHERE (
          sm.type IN ('PURCHASE_RECEIPT', 'PRODUCTION_IN')
          OR (sm.type = 'ADJUSTMENT' AND sm."toWarehouseId" IS NOT NULL)
        )
        AND sm.qty > 0
        AND sm."toWarehouseId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "cost_layers" cl
          WHERE cl."productId" = sm."productId"
            AND cl."warehouseId" = sm."toWarehouseId"
            AND ABS(cl."receivedQty" - sm.qty) <= 0.0001
            AND (
              (sm.type = 'PRODUCTION_IN'
                AND sm."referenceType" = 'ProductionOrder'
                AND sm."referenceId" IS NOT NULL
                AND cl."production_order_id" = sm."referenceId")
              OR
              (sm.type = 'PURCHASE_RECEIPT'
                AND sm."referenceType" = 'PurchaseOrder'
                AND sm."referenceId" IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM "purchase_order_lines" pol
                  WHERE pol.id = cl."poLineId"
                    AND pol."poId" = sm."referenceId"
                ))
              OR
              (sm.type = 'ADJUSTMENT'
                AND cl."adjustment_movement_id" = sm.id)
            )
        )
    ),
    COUNT(*) FILTER (
      WHERE (
          sm.type IN ('SALE_DISPATCH', 'PRODUCTION_OUT')
          OR (sm.type = 'ADJUSTMENT' AND sm."fromWarehouseId" IS NOT NULL)
        )
        AND sm.qty > 0
        AND NOT EXISTS (
          SELECT 1
          FROM "cogs_entries" ce
          WHERE ce."movementId" = sm.id
        )
    )
  INTO
    value_partial_count,
    value_mismatch_count,
    inbound_missing_layer_count,
    outbound_missing_cogs_count
  FROM "stock_movements" sm;

  IF inbound_missing_layer_count > 0 OR outbound_missing_cogs_count > 0 THEN
    RAISE WARNING
      'Existing movement evidence drift will be reported by inventory invariants. inbound_missing_layer=%, outbound_missing_cogs=%',
      inbound_missing_layer_count,
      outbound_missing_cogs_count;
  END IF;

  IF value_partial_count > 0 OR value_mismatch_count > 0 THEN
    RAISE EXCEPTION
      'Preflight failed for 20260602103000_stock_movement_reporting_guarantees. Resolve stock movement value drift before applying guarantee. value_partial=%, value_mismatch=%',
      value_partial_count,
      value_mismatch_count;
  END IF;
END $$;

-- Operator mapping for the preflight counts above:
--   value_partial          -> inventory invariant code stock_movement_value_partial
--   value_mismatch         -> inventory invariant code stock_movement_value_mismatch
--   inbound_missing_layer  -> inventory invariant code stock_movement_missing_cost_layer
--   outbound_missing_cogs  -> inventory invariant code stock_movement_missing_cogs_entry
-- Value-field drift is a hard deploy blocker because the CHECK constraint
-- would reject the existing rows during validation. Existing evidence drift is
-- warning-only because historical rows can be repaired after deploy by running
-- the inventory invariant report and backfilling the missing evidence rows.
-- Rollback, if required:
--   DROP TRIGGER IF EXISTS stock_movements_reporting_evidence_guard ON "stock_movements";
--   DROP FUNCTION IF EXISTS assert_stock_movement_reporting_evidence();
--   ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_reporting_value_consistent";
-- Maintenance bypass:
--   ALTER TABLE "stock_movements" DISABLE TRIGGER stock_movements_reporting_evidence_guard;
--   -- run bounded repair, then re-enable and run the inventory invariant report
--   ALTER TABLE "stock_movements" ENABLE TRIGGER stock_movements_reporting_evidence_guard;
-- The deferred trigger runs once per affected movement at commit time. Keep
-- bulk repair batches bounded so commit-time evidence checks stay predictable.

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_reporting_value_consistent"
  CHECK (
    (
      "unitCostBase" IS NULL
      AND "totalValueBase" IS NULL
    )
    OR
    (
      "unitCostBase" IS NOT NULL
      AND "totalValueBase" IS NOT NULL
      AND "totalValueBase" = ROUND((qty * "unitCostBase")::numeric, 6)
    )
  ) NOT VALID;

ALTER TABLE "stock_movements"
  VALIDATE CONSTRAINT "stock_movements_reporting_value_consistent";

CREATE OR REPLACE FUNCTION assert_stock_movement_reporting_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.qty <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.type IN ('PURCHASE_RECEIPT', 'PRODUCTION_IN')
    OR (NEW.type = 'ADJUSTMENT' AND NEW."toWarehouseId" IS NOT NULL) THEN
    IF NEW."toWarehouseId" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "cost_layers" cl
      WHERE cl."productId" = NEW."productId"
        AND cl."warehouseId" = NEW."toWarehouseId"
        AND ABS(cl."receivedQty" - NEW.qty) <= 0.0001
        AND (
          (NEW.type = 'PRODUCTION_IN'
            AND NEW."referenceType" = 'ProductionOrder'
            AND NEW."referenceId" IS NOT NULL
            AND cl."production_order_id" = NEW."referenceId")
          OR
          (NEW.type = 'PURCHASE_RECEIPT'
            AND NEW."referenceType" = 'PurchaseOrder'
            AND NEW."referenceId" IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM "purchase_order_lines" pol
              WHERE pol.id = cl."poLineId"
                AND pol."poId" = NEW."referenceId"
            ))
          OR
          (NEW.type = 'ADJUSTMENT'
            AND cl."adjustment_movement_id" = NEW.id)
        )
    ) THEN
      RAISE EXCEPTION
        'Inbound stock movement % (%) requires matching cost-layer evidence',
        NEW.id,
        NEW.type
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (
    NEW.type IN ('SALE_DISPATCH', 'PRODUCTION_OUT')
    OR (NEW.type = 'ADJUSTMENT' AND NEW."fromWarehouseId" IS NOT NULL)
  ) AND NOT EXISTS (
    SELECT 1
    FROM "cogs_entries" ce
    WHERE ce."movementId" = NEW.id
  ) THEN
    RAISE EXCEPTION
      'Outbound stock movement % (%) requires matching COGS evidence',
      NEW.id,
      NEW.type
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_movements_reporting_evidence_guard ON "stock_movements";

CREATE CONSTRAINT TRIGGER stock_movements_reporting_evidence_guard
AFTER INSERT OR UPDATE OF type, "productId", "fromWarehouseId", "toWarehouseId", qty, "referenceType", "referenceId"
ON "stock_movements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION assert_stock_movement_reporting_evidence();
