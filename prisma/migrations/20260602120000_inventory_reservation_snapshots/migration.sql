-- Historical reservation snapshots for true as-of stock availability reports.
CREATE TABLE "inventory_reservation_snapshots" (
  "id" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "productId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "reservedQty" DECIMAL(12,4) NOT NULL,
  "availableQty" DECIMAL(12,4) NOT NULL,
  "reservationSourceCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_reservation_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_reservation_snapshots_snapshotDate_productId_warehous"
  ON "inventory_reservation_snapshots"("snapshotDate", "productId", "warehouseId");

CREATE INDEX "inventory_reservation_snapshots_snapshotDate_idx"
  ON "inventory_reservation_snapshots"("snapshotDate");

CREATE INDEX "inventory_reservation_snapshots_productId_snapshotDate_idx"
  ON "inventory_reservation_snapshots"("productId", "snapshotDate");

CREATE INDEX "inventory_reservation_snapshots_warehouseId_snapshotDate_idx"
  ON "inventory_reservation_snapshots"("warehouseId", "snapshotDate");

ALTER TABLE "inventory_reservation_snapshots"
  ADD CONSTRAINT "inventory_reservation_snapshots_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_reservation_snapshots"
  ADD CONSTRAINT "inventory_reservation_snapshots_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_reservation_snapshots"
  ADD CONSTRAINT "inventory_reservation_snapshots_reserved_qty_nonnegative"
  CHECK ("reservedQty" >= 0) NOT VALID;

ALTER TABLE "inventory_reservation_snapshots"
  ADD CONSTRAINT "inventory_reservation_snapshots_available_qty_nonnegative"
  CHECK ("availableQty" >= 0) NOT VALID;

ALTER TABLE "inventory_reservation_snapshots"
  ADD CONSTRAINT "inventory_reservation_snapshots_source_count_nonnegative"
  CHECK ("reservationSourceCount" >= 0) NOT VALID;

ALTER TABLE "inventory_reservation_snapshots"
  VALIDATE CONSTRAINT "inventory_reservation_snapshots_reserved_qty_nonnegative";

ALTER TABLE "inventory_reservation_snapshots"
  VALIDATE CONSTRAINT "inventory_reservation_snapshots_available_qty_nonnegative";

ALTER TABLE "inventory_reservation_snapshots"
  VALIDATE CONSTRAINT "inventory_reservation_snapshots_source_count_nonnegative";
