-- Adds deterministic idempotency keys for irreversible stock movements.
-- PostgreSQL unique indexes allow multiple NULL values, so legacy/manual
-- movement rows can remain without keys while keyed retry paths are protected.
ALTER TABLE "stock_movements" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "stock_movements_idempotencyKey_key"
  ON "stock_movements"("idempotencyKey");
