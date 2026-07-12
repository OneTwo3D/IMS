-- Add a nullable customs description to products. Plain nullable add-column
-- (no backfill / NOT NULL) per docs/migration-conventions.md. Used on customs
-- documentation; variants inherit the parent's value at generation time and it
-- can be imported from the WooCommerce "customs_description" product attribute.
ALTER TABLE "products" ADD COLUMN "customsDescription" TEXT;
