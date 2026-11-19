-- Post-build validity check for every CONCURRENTLY index of the CRM foundation. A concurrent build that was interrupted leaves the index behind marked INVALID,
-- and `CREATE INDEX CONCURRENTLY IF NOT EXISTS` then SKIPS it on a rerun, so the resolver / importer lookups would silently fall back to a sequential scan
-- (the planner ignores an invalid index) while every write still maintains it. This check fails the deploy if any of them is missing or INVALID and names the
-- remediation (the same pattern as 20260821090100_invoice_number_fence_index_validate). It reads pg_index and modifies nothing.
-- prisma-schema-scope-ok: db-native index validity assertion | reason: nothing to represent: creates no object, asserts a concurrent build completed

DO $$
DECLARE
  v_name  text;
  v_oid   oid;
  v_valid boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'sales_orders_customerId_createdAt_idx',
    'customers_identity_key_idx',
    'customers_loose_identity_key_v2_idx',
    'customers_email_lower_btrim_idx',
    'sales_orders_external_customer_id_idx'
  ] LOOP
    SELECT c.oid, i.indisvalid INTO v_oid, v_valid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = v_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());

    IF v_oid IS NULL THEN
      RAISE EXCEPTION '% does not exist: its CONCURRENTLY build did not complete. Rerun the deploy.', v_name;
    END IF;
    IF NOT v_valid THEN
      RAISE EXCEPTION '% exists but is INVALID: its concurrent build was interrupted. Drop it and rebuild: DROP INDEX CONCURRENTLY IF EXISTS "%"; then rerun the deploy (the CREATE INDEX CONCURRENTLY IF NOT EXISTS migration must run again: mark it rolled back with prisma migrate resolve --rolled-back first).', v_name, v_name;
    END IF;
  END LOOP;
END $$;
