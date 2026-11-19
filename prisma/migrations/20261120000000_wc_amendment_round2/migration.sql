-- Additive: the WooCommerce line state seen at the last compared delivery, and a structured marker on refunds the amendment step creates. Existing rows: no seen state, not an amendment refund.
ALTER TABLE "sales_orders" ADD COLUMN "wc_seen_lines" JSONB;
ALTER TABLE "sales_order_refunds" ADD COLUMN "wc_amendment" BOOLEAN NOT NULL DEFAULT false;
