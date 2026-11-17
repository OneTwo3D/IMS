-- Additive: one nullable timestamp recording that an operator edited a confirmed (or dispatched) sales order in IMS, so a later WooCommerce delivery does not write its copy of the addresses and notes back over the edit. No existing row or column is touched.
ALTER TABLE "sales_orders" ADD COLUMN "edited_in_ims_at" TIMESTAMP(3);
