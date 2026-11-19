-- Additive: the WooCommerce line state seen at the last compared delivery, a structured marker on refunds the amendment step creates, and a discrepancy category for a withheld Mintsoft product name. Existing rows: no seen state; not an amendment refund (except as backfilled below).
ALTER TABLE "sales_orders" ADD COLUMN "wc_seen_lines" JSONB;
ALTER TABLE "sales_order_refunds" ADD COLUMN "wc_amendment" BOOLEAN NOT NULL DEFAULT false;
-- Data only: refunds the #1055 amendment step already wrote carry its fixed reason text; mark them so a later restore is still recognised.
UPDATE "sales_order_refunds" SET "wc_amendment" = true WHERE "reason" = 'Order reduced in WooCommerce after payment (IMS amendment, latest edit wins)';
ALTER TYPE "WmsDiscrepancyCategory" ADD VALUE IF NOT EXISTS 'PRODUCT_NAME_REFUSED';
