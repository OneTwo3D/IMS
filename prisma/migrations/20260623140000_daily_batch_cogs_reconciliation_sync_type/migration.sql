-- khdw: new accounting sync type for the end-of-daily-batch COGS subledger-vs-GL
-- rounding-difference sweep ManualJournal (mirrors scjz.60.4's inventory variant).
-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'DAILY_BATCH_COGS_RECONCILIATION';
