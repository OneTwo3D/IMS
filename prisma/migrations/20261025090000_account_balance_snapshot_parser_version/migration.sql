-- Which parser version wrote a stored trial-balance balance. NULL = stored by the earlier parser, which misread the report's
-- columns; every reader treats such a row as absent until the date is pulled again (the pull overwrites this column).
-- Nullable on purpose: no backfill, nothing is guessed, nothing is deleted.
ALTER TABLE "accounting_account_balance_snapshots" ADD COLUMN "parserVersion" INTEGER;
