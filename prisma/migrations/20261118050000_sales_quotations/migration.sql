-- Additive: a sales quotation is a DRAFT order carrying is_quote. Existing rows become is_quote = false, so every current order behaves exactly as before.
-- migration-convention-ok: ADD COLUMN NOT NULL because it has a safe DEFAULT (false) valid for every historical row
ALTER TABLE "sales_orders" ADD COLUMN "is_quote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales_orders" ADD COLUMN "quote_valid_until" DATE;
ALTER TABLE "sales_orders" ADD COLUMN "quote_sent_at" TIMESTAMP(3);
-- A quote is a draft: the flag can only sit on a DRAFT order, or on one cancelled while it was a quote. Structural, so no writer can store a live quote.
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quote_is_draft_check" CHECK (NOT "is_quote" OR "status" IN ('DRAFT', 'CANCELLED'));
