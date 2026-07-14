-- 6oyu.4 (epic khdw): new accounting sync type for the end-of-daily-batch transit
-- subledger-vs-GL rounding-difference sweep ManualJournal (mirrors the inventory +
-- COGS variants; guarded — only immaterial rounding is swept, material gaps flag).
-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'DAILY_BATCH_TRANSIT_RECONCILIATION';
