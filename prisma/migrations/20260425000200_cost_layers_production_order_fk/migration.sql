-- Add the production-order FK separately so the original manufacturing-cost
-- migration remains checksum-stable for databases that already applied it.
ALTER TABLE "cost_layers"
  ADD CONSTRAINT "cost_layers_production_order_id_fkey"
  FOREIGN KEY ("production_order_id") REFERENCES "production_orders" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
