-- Additive: the tax a WooCommerce refund states across all its rate ids when it carried tax on EAS rate 182, and when that credit note was counted against the first-N hold. Nullable, no default, no existing row is touched.
ALTER TABLE "sales_order_refunds" ADD COLUMN "eas182_stated_tax_foreign" DECIMAL(18,4);
ALTER TABLE "sales_order_refunds" ADD COLUMN "eas182_held_at" TIMESTAMP(3);
