-- Decouple refund state from the lifecycle status: orders whose `status` still holds
-- REFUNDED/PARTIALLY_REFUNDED get a reconstructed fulfilment status. refundStatus was
-- already backfilled (20260627225630_add_sales_order_refund_status), so this only
-- restores the lifecycle dimension. Shipped orders → SHIPPED, otherwise → PROCESSING
-- (a safe approximation; a delivered date is not reconstructable from existing columns).
SET LOCAL statement_timeout = '60s';
UPDATE "sales_orders"
SET "status" = CASE
    WHEN "shippedAt" IS NOT NULL THEN 'SHIPPED'::"SalesOrderStatus"
    ELSE 'PROCESSING'::"SalesOrderStatus"
  END
WHERE "status" IN ('REFUNDED', 'PARTIALLY_REFUNDED');
