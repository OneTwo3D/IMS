-- Add currency + FX columns to ProductionOrder so manufacturing-cost lines
-- entered in a non-base currency resolve to a stable base amount.
-- (The new AccountingSyncType values are added in the preceding migration.)
ALTER TABLE "production_orders"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'GBP',
  ADD COLUMN "fxRateToBase" DECIMAL(18, 8) NOT NULL DEFAULT 1;

-- Per-run overhead lines (labour, machine time, utilities, etc.).
CREATE TABLE "manufacturing_cost_lines" (
  "id"                TEXT         NOT NULL,
  "productionOrderId" TEXT         NOT NULL,
  "description"       TEXT         NOT NULL,
  "amountForeign"     DECIMAL(18, 4) NOT NULL,
  "amountBase"        DECIMAL(18, 4) NOT NULL,
  "accountCode"       TEXT,
  "sortOrder"         INTEGER      NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "manufacturing_cost_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "manufacturing_cost_lines_productionOrderId_idx"
  ON "manufacturing_cost_lines" ("productionOrderId");

ALTER TABLE "manufacturing_cost_lines"
  ADD CONSTRAINT "manufacturing_cost_lines_productionOrderId_fkey"
  FOREIGN KEY ("productionOrderId") REFERENCES "production_orders" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Track which production order produced a cost layer so retro edits to
-- manufacturing-cost lines can find the layers to recalc.
ALTER TABLE "cost_layers"
  ADD COLUMN "production_order_id" TEXT;

CREATE INDEX "cost_layers_production_order_id_idx"
  ON "cost_layers" ("production_order_id");
