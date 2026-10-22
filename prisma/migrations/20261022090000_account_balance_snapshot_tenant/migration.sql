-- Which Xero organisation a stored trial-balance balance was fetched from. NULL = stored before this column existed
-- (or by a pull that could not name the connection); the reconciliation pack basis treats a NULL as not belonging to
-- the connected organisation. Nullable on purpose: no backfill, nothing is guessed.
ALTER TABLE "accounting_account_balance_snapshots" ADD COLUMN "tenantId" TEXT;
