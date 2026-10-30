-- The WooCommerce tax-rate writer binds ownership to the store it was made against (lib/connectors/woocommerce/tax-rate-plan.ts).
--
-- ADDITIVE ONLY: two nullable columns. NULL on every existing mapping row means "from before the identity rule": such a row does not count as ownership for the writer until the
-- operator's adoption step stamps it, so nothing changes for any reader that does not know the column. The writer's own record table is new in the previous migration and empty;
-- its kind check gains ADOPT (the adoption step's record).

-- AlterTable
ALTER TABLE "shopping_tax_rate_mappings" ADD COLUMN "store_identity" TEXT;

-- AlterTable
ALTER TABLE "woo_tax_rate_writes" ADD COLUMN "store_identity" TEXT;

ALTER TABLE "woo_tax_rate_writes" DROP CONSTRAINT "woo_tax_rate_writes_kind_check";
ALTER TABLE "woo_tax_rate_writes" ADD CONSTRAINT "woo_tax_rate_writes_kind_check" CHECK ("kind" IN ('CREATE', 'UPDATE', 'DELETE', 'ADOPT'));
