-- Reverses 20261118231000_refund_adopted_returns_inbox: adoption is now recorded per refund, inbox row and quantity in
-- sales_order_refund_inbox_adoptions, so the array column is unused. The column was added and never populated by shipped code.
ALTER TABLE "sales_order_refunds" DROP COLUMN IF EXISTS "adopted_returns_inbox_ids";
