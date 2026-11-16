-- Additive: a new table only; no existing row is touched. Orders whose IMS allocation was released, reduced or deleted, which the
-- WooCommerce stock guard re-fetches by id until Woo no longer holds them or IMS accounts for them again. No foreign key on purpose
-- (the row must survive the order's deletion); a release replaces `token`, so the guard's clear is a compare-and-set.
CREATE TABLE "wc_stock_dirty_orders" (
    "id" TEXT NOT NULL,
    "wc_order_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "released_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wc_stock_dirty_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wc_stock_dirty_orders_wc_order_id_key" ON "wc_stock_dirty_orders"("wc_order_id");

CREATE INDEX "wc_stock_dirty_orders_released_idx" ON "wc_stock_dirty_orders"("released_at", "id");
