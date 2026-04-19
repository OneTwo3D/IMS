-- Preserve historical component cost provenance on manufactured output layers
-- so later disassembly can recover from real assembly cost lines.

CREATE TABLE "cost_layer_source_lines" (
    "id" TEXT NOT NULL,
    "costLayerId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "sourceCostLayerId" TEXT,
    "qty" DECIMAL(12,4) NOT NULL,
    "unitCostBase" DECIMAL(18,6) NOT NULL,
    "totalCostBase" DECIMAL(18,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_layer_source_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cost_layer_source_lines_costLayerId_idx" ON "cost_layer_source_lines"("costLayerId");
CREATE INDEX "cost_layer_source_lines_sourceProductId_idx" ON "cost_layer_source_lines"("sourceProductId");
CREATE INDEX "cost_layer_source_lines_sourceCostLayerId_idx" ON "cost_layer_source_lines"("sourceCostLayerId");

ALTER TABLE "cost_layer_source_lines"
ADD CONSTRAINT "cost_layer_source_lines_costLayerId_fkey"
FOREIGN KEY ("costLayerId") REFERENCES "cost_layers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cost_layer_source_lines"
ADD CONSTRAINT "cost_layer_source_lines_sourceProductId_fkey"
FOREIGN KEY ("sourceProductId") REFERENCES "products"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
