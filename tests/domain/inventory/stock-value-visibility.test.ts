import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { canViewStockValue } from '@/lib/security/stock-position-policy'
import { getStockOnHandReport, type StockPositionReportClient } from '@/lib/domain/inventory/stock-position-reports'
import {
  getDeadStockReport,
  getInventoryAgingReport,
  type InventoryHealthReportClient,
} from '@/lib/domain/inventory/inventory-health-reports'
import {
  getStockAdjustmentReport,
  getStockCountReport,
  getStockMovementLedgerReport,
  getStockTransferReport,
} from '@/lib/domain/inventory/inventory-ledger-reports'

type InventoryLedgerReportClient = NonNullable<NonNullable<Parameters<typeof getStockMovementLedgerReport>[1]>['client']>

const decimal = (value: string | number) => new Prisma.Decimal(value)

const NO_VALUE_ROLES = ['WAREHOUSE', 'READONLY']
const VALUE_ROLES = ['ADMIN', 'MANAGER', 'FINANCE']

// Every key at any depth, so a value field cannot hide inside a summary or total.
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, out))
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key)
      allKeys(inner, out)
    }
  }
  return out
}
const VALUE_KEY = /value|unitcost/i
// Reliability flags and counts about the value replay carry no money amount.
const NOT_MONEY = new Set(['valueReplayReliable', 'missingValueMovementCount', 'currentValueDriftCount'])
function valueKeys(report: unknown): string[] {
  return [...allKeys(report)].filter((key) => VALUE_KEY.test(key) && !NOT_MONEY.has(key))
}

test('only inventory.prices roles may view stock value', () => {
  for (const role of NO_VALUE_ROLES) assert.equal(canViewStockValue(role), false, role)
  for (const role of VALUE_ROLES) assert.equal(canViewStockValue(role), true, role)
  assert.equal(canViewStockValue('SUPPLIER'), false)
})

// ---- Stock on Hand ----
const sohProduct = { id: 'product-1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs', category: { name: 'Finished goods' }, supplierProducts: [] }
const warehouse = { id: 'warehouse-1', code: 'WH1', name: 'Main warehouse' }

async function stockOnHand(includeCost: boolean | undefined) {
  const unused = { findMany: async () => [] }
  const client = {
    warehouse: { findMany: async () => [warehouse] },
    productCategory: unused,
    supplier: unused,
    product: { findMany: async () => [sohProduct, { ...sohProduct, id: 'product-2', sku: 'SKU-2' }] },
    stockLevel: { findMany: async () => [] },
    inventoryReservationSnapshot: unused,
    inventoryReservationSnapshotRun: { findUnique: async () => null },
    stockMovement: unused,
  } as unknown as StockPositionReportClient
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T22:59:59.999Z', generatedAt: '2026-06-02T10:00:00.000Z', anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
      { productId: 'product-2', warehouseId: 'warehouse-1', qty: '5', valueBase: '15', unitCostBase: '3' },
    ],
    missingValueMovementCount: 0, orphanWarehouseMovementCount: 0, missingValueMovementSample: [],
    valueReplayReliable: true, currentValueDriftCount: 0, postAsOfRevaluationCount: 0, staleSnapshotCount: 0,
  })
  return getStockOnHandReport({ includeCost }, { deps: { client, getOnHandAsOf } })
}

test('stock on hand carries no value fields for roles without inventory.prices, but still the quantities', async () => {
  for (const includeCost of [false, undefined]) {
    const report = await stockOnHand(includeCost)
    assert.deepEqual(valueKeys(report), [], `includeCost=${String(includeCost)}`)
    assert.equal(report.totals.quantity, '15')
    assert.equal(report.rows.length, 2)
    assert.ok(!JSON.stringify(report).includes('"25"') && !JSON.stringify(report).includes('2.5'))
  }
})

test('stock on hand keeps unit cost and value for an inventory.prices caller', async () => {
  const report = await stockOnHand(true)
  assert.equal(report.totals.totalValueBase, '40')
  assert.deepEqual(report.rows.map((row) => [row.unitCostBase, row.totalValueBase]), [['2.5', '25'], ['3', '15']])
})

// ---- Inventory Aging + Dead Stock ----
function item(id: string, sku: string) {
  return { id, sku, name: sku, type: ProductType.SIMPLE, stockUnit: 'pcs', category: { name: 'Goods' }, supplierProducts: [] }
}
function healthClient(): InventoryHealthReportClient {
  const unused = { findMany: async () => [] }
  const levels = [
    { productId: 'cheap', warehouseId: 'warehouse-1', quantity: decimal('4'), product: item('cheap', 'A-CHEAP'), warehouse },
    { productId: 'dear', warehouseId: 'warehouse-1', quantity: decimal('4'), product: item('dear', 'B-DEAR'), warehouse },
  ]
  const layers = [
    { id: 'l1', productId: 'cheap', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('1'), receivedAt: new Date('2026-01-01T00:00:00.000Z'), product: item('cheap', 'A-CHEAP'), warehouse },
    { id: 'l2', productId: 'dear', warehouseId: 'warehouse-1', remainingQty: decimal('4'), unitCostBase: decimal('50'), receivedAt: new Date('2026-01-01T00:00:00.000Z'), product: item('dear', 'B-DEAR'), warehouse },
  ]
  return { stockLevel: { findMany: async () => levels }, stockMovement: unused, costLayer: { findMany: async () => layers }, cogsEntry: unused }
}
const healthDeps = () => ({ client: healthClient(), now: () => new Date('2026-06-02T00:00:00.000Z') })

test('inventory aging carries no value fields for roles without inventory.prices', async () => {
  for (const includeCost of [false, undefined]) {
    const report = await getInventoryAgingReport({ asOf: '2026-06-01', includeCost }, { paginate: false, deps: healthDeps() })
    assert.deepEqual(valueKeys(report), [], `includeCost=${String(includeCost)}`)
    assert.equal(report.totals.qty, '8')
    assert.ok(!report.notices.some((notice) => /value/i.test(notice)))
  }
  const paged = await getInventoryAgingReport({ asOf: '2026-06-01', includeCost: false }, { deps: healthDeps() })
  assert.deepEqual(valueKeys(paged), [])
})

test('inventory aging keeps value for an inventory.prices caller', async () => {
  const report = await getInventoryAgingReport({ asOf: '2026-06-01', includeCost: true }, { paginate: false, deps: healthDeps() })
  assert.equal(report.totals.valueBase, '204')
  assert.deepEqual(report.rows.map((row) => row.valueBase), ['4', '200'])
  assert.ok(report.bucketSummary.every((bucket) => bucket.valueBase != null))
})

test('dead stock carries no value fields for roles without inventory.prices and is not ordered by value', async () => {
  for (const includeCost of [false, undefined]) {
    const report = await getDeadStockReport({ asOf: '2026-06-01', thresholdDays: 90, includeCost }, { paginate: false, deps: healthDeps() })
    assert.deepEqual(valueKeys(report), [], `includeCost=${String(includeCost)}`)
    assert.equal(report.totals.qty, '8')
    // value order would put B-DEAR (200) before A-CHEAP (4); without the permission the order is by SKU.
    assert.deepEqual(report.rows.map((row) => row.sku), ['A-CHEAP', 'B-DEAR'])
  }
})

test('dead stock keeps value, ordered by value, for an inventory.prices caller', async () => {
  const report = await getDeadStockReport({ asOf: '2026-06-01', thresholdDays: 90, includeCost: true }, { paginate: false, deps: healthDeps() })
  assert.deepEqual(report.rows.map((row) => [row.sku, row.valueBase]), [['B-DEAR', '200'], ['A-CHEAP', '4']])
  assert.equal(report.totals.valueBase, '204')
})

// ---- Ledger reports (movements, adjustments, transfers, counts) ----
const movement = {
  id: 'm1', type: 'ADJUSTMENT', productId: 'p1', fromWarehouseId: 'warehouse-1', toWarehouseId: null,
  product: { sku: 'SKU-1', name: 'Widget', stockUnit: 'pcs' }, fromWarehouse: { code: 'WH1', name: 'Main' }, toWarehouse: null,
  qty: decimal('2'), unitCostBase: decimal('7'), totalValueBase: decimal('14'), referenceType: null, referenceId: null,
  note: 'Damaged', createdAt: new Date('2026-06-01T10:00:00.000Z'),
}

function ledgerClient(): InventoryLedgerReportClient {
  const transfer = {
    id: 't1', reference: 'TR-1', status: 'COMPLETED', fromWarehouse: { code: 'WH1', name: 'Main' }, toWarehouse: { code: 'WH2', name: 'Other' },
    dispatchedAt: new Date('2026-06-01T10:00:00.000Z'), completedAt: new Date('2026-06-02T10:00:00.000Z'), createdAt: new Date('2026-06-01T09:00:00.000Z'),
    lines: [{ id: 'tl1', qty: decimal('2'), qtyReceived: decimal('2'), sku: 'SKU-1', productName: 'Widget' }],
  }
  const countLine = {
    id: 'cl1', countId: 'c1', sku: 'SKU-1', productId: 'p1', expectedQty: decimal('5'), countedQty: decimal('3'), variance: decimal('-2'),
    count: { id: 'c1', reference: 'SC-1', status: 'COMPLETED', warehouse: { code: 'WH1', name: 'Main' }, completedAt: new Date('2026-06-02T10:00:00.000Z'), createdAt: new Date('2026-06-01T10:00:00.000Z') },
  }
  return {
    stockMovement: {
      count: async () => 1,
      findMany: async () => [movement],
      aggregate: async () => ({ _sum: { qty: decimal('2'), totalValueBase: decimal('14') } }),
      groupBy: async (args: { by: string[] }) => args.by[0] === 'productId'
        ? [{ productId: 'p1', _count: { _all: 1 }, _sum: { qty: decimal('2'), totalValueBase: decimal('14') } }]
        : [{ note: 'Damaged', _count: { _all: 1 }, _sum: { qty: decimal('2'), totalValueBase: decimal('14') } }],
    },
    product: { findMany: async () => [{ id: 'p1', sku: 'SKU-1', name: 'Widget' }] },
    adjustmentReason: { findMany: async () => [{ name: 'Damaged' }] },
    stockTransfer: { count: async () => 1, findMany: async () => [transfer] },
    stockTransferLine: { findMany: async () => [{ id: 'tl1', qty: decimal('2'), qtyReceived: decimal('2') }] },
    wmsAsnLineMap: { findMany: async () => [] },
    stockCountLine: {
      count: async () => 1,
      findMany: async () => [countLine],
      aggregate: async () => ({ _sum: { expectedQty: decimal('5'), countedQty: decimal('3'), variance: decimal('-2') } }),
      groupBy: async () => [],
    },
  } as unknown as InventoryLedgerReportClient
}

test('stock movement ledger carries no value fields (and ignores minValue) without inventory.prices', async () => {
  const report = await getStockMovementLedgerReport({ includeCost: false, minValue: '1' }, { client: ledgerClient() })
  assert.deepEqual(valueKeys(report), [])
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]!.signedQty, '-2')
})

test('stock movement ledger keeps value for an inventory.prices caller', async () => {
  const report = await getStockMovementLedgerReport({ includeCost: true }, { client: ledgerClient() })
  assert.equal(report.rows[0]!.totalValueBase, '14')
  assert.equal(report.rows[0]!.unitCostBase, '7')
  assert.ok(report.totals.closingValueBase != null)
})

test('stock adjustment report carries no value fields without inventory.prices and keeps them with it', async () => {
  const hidden = await getStockAdjustmentReport({ includeCost: false }, { client: ledgerClient() })
  assert.deepEqual(valueKeys(hidden), [])
  assert.equal(hidden.reasonSummary[0]!.count, 1)
  const shown = await getStockAdjustmentReport({ includeCost: true }, { client: ledgerClient() })
  assert.equal(shown.reasonSummary[0]!.valueBase, '14')
  assert.equal(shown.skuSummary[0]!.valueBase, '14')
  assert.equal(shown.rows[0]!.totalValueBase, '14')
})

test('stock transfer report carries no value fields without inventory.prices', async () => {
  const hidden = await getStockTransferReport({ includeCost: false }, { client: ledgerClient() })
  assert.deepEqual(valueKeys(hidden), [])
  assert.equal(hidden.rows.length, 1)
  const shown = await getStockTransferReport({ includeCost: true }, { client: ledgerClient() })
  assert.ok(shown.totals.movementValueBase != null)
  assert.ok(shown.rows[0]!.movementValueBase != null)
})

test('stock count report carries no value fields without inventory.prices', async () => {
  const hidden = await getStockCountReport({ includeCost: false }, { client: ledgerClient() })
  assert.deepEqual(valueKeys(hidden), [])
  assert.equal(hidden.rows.length, 1)
  const shown = await getStockCountReport({ includeCost: true }, { client: ledgerClient() })
  assert.ok(shown.totals.linkedAdjustmentValueBase != null)
})
