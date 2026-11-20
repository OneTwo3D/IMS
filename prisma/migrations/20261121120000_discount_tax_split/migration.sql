-- Additive: the order discount's per-rate tax split (written only with sales_order_discount_tax_apportion_enabled on) and the rate a discount-reversal refund line belongs to.
ALTER TABLE "sales_orders" ADD COLUMN "discount_tax_split" JSONB;
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "discount_tax_rate_id" TEXT;
