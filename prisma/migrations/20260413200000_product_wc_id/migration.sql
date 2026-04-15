-- Add externalProductId on products for O(1) WooCommerce stock sync.
-- Resolved once via SKU lookup and persisted so subsequent sync runs do
-- not re-query WC by SKU for every product.
--
-- BIGINT (not INTEGER): WooCommerce/WordPress object IDs are database-
-- backed post IDs and can exceed the signed 32-bit range (2,147,483,647)
-- on long-lived stores. Using INTEGER would cause inserts of legitimate
-- WC ids to error permanently, leaving those products unsynced. BIGINT
-- covers the full JavaScript safe-integer range (2^53-1) with headroom.
--
-- ADD COLUMN of a nullable BIGINT is a catalog-only change on Postgres
-- (no table rewrite, no write lock on existing rows). The unique index
-- is created in a separate, non-transactional migration using
-- CREATE UNIQUE INDEX CONCURRENTLY so production writes to `products`
-- are not blocked for the duration of the index build.

ALTER TABLE "products"
  ADD COLUMN "externalProductId" BIGINT;
