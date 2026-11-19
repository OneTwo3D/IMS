-- Additive: the loose identity key each member of a person-erasure request had before it was erased (member id -> key), so the completion re-resolve can find an
-- alias of a member that was already erased. A new column with a constant default: no table rewrite, no backfill (a PENDING request saved before this column
-- re-resolves from its live members only, as it did).
ALTER TABLE "customer_cluster_erasures" ADD COLUMN IF NOT EXISTS "memberIdentityKeys" JSONB NOT NULL DEFAULT '{}';
