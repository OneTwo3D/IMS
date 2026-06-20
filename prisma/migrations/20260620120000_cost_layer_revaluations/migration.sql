-- Cost-layer revaluation event log (cogs-audit scjz.43/.48). Records every change
-- to a cost layer's unitCostBase with the effective timestamp, so as-of/historical
-- valuation can reconstruct the cost basis valid at a point in time instead of
-- using the current (post-revaluation) cost. Purely additive (new table).
CREATE TABLE "cost_layer_revaluations" (
  "id" text PRIMARY KEY,
  "costLayerId" text NOT NULL,
  "oldUnitCostBase" numeric(18,6) NOT NULL,
  "newUnitCostBase" numeric(18,6) NOT NULL,
  "effectiveAt" timestamp(3) NOT NULL,
  "reason" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cost_layer_revaluations_costLayerId_fkey"
    FOREIGN KEY ("costLayerId") REFERENCES "cost_layers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "cost_layer_revaluations_costLayerId_effectiveAt_idx"
  ON "cost_layer_revaluations"("costLayerId", "effectiveAt");
