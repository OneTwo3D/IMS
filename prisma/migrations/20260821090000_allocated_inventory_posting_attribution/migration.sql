-- o3d-o97 — RECORD WHAT WAS POSTED TO ALLOCATED INVENTORY, AND WHETHER IT POSTED AT ALL.
--
-- WITHOUT THIS FILE THE FEATURE IS WORSE THAN ABSENT. `prisma migrate deploy` applies migrations,
-- not schema.prisma, so on production every column below would simply not exist: the drift check
-- fails the deploy, and if it were forced through, every read of these columns returns nothing —
-- which is exactly the "no record" state the branch's fallbacks treat as "pre-migration row, use
-- the old inference". The durable records would silently degrade back into the absent ones they
-- were written to replace, on the one code path that credits a real ledger account.
--
-- WHAT EACH COLUMN IS FOR (the full argument lives beside each field in prisma/schema.prisma):
--
--   sales_orders.accounting_allocation_batch_sync_log_id / _connector / _account_code
--     Group A2 debits DR Allocated Inventory / CR Inventory for a whole day's window and stamps
--     each member order with the pounds it contributed. That amount alone proves nothing: the
--     batch journal row is created only when the window's ROUNDED total is positive, it is created
--     PENDING inside the batch transaction with the remote call in a LATER one, and it names no
--     ledger. A refund crediting Allocated Inventory off the amount alone can credit an account
--     that was never debited, or the right amount in the wrong ledger after a connector switch.
--     The sync log's own id cannot exist unless the row was created, so it turns "A2 valued this
--     order at £x" into "A2 raised journal <id> on <connector> against account <code>", and the
--     refund resolves it to read that row's STATUS — queued is never read as posted.
--
--   order_allocations.accounting_allocation_batch_amount
--     The same figure per allocation row, so a PARTIAL refund reverses at the unit cost A2 posted
--     rather than at whatever `costLayerSnapshot` beside it says today — landed-cost revaluation
--     rewrites those pinned layers' unitCostBase in place.
--
--   shipments.accounting_allocated_relief_amount / _sync_log_id / _connector / _account_code
--     Group B relieves that contra (DR COGS / CR Allocated) at dispatch. The relief used to be
--     re-derived from the shipment's CogsEntry rows, which `retention_stock_movements_months`
--     HARD-DELETES — after which the derivation re-values at the CURRENT layer cost, or returns
--     zero, and zero reads as "Group B relieved nothing" so the refund reverses that relief a
--     second time. Recorded by Group B itself now, with the same three-part attribution as A2 so a
--     queued or cancelled Group B journal is not counted as relief either.
--
--   sales_order_refunds.accounting_allocated_relief_amount
--     What an earlier refund's own reversal raised against the contra. Its only previous source
--     was that refund's UNEARNED_REV_REVERSAL sync payload, and `retention_sync_logs_months`
--     hard-deletes the row once it terminalises; a missing row read as zero relief credits the
--     same pounds twice. (Refund rows are archived by retention, never deleted.)
--
--   sales_order_refunds.accounting_allocation_basis_unresolved
--     The REFUSAL. When a refund cannot establish what is still open on the contra it reverses
--     nothing and says why here — on a row that outlives every accounting stamp on the order. The
--     accounting-invariant report reads it (see the index migration that follows this one).
--
-- ADDITIVE, NULLABLE, NO DEFAULT, NO BACKFILL, NO INDEX.
--
-- Every column is a plain nullable add with no DEFAULT, which on PG11+ is a catalogue-only change:
-- no table rewrite, no long lock, and none of the risky patterns docs/migration-conventions.md
-- guards (no NOT NULL, no rename, no drop, no NOT VALID constraint). The house split of ADD COLUMN
-- and SET DEFAULT into two statements exists so a default is never applied while the column is
-- being added; it does not arise here because NOTHING BELOW TAKES A DEFAULT, deliberately — a
-- default is a value, and the whole point of these columns is that a historical row has no value
-- and must say so.
--
-- NOT BACKFILLED for the same reason. Nothing can retroactively prove that a 2025 batch reached a
-- ledger, and writing one of these ids or amounts onto a legacy row would manufacture exactly the
-- confidence the columns exist to stop being assumed. NULL means "not on record", every reader
-- treats it as a pre-migration row and falls back to its older derivation, and those fallbacks
-- refuse rather than degrade when their own basis has expired.
--
-- NO INDEX on any of them: each is read from a row already located by its primary key (the refund
-- loads its order, its shipments and its prior refunds by id) or resolved through
-- accounting_sync_logs' own primary key. The one column that IS the subject of a query —
-- accounting_allocation_basis_unresolved, which the invariant report scans for — gets its index in
-- 20260821090100, built CONCURRENTLY because it cannot share a transaction with anything.

ALTER TABLE "sales_orders" ADD COLUMN "accounting_allocation_batch_sync_log_id" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "accounting_allocation_batch_connector" TEXT;
ALTER TABLE "sales_orders" ADD COLUMN "accounting_allocation_batch_account_code" TEXT;

ALTER TABLE "order_allocations" ADD COLUMN "accounting_allocation_batch_amount" DECIMAL(18,4);

ALTER TABLE "shipments" ADD COLUMN "accounting_allocated_relief_amount" DECIMAL(18,4);
ALTER TABLE "shipments" ADD COLUMN "accounting_allocated_relief_sync_log_id" TEXT;
ALTER TABLE "shipments" ADD COLUMN "accounting_allocated_relief_connector" TEXT;
ALTER TABLE "shipments" ADD COLUMN "accounting_allocated_relief_account_code" TEXT;

ALTER TABLE "sales_order_refunds" ADD COLUMN "accounting_allocated_relief_amount" DECIMAL(18,4);
ALTER TABLE "sales_order_refunds" ADD COLUMN "accounting_allocation_basis_unresolved" TEXT;

-- DELIBERATELY NO FOREIGN KEY from either *_sync_log_id to accounting_sync_logs. The whole design
-- rests on the id outliving nothing and the ROW being allowed to disappear: retention hard-deletes
-- settled sync logs, and a foreign key would either block that sweep or (ON DELETE SET NULL) erase
-- the attribution and turn "the journal this order was staged into is no longer on record" — which
-- every reader treats as a refusal — into "this order was never staged into a journal", which they
-- treat as a fact. A dangling id is the honest state and is read as one.
