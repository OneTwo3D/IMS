-- o3d-0qoo: persist the EXACT daily-batch referenceId on every staged row.
--
-- Batch IDENTITY used to be DERIVED from the row's own stage stamp
-- (revenueDeferredDate / inventoryAllocatedDate / shipmentJournalDate) by several
-- independent consumers — the delete guard, the recreate sweep, the accounting
-- invariants and reconciliation. But both daily-sync implementations capture the batch
-- reference date ONCE near the start of the run and write the stage stamps with later
-- new Date() calls, so a run crossing UTC midnight produces
--
--   AccountingSyncLog.referenceId = A2-2026-07-20-<digest>
--   sales_orders.accounting_inventory_allocated_date = 2026-07-21T00:0x:xxZ
--
-- and every consumer that re-derives looks for a batch that does not exist. For the
-- delete guard that meant permitting a hard delete while the journal stood.
--
-- Aligning the timestamps was tried and reverted (three consumers broke in three
-- different ways), because the problem is not the arithmetic — it is that identity was
-- derived at all. These columns make it stored, written in the same transaction as the
-- stamp beside them.
--
-- Nullable, no default, no backfill: pre-migration rows keep NULL and consumers fall
-- back to the derive-from-stamp helpers for them, which is exactly today's behaviour.
-- Adding a nullable column without a default is metadata-only on Postgres — no rewrite.
ALTER TABLE "sales_orders" ADD COLUMN "accounting_revenue_deferred_batch_ref" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "accounting_inventory_allocated_batch_ref" TEXT;
ALTER TABLE "shipments" ADD COLUMN "accounting_shipment_journal_batch_ref" TEXT;

-- "which rows are in batch <ref>" — the reverse of the delete guard's lookup, wanted by
-- reconciliation and by anyone investigating a journal. Plain (not partial) indexes:
-- Prisma cannot express a WHERE clause in schema.prisma, and a partial index here would
-- read as drift on every subsequent migrate.
CREATE INDEX "sales_orders_revenue_deferred_batch_ref_idx"
  ON "sales_orders" ("accounting_revenue_deferred_batch_ref");
CREATE INDEX "sales_orders_inventory_allocated_batch_ref_idx"
  ON "sales_orders" ("accounting_inventory_allocated_batch_ref");
CREATE INDEX "shipments_shipment_journal_batch_ref_idx"
  ON "shipments" ("accounting_shipment_journal_batch_ref");
