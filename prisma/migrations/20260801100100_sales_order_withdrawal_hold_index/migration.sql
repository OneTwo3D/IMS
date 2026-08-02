-- o3d-e1yb [wdraw]: index behind the WMS release pass, which filters HELD
-- links on `withdrawalHoldAt IS NULL` alongside status/paidAt/refundStatus.
--
-- CONCURRENTLY because sales_orders is a daily-operations table (see
-- docs/migration-conventions.md), and therefore isolated in its own migration
-- file: Prisma wraps migrations in a transaction and CREATE INDEX
-- CONCURRENTLY cannot run inside one.
--
-- PARTIAL so it stays tiny: only orders actually under a withdrawal hold are
-- indexed, which is a handful at any moment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sales_orders_withdrawalHoldAt_idx"
  ON "sales_orders" ("withdrawalHoldAt")
  WHERE "withdrawalHoldAt" IS NOT NULL;
