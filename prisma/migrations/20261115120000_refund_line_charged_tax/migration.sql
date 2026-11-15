-- Additive: the VAT the source (WooCommerce) STATED it returned on a refund line, in the order's currency, kept so a later refund of the same order line can be held to what that line still has left in VAT. Nullable, no default, no backfill: every existing row reads NULL (not stated).
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "charged_tax_foreign" DECIMAL(18,4);
