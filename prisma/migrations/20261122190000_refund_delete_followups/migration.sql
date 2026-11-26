-- Additive (#1132 review follow-ups for the refund delete):
--  1. The refund-delete tombstone records when its post-commit follow-ups (re-reserving the order, the storefront stock push) ran, so a void
--     worker that stopped between phase 2's commit and them runs them on its retry. Null on existing rows: only the void worker's retry of a
--     refund it has not finished reads the column, and both follow-ups are safe to repeat.
--  2. One new operator-task reason, appended: the refund delete's credit-note void entry used up its retries.
ALTER TABLE "sales_order_refund_deletions" ADD COLUMN "follow_ups_done_at" TIMESTAMP(3);
ALTER TYPE "WmsOperatorTaskReason" ADD VALUE 'REFUND_DELETE_VOID_STUCK';
