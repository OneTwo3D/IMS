-- Stock in transit valued per transfer, as of each inventory snapshot day (additive only).
ALTER TABLE "inventory_snapshot_runs" ADD COLUMN "inTransitCovered" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "inventory_transit_snapshots" (
    "id" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "transferId" TEXT NOT NULL,
    "valueBase" DECIMAL(18,6) NOT NULL,
    "valueReplayReliable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transit_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_transfer_transit_revaluations" (
    "id" TEXT NOT NULL,
    "transferLineId" TEXT NOT NULL,
    "costLayerId" TEXT NOT NULL,
    "qty" DECIMAL(14,6) NOT NULL,
    "unitDelta" DECIMAL(18,6) NOT NULL,
    "deltaBase" DECIMAL(18,6) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_transit_revaluations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inventory_transit_snapshots_snapshotDate_idx" ON "inventory_transit_snapshots"("snapshotDate");
CREATE UNIQUE INDEX "inventory_transit_snapshots_snapshotDate_transferId_key" ON "inventory_transit_snapshots"("snapshotDate", "transferId");
CREATE INDEX "stock_transfer_transit_revaluations_transferLineId_effectiv_idx" ON "stock_transfer_transit_revaluations"("transferLineId", "effectiveAt");
CREATE INDEX "stock_transfer_transit_revaluations_effectiveAt_idx" ON "stock_transfer_transit_revaluations"("effectiveAt");

ALTER TABLE "inventory_transit_snapshots" ADD CONSTRAINT "inventory_transit_snapshots_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
