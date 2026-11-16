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

test('migration: override columns exist, are NULL by default, and the Product value is the fallback', { skip }, async () => {
  const out = await withRollback(async (tx: Tx) => {
    const { product, main } = await fixture(tx)
    const level = await tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: product.id, warehouseId: main.id } } })
    const p = await tx.product.findUniqueOrThrow({ where: { id: product.id } })
    return { level, resolved: resolveReorderThresholds(p, level) }
  })
  assert.equal(out.level.reorderPointOverride, null)
  assert.equal(out.level.safetyStockQtyOverride, null)
  assert.equal(out.level.reorderQtyOverride, null)
  assert.equal(out.resolved.reorderPoint?.toString(), '100')
  assert.deepEqual(out.resolved.overridden, [])
})

test('migration: a negative override is refused by the database check', { skip }, async () => {
  await assert.rejects(
    withRollback(async (tx: Tx) => {
      const { product, main } = await fixture(tx)
      await tx.stockLevel.update({
        where: { productId_warehouseId: { productId: product.id, warehouseId: main.id } },
        data: { reorderPointOverride: '-1' },
      })
    }),
    /stock_levels_reorder_point_override_check|check constraint/i,
  )
})

test('save path: updates an existing row, creates a zero row for a new warehouse, audits in the same transaction', { skip }, async () => {
  const out = await withRollback(async (tx: Tx) => {
    const { product, main, sat } = await fixture(tx)
    const result = await applyWarehouseReorderOverrides(tx, {
      productId: product.id,
      userId: null,
      rows: [
        { warehouseId: main.id, reorderPoint: '60', safetyStockQty: null, reorderQty: null },
        { warehouseId: sat.id, reorderPoint: '12.5', safetyStockQty: '3', reorderQty: '' },
      ],
    })
    const levels = await tx.stockLevel.findMany({ where: { productId: product.id }, orderBy: { warehouseId: 'asc' } })
    const audit = await tx.activityLog.findMany({ where: { entityId: product.id, action: 'reorder_threshold_override_changed' } })
    // Second save with identical values: nothing changes, nothing more is audited.
    const again = await applyWarehouseReorderOverrides(tx, {
      productId: product.id,
      userId: null,
      rows: [{ warehouseId: main.id, reorderPoint: '60.0', safetyStockQty: '', reorderQty: '' }],
    })
    const auditAfter = await tx.activityLog.count({ where: { entityId: product.id, action: 'reorder_threshold_override_changed' } })
    return { result, levels, audit, again, auditAfter, mainId: main.id, satId: sat.id }
  })
  assert.equal(out.result.ok, true)
  if (out.result.ok) assert.equal(out.result.changes.length, 3)
  const byWarehouse = new Map(out.levels.map((l: { warehouseId: string }) => [l.warehouseId, l]))
  const main = byWarehouse.get(out.mainId) as { quantity: { toString(): string }; reorderPointOverride: { toString(): string } | null }
  const sat = byWarehouse.get(out.satId) as { quantity: { toString(): string }; reorderPointOverride: { toString(): string }; safetyStockQtyOverride: { toString(): string }; reorderQtyOverride: unknown }
  assert.equal(main.quantity.toString(), '5')
  assert.equal(main.reorderPointOverride?.toString(), '60')
  assert.equal(Number(sat.quantity.toString()), 0)
  assert.equal(sat.reorderPointOverride.toString(), '12.5')
  assert.equal(sat.safetyStockQtyOverride.toString(), '3')
  assert.equal(sat.reorderQtyOverride, null)
  assert.equal(out.audit.length, 3)
  assert.deepEqual(out.again, { ok: true, changes: [] })
  assert.equal(out.auditAfter, 3)
})
