-- scjz.70: revenue-only chargeback flag on sales order refunds. The credit note
-- still reverses recognised revenue against AR, but COGS reversal + inventory
-- restock are suppressed (cost kept as a loss, goods not returned). Persisted so an
-- accounting retry that re-stages reproduces the revenue-only treatment.
-- Additive NOT NULL column with a default — safe on existing rows.
ALTER TABLE "sales_order_refunds"
  ADD COLUMN "chargeback" BOOLEAN NOT NULL DEFAULT false;
