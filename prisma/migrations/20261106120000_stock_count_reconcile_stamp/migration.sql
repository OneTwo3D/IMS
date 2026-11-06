-- Stocktake reconcile stamp: the on-hand each counted line was reconciled against, so authorising (posting) a count can refuse when stock has moved since.
--
-- ADDITIVE ONLY: two nullable columns, no default, no backfill. A line or count with no stamp reads as "not reconciled", which authorising refuses until the operator reconciles.

-- AlterTable
ALTER TABLE "stock_counts" ADD COLUMN "reconciledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stock_count_lines" ADD COLUMN "reconciledQty" DECIMAL(14,6);
