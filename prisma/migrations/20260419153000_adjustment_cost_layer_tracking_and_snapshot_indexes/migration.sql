ALTER TABLE "cost_layers"
ADD COLUMN "adjustment_movement_id" TEXT;

ALTER TABLE "cost_layers"
ADD CONSTRAINT "cost_layers_adjustment_movement_id_fkey"
FOREIGN KEY ("adjustment_movement_id") REFERENCES "stock_movements"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "cost_layers_adjustment_movement_id_idx"
ON "cost_layers"("adjustment_movement_id");

CREATE INDEX "shipment_lines_costLayerSnapshot_gin_idx"
ON "shipment_lines"
USING GIN ("costLayerSnapshot");

CREATE INDEX "order_allocations_costLayerSnapshot_gin_idx"
ON "order_allocations"
USING GIN ("costLayerSnapshot");

CREATE INDEX "sales_order_refund_lines_costLayerSnapshot_gin_idx"
ON "sales_order_refund_lines"
USING GIN ("costLayerSnapshot");

CREATE INDEX "stock_transfer_lines_costLayerSnapshot_gin_idx"
ON "stock_transfer_lines"
USING GIN ("costLayerSnapshot");
