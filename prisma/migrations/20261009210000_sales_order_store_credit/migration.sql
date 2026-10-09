-- Store credit is a PAYMENT, not a discount: record it beside the order instead of inside discountAmount.
--
-- WHY: the WooCommerce importer folded Smart Coupons store credit into SalesOrder.discountAmount, which
-- then went to Mintsoft as DiscountTotalExVat (understating the goods value used for customs / IOSS) and to
-- the accounting document as a discount (understating revenue and VAT). The credit is held here, GROSS and
-- in the order currency, so it can settle the invoice rather than reduce it.
--
-- ADDITIVE AND BACKFILL-FREE: NOT NULL DEFAULT 0 is the old behaviour for every existing row (no credit
-- recorded), and the application is not live against a production database yet, so there is nothing to
-- backfill. A constant default is a metadata-only change on PostgreSQL 11+: no table rewrite.
ALTER TABLE "sales_orders" ADD COLUMN "storeCreditForeign" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Provenance / review marker (see SalesOrder.storeCreditAssessment). Nullable with no default: NULL means "not
-- assessed", which every reader treats as unproven wherever store credit is present. No backfill (the application
-- is not live against a production database yet), and an additive nullable column is metadata-only.
CREATE TYPE "StoreCreditAssessment" AS ENUM ('ASSESSED', 'REVIEW_REQUIRED');
ALTER TABLE "sales_orders" ADD COLUMN "storeCreditAssessment" "StoreCreditAssessment";
