-- The CRM resolver finds the customers that share a folded email key. An expression index on the SAME expression as
-- lib/domain/crm/cluster-resolver.ts (CUSTOMER_LOOSE_EMAIL_KEY_SQL): lower + trim, the +tag dropped, and for gmail.com / googlemail.com the dots dropped
-- and the domain folded. Partial: customers with no email are not indexed. CONCURRENTLY, in its own file (cannot run in a transaction). ADDITIVE ONLY.
-- prisma-schema-scope-ok: db-native expression index | reason: Prisma cannot represent an index on an expression
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customers_identity_key_idx"
ON "customers" ((
  CASE
    WHEN split_part(lower(btrim("email")), '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(split_part(lower(btrim("email")), '@', 1), '+', 1), '.', '') || '@gmail.com'
    ELSE split_part(split_part(lower(btrim("email")), '@', 1), '+', 1) || '@' || split_part(lower(btrim("email")), '@', 2)
  END
))
WHERE "email" IS NOT NULL;
