-- The order importer matches a customer by exact, case-insensitive email: lower(btrim("email")) = lower(btrim($1)) (NOT Prisma's insensitive equals, which is an
-- unescaped ILIKE where `_` and `%` are wildcards). This is the index of exactly that expression. Partial: customers with no email are not indexed.
-- CONCURRENTLY, in its own file (cannot run in a transaction); an interrupted build is caught by 20261119140500_crm_indexes_validate. ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native expression index | reason: Prisma cannot represent an index on an expression
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_email_lower_btrim_idx"
ON "customers" ((lower(btrim("email"))))
WHERE "email" IS NOT NULL;
