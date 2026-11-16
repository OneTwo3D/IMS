-- Additive: two nullable columns on the WMS push link. Set when Mintsoft merges orders and more than one of them charged the customer shipping
-- (a possible double postage an IMS operator reviews and clears on Sync > Exceptions; never refunded automatically). No existing row is touched.
ALTER TABLE "wms_order_push_links" ADD COLUMN "double_postage_at" TIMESTAMP(3);
ALTER TABLE "wms_order_push_links" ADD COLUMN "double_postage_detail" TEXT;
