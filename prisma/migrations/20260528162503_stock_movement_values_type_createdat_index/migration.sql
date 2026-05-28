-- Build CONCURRENTLY so active dispatch/receipt/transfer writes are not blocked
-- while the reporting index scans historical movement rows.
-- If interrupted and left INVALID, drop and rerun deploy:
--   DROP INDEX IF EXISTS "stock_movements_type_createdAt_idx";
CREATE INDEX CONCURRENTLY IF NOT EXISTS "stock_movements_type_createdAt_idx" ON "stock_movements"("type", "createdAt");
