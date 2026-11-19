-- The order importer matches an order to its customer by the storefront customer id stored on earlier orders (owner decision Q5), ahead of the email.
-- Partial: guest orders (no id) are not indexed. CONCURRENTLY, in its own file (cannot run in a transaction); an interrupted build is caught by
-- 20261119140500_crm_indexes_validate. ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native partial index | reason: Prisma cannot represent a partial index
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sales_orders_external_customer_id_idx"
ON "sales_orders" ("external_customer_id")
WHERE "external_customer_id" IS NOT NULL;
