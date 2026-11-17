-- Additive: a sales quotation is a DRAFT order carrying is_quote. Existing rows become is_quote = false, so every current order behaves exactly as before.
-- migration-convention-ok: ADD COLUMN NOT NULL because it has a safe DEFAULT (false) valid for every historical row
ALTER TABLE "sales_orders" ADD COLUMN "is_quote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales_orders" ADD COLUMN "quote_valid_until" DATE;
ALTER TABLE "sales_orders" ADD COLUMN "quote_sent_at" TIMESTAMP(3);
