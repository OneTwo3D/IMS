-- The resolver's candidate lookup (crm_loose_identity_key, migration 20261119140100) is an index probe. Replaces, for the resolver, the earlier index
-- customers_identity_key_idx (migration 20261119131200), whose expression is the older ASCII-space-only fold; that earlier index is no longer used and is
-- left in place (migrations are additive only; drop it in a later cleanup migration). Partial: customers with no email are not indexed.
-- CONCURRENTLY, in its own file (cannot run in a transaction); an interrupted build is caught by 20261119140500_crm_indexes_validate. ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native expression index | reason: Prisma cannot represent an index on an expression
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_loose_identity_key_v2_idx"
ON "customers" (crm_loose_identity_key("email"))
WHERE "email" IS NOT NULL;
