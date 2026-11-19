-- Rebuild step for customers_loose_identity_key_v2_idx (see 20261119141200_crm_invalid_indexes_drop); same reasoning and same remediation as
-- 20261119141300_sales_orders_customer_created_idx_rebuild. ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native expression index | reason: Prisma cannot represent an index on an expression
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_loose_identity_key_v2_idx"
ON "customers" (crm_loose_identity_key("email"))
WHERE "email" IS NOT NULL;
