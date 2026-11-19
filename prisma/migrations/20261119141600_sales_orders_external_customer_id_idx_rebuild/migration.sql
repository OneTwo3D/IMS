-- Rebuild step for sales_orders_external_customer_id_idx (see 20261119141200_crm_invalid_indexes_drop); same reasoning and same remediation as
-- 20261119141300_sales_orders_customer_created_idx_rebuild. ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native partial index | reason: Prisma cannot represent a partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sales_orders_external_customer_id_idx"
ON "sales_orders" ("external_customer_id")
WHERE "external_customer_id" IS NOT NULL;
