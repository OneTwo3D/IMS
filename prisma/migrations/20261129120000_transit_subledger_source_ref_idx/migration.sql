-- expand-only
-- The floored supplier-credit COGS journal (switch landed_cost_floor_cogs_enabled, lib/domain/purchasing/landed-floor-cogs.ts) looks up an order's own
-- transit sub-ledger rows by (source_ref, source_type) on every receipt, WMS book-in, align-up and landed-cost recalculation, also with the switch off
-- (an order it already journalled keeps being reconciled). Without this index that lookup scanned the table. CONCURRENTLY, one statement in its own file
-- (it cannot run in a transaction): the table grows with every transit posting. If the build is interrupted it fails this migration:
-- DROP INDEX CONCURRENTLY IF EXISTS "transit_subledger_movements_source_ref_source_type_idx", `prisma migrate resolve --rolled-back` this migration, rerun
-- `migrate deploy`. ADDITIVE ONLY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transit_subledger_movements_source_ref_source_type_idx"
ON "transit_subledger_movements" ("source_ref", "source_type");
