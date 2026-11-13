-- Additive: the posting type a scheme credit-note line posts on, and the gross the refund's source stated. Nullable, no default, no existing row is touched.
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "posting_tax_type" TEXT;
ALTER TABLE "sales_order_refunds" ADD COLUMN "stated_gross_foreign" DECIMAL(18,4);
