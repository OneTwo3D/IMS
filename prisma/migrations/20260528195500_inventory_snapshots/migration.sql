CREATE TABLE "inventory_snapshots" (
  "id" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "productId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "qty" DECIMAL(12,4) NOT NULL,
  "valueBase" DECIMAL(18,6) NOT NULL,
  "unitCostBase" DECIMAL(18,6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "inventory_snapshots"
  ADD CONSTRAINT "inventory_snapshots_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_snapshots"
  ADD CONSTRAINT "inventory_snapshots_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "inventory_snapshots_snapshotDate_productId_warehouseId_key"
  ON "inventory_snapshots"("snapshotDate", "productId", "warehouseId");

CREATE INDEX "inventory_snapshots_snapshotDate_idx"
  ON "inventory_snapshots"("snapshotDate");

CREATE INDEX "inventory_snapshots_productId_snapshotDate_idx"
  ON "inventory_snapshots"("productId", "snapshotDate");
