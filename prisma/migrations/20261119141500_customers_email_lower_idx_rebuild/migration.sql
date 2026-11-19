-- Rebuild step for customers_email_lower_btrim_idx (see 20261119141200_crm_invalid_indexes_drop); same reasoning and same remediation as
-- 20261119141300_sales_orders_customer_created_idx_rebuild. ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native expression index | reason: Prisma cannot represent an index on an expression
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_email_lower_btrim_idx"
ON "customers" ((lower(btrim("email"))))
WHERE "email" IS NOT NULL;
