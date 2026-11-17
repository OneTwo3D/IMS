import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'

/**
 * Per-warehouse reorder thresholds: the save action is gated on inventory.edit (the reader on inventory),
 * writes one activity-log row per changed cell in the same transaction (who, old, new), writes nothing for an
 * unchanged cell, and refuses bad input before touching the database.
 */

type Row = { reorderPoint: Prisma.Decimal | null; safetyStockQty: Prisma.Decimal | null; reorderQty: Prisma.Decimal | null }
const dec = (v: string | null) => (v == null ? null : new Prisma.Decimal(v))

const state = {
  permissions: new Set<string>(['inventory', 'inventory.edit']),
  asked: [] as string[],
  productType: 'SIMPLE',
  rows: new Map<string, Row>(), // warehouseId -> override row
  writes: [] as Array<{ op: string; data: Record<string, unknown> }>,
  locks: 0,
  activity: [] as Array<Record<string, unknown>>,
  txCount: 0,
  touched: new Set<string>(),
  stockPushes: 0,
}

const rawTx = {
  product: { findUnique: async () => ({ id: 'p1', sku: 'SKU-1', type: state.productType }) },
  warehouse: {
    findMany: async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((id) => id !== 'GONE').map((id) => ({ id, code: id.toUpperCase() })),
  },
  // INSERT ... ON CONFLICT DO NOTHING
  $executeRaw: async (_strings: TemplateStringsArray, _id: string, _productId: string, warehouseId: string) => {
    if (!state.rows.has(warehouseId)) state.rows.set(warehouseId, { reorderPoint: null, safetyStockQty: null, reorderQty: null })
    return 1
  },
  // SELECT ... FOR UPDATE
  $queryRaw: async () => { state.locks += 1; return [] },
  reorderThresholdOverride: {
    findUnique: async (args: { where: { productId_warehouseId: { warehouseId: string } } }) => state.rows.get(args.where.productId_warehouseId.warehouseId) ?? null,
    update: async (args: { where: { productId_warehouseId: { warehouseId: string } }; data: Record<string, Prisma.Decimal | null> }) => {
      state.writes.push({ op: 'update', data: args.data })
      Object.assign(state.rows.get(args.where.productId_warehouseId.warehouseId)!, args.data)
      return {}
    },
    deleteMany: async (args: { where: { warehouseId: string } }) => { state.writes.push({ op: 'delete', data: {} }); state.rows.delete(args.where.warehouseId); return { count: 1 } },
  },
  activityLog: { create: async (args: { data: Record<string, unknown> }) => { state.activity.push(args.data); return {} } },
}
// Any delegate the save path touches is recorded; stockLevel must never be one of them.
const tx = new Proxy(rawTx, { get: (t, k: string) => { state.touched.add(k); return (t as Record<string, unknown>)[k] } })

mock.module('@/lib/db', {
  namedExports: { db: { $transaction: async (fn: (t: unknown) => Promise<unknown>) => { state.txCount += 1; return fn(tx) } } },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      state.asked.push(permission)
      if (!state.permissions.has(permission)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'user-7', role: 'MANAGER' } }
    },
  },
})
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => { state.stockPushes += 1 } } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

function reset() {
  state.permissions = new Set(['inventory', 'inventory.edit'])
  state.asked = []
  state.productType = 'SIMPLE'
  state.rows = new Map()
  state.writes = []
  state.locks = 0
  state.activity = []
  state.txCount = 0
  state.touched = new Set()
  state.stockPushes = 0
}

type Cells = [string | null, string | null, string | null]
const row = (warehouseId: string, want: Cells, was: Cells = [null, null, null]) => ({
  warehouseId,
  reorderPoint: want[0], safetyStockQty: want[1], reorderQty: want[2],
  expected: { reorderPoint: was[0], safetyStockQty: was[1], reorderQty: was[2] },
})
const seed = (warehouseId: string, v: Cells) => state.rows.set(warehouseId, { reorderPoint: dec(v[0]), safetyStockQty: dec(v[1]), reorderQty: dec(v[2]) })
const meta = (a: Record<string, unknown>) => a.metadata as Record<string, unknown>

test('a user without inventory.edit is refused and nothing is written or audited', async () => {
  reset()
  state.permissions = new Set(['inventory'])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  await assert.rejects(() => saveWarehouseReorderThresholds('p1', [row('sat', ['5', null, null])]), /missing permission inventory\.edit/)
  assert.deepEqual(state.asked, ['inventory.edit'])
  assert.equal(state.txCount, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
})

test('an edit writes the override and one audit row per changed cell with who, old and new value', async () => {
  reset()
  seed('sat', ['10', null, null])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', ['15', '4', null], ['10', null, null])])
  assert.deepEqual(result, { success: true, changed: 2, conflicts: [], conflictMessage: null })
  assert.equal(state.locks, 1)
  assert.equal(state.rows.get('sat')!.reorderPoint?.toString(), '15')
  assert.equal(state.rows.get('sat')!.safetyStockQty?.toString(), '4')
  assert.equal(state.activity.length, 2)
  const byField = Object.fromEntries(state.activity.map((a) => [meta(a).field as string, a]))
  assert.equal(byField.reorderPoint!.userId, 'user-7')
  assert.equal(byField.reorderPoint!.entityId, 'p1')
  assert.deepEqual([meta(byField.reorderPoint!).oldValue, meta(byField.reorderPoint!).newValue], ['10', '15'])
  assert.deepEqual([meta(byField.safetyStockQty!).oldValue, meta(byField.safetyStockQty!).newValue], [null, '4'])
})

test('clearing the last value deletes the row (a row exists only while an override is set) and is audited', async () => {
  reset()
  seed('sat', ['10', null, null])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', [null, null, null], ['10', null, null])])
  assert.equal(result.success && result.changed, 1)
  assert.equal(state.rows.has('sat'), false)
  assert.equal(meta(state.activity[0]!).newValue, null)
})

test('an unchanged save writes, locks and audits nothing; 10 equals 10.0000', async () => {
  reset()
  seed('sat', ['10.0000', null, null])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', ['10', null, null], ['10.0000', null, null]), row('main', [null, null, null])])
  assert.equal(result.success && result.changed, 0)
  assert.deepEqual(state.writes, [])
  assert.equal(state.locks, 0)
  assert.deepEqual(state.activity, [])
})

test('a stale cell is refused with operator wording, the other cells still save, and audit holds the true old value', async () => {
  reset()
  // Someone else already moved the reorder point 10 -> 20 while this operator's page still shows 10.
  seed('sat', ['20', null, null])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', ['12', '5', null], ['10', null, null])])
  assert.ok(result.success)
  if (!result.success) return
  assert.equal(result.changed, 1)
  assert.deepEqual(result.conflicts.map((c) => [c.warehouseCode, c.field]), [['SAT', 'reorderPoint']])
  assert.match(result.conflictMessage ?? '', /changed by someone else.*SAT reorder point.*Reload/)
  // The other person's reorder point is NOT reverted; the operator's safety stock edit is saved.
  assert.equal(state.rows.get('sat')!.reorderPoint?.toString(), '20')
  assert.equal(state.rows.get('sat')!.safetyStockQty?.toString(), '5')
  assert.equal(state.activity.length, 1)
  assert.deepEqual([meta(state.activity[0]!).field, meta(state.activity[0]!).oldValue, meta(state.activity[0]!).newValue], ['safetyStockQty', null, '5'])
})

test('an untouched stale cell is not written: an old page cannot revert another editor\'s value', async () => {
  reset()
  seed('sat', ['20', null, null])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  // Page loaded when reorder point was 10; operator only edits safety stock, but the page still submits reorderPoint 10.
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', ['10', '5', null], ['10', null, null])])
  assert.ok(result.success && result.changed === 1 && result.conflicts.length === 0)
  assert.equal(state.rows.get('sat')!.reorderPoint?.toString(), '20')
})

test('a concurrent insert of the same row is tolerated (ON CONFLICT path): an existing row is kept, not duplicated', async () => {
  reset()
  seed('sat', [null, null, '7'])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', ['3', null, null], [null, null, null])])
  assert.ok(result.success && result.changed === 1)
  assert.equal(state.rows.get('sat')!.reorderQty?.toString(), '7')
  assert.equal(state.rows.size, 1)
})

test('saving an override for a warehouse with no stock row creates no StockLevel row and enqueues no stock push', async () => {
  reset()
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('newwh', [null, null, '12'])])
  assert.ok(result.success && result.changed === 1)
  assert.equal(state.rows.get('newwh')!.reorderQty?.toString(), '12')
  assert.equal(state.touched.has('stockLevel'), false)
  assert.equal(state.stockPushes, 0)
})

test('the save path never references stock rows or stock sync in source', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['lib/domain/inventory/reorder-threshold-overrides.ts', 'app/actions/reorder-thresholds.ts']) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /stockLevel|stock_levels|enqueueStockSync/, file)
  }
})

test('invalid input is refused with a per-cell error before anything is written', async () => {
  reset()
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', ['-3', null, null]), row('main', ['5', 'abc', null])])
  assert.equal(result.success, false)
  if (!result.success) assert.deepEqual(Object.keys(result.fieldErrors ?? {}).sort(), ['main.safetyStockQty', 'sat.reorderPoint'])
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
})

test('a product that holds no stock of its own, or an unknown warehouse, is refused', async () => {
  reset()
  state.productType = 'KIT'
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const kit = await saveWarehouseReorderThresholds('p1', [row('sat', ['5', null, null])])
  assert.equal(kit.success, false)
  reset()
  const unknown = await saveWarehouseReorderThresholds('p1', [row('GONE', ['5', null, null])])
  assert.equal(unknown.success, false)
  assert.deepEqual(state.writes, [])
})
