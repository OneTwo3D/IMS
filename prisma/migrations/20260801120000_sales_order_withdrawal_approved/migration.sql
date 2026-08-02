-- o3d-e1yb [wdraw]: the durable fact that a withdrawal request was APPROVED and
-- the order cancelled, separate from the (cleared) active hold marker.
--
-- Nullable with no default: metadata-only on an existing table, no rewrite, no
-- backfill, and existing rows correctly read as "no approved withdrawal".
-- No index: this is read only alongside the order row itself, never filtered on.
ALTER TABLE "sales_orders" ADD COLUMN "withdrawalApprovedAt" TIMESTAMP(3);
