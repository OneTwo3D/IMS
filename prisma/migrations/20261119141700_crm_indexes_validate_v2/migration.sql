-- Post-build validity check for the CRM CONCURRENTLY indexes, after the rebuild migrations 141300-141600. It fails the deploy if one is missing or INVALID and names the EXACT
-- repair. It reads pg_index and modifies nothing. customers_identity_key_idx (migration 131200) is deliberately NOT checked: it is the older ASCII-space fold, nothing reads it,
-- and an interrupted build of a dead index must not stop a deploy. A LATER CLEANUP MIGRATION SHOULD DROP IT (DROP INDEX CONCURRENTLY, in its own file).
--
-- REPAIR when this migration fails (it is then recorded FAILED, which blocks every later `migrate deploy` with P3009 until it is resolved):
--   1. psql "$DATABASE_URL" -c 'DROP INDEX CONCURRENTLY IF EXISTS "<index>";'
--   2. run the CREATE INDEX CONCURRENTLY statement of the rebuild migration for that index BY HAND (psql, not inside a transaction; the statement is the one in
--      prisma/migrations/20261119141300..141600_*_rebuild/migration.sql, nothing else in the file)
--   3. npx prisma migrate resolve --rolled-back 20261119141700_crm_indexes_validate_v2
--   4. npx prisma migrate deploy
-- prisma-schema-scope-ok: db-native index validity assertion | reason: nothing to represent: creates no object, asserts a concurrent build completed

DO $$
DECLARE
  v_name  text;
  v_oid   oid;
  v_valid boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'sales_orders_customerId_createdAt_idx',
    'customers_loose_identity_key_v2_idx',
    'customers_email_lower_btrim_idx',
    'sales_orders_external_customer_id_idx'
  ] LOOP
    SELECT c.oid, i.indisvalid INTO v_oid, v_valid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = v_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());

    IF v_oid IS NULL THEN
      RAISE EXCEPTION '% does not exist: its CONCURRENTLY build did not complete. Build it by hand (CREATE INDEX CONCURRENTLY, see the rebuild migration 20261119141300-141600 for it), then: prisma migrate resolve --rolled-back 20261119141700_crm_indexes_validate_v2; prisma migrate deploy.', v_name;
    END IF;
    IF NOT v_valid THEN
      RAISE EXCEPTION '% exists but is INVALID: its concurrent build was interrupted. Repair: DROP INDEX CONCURRENTLY IF EXISTS "%"; run its CREATE INDEX CONCURRENTLY statement by hand (see the rebuild migration 20261119141300-141600); then prisma migrate resolve --rolled-back 20261119141700_crm_indexes_validate_v2; then prisma migrate deploy.', v_name, v_name;
    END IF;
  END LOOP;
END $$;
