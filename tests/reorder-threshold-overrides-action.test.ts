import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'

/**
 * Per-warehouse reorder thresholds: the save action is gated on inventory.edit (the reader on inventory),
 * writes one activity-log row per changed cell in the same transaction (who, old, new), writes nothing for an
 * unchanged cell, and refuses bad input before touching the database.
 */

type Level = { warehouseId: string; reorderPointOverride: Prisma.Decimal | null; safetyStockQtyOverride: Prisma.Decimal | null; reorderQtyOverride: Prisma.Decimal | null }

const state = {
  permissions: new Set<string>(['inventory', 'inventory.edit']),
  asked: [] as string[],
  productType: 'SIMPLE',
  levels: [] as Level[],
  writes: [] as Array<{ op: string; data: Record<string, unknown> }>,
  activity: [] as Array<Record<string, unknown>>,
  txCount: 0,
}

const tx = {
  product: { findUnique: async () => ({ id: 'p1', sku: 'SKU-1', type: state.productType }) },
  warehouse: {
    findMany: async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((id) => id !== 'GONE').map((id) => ({ id, code: id.toUpperCase(), active: true })),
  },
  stockLevel: {
    findMany: async () => state.levels,
    update: async (args: { data: Record<string, unknown> }) => { state.writes.push({ op: 'update', data: args.data }); return {} },
    upsert: async (args: { create: Record<string, unknown> }) => { state.writes.push({ op: 'create', data: args.create }); return {} },
  },
  activityLog: { create: async (args: { data: Record<string, unknown> }) => { state.activity.push(args.data); return {} } },
}

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
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

function reset() {
  state.permissions = new Set(['inventory', 'inventory.edit'])
  state.asked = []
  state.productType = 'SIMPLE'
  state.levels = []
  state.writes = []
  state.activity = []
  state.txCount = 0
}

const row = (warehouseId: string, reorderPoint: string | null, safetyStockQty: string | null = null, reorderQty: string | null = null) =>
  ({ warehouseId, reorderPoint, safetyStockQty, reorderQty })

test('a user without inventory.edit is refused and nothing is written or audited', async () => {
  reset()
  state.permissions = new Set(['inventory'])
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  await assert.rejects(() => saveWarehouseReorderThresholds('p1', [row('sat', '5')]), /missing permission inventory\.edit/)
  assert.deepEqual(state.asked, ['inventory.edit'])
  assert.equal(state.txCount, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
})

test('an edit writes the override and one audit row per changed cell with who, old and new value', async () => {
  reset()
  state.levels = [{ warehouseId: 'sat', reorderPointOverride: new Prisma.Decimal('10'), safetyStockQtyOverride: null, reorderQtyOverride: null }]
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', '15', '4')])
  assert.deepEqual(result, { success: true, changed: 2 })
  assert.equal(state.writes.length, 1)
  assert.deepEqual(state.writes[0]!.data.reorderPointOverride?.toString(), '15')
  assert.equal(state.activity.length, 2)
  const byField = Object.fromEntries(state.activity.map((a) => [(a.metadata as { field: string }).field, a]))
  assert.equal(byField.reorderPoint!.userId, 'user-7')
  assert.equal(byField.reorderPoint!.entityType, 'PRODUCT')
  assert.equal(byField.reorderPoint!.entityId, 'p1')
  assert.deepEqual(
    { old: (byField.reorderPoint!.metadata as Record<string, unknown>).oldValue, next: (byField.reorderPoint!.metadata as Record<string, unknown>).newValue },
    { old: '10', next: '15' },
  )
  assert.deepEqual(
    { old: (byField.safetyStockQty!.metadata as Record<string, unknown>).oldValue, next: (byField.safetyStockQty!.metadata as Record<string, unknown>).newValue },
    { old: null, next: '4' },
  )
})

test('clearing a cell back to blank is a change (new value null) and is audited', async () => {
  reset()
  state.levels = [{ warehouseId: 'sat', reorderPointOverride: new Prisma.Decimal('10'), safetyStockQtyOverride: null, reorderQtyOverride: null }]
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', '')])
  assert.deepEqual(result, { success: true, changed: 1 })
  assert.equal(state.writes[0]!.data.reorderPointOverride, null)
  assert.equal((state.activity[0]!.metadata as Record<string, unknown>).newValue, null)
})

test('an unchanged save writes and audits nothing; 10 equals 10.0000', async () => {
  reset()
  state.levels = [{ warehouseId: 'sat', reorderPointOverride: new Prisma.Decimal('10.0000'), safetyStockQtyOverride: null, reorderQtyOverride: null }]
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', '10'), row('main', null)])
  assert.deepEqual(result, { success: true, changed: 0 })
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
})

test('a warehouse with no stock row gets one created at zero when an override is set', async () => {
  reset()
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('newwh', null, null, '12')])
  assert.deepEqual(result, { success: true, changed: 1 })
  assert.equal(state.writes[0]!.op, 'create')
  assert.equal(state.writes[0]!.data.quantity, 0)
})

test('invalid input is refused with a per-cell error before anything is written', async () => {
  reset()
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const result = await saveWarehouseReorderThresholds('p1', [row('sat', '-3'), row('main', '5', 'abc')])
  assert.equal(result.success, false)
  if (!result.success) assert.deepEqual(Object.keys(result.fieldErrors ?? {}).sort(), ['main.safetyStockQty', 'sat.reorderPoint'])
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
})

test('a product that holds no stock of its own, or an unknown warehouse, is refused', async () => {
  reset()
  state.productType = 'KIT'
  const { saveWarehouseReorderThresholds } = await import('@/app/actions/reorder-thresholds')
  const kit = await saveWarehouseReorderThresholds('p1', [row('sat', '5')])
  assert.equal(kit.success, false)
  reset()
  const unknown = await saveWarehouseReorderThresholds('p1', [row('GONE', '5')])
  assert.equal(unknown.success, false)
  assert.deepEqual(state.writes, [])
})
