-- The unearned revenue a refund's own UNEARNED_REV_REVERSAL debits, recorded on the refund row at staging.
-- A later refund's remainder sweep nets earlier refunds' reversals from it: their sync rows are hard-deleted by
-- retention once terminal, which made the sweep over-reverse Unearned. NULL = written before the column existed
-- (unknown, never zero). Additive; no backfill.
ALTER TABLE "sales_order_refunds" ADD COLUMN "accounting_unearned_reversed_amount" DECIMAL(18,4);
