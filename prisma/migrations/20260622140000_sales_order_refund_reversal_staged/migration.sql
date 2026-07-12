-- scjz.71: durable flag recording whether a refund STAGED a COGS/unearned reversal,
-- set at staging time. Distinguishes a fully-shipped chargeback (no reversal staged,
-- credit-note-only — exempt from reversal-evidence checks) from a partial/deferred
-- chargeback that staged an UNEARNED_REV_REVERSAL and must still have that evidence.
-- accountingRetrySyncs is cleared once syncs queue, so it cannot carry this signal.
-- Additive NOT NULL column with a default — safe on existing rows.
ALTER TABLE "sales_order_refunds"
  ADD COLUMN "reversalStaged" BOOLEAN NOT NULL DEFAULT false;
