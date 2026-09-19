-- o3d-1xmo / o3d-2guf — PER-ROW LEDGER PROVENANCE FOR DAILY-BATCH GROUPS A1 AND B.
--
-- A daily-batch reference names a group and a date, and no ledger. Group A2 already records the
-- connector its debit was raised into (accounting_allocation_batch_connector); A1 and B did not, so
-- after a connector switch the other connector's recreate sweep rebuilt their batches into its own
-- books, and a refund reversed A1's unearned revenue in whatever books were active.
--
-- Three nullable TEXT columns, no default and no backfill: NULL means "staged before this column
-- existed", and readers treat it as UNATTRIBUTED rather than guessing a ledger (see
-- lib/domain/accounting/daily-batch-row-ledger.ts). Adding a nullable column without a default is a
-- catalog-only change in PostgreSQL, so this takes no table rewrite.
ALTER TABLE "sales_orders" ADD COLUMN "accounting_revenue_deferred_connector" TEXT;
ALTER TABLE "shipments" ADD COLUMN "accounting_shipment_journal_connector" TEXT;
ALTER TABLE "sales_order_refunds" ADD COLUMN "accounting_unearned_reversal_unresolved" TEXT;
