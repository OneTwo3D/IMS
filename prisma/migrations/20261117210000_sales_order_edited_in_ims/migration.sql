-- Additive: one nullable timestamp recording that an operator edited a confirmed (or dispatched) sales order in IMS, so a later WooCommerce delivery does not write its copy of the addresses and notes back over the edit. No existing row or column is touched.
ALTER TABLE "sales_orders" ADD COLUMN "edited_in_ims_at" TIMESTAMP(3);
-- Additive: the WooCommerce-facing lines and total as they were before the first IMS edit of the lines, so the edited-in-WooCommerce comparison keeps running against what the store holds.
ALTER TABLE "sales_orders" ADD COLUMN "wc_line_baseline" JSONB;
