-- Post-build validity check for products_externalProductId_key.
--
-- The previous migration creates the unique index with CONCURRENTLY.
-- Concurrent index builds can leave the index in an INVALID state if
-- any row violates the uniqueness constraint mid-build or if the build
-- is interrupted. An INVALID index is NOT enforced by the query planner
-- for constraint-checking purposes, so the collision-safety logic in
-- lib/connectors/woocommerce/sync/stock-sync.ts (which depends on the
-- unique constraint to prevent two IMS products pointing at the same
-- WC product id) would quietly operate without its guarantee.
--
-- This check fails the deploy if the index is missing or INVALID.
-- The DO block runs in a normal transaction, which is fine — it is not
-- a CONCURRENTLY operation and it does not modify any catalog state.

DO $$
DECLARE
  v_oid     oid;
  v_valid   boolean;
  v_unique  boolean;
BEGIN
  SELECT c.oid, i.indisvalid, i.indisunique
    INTO v_oid, v_valid, v_unique
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE c.relname = 'products_externalProductId_key'
    AND c.relnamespace = (
      SELECT oid FROM pg_namespace WHERE nspname = current_schema()
    );

  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'products_externalProductId_key does not exist. The preceding CONCURRENTLY build failed or was rolled back. Remediate per 20260413200001_product_wc_id_index.';
  END IF;

  IF NOT v_unique THEN
    RAISE EXCEPTION
      'products_externalProductId_key exists but is NOT unique. WooCommerce stock-sync collision safety depends on a unique constraint; aborting.';
  END IF;

  IF NOT v_valid THEN
    RAISE EXCEPTION
      'products_externalProductId_key exists but is INVALID. A prior CONCURRENTLY build was interrupted or hit a duplicate. Drop the invalid index and rerun migration 20260413200001_product_wc_id_index: DROP INDEX IF EXISTS "products_externalProductId_key";';
  END IF;
END $$;
