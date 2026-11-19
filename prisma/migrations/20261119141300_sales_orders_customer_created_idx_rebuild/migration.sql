-- Rebuild step for sales_orders_customerId_createdAt_idx (see 20261119141200_crm_invalid_indexes_drop): after that migration no INVALID leftover exists, so IF NOT EXISTS is
-- safe here (it skips only a VALID index, which is what 20261119131100 built). CONCURRENTLY, one statement in its own file. If THIS build is interrupted it fails this
-- migration: DROP INDEX CONCURRENTLY IF EXISTS "sales_orders_customerId_createdAt_idx", `prisma migrate resolve --rolled-back` this migration, rerun `migrate deploy`.
-- ADDITIVE ONLY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sales_orders_customerId_createdAt_idx"
ON "sales_orders" ("customerId", "createdAt" DESC);
