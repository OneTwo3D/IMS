-- Additive: the SKU actually sent for each order line (see WmsOrderPushLink.sentLineSkus). Nullable, no backfill.
ALTER TABLE "wms_order_push_links" ADD COLUMN "sent_line_skus" JSONB;
