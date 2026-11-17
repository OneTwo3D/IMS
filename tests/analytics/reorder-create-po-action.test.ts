import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * createReorderPOs: destination from the filter, per-line dates + header rule, supplier override grouping, dedup
 * scoped by destination, and reorderEvidence. The report, DB, auth and logging are doubles; the pure planning
 * helpers are real.
 */

type Row = Record<string, unknown>
type PoData = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const state = {
  rows: [] as Row[],
  findManyWhere: [] as Array<Record<string, unknown>>,
  recent: [] as Array<{ supplierId: string }>,
  created: [] as Array<{ data: PoData }>,
  reportFilters: [] as unknown[],
}

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/purchasing/purchase-order-fx', { namedExports: { resolvePurchaseOrderFxRateToBase: async () => 1 } })
mock.module('@/lib/domain/inventory/replenishment-reports', {
  namedExports: {
    getReorderReport: async (filters: unknown) => { state.reportFilters.push(filters); return { rows: state.rows } },
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      purchaseOrder: {
        findMany: async (args: { where: Record<string, unknown> }) => { state.findManyWhere.push(args.where); return state.recent },
        create: async (args: { data: PoData }) => { state.created.push(args) },
      },
      supplier: { findUnique: async () => ({ currency: 'GBP' }) },
      supplierProduct: { findMany: async () => [] },
    },
  },
})

const opt = (supplierId: string) => ({ supplierId, supplierName: supplierId, supplierSku: null })
function row(productId: string, over: Row = {}): Row {
  return {
    productId, sku: productId, productType: 'SIMPLE', supplierId: 'sup-a', supplierOptions: [opt('sup-a'), opt('sup-b')],
    suggestedReorderQty: '5', leadTimeDays: 10, requiredReceiptDate: null, latestPoDate: null, latestPoOverdue: false,
    timingBasis: 'no_demand', averageDailyDemand: '0', abcClass: 'C', availableQty: '0', inboundOpenPoQty: '0',
    reorderPoint: '10', safetyStockQty: '0', urgency: 'reorder', ...over,
  }
}

beforeEach(() => {
  state.rows = []
  state.findManyWhere.length = 0
  state.recent = []
  state.created.length = 0
  state.reportFilters.length = 0
})

function day(offset: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return new Date(d.getTime() + offset * 86400000).toISOString().slice(0, 10)
}

test('the draft PO gets its destination from the warehouse filter', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1')]
  const result = await createReorderPOs(['p1'], { filters: { warehouseId: 'wh-1' } })
  assert.equal(result.success, true)
  assert.equal(state.created[0].data.destinationWarehouseId, 'wh-1')
  assert.equal(state.created[0].data.lines.create[0].reorderEvidence.destinationWarehouseId, 'wh-1')
})

test('unfiltered: no destination (null), never a first-warehouse fallback', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1')]
  await createReorderPOs(['p1'], { filters: {} })
  assert.equal(state.created[0].data.destinationWarehouseId, null)
})

test('dedup is scoped to the destination warehouse, so two warehouses get two POs', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1')]
  await createReorderPOs(['p1'], { filters: { warehouseId: 'wh-2' } })
  assert.equal(state.findManyWhere[0].destinationWarehouseId, 'wh-2')
  assert.equal(state.findManyWhere[0].status, 'DRAFT')
  await createReorderPOs(['p1'], {})
  assert.equal(state.findManyWhere[1].destinationWarehouseId, null)
})

test('a recent draft for the same supplier and destination is still skipped as a duplicate', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1')]
  state.recent = [{ supplierId: 'sup-a' }]
  const result = await createReorderPOs(['p1'], { filters: { warehouseId: 'wh-1' } })
  assert.equal(result.poCount, 0)
  assert.equal(result.skippedSupplierCount, 1)
  assert.equal(state.created.length, 0)
})

test('line dates come from requiredReceiptDate (clamped to today + lead time), undated rows take the lead-time floor; header is the earliest line date', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [
    row('far', { requiredReceiptDate: day(60), leadTimeDays: 10, timingBasis: 'projected', latestPoDate: day(50) }),
    row('overdue', { requiredReceiptDate: day(-5), leadTimeDays: 14, timingBasis: 'already_below', latestPoDate: day(-19), latestPoOverdue: true }),
    row('none'),
  ]
  await createReorderPOs(['far', 'overdue', 'none'], {})
  const data = state.created[0].data
  const [far, overdue, none] = data.lines.create
  assert.equal(far.expectedDelivery.toISOString().slice(0, 10), day(60))
  assert.equal(overdue.expectedDelivery.toISOString().slice(0, 10), day(14))
  assert.equal(none.expectedDelivery.toISOString().slice(0, 10), day(10), 'undated row: today + its own lead time')
  assert.equal(none.reorderEvidence.expectedDeliveryBasis, 'lead_time_floor')
  assert.equal(far.reorderEvidence.expectedDeliveryBasis, 'required_receipt')
  assert.equal(data.expectedDelivery.toISOString().slice(0, 10), day(10))
  assert.equal(overdue.reorderEvidence.expectedDeliveryClamped, true)
  assert.equal(overdue.reorderEvidence.requiredReceiptDate, day(-5))
  assert.equal(overdue.reorderEvidence.earliestPossibleDate, day(14))
  assert.equal(overdue.reorderEvidence.latestPoOverdue, true)
  assert.equal(far.reorderEvidence.expectedDeliveryClamped, false)
  assert.equal(far.reorderEvidence.timingBasis, 'projected')
})

test('every line is dated, so none inherits the header date; an unusable lead time nulls line and header', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1'), row('p2')]
  await createReorderPOs(['p1', 'p2'], {})
  const first = state.created[0].data
  assert.ok(first.lines.create.every((l: Row) => l.expectedDelivery instanceof Date))
  state.rows = [row('p1', { requiredReceiptDate: day(30) }), row('bad', { leadTimeDays: Number.NaN })]
  await createReorderPOs(['p1', 'bad'], {})
  const second = state.created[1].data
  assert.equal(second.lines.create[1].expectedDelivery, null)
  assert.equal(second.lines.create[1].reorderEvidence.expectedDeliveryBasis, 'none')
  assert.equal(second.expectedDelivery, null, 'header null when any line is undated')
})

test('a supplier override moves the line to the chosen supplier draft and is stamped in the evidence', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1'), row('p2')]
  const result = await createReorderPOs(['p1', 'p2'], { supplierOverrides: { p1: 'sup-b', ghost: 'sup-b' } })
  assert.equal(result.poCount, 2)
  const bySupplier = new Map(state.created.map((c) => [c.data.supplierId, c.data]))
  const b = bySupplier.get('sup-b')!.lines.create[0]
  assert.equal(b.productId, 'p1')
  assert.equal(b.reorderEvidence.supplierOverridden, true)
  assert.equal(b.reorderEvidence.defaultSupplierId, 'sup-a')
  assert.equal(b.reorderEvidence.supplierId, 'sup-b')
  const a = bySupplier.get('sup-a')!.lines.create[0]
  assert.equal(a.productId, 'p2')
  assert.equal(a.reorderEvidence.supplierOverridden, false)
})

test('an override outside the catalog is reported, not silently defaulted', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1')]
  const result = await createReorderPOs(['p1'], { supplierOverrides: { p1: 'sup-nope' } })
  assert.equal(result.poCount, 0)
  assert.deepEqual(result.skippedProducts, [{ productId: 'p1', sku: 'p1', reason: 'supplier_override_not_in_catalog' }])
  assert.equal(state.created.length, 0)
})

test('reorderEvidence keeps its existing keys', async () => {
  const { createReorderPOs } = await import('@/app/actions/forecasting')
  state.rows = [row('p1')]
  await createReorderPOs(['p1'], { filters: { warehouseId: 'wh-1' } })
  const ev = state.created[0].data.lines.create[0].reorderEvidence
  for (const key of ['source', 'generatedAt', 'filters', 'supplierId', 'productId', 'sku', 'averageDailyDemand', 'abcClass', 'availableQty', 'inboundOpenPoQty', 'leadTimeDays', 'reorderPoint', 'safetyStockQty', 'suggestedReorderQty', 'urgency']) {
    assert.ok(key in ev, `evidence still has ${key}`)
  }
  assert.equal(ev.source, 'reorder_planning')
})
