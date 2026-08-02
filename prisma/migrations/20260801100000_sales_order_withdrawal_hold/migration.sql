-- o3d-e1yb [wdraw]: marks a sales-order hold as originating from an EU
-- right-of-withdrawal request filed in the storefront.
--
-- Nullable with no default, so this is a metadata-only change on an existing
-- table: no table rewrite, no backfill, and existing rows correctly read as
-- "not a withdrawal hold". The supporting index ships separately because
-- sales_orders needs a CONCURRENT build, which cannot run in this
-- transaction.
ALTER TABLE "sales_orders" ADD COLUMN "withdrawalHoldAt" TIMESTAMP(3);
