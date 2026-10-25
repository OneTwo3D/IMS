-- The organisation's financial-year end ("MM-DD") in force when a trial-balance balance was pulled. The trial balance is
-- year-to-date, so a profit-and-loss account restarts at the financial-year start; two stored balances may be differenced into a
-- movement only if both prove the same year end. NULL = not proven (stored before this column existed, or the Organisation did
-- not carry a valid year end). Nullable on purpose: no backfill, nothing is guessed.
ALTER TABLE "accounting_account_balance_snapshots" ADD COLUMN "financialYearEnd" TEXT;
