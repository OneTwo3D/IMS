-- Post-build validity check for the CONCURRENTLY index of 20261121130000_wc_completion_refusal_open_index. It fails the deploy if the index is missing or INVALID and names the
-- EXACT repair. It reads pg_index and modifies nothing.
--
-- REPAIR when this migration fails (it is then recorded FAILED, which blocks every later `migrate deploy` with P3009 until it is resolved):
--   1. psql "$DATABASE_URL" -c 'DROP INDEX CONCURRENTLY IF EXISTS "shopping_sync_logs_open_wc_completion_refusal_idx";'
--   2. run the CREATE INDEX CONCURRENTLY statement of prisma/migrations/20261121130000_wc_completion_refusal_open_index/migration.sql BY HAND (psql, not inside a transaction)
--   3. npx prisma migrate resolve --rolled-back 20261121131000_wc_completion_refusal_open_index_validate
--   4. npx prisma migrate deploy
-- prisma-schema-scope-ok: db-native index validity assertion | reason: nothing to represent: creates no object, asserts a concurrent build completed

DO $$
DECLARE
  v_oid   oid;
  v_valid boolean;
BEGIN
  SELECT c.oid, i.indisvalid INTO v_oid, v_valid
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE c.relname = 'shopping_sync_logs_open_wc_completion_refusal_idx' AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'index shopping_sync_logs_open_wc_completion_refusal_idx is missing: run its CREATE INDEX CONCURRENTLY by hand (see the REPAIR steps at the top of this migration)';
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'index shopping_sync_logs_open_wc_completion_refusal_idx is INVALID (an interrupted concurrent build): DROP INDEX CONCURRENTLY IF EXISTS it, rebuild it by hand, then resolve this migration as rolled back (see the REPAIR steps at the top of this migration)';
  END IF;
END $$;
