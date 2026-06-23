-- khdw COGS-reconciliation: structured, independent source for the COGS account's
-- refund-reversal movement. The daily-batch COGS GL reconciliation nets refund
-- COGS reversals out of the subledger movement; before this, the only source for
-- that amount was the COGS_REVERSAL journal payload (fragile to scrape). These
-- columns promote it to first-class fields populated at refund-staging time.
--
-- Rollout: additive nullable columns (no NOT NULL, no default), so every existing
-- row is valid immediately. Historical rows stay null and are populated by the
-- idempotent backfill script scripts/backfill-refund-cogs-reversal.ts (reads the
-- synced COGS_REVERSAL logs). The reconciliation is forward-looking per batch and
-- bounds any null-sourced gap to flag-vs-sweep safety, so a not-yet-backfilled row
-- can never mis-sweep — at worst it flags.

ALTER TABLE "sales_order_refunds" ADD COLUMN "cogs_reversal_base" DECIMAL(18,6);
ALTER TABLE "sales_order_refunds" ADD COLUMN "cogs_reversal_journal_date" TIMESTAMP(3);
