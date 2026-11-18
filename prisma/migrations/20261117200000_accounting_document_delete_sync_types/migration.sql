-- Additive: two accounting sync types for deleting a synced invoice or bill in Xero (renumber, then DELETE or VOID).
-- Nothing is backfilled; no existing row changes.
ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'SALES_INVOICE_DELETE';
ALTER TYPE "AccountingSyncType" ADD VALUE IF NOT EXISTS 'PURCHASE_INVOICE_DELETE';
