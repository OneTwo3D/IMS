ALTER TABLE "inventory_snapshots"
  ADD CONSTRAINT "inventory_snapshots_qty_nonnegative" CHECK ("qty" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_snapshots_value_base_nonnegative" CHECK ("valueBase" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_snapshots_unit_cost_nonnegative" CHECK ("unitCostBase" IS NULL OR "unitCostBase" >= 0) NOT VALID,
  ADD CONSTRAINT "inventory_snapshots_unit_cost_qty_consistency" CHECK (
    ("qty" > 0 AND "unitCostBase" IS NOT NULL)
    OR ("qty" = 0 AND "unitCostBase" IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT "inventory_snapshots_snapshot_date_range" CHECK (
    "snapshotDate" >= DATE '2020-01-01'
    AND "snapshotDate" <= DATE '2100-01-01'
  ) NOT VALID;

ALTER TABLE "inventory_snapshots" VALIDATE CONSTRAINT "inventory_snapshots_qty_nonnegative";
ALTER TABLE "inventory_snapshots" VALIDATE CONSTRAINT "inventory_snapshots_value_base_nonnegative";
ALTER TABLE "inventory_snapshots" VALIDATE CONSTRAINT "inventory_snapshots_unit_cost_nonnegative";
ALTER TABLE "inventory_snapshots" VALIDATE CONSTRAINT "inventory_snapshots_unit_cost_qty_consistency";
ALTER TABLE "inventory_snapshots" VALIDATE CONSTRAINT "inventory_snapshots_snapshot_date_range";

CREATE INDEX "inventory_snapshots_warehouseId_snapshotDate_idx"
  ON "inventory_snapshots"("warehouseId", "snapshotDate");
