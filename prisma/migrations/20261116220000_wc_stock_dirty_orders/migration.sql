-- Additive: a new table only; no existing row is touched. Orders whose IMS allocation was released, reduced or deleted, which the
-- WooCommerce stock guard charges on every run (from a live read, or the snapshot of an earlier one kept in lines/line_status/checked_at)
-- until Woo no longer holds them or IMS accounts for them again. Bound to the connection generation (sync_version = wc_settings_version):
-- another store's order ids are ignored and retired when the generation moves. No foreign key on purpose (the row must survive the
-- order's deletion); a release replaces `token`, so the guard's clear and snapshot writes are compare-and-set.
CREATE TABLE "wc_stock_dirty_orders" (
    "id" TEXT NOT NULL,
    "wc_order_id" TEXT NOT NULL,
    "sync_version" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "released_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lines" JSONB,
    "line_status" TEXT,
    "checked_at" TIMESTAMP(3),

    CONSTRAINT "wc_stock_dirty_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wc_stock_dirty_orders_wc_order_id_key" ON "wc_stock_dirty_orders"("wc_order_id");

CREATE INDEX "wc_stock_dirty_orders_refresh_idx" ON "wc_stock_dirty_orders"("sync_version", "checked_at", "released_at", "id");
