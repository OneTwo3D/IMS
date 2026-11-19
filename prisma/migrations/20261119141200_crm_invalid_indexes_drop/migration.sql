-- CRM indexes: drop any CRM index that an interrupted CONCURRENTLY build left INVALID, so the rebuild migrations that follow (141300-141600) build it fresh instead of
-- skipping it (`CREATE INDEX CONCURRENTLY IF NOT EXISTS` is a silent no-op against an INVALID leftover). The CRM index migrations 20261119131100 and 140200-140400 are
-- already pushed and are NOT edited (migrations are additive only). A VALID index is never touched. An INVALID index is never used by the planner, so dropping it
-- changes no query result; the plain DROP INDEX takes a short exclusive lock on the table, which is acceptable for an index that serves nothing.
-- customers_identity_key_idx (migration 131200) is NOT listed: nothing reads it any more and it is left alone (see 20261119141700_crm_indexes_validate_v2).
-- prisma-schema-scope-ok: db-native index maintenance | reason: nothing to represent: drops only an INVALID leftover of an index that schema.prisma / earlier migrations own
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'sales_orders_customerId_createdAt_idx',
    'customers_loose_identity_key_v2_idx',
    'customers_email_lower_btrim_idx',
    'sales_orders_external_customer_id_idx'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = v_name AND NOT i.indisvalid
        AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
    ) THEN
      EXECUTE format('DROP INDEX %I.%I', current_schema(), v_name);
    END IF;
  END LOOP;
END $$;
