-- cogs-audit scjz.60.4: new accounting sync type for the end-of-daily-batch
-- inventory subledger-vs-GL rounding-difference sweep ManualJournal.
-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'DAILY_BATCH_INVENTORY_RECONCILIATION';
