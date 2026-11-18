-- Additive: the VAT rate of each refund line's tax code as of the refund's creation, so credit-note history does not re-price from the current tax table.
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "posted_tax_rate" DECIMAL(9,6);
