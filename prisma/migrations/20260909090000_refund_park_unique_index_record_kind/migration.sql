-- prisma-schema-scope-ok: db-native partial UNIQUE index — Prisma cannot represent a partial index
-- WHERE predicate, so this cannot live in schema.prisma. It replaces the predicate of the index
-- 20260721150000 built, and adds no column, table or constraint the Prisma schema can see.
--
-- o3d-272i r2 (Codex HIGH) — THE NINTH READER OF THE REFUND-PARK RULE IS THE DATABASE, AND IT WAS
-- STILL READING THE PRE-`recordKind` SHAPE.
--
-- WHAT WAS WRONG. `shopping_sync_logs_active_refund_park_uq` (migration 20260721150000) enforces one
-- actionable refund park per (connector, externalId). Its predicate was written in July, before
-- `recordKind` existed (20260822120000), out of the five clauses that were then believed to identify
-- a refund park: connector='woocommerce', direction='FROM_CONNECTOR', entityType='SalesOrder', an
-- actionable status, and a non-null entityId.
--
-- A HELD SALES INVOICE WRITES EVERY ONE OF THEM (o3d-k26m.6,
-- lib/connectors/woocommerce/sync/order-import.ts). That is the collision o3d-xnwu r8 added
-- `recordKind` to end, and o3d-272i removed eight hand-written TypeScript copies of the old shape
-- for. This one is not TypeScript, so no AST sweep reached it — and being an INDEX it OVERRIDES the
-- application fixes rather than merely lagging them. The two rows' externalIds come from DIFFERENT
-- WooCommerce id spaces: a park carries the REFUND id, a hold carries the ORDER id. They collide as
-- soon as some order id equals some refund id, which is a matter of time and not of misuse. When
-- they do, whichever row is written second is refused by a UNIQUE violation for sharing a key with a
-- row of another family entirely: a legitimate invoice hold cannot be recorded, or a refund park
-- cannot be recorded, and the loser is decided by arrival order.
--
-- THE FIX is the clause the index has never carried. The predicate below is rendered by
-- `activeRefundParkIndexPredicateSql()` in lib/domain/sales/wc-sync-row-families.ts, from the same
-- `ACTIVE_REFUND_PARK_ROW` object `activeRefundParkWhere()` reads, so this file is a COPY OF A
-- GENERATED STRING rather than a tenth independent statement of the rule.
-- tests/prisma/refund-park-unique-index-record-kind-migration.test.ts asserts the two are identical
-- character for character, and tests/concurrency/refund-park-index-family-scope.concurrent.test.ts
-- executes the SHIPPED index predicate and the shared `where` over one probe matrix and requires the
-- same answer.
--
-- WHY THERE IS NO DEDUP OR COLLISION GATE HERE, unlike 20260721150000. That migration WIDENED the
-- set of rows a uniqueness rule applied to, so it had to prove no duplicates already existed. This
-- one NARROWS it: the new predicate is the old one AND `"recordKind" = 'WC_REFUND_PARK'`, so every
-- key group it forms is a subset of a group the existing index already held unique. A subset of a
-- set with no duplicates has no duplicates, so the build cannot fail on data and nothing needs
-- collapsing. Narrowing also cannot orphan a row: rows that leave the index (the held invoices) stop
-- being constrained, which is the entire point.
--
-- ONE TRANSACTION, and no LOCK TABLE. `DROP INDEX` takes ACCESS EXCLUSIVE on the table for the whole
-- transaction, which already excludes every reader and writer across the drop and the rebuild — a
-- strictly stronger exclusion than the SHARE ROW EXCLUSIVE its predecessor had to take explicitly.
-- So there is no window in which the table is unconstrained. Prisma 7.8's runner does not wrap a
-- migration file, so the BEGIN/COMMIT is written out: without it a failed CREATE would leave the
-- table with NO uniqueness at all and the migration marked failed — the one outcome worse than the
-- bug. Not CONCURRENTLY: it cannot run in a transaction, and a concurrent UNIQUE build that meets a
-- duplicate is left behind INVALID and must be dropped by hand.
--
-- DROP without IF EXISTS, deliberately. The index is created by 20260721150000, which every database
-- that reaches this migration has applied. If it is absent, something removed it outside migrations
-- and this deploy should say so loudly rather than quietly create one and imply the predecessor's
-- dedup and cross-order collision gate had run.
BEGIN;

DROP INDEX "shopping_sync_logs_active_refund_park_uq";

CREATE UNIQUE INDEX "shopping_sync_logs_active_refund_park_uq"
ON "shopping_sync_logs" (connector, "externalId")
WHERE connector = 'woocommerce'
  AND direction = 'FROM_CONNECTOR'
  AND "entityType" = 'SalesOrder'
  AND "recordKind" = 'WC_REFUND_PARK'
  AND status IN ('PENDING', 'FAILED', 'QUARANTINED')
  AND "externalId" IS NOT NULL
  AND "entityId" IS NOT NULL;

COMMIT;
