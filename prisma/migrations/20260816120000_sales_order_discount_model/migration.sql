-- o3d-9te: record WHAT sales_orders.discountAmount means, at the moment it is written.
--
-- The o3d-y14 coupon double-count happened because one column carried two different
-- meanings — "the whole cart coupon" (pre-fix WooCommerce import) and "the part of it the
-- line items do NOT already carry" (post-fix) — and nothing on the row said which.
--
-- The corrective backfill needs to tell them apart, and it cannot do that from
-- sales_orders."createdAt": the WooCommerce initial import backdates that column to the
-- historical Woo order date (importWcOrder's useWcDateAsCreatedAt), so an order imported
-- AFTER the fix can sort before any deployment cutoff and be "corrected" a second time,
-- permanently erasing a genuine discount.
--
-- Nullable with no default and no backfill, deliberately. NULL is the honest state for
-- every existing row and for native/manual orders, and readers must treat it as UNKNOWN
-- rather than as the pre-fix meaning. Adding a nullable column with no default is
-- metadata-only on Postgres — no table rewrite.
CREATE TYPE "OrderDiscountModel" AS ENUM ('LINE_ALLOCATED');

ALTER TABLE "sales_orders" ADD COLUMN "discount_model" "OrderDiscountModel";
