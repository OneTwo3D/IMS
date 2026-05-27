-- Adds deterministic idempotency keys for irreversible stock movements.
-- PostgreSQL unique indexes allow multiple NULL values, so legacy/manual
-- movement rows can remain without keys while keyed retry paths are protected.
ALTER TABLE "stock_movements" ADD COLUMN "idempotencyKey" TEXT;

-- Build CONCURRENTLY so active stock movement writes are not blocked while the
-- index scans historical movement rows. If this migration is interrupted and
-- leaves an INVALID index, drop it and rerun deploy:
--   DROP INDEX IF EXISTS "stock_movements_idempotencyKey_key";
CREATE UNIQUE INDEX CONCURRENTLY "stock_movements_idempotencyKey_key"
  ON "stock_movements"("idempotencyKey");
