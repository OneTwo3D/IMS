-- bk47: VALIDATE the stock_levels reserved<=quantity CHECK constraint that
-- 20260424180000_stock_integrity_checks added as NOT VALID with a promise to
-- validate "once existing data is clean". The constraint has enforced
-- reservedQty <= quantity on every INSERT/UPDATE since; this proves the
-- historical rows are clean too, so the invariant is fully enforced (not just
-- forward-looking). Preflight-count any violations and fail the deploy with an
-- actionable message (mirroring 20260512100000) before VALIDATE scans the table.
DO $$
DECLARE
  reserved_over_quantity_count integer := 0;
BEGIN
  SELECT COUNT(*) INTO reserved_over_quantity_count
  FROM "stock_levels"
  WHERE "reservedQty" > "quantity";

  IF reserved_over_quantity_count > 0 THEN
    RAISE EXCEPTION
      'Preflight failed for 20260624120000_validate_stock_reserved_lte_quantity. Resolve stock_levels rows where reservedQty > quantity (over-reserved) before validating the constraint. reserved_over_quantity=%',
      reserved_over_quantity_count;
  END IF;
END $$;

-- Operator mapping for the preflight count above:
--   reserved_over_quantity -> stock_levels rows holding more reservation than on-hand
--     (query: SELECT * FROM "stock_levels" WHERE "reservedQty" > "quantity")
-- See docs/development.md for the remediation checklist.

ALTER TABLE "stock_levels"
  VALIDATE CONSTRAINT "stock_levels_reserved_qty_lte_quantity";
