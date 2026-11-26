import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-0ypv9 — applyStockAdjustment with the switch `stock_adjustment_reason_cost_required` ON refuses an adjustment without a
// reason, refuses a valued adjustment the ledger would never see, and values a blank addition at the latest cost layer, never an
// average. With it OFF the same inputs behave as before (an average, an owed posting).

const reports: Array<Record<string, unknown>> = []
const enqueued: Array<Record<string, unknown>> = []
let settings: Record<string, unknown> = {}
let verdict = 'post'
let averageCost = 4
const layersCreated: Array<Record<string, unknown>> = []

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => settings,
    accountingPostingVerdictForChart: async () => ({ verdict }),
    queueAccountingSyncTxWithOutcome: async (_tx: unknown, params: Record<string, unknown>) => {
      enqueued.push(params)
      return { queued: true }
    },
  },
})
mock.module('@/lib/domain/accounting/enqueue-outcome', {
  namedExports: { postingIsOwed: () => false, reportPostingNotQueued: async () => {} },
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
    createCostLayer: async (_tx: unknown, data: Record<string, unknown>) => { layersCreated.push(data); return 'layer' },
    getAverageUnitCost: async () => averageCost,
    getHistoricalAverageUnitCost: async () => averageCost,
    lockStockLevelRow: async () => ({ quantity: 100, reservedQty: 0 }),
  },
})

const loadApply = async () => (await import('@/lib/domain/inventory/stock-adjustment-apply')).applyStockAdjustment

type Reason = { name: string; accountCode: string | null; active?: boolean } | null

function fakeTx(opts: { switchOn: boolean; reason: Reason; latestInWarehouse?: string | null; latestAnywhere?: string | null }) {
  const writes: string[] = []
  const movements: Array<Record<string, unknown>> = []
  const tx = {
    setting: { findUnique: async () => (opts.switchOn ? { value: 'true' } : null) },
    adjustmentReason: { findUnique: async () => opts.reason },
    costLayer: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const v = 'warehouseId' in args.where ? opts.latestInWarehouse ?? null : opts.latestAnywhere ?? null
        return v == null ? null : { unitCostBase: v }
      },
    },
    stockMovement: {
      create: async (args: { data: Record<string, unknown> }) => { writes.push('movement'); movements.push(args.data); return { id: 'mv-1', createdAt: new Date() } },
      findUnique: async () => null,
      update: async (args: { data: Record<string, unknown> }) => { movements.push(args.data); return {} },
    },
    stockLevel: { upsert: async () => { writes.push('level'); return {} } },
    product: { findUnique: async () => ({ sku: 'SKU1', name: 'Thing' }) },
    warehouse: { findUnique: async () => ({ code: 'W1', name: 'Main' }) },
    cogsEntry: { createMany: async () => ({}) },
  }
  return { tx: tx as never, writes, movements }
}

function reset() {
  reports.length = 0
  enqueued.length = 0
  layersCreated.length = 0
  settings = { connector: 'xero', inventoryAccount: '630' }
  verdict = 'post'
  averageCost = 4
}

const mapped: Reason = { name: 'Damaged', accountCode: '820', active: true }
const unmapped: Reason = { name: 'Found', accountCode: null, active: true }

test('ON: no reason is refused before anything is written', async () => {
  reset()
  const f = fakeTx({ switchOn: true, reason: null })
  await assert.rejects((await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2 }), /Choose an adjustment reason for SKU1/)
  assert.deepEqual(f.writes, [])
  // A reason id that resolves to nothing is the same as no reason.
  const g = fakeTx({ switchOn: true, reason: null })
  await assert.rejects((await loadApply())({ tx: g.tx, productId: 'p', warehouseId: 'w', qty: -1, reasonId: 'gone' }), /Choose an adjustment reason/)
  assert.deepEqual(g.writes, [])
})

test('ON: an inactive reason is refused', async () => {
  reset()
  const f = fakeTx({ switchOn: true, reason: { name: 'Old', accountCode: '820', active: false } })
  await assert.rejects((await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' }), /"Old" is inactive/)
  assert.deepEqual(f.writes, [])
})

test('ON: a valued addition under a reason with no account is refused, naming the reason, before anything is written', async () => {
  reset()
  const f = fakeTx({ switchOn: true, reason: unmapped })
  await assert.rejects((await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' }), /Map an account to "Found"/)
  assert.deepEqual(f.writes, [])
  assert.equal(reports.length, 0, 'refused, not sent to the exception inbox')
})

test('ON: no inventory account mapped is refused the same way', async () => {
  reset()
  settings = { connector: 'xero', inventoryAccount: '' }
  const f = fakeTx({ switchOn: true, reason: mapped })
  await assert.rejects((await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' }), /Map the inventory account first/)
})

test('ON: an unmapped reason is accepted when nothing would post (no connector / sync off) or the value is zero', async () => {
  reset()
  settings = { connector: null, inventoryAccount: '' }
  await (await loadApply())({ tx: fakeTx({ switchOn: true, reason: unmapped }).tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' })
  reset()
  verdict = 'not-configured'
  await (await loadApply())({ tx: fakeTx({ switchOn: true, reason: unmapped }).tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' })
  reset()
  const free = fakeTx({ switchOn: true, reason: unmapped })
  await (await loadApply())({ tx: free.tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 0, reasonId: 'r' })
  assert.equal(String(layersCreated[0]!.unitCostBase), '0', 'an entered 0 is booked at 0 (genuinely free stock)')
  assert.equal(reports.length, 0)
})

test('ON: a blank addition takes the latest layer cost in this warehouse, never the average, and the journal is valued at it', async () => {
  reset()
  averageCost = 4
  const f = fakeTx({ switchOn: true, reason: mapped, latestInWarehouse: '2.500000', latestAnywhere: '9.000000' })
  await (await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 3, reasonId: 'r' })
  assert.equal(String(layersCreated[0]!.unitCostBase), '2.5')
  assert.equal(f.movements[0]!.unitCostBase, '2.500000')
  assert.equal(f.movements[0]!.totalValueBase, '7.500000')
  const lines = (enqueued[0]!.payload as { lines: Array<{ debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => l.debit ?? l.credit), [7.5, 7.5])
})

test('ON: with no costed layer in this warehouse it falls back to any warehouse; with none anywhere it is refused', async () => {
  reset()
  const f = fakeTx({ switchOn: true, reason: mapped, latestInWarehouse: null, latestAnywhere: '9.000000' })
  await (await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 1, reasonId: 'r' })
  assert.equal(String(layersCreated[0]!.unitCostBase), '9')
  reset()
  const g = fakeTx({ switchOn: true, reason: mapped, latestInWarehouse: null, latestAnywhere: null })
  await assert.rejects((await loadApply())({ tx: g.tx, productId: 'p', warehouseId: 'w', qty: 1, reasonId: 'r' }), /Enter a unit cost for this addition of SKU1/)
  assert.deepEqual(g.writes, [])
})

test('ON: an entered cost is used as entered, exact to 6dp', async () => {
  reset()
  const f = fakeTx({ switchOn: true, reason: mapped, latestInWarehouse: '2.500000' })
  await (await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 3, unitCostBase: 0.1, reasonId: 'r' })
  assert.equal(f.movements[0]!.totalValueBase, '0.300000', '3 x 0.1 is 0.3 exactly, not 0.30000000000000004')
  const lines = (enqueued[0]!.payload as { lines: Array<{ debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => l.debit ?? l.credit), [0.3, 0.3])
})

test('OFF: the same inputs behave as before — no reason is accepted and owed, a blank addition takes the average', async () => {
  reset()
  const f = fakeTx({ switchOn: false, reason: null, latestInWarehouse: '2.500000' })
  await (await loadApply())({ tx: f.tx, productId: 'p', warehouseId: 'w', qty: 3 })
  assert.equal(layersCreated[0]!.unitCostBase, 4, 'the average, as before')
  assert.equal(reports.length, 1, 'the unmapped adjustment is owed to the exception inbox, as before')
  reset()
  const g = fakeTx({ switchOn: false, reason: unmapped })
  await (await loadApply())({ tx: g.tx, productId: 'p', warehouseId: 'w', qty: 5, unitCostBase: 2, reasonId: 'r' })
  assert.equal(reports.length, 1)
  assert.equal(enqueued.length, 0)
})
