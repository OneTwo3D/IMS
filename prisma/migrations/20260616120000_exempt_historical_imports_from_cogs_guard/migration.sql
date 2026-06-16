-- Exempt forecasting-only demand history from the outbound COGS-evidence guard.
--
-- The historical/initial sales import (referenceType WcHistorical / CsvHistorical /
-- WcInitialImport) records PAST sales as zero-cost, warehouse-less SALE_DISPATCH
-- movements with no cogs_entries row. They exist purely to seed demand velocity for
-- forecasting and are excluded from stock levels, inventory stats, COGS and the
-- retention purge everywhere else in the app. The reporting-evidence guard added in
-- 20260602103000 required EVERY outbound movement to carry COGS evidence, so it
-- rejected these imports — and because the constraint trigger is DEFERRABLE INITIALLY
-- DEFERRED it fired at COMMIT, surfacing through createMany() as the misleading
-- "Transaction already closed" (P2028) error.
--
-- Only the OUTBOUND COGS branch changes; the inbound cost-layer branch and the
-- value-consistency constraint are untouched. Real warehouse dispatches (referenceType
-- NULL or any non-historical value) still require COGS evidence.
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
  )
  -- Exempt ONLY the forecasting demand-history shape: a warehouse-less SALE_DISPATCH
  -- carrying a historical-import referenceType. Narrowed (not a blanket referenceType
  -- skip) so a real warehouse-backed dispatch, PRODUCTION_OUT, or outbound ADJUSTMENT
  -- cannot evade the COGS-evidence guard by borrowing a historical referenceType.
  AND NOT (
    NEW.type = 'SALE_DISPATCH'
    AND NEW."fromWarehouseId" IS NULL
    AND NEW."toWarehouseId" IS NULL
    AND COALESCE(NEW."referenceType", '') IN ('WcHistorical', 'WcInitialImport', 'CsvHistorical')
  )
  AND NOT EXISTS (
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
