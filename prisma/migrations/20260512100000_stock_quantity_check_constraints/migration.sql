DO $$
DECLARE
  negative_stock_quantity_count integer := 0;
  negative_stock_reserved_count integer := 0;
  negative_cost_layer_received_count integer := 0;
  negative_cost_layer_remaining_count integer := 0;
  cost_layer_remaining_over_received_count integer := 0;
  negative_stock_movement_qty_count integer := 0;
BEGIN
  SELECT COUNT(*) INTO negative_stock_quantity_count
  FROM "stock_levels"
  WHERE "quantity" < 0;

  SELECT COUNT(*) INTO negative_stock_reserved_count
  FROM "stock_levels"
  WHERE "reservedQty" < 0;

  SELECT COUNT(*) INTO negative_cost_layer_received_count
  FROM "cost_layers"
  WHERE "receivedQty" < 0;

  SELECT COUNT(*) INTO negative_cost_layer_remaining_count
  FROM "cost_layers"
  WHERE "remainingQty" < 0;

  SELECT COUNT(*) INTO cost_layer_remaining_over_received_count
  FROM "cost_layers"
  WHERE "remainingQty" > "receivedQty";

  SELECT COUNT(*) INTO negative_stock_movement_qty_count
  FROM "stock_movements"
  WHERE "qty" < 0;

  IF negative_stock_quantity_count > 0
    OR negative_stock_reserved_count > 0
    OR negative_cost_layer_received_count > 0
    OR negative_cost_layer_remaining_count > 0
    OR cost_layer_remaining_over_received_count > 0
    OR negative_stock_movement_qty_count > 0
  THEN
    RAISE EXCEPTION
      'Preflight failed for 20260512100000_stock_quantity_check_constraints. Resolve invalid inventory quantity rows before applying constraints. negative_stock_quantity=%, negative_stock_reserved=%, negative_cost_layer_received=%, negative_cost_layer_remaining=%, cost_layer_remaining_over_received=%, negative_stock_movement_qty=%',
      negative_stock_quantity_count,
      negative_stock_reserved_count,
      negative_cost_layer_received_count,
      negative_cost_layer_remaining_count,
      cost_layer_remaining_over_received_count,
      negative_stock_movement_qty_count;
  END IF;
END $$;

ALTER TABLE "stock_levels"
  ADD CONSTRAINT "stock_levels_quantity_nonnegative"
  CHECK ("quantity" >= 0),
  ADD CONSTRAINT "stock_levels_reserved_nonnegative"
  CHECK ("reservedQty" >= 0);

ALTER TABLE "cost_layers"
  ADD CONSTRAINT "cost_layers_received_nonnegative"
  CHECK ("receivedQty" >= 0);

ALTER TABLE "cost_layers"
  VALIDATE CONSTRAINT "cost_layers_remaining_qty_non_negative";

ALTER TABLE "cost_layers"
  VALIDATE CONSTRAINT "cost_layers_remaining_qty_lte_received_qty";

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_qty_nonnegative"
  CHECK ("qty" >= 0);
