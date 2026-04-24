-- Enforce core stock invariants for new writes without blocking deployment on
-- historical drift. NOT VALID still checks all future INSERT/UPDATE rows; a
-- later cleanup migration can VALIDATE CONSTRAINT once existing data is clean.

ALTER TABLE "stock_levels"
  ADD CONSTRAINT "stock_levels_reserved_qty_lte_quantity"
  CHECK ("reservedQty" <= "quantity") NOT VALID;

ALTER TABLE "cost_layers"
  ADD CONSTRAINT "cost_layers_remaining_qty_non_negative"
  CHECK ("remainingQty" >= 0) NOT VALID;

ALTER TABLE "cost_layers"
  ADD CONSTRAINT "cost_layers_remaining_qty_lte_received_qty"
  CHECK ("remainingQty" <= "receivedQty") NOT VALID;
