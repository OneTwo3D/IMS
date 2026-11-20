-- o3d-hqvrp.39: WooCommerce's refunded_payment (was the refund paid back through the gateway?) stored on the refund. Additive, nullable, no default, no backfill:
-- NULL means unknown, and unknown never counts as cash.
ALTER TABLE "sales_order_refunds" ADD COLUMN "refunded_via_gateway" BOOLEAN;
