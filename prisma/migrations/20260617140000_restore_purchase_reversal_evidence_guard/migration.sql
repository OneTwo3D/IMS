-- Restore PURCHASE_REVERSAL to the outbound COGS-evidence guard.
--
-- 20260604154100 added PURCHASE_REVERSAL to the guard, but 20260616120000
-- (historical-import exemption) recreated assert_stock_movement_reporting_evidence
-- and inadvertently dropped PURCHASE_REVERSAL from the outbound type list. That
-- left an asymmetry: the app invariant (lib/domain/inventory/invariants.ts
-- OUTBOUND_COGS_MOVEMENT_TYPES + the SQL invariant collector) flags a
-- PURCHASE_REVERSAL without COGS evidence, but the DB trigger no longer enforced
-- it. The only PURCHASE_REVERSAL writer (po-cancellation.ts) always creates a
-- cogs_entries row, so restoring the guard matches the code and the invariant.
--
-- Preflight: fail loudly if any existing PURCHASE_REVERSAL row (qty>0) lacks COGS
-- evidence, so we never enable a guard that current data would violate on a later
-- UPDATE. Expected count is 0 (po-cancellation has always written the evidence).
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM "stock_movements" sm
  WHERE sm.type = 'PURCHASE_REVERSAL'
    AND sm.qty > 0
    AND NOT EXISTS (
      SELECT 1 FROM "cogs_entries" ce WHERE ce."movementId" = sm.id
    );
  IF missing_count > 0 THEN
    RAISE EXCEPTION
      'Cannot restore PURCHASE_REVERSAL evidence guard: % existing PURCHASE_REVERSAL movement(s) lack cogs_entries. Backfill their COGS evidence first.',
      missing_count;
  END IF;
END;
$$;

-- Recreate the guard with PURCHASE_REVERSAL added back to the outbound branch.
-- Everything else (inbound cost-layer branch, historical-import SALE_DISPATCH
-- exemption) is preserved verbatim from 20260616120000.
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
    NEW.type IN ('SALE_DISPATCH', 'PRODUCTION_OUT', 'PURCHASE_REVERSAL')
    OR (NEW.type = 'ADJUSTMENT' AND NEW."fromWarehouseId" IS NOT NULL)
  )
  -- Exempt ONLY the forecasting demand-history shape: a warehouse-less SALE_DISPATCH
  -- carrying a historical-import referenceType. Narrowed (not a blanket referenceType
  -- skip) so a real warehouse-backed dispatch, PRODUCTION_OUT, PURCHASE_REVERSAL, or
  -- outbound ADJUSTMENT cannot evade the COGS-evidence guard by borrowing a historical
  -- referenceType.
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
