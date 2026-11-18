import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-hqvrp.47 — a valued stock adjustment with no account to post against is recorded as an owed posting, not silently dropped.

const reports: Array<Record<string, unknown>> = []
const enqueued: Array<Record<string, unknown>> = []
let settings: Record<string, unknown> = {}

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => settings,
    queueAccountingSyncTxWithOutcome: async (_tx: unknown, params: Record<string, unknown>) => {
      enqueued.push(params)
      return { queued: true }
    },
  },
})
mock.module('@/lib/domain/accounting/enqueue-outcome', {
  namedExports: {
    postingIsOwed: (o: { queued: boolean; reason?: string }) => !o.queued && o.reason !== 'not-configured' && o.reason !== 'shadowed',
    reportPostingNotQueued: async () => {},
  },
})
mock.module('@/lib/domain/accounting/posting-refusal-inbox', {
  namedExports: {
    recordAccountingPostingRefusal: async (_client: unknown, key: Record<string, unknown>, record: Record<string, unknown>) => {
      reports.push({ key, record })
      return { recorded: true }
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => ({}) } })
mock.module('@/lib/db/savepoint', { namedExports: { withSavepoint: async (_tx: unknown, fn: () => Promise<unknown>) => fn() } })
mock.module('@/lib/cost-layers', {
  namedExports: {
    cogsEntryDataFromConsumed: () => ({}),
    consumeFifoLayersStrict: async () => ({ consumed: [] }),
    createCostLayer: async () => ({}),
    getAverageUnitCost: async () => 0,
    getHistoricalAverageUnitCost: async () => 0,
    lockStockLevelRow: async () => ({ quantity: 100, reservedQty: 0 }),
  },
})

const loadApply = async () => (await import('@/lib/domain/inventory/stock-adjustment-apply')).applyStockAdjustment

function fakeTx(reason: { name: string; accountCode: string | null } | null) {
  return {
    adjustmentReason: { findUnique: async () => reason },
    stockMovement: { create: async () => ({ id: 'mv-1', createdAt: new Date() }), findUnique: async () => null, update: async () => ({}) },
    stockLevel: { upsert: async () => ({}) },
    product: { findUnique: async () => ({ sku: 'SKU1', name: 'Thing' }) },
    warehouse: { findUnique: async () => ({ code: 'W1', name: 'Main' }) },
    cogsEntry: { createMany: async () => ({}) },
  } as never
}

function reset(connector: string | null, inventoryAccount = '630') {
  reports.length = 0
  enqueued.length = 0
  settings = { connector, inventoryAccount }
}

test('no reason: value moved, no journal built -> the owed posting is reported', async () => {
  reset('xero')
  await (await loadApply())({ tx: fakeTx(null), productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2 })
  assert.equal(enqueued.length, 0)
  assert.equal(reports.length, 1)
  assert.equal((reports[0]!.record as { kind: string }).kind, 'stock_adjustment_journal')
  assert.equal((reports[0]!.key as Record<string, string>).type, 'INVENTORY_ADJUSTMENT')
  assert.equal((reports[0]!.key as Record<string, string>).referenceId, 'mv-1')
})

test('a reason with no account is reported the same way', async () => {
  reset('xero')
  await (await loadApply())({ tx: fakeTx({ name: 'Damaged', accountCode: null }), productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' })
  assert.equal(enqueued.length, 0)
  assert.equal(reports.length, 1)
})

test('no inventory account mapped is reported', async () => {
  reset('xero', '')
  await (await loadApply())({ tx: fakeTx({ name: 'Damaged', accountCode: '820' }), productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' })
  assert.equal(reports.length, 1)
})

test('no accounting connector: nothing is owed, nothing is reported', async () => {
  reset(null)
  await (await loadApply())({ tx: fakeTx(null), productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2 })
  assert.equal(reports.length, 0)
})

test('a zero-value adjustment is not reported', async () => {
  reset('xero')
  await (await loadApply())({ tx: fakeTx(null), productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 0 })
  assert.equal(reports.length, 0)
})

test('a mapped reason still queues its journal and reports nothing', async () => {
  reset('xero')
  await (await loadApply())({ tx: fakeTx({ name: 'Damaged', accountCode: '820' }), productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' })
  assert.equal(enqueued.length, 1)
  assert.equal(reports.length, 0)
})
