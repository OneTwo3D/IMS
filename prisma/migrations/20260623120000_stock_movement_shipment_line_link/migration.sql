-- cogs-audit 4pz6.1: durable line-granularity link from a SALE_DISPATCH stock
-- movement to its originating ShipmentLine (and thus the SalesOrderLine).
-- The link already existed implicitly in the idempotency key
-- (`SALE_DISPATCH:shipmentLine:<shipmentLineId>`); this promotes it to a
-- first-class, indexed, FK-validated column so revenue↔COGS reporting can join
-- at shipment-line granularity (fixes the data-model gap behind scjz.51/.67).
--
-- Rollout: additive nullable column (no NOT NULL), so existing rows are valid
-- immediately. Backfill runs in-line and only sets ids that still exist in
-- shipment_lines, so the FK added afterwards validates cleanly. Movements with
-- no real shipment line (other types, zero-cost historical-import demand rows,
-- or shipment lines since deleted) keep a null link.

ALTER TABLE "stock_movements" ADD COLUMN "shipmentLineId" TEXT;

-- Backfill historical sale-dispatch movements from their idempotency key.
-- The join to shipment_lines guarantees referential integrity for the FK below;
-- keys whose shipment line was deleted (or whose key shape differs) stay null.
UPDATE "stock_movements" AS sm
SET "shipmentLineId" = sl."id"
FROM "shipment_lines" AS sl
WHERE sm."type" = 'SALE_DISPATCH'
  AND sm."shipmentLineId" IS NULL
  AND sm."idempotencyKey" LIKE 'SALE_DISPATCH:shipmentLine:%'
  AND sl."id" = substring(sm."idempotencyKey" FROM 'SALE_DISPATCH:shipmentLine:(.*)$');

CREATE INDEX "stock_movements_shipmentLineId_idx" ON "stock_movements"("shipmentLineId");

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_shipmentLineId_fkey"
  FOREIGN KEY ("shipmentLineId") REFERENCES "shipment_lines"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
