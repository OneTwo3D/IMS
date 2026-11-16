import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { applyWarehouseReorderOverrides } from '../../lib/domain/inventory/reorder-threshold-overrides'
import { resolveReorderThresholds } from '../../lib/domain/inventory/reorder-thresholds'

/**
 * PER-WAREHOUSE REORDER OVERRIDES AGAINST A REAL DATABASE.
 *
 * The fakes in tests/ prove the rules; this proves the migration made the schema they assume (three nullable
 * Decimal(12,4) columns on stock_levels, defaulting to NULL, with >= 0 checks) and that the real save path
 * writes the override, upserts a zero row for a warehouse with no stock, and writes the audit row in the same
 * transaction. Every arm runs in a transaction that is ROLLED BACK, ALWAYS, with fixtures unique per run.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/stock-level-reorder-overrides.test.ts would have been skipped.')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  return (await import('../../lib/db')).db
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb()
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

async function fixture(tx: Tx) {
  const tag = randomUUID().slice(0, 8)
  const product = await tx.product.create({
    data: { sku: `OVR-${tag}`, name: 'Override fixture', reorderPoint: '100', safetyStockQty: '20', reorderQty: '30' },
    select: { id: true, sku: true },
  })
  const main = await tx.warehouse.create({ data: { code: `M${tag}`, name: 'Main' }, select: { id: true } })
  const sat = await tx.warehouse.create({ data: { code: `S${tag}`, name: 'Satellite' }, select: { id: true } })
  await tx.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: 5 } })
  return { product, main, sat }
}

type Cells = [string | null, string | null, string | null]
const cells = (warehouseId: string, want: Cells, was: Cells = [null, null, null]) => ({
  warehouseId,
  reorderPoint: want[0], safetyStockQty: want[1], reorderQty: want[2],
  expected: { reorderPoint: was[0], safetyStockQty: was[1], reorderQty: was[2] },
})

test('migration: the table exists, a product with no override resolves to the Product value, stock_levels is untouched', { skip }, async () => {
  const out = await withRollback(async (tx: Tx) => {
    const { product } = await fixture(tx)
    const p = await tx.product.findUniqueOrThrow({ where: { id: product.id } })
    const overrides = await tx.reorderThresholdOverride.findMany({ where: { productId: product.id } })
    const columns = await tx.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_levels' AND column_name ILIKE '%override%'`
    return { overrides, columns, resolved: resolveReorderThresholds(p, overrides[0]) }
  })
  assert.deepEqual(out.overrides, [])
  assert.deepEqual(out.columns, [])
  assert.equal(out.resolved.reorderPoint?.toString(), '100')
  assert.deepEqual(out.resolved.overridden, [])
})

test('migration: a negative override is refused by the database check', { skip }, async () => {
  await assert.rejects(
    withRollback(async (tx: Tx) => {
      const { product, main } = await fixture(tx)
      await tx.reorderThresholdOverride.create({ data: { productId: product.id, warehouseId: main.id, reorderPoint: '-1' } })
    }),
    /reorder_threshold_overrides_reorder_point_check|check constraint/i,
  )
})

test('migration: one row per product and warehouse, and deleting the product removes its overrides', { skip }, async () => {
  const out = await withRollback(async (tx: Tx) => {
    const { product, main } = await fixture(tx)
    await tx.reorderThresholdOverride.create({ data: { productId: product.id, warehouseId: main.id, reorderQty: '4' } })
    let duplicate = false
    try {
      await tx.$executeRaw`SAVEPOINT dup`
      await tx.reorderThresholdOverride.create({ data: { productId: product.id, warehouseId: main.id, reorderQty: '5' } })
    } catch {
      duplicate = true
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT dup`
    }
    await tx.stockLevel.deleteMany({ where: { productId: product.id } })
    await tx.product.delete({ where: { id: product.id } })
    const left = await tx.reorderThresholdOverride.count({ where: { productId: product.id } })
    return { duplicate, left }
  })
  assert.equal(out.duplicate, true)
  assert.equal(out.left, 0)
})

test('save path: creates override rows only, never a stock row, compare-and-sets, and audits in the same transaction', { skip }, async () => {
  const out = await withRollback(async (tx: Tx) => {
    const { product, main, sat } = await fixture(tx)
    const stockBefore = await tx.stockLevel.count({ where: { productId: product.id } })
    const first = await applyWarehouseReorderOverrides(tx, {
      productId: product.id,
      userId: null,
      rows: [cells(main.id, ['60', null, null]), cells(sat.id, ['12.5', '3', null])],
    })
    const stockAfter = await tx.stockLevel.count({ where: { productId: product.id } })
    const rows = await tx.reorderThresholdOverride.findMany({ where: { productId: product.id } })
    const audit = await tx.activityLog.count({ where: { entityId: product.id, action: 'reorder_threshold_override_changed' } })
    // Stale page: still expects reorder point blank at SAT; stored is 12.5. The safety stock edit on the same row still saves.
    const stale = await applyWarehouseReorderOverrides(tx, {
      productId: product.id,
      userId: null,
      rows: [cells(sat.id, ['99', '4', null], [null, '3', null])],
    })
    const sat2 = await tx.reorderThresholdOverride.findUniqueOrThrow({ where: { productId_warehouseId: { productId: product.id, warehouseId: sat.id } } })
    const staleAudit = await tx.activityLog.count({ where: { entityId: product.id, action: 'reorder_threshold_override_changed' } })
    const cleared = await applyWarehouseReorderOverrides(tx, {
      productId: product.id,
      userId: null,
      rows: [cells(main.id, [null, null, null], ['60', null, null])],
    })
    const mainRows = await tx.reorderThresholdOverride.count({ where: { productId: product.id, warehouseId: main.id } })
    return { first, stockBefore, stockAfter, rows, audit, stale, sat2, staleAudit, cleared, mainRows }
  })
  assert.equal(out.first.ok, true)
  if (out.first.ok) assert.equal(out.first.changes.length, 3)
  assert.equal(out.stockAfter, out.stockBefore, 'no stock row may be created')
  assert.equal(out.rows.length, 2)
  assert.equal(out.audit, 3)
  assert.equal(out.stale.ok, true)
  if (out.stale.ok) {
    assert.deepEqual(out.stale.conflicts.map((c: { field: string }) => c.field), ['reorderPoint'])
    assert.equal(out.stale.changes.length, 1)
  }
  assert.equal(out.sat2.reorderPoint.toString(), '12.5')
  assert.equal(out.sat2.safetyStockQty.toString(), '4')
  assert.equal(out.staleAudit, 4)
  assert.equal(out.cleared.ok, true)
  assert.equal(out.mainRows, 0)
})
