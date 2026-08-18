-- o3d-z82a Codex r4: give the direct-create marker sweep an index, or it is a table scan.
--
-- WHAT RUNS. sweepUnresolvedDirectCreateMarkers (lib/fulfillment/pre-fulfilment-reallocation.ts)
-- runs on the reallocation-sweep cron — every 15 minutes by default — and asks
--
--   SELECT "entityId" FROM "activity_logs"
--    WHERE "entityType" = 'SALES_ORDER'
--      AND action = 'fulfilment_entry_pending_verification'
--      AND "createdAt" < NOW() - <grace>
--    GROUP BY "entityId" ORDER BY MIN("createdAt") ASC LIMIT <n>
--
-- activity_logs has indexes on (entityType, entityId), (createdAt), (tag), (level) and
-- (level, createdAt). NONE of them helps: the query knows no entityId, and every other predicate
-- selects a large fraction of the table. Without this index the planner falls back to scanning
-- activity_logs — a table holding 30 to 90 days of every action IMS takes — four times an hour, to
-- find a set that is almost always EMPTY.
--
-- WHY PARTIAL. Unresolved markers are the rarest rows in the table: one is written only by a
-- WooCommerce import whose status mapping lands on PICKING or PACKING, and the import that wrote
-- it clears it seconds later. A partial index holds only the outstanding ones, so it is a few
-- pages at most, costs effectively nothing to maintain on the write path that everything else in
-- activity_logs takes, and turns the sweep's scan into a bounded index read.
--
-- ("createdAt", "entityId") in that order, matching the query: the ageing predicate is the range
-- scan and entityId comes along so the GROUP BY and ORDER BY MIN("createdAt") are answered from
-- the index alone.
--
-- THE LITERAL IS LOAD-BEARING. A partial index predicate cannot reference a TypeScript constant,
-- so this string and DIRECT_CREATE_PENDING_ACTION must stay in step; rename one and the sweep
-- keeps working while silently reverting to the table scan this exists to prevent. That pairing is
-- asserted in tests/pre-fulfilment-reallocation.test.ts.
--
-- Prisma cannot express a partial index in schema.prisma, so this index is deliberately not
-- represented there — the same as hs_code_proposals_one_pending_per_product.
-- prisma-schema-scope-ok: db-native partial index | reason: Prisma schema has no way to express an index WHERE predicate, so a partial index cannot be modelled in schema.prisma
--
-- ONE EXPLICIT TRANSACTION, for the reason 20260721150000_refund_park_unique_index documents:
-- Prisma does NOT auto-wrap a migration file.
BEGIN;

CREATE INDEX "activity_logs_direct_create_marker_idx"
  ON "activity_logs" ("createdAt", "entityId")
  WHERE action = 'fulfilment_entry_pending_verification';

COMMIT;
