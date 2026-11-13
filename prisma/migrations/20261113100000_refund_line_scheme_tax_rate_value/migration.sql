-- Additive: the VAT rate a scheme refund line was priced at when the refund was created. Nullable, no default, no existing row is touched.
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "scheme_tax_rate_value" DECIMAL(9,6);
