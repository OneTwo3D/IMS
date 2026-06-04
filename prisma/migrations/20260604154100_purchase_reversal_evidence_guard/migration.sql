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
    NEW.type IN ('SALE_DISPATCH', 'PURCHASE_REVERSAL', 'PRODUCTION_OUT')
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
