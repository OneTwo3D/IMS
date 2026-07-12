import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LandedCostMethod } from '@/app/generated/prisma/client'
import {
  aggregateCogsRows,
  aggregateInventoryTurnoverRows,
  aggregateLandedCostMethods,
  assertInventoryTurnoverSourceLimit,
  getInventoryTurnoverReport,
  inventoryCostingFiltersFromSearch,
  InventoryTurnoverSourceLimitError,
  type CogsAggregationInput,
  type InventoryTurnoverCogsAggregationInput,
  type InventoryTurnoverSnapshotAggregationInput,
  type LandedCostAggregationInput,
} from '@/lib/domain/inventory/inventory-costing-reports'

const turnoverWarehouse = { id: 'warehouse-a', code: 'WHA', name: 'Warehouse A' }

function turnoverProduct(overrides: Partial<{
  id: string
  sku: string
  name: string
  categoryName: string | null
  suppliers: Array<{ id: string; name: string }>
}> = {}) {
  return {
    id: overrides.id ?? 'product-a',
    sku: overrides.sku ?? 'A-001',
    name: overrides.name ?? 'Widget A',
    stockUnit: 'pcs',
    category: overrides.categoryName === undefined ? { name: 'Widgets' } : overrides.categoryName == null ? null : { name: overrides.categoryName },
    supplierProducts: (overrides.suppliers ?? [{ id: 'supplier-a', name: 'Supplier A' }])
      .map((supplier) => ({ supplier })),
  }
}

function turnoverCogsRow(overrides: Partial<{
  id: string
  totalCostBase: string
  product: ReturnType<typeof turnoverProduct>
}> = {}) {
  return {
    id: overrides.id ?? 'cogs-1',
    qty: '1',
    totalCostBase: overrides.totalCostBase ?? '90',
    createdAt: new Date('2026-05-01T12:00:00.000Z'),
    movement: {
      id: `movement-${overrides.id ?? '1'}`,
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      fromWarehouseId: turnoverWarehouse.id,
      toWarehouseId: null,
      product: overrides.product ?? turnoverProduct(),
      fromWarehouse: turnoverWarehouse,
      toWarehouse: null,
    },
  }
}

function turnoverSnapshotRow(overrides: Partial<{
  id: string
  snapshotDate: string
  valueBase: string
  product: ReturnType<typeof turnoverProduct>
}> = {}) {
  const product = overrides.product ?? turnoverProduct()
  return {
    id: overrides.id ?? 'snapshot-1',
    snapshotDate: new Date(`${overrides.snapshotDate ?? '2026-05-01'}T00:00:00.000Z`),
    productId: product.id,
    warehouseId: turnoverWarehouse.id,
    valueBase: overrides.valueBase ?? '90',
    product,
    warehouse: turnoverWarehouse,
  }
}

function turnoverClient(cogsRows: unknown[], snapshotRows: unknown[]) {
  return {
    cogsEntry: { findMany: async () => cogsRows },
    inventorySnapshot: { findMany: async () => snapshotRows },
  } as never
}

describe('inventory costing report aggregations', () => {
  it('aggregates COGS by product without recalculating cost from movement quantities', () => {
    const rows: CogsAggregationInput[] = [
      {
        id: 'movement-1',
        qty: '1.0000',
        cogsBase: '2.500000',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        customerName: 'Customer One',
        channel: 'woocommerce',
        revenueKey: 'order-1:product-a',
        revenueBase: '10.000000',
      },
      {
        id: 'movement-2',
        qty: '2.0000',
        cogsBase: '5.250000',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        customerName: 'Customer One',
        channel: 'woocommerce',
        revenueKey: 'order-2:product-a',
        revenueBase: '20.000000',
      },
    ]

    const [row] = aggregateCogsRows(rows, 'product')

    assert.equal(row?.groupKey, 'product-a')
    assert.equal(row?.qty, '3')
    assert.equal(row?.cogsBase, '7.750000')
    assert.equal(row?.revenueBase, '30.000000')
    assert.equal(row?.grossMarginBase, '22.250000')
    assert.equal(row?.grossMarginPct, '74.17')
    assert.equal(row?.revenueCaptured, true)
  })

  it('does not mark repeated matched revenue keys as uncaptured for multi-shipment orders', () => {
    const rows: CogsAggregationInput[] = [
      {
        id: 'movement-1',
        qty: '1',
        cogsBase: '3',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: 'Customer One',
        channel: 'woocommerce',
        revenueKey: 'order-1:product-a',
        revenueBase: '10',
      },
      {
        id: 'movement-2',
        qty: '1',
        cogsBase: '4',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: 'Customer One',
        channel: 'woocommerce',
        revenueKey: 'order-1:product-a',
        revenueBase: '10',
      },
    ]

    const [row] = aggregateCogsRows(rows, 'product')

    assert.equal(row?.cogsBase, '7.000000')
    assert.equal(row?.revenueBase, '10.000000')
    assert.equal(row?.grossMarginBase, '3.000000')
    assert.equal(row?.revenueCaptured, true)
  })

  it('sorts COGS groups numerically rather than lexicographically', () => {
    const rows: CogsAggregationInput[] = [
      {
        id: 'movement-small',
        qty: '1',
        cogsBase: '900',
        productId: 'product-small',
        sku: 'S',
        productName: 'Small',
        categoryName: null,
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: null,
        channel: null,
        revenueBase: null,
      },
      {
        id: 'movement-large',
        qty: '1',
        cogsBase: '1000',
        productId: 'product-large',
        sku: 'L',
        productName: 'Large',
        categoryName: null,
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: null,
        channel: null,
        revenueBase: null,
      },
    ]

    const [first] = aggregateCogsRows(rows, 'product')

    assert.equal(first?.productId, 'product-large')
  })

  it('marks grouped COGS revenue as uncaptured when any member cannot be matched', () => {
    const rows: CogsAggregationInput[] = [
      {
        id: 'movement-1',
        qty: '1',
        cogsBase: '3',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: null,
        channel: null,
        revenueBase: '10',
      },
      {
        id: 'movement-2',
        qty: '1',
        cogsBase: '4',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        customerName: null,
        channel: null,
        revenueBase: null,
      },
    ]

    const [row] = aggregateCogsRows(rows, 'product')

    assert.equal(row?.cogsBase, '7.000000')
    assert.equal(row?.revenueBase, null)
    assert.equal(row?.grossMarginBase, null)
    assert.equal(row?.revenueCaptured, false)
  })

  it('summarises landed-cost uplift by allocation method', () => {
    const rows: LandedCostAggregationInput[] = [
      { method: LandedCostMethod.BY_VALUE, qty: '5', goodsValueBase: '100', landedValueBase: '115' },
      { method: LandedCostMethod.BY_VALUE, qty: '2', goodsValueBase: '20', landedValueBase: '26' },
      { method: LandedCostMethod.EQUAL_SPLIT, qty: '1', goodsValueBase: '10', landedValueBase: '11.5' },
    ]

    const summary = aggregateLandedCostMethods(rows)

    assert.deepEqual(summary, [
      {
        method: LandedCostMethod.BY_VALUE,
        poLineCount: 2,
        goodsValueBase: '120.000000',
        landedValueBase: '141.000000',
        upliftBase: '21.000000',
      },
      {
        method: LandedCostMethod.EQUAL_SPLIT,
        poLineCount: 1,
        goodsValueBase: '10.000000',
        landedValueBase: '11.500000',
        upliftBase: '1.500000',
      },
    ])
  })

  it('normalises invalid filter enum values', () => {
    const filters = inventoryCostingFiltersFromSearch({
      groupBy: 'unknown',
      landedCostMethod: 'BAD',
      page: '2',
      pageSize: '250',
    })

    assert.equal(filters.groupBy, undefined)
    assert.equal(filters.landedCostMethod, undefined)
    assert.equal(filters.page, 2)
    assert.equal(filters.pageSize, 250)
  })

  it('accepts supplier grouping for inventory turnover filters', () => {
    const filters = inventoryCostingFiltersFromSearch({ groupBy: 'supplier' })

    assert.equal(filters.groupBy, 'supplier')
  })

  it('drops invalid date filter values instead of preserving misleading UI state', () => {
    const filters = inventoryCostingFiltersFromSearch({
      asOf: '2026-13-99',
      dateFrom: 'not-a-date',
      dateTo: '2026-02-29',
    })

    assert.equal(filters.asOf, undefined)
    assert.equal(filters.dateFrom, undefined)
    assert.equal(filters.dateTo, undefined)
  })

  it('calculates inventory turnover from sales COGS and average daily snapshot value', () => {
    const cogsRows: InventoryTurnoverCogsAggregationInput[] = [
      {
        id: 'cogs-1',
        cogsBase: '300',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        suppliers: [{ id: 'supplier-a', name: 'Supplier A' }],
      },
    ]
    const snapshotRows: InventoryTurnoverSnapshotAggregationInput[] = [
      {
        id: 'snapshot-1',
        snapshotDate: '2026-05-01',
        inventoryValueBase: '100',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        suppliers: [{ id: 'supplier-a', name: 'Supplier A' }],
      },
      {
        id: 'snapshot-2',
        snapshotDate: '2026-05-02',
        inventoryValueBase: '100',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        suppliers: [{ id: 'supplier-a', name: 'Supplier A' }],
      },
      {
        id: 'snapshot-3',
        snapshotDate: '2026-05-03',
        inventoryValueBase: '100',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: 'Widgets',
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        suppliers: [{ id: 'supplier-a', name: 'Supplier A' }],
      },
    ]

    const [row] = aggregateInventoryTurnoverRows(cogsRows, snapshotRows, 'product', 3)

    assert.equal(row?.groupKey, 'product-a')
    assert.equal(row?.cogsBase, '300.000000')
    assert.equal(row?.averageInventoryValueBase, '100.000000')
    assert.equal(row?.turnoverRatio, '3')
    assert.equal(row?.daysInventoryOutstanding, '1')
    assert.equal(row?.snapshotDayCount, 3)
  })

  it('uses observed inventory snapshot days for turnover averages', () => {
    const cogsRows: InventoryTurnoverCogsAggregationInput[] = [
      {
        id: 'cogs-1',
        cogsBase: '100',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: null,
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        suppliers: [],
      },
    ]
    const snapshotRows: InventoryTurnoverSnapshotAggregationInput[] = [
      {
        id: 'snapshot-1',
        snapshotDate: '2026-05-01',
        inventoryValueBase: '100',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: null,
        warehouseId: 'warehouse-a',
        warehouseCode: 'WHA',
        warehouseName: 'Warehouse A',
        suppliers: [],
      },
    ]

    const [row] = aggregateInventoryTurnoverRows(cogsRows, snapshotRows, 'product', 2)

    assert.equal(row?.averageInventoryValueBase, '100.000000')
    assert.equal(row?.turnoverRatio, '1')
    assert.equal(row?.daysInventoryOutstanding, '2')
    assert.equal(row?.snapshotDayCount, 1)
  })

  it('returns blank turnover ratios when average inventory value is zero', () => {
    const cogsRows: InventoryTurnoverCogsAggregationInput[] = [
      {
        id: 'cogs-1',
        cogsBase: '25',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: null,
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        suppliers: [],
      },
    ]

    const [row] = aggregateInventoryTurnoverRows(cogsRows, [], 'product', 7)

    assert.equal(row?.averageInventoryValueBase, '0.000000')
    assert.equal(row?.turnoverRatio, null)
    assert.equal(row?.daysInventoryOutstanding, null)
  })

  it('splits inventory turnover rows across linked suppliers when grouped by supplier', () => {
    const cogsRows: InventoryTurnoverCogsAggregationInput[] = [
      {
        id: 'cogs-1',
        cogsBase: '20',
        productId: 'product-a',
        sku: 'A-001',
        productName: 'Widget A',
        categoryName: null,
        warehouseId: null,
        warehouseCode: null,
        warehouseName: null,
        suppliers: [
          { id: 'supplier-a', name: 'Supplier A' },
          { id: 'supplier-b', name: 'Supplier B' },
        ],
      },
    ]

    const rows = aggregateInventoryTurnoverRows(cogsRows, [], 'supplier', 30)

    assert.deepEqual(rows.map((row) => [row.groupKey, row.groupLabel, row.cogsBase]), [
      ['supplier-a', 'Supplier A', '10.000000'],
      ['supplier-b', 'Supplier B', '10.000000'],
    ])
  })

  it('rejects inventory turnover source scans over the configured cap', () => {
    assert.doesNotThrow(() => assertInventoryTurnoverSourceLimit(100000, 100000, 'COGS'))
    assert.throws(
      () => assertInventoryTurnoverSourceLimit(100001, 100000, 'snapshot'),
      InventoryTurnoverSourceLimitError,
    )
  })

  it('inventory turnover report splits multi-supplier values without inflating totals', async () => {
    const product = turnoverProduct({
      suppliers: [
        { id: 'supplier-a', name: 'Supplier A' },
        { id: 'supplier-b', name: 'Supplier B' },
        { id: 'supplier-c', name: 'Supplier C' },
      ],
    })
    const report = await getInventoryTurnoverReport(
      { dateFrom: '2026-05-01', dateTo: '2026-05-01', groupBy: 'supplier' },
      {
        paginate: false,
        client: turnoverClient(
          [turnoverCogsRow({ totalCostBase: '90', product })],
          [turnoverSnapshotRow({ valueBase: '90', product })],
        ),
      },
    )

    assert.equal(report.totals.cogsBase, '90.000000')
    assert.equal(report.totals.averageInventoryValueBase, '90.000000')
    assert.deepEqual(report.rows.map((row) => [row.groupLabel, row.cogsBase, row.averageInventoryValueBase]), [
      ['Supplier A', '30.000000', '30.000000'],
      ['Supplier B', '30.000000', '30.000000'],
      ['Supplier C', '30.000000', '30.000000'],
    ])
    assert.match(report.notices.join('\n'), /splits multi-supplier SKU/)
  })

  it('inventory turnover report averages over observed snapshot days', async () => {
    const report = await getInventoryTurnoverReport(
      { dateFrom: '2026-05-01', dateTo: '2026-07-29', groupBy: 'product' },
      {
        paginate: false,
        client: turnoverClient(
          [turnoverCogsRow({ totalCostBase: '90' })],
          Array.from({ length: 30 }, (_, index) => turnoverSnapshotRow({
            id: `snapshot-${index}`,
            snapshotDate: `2026-05-${String(index + 1).padStart(2, '0')}`,
            valueBase: '90',
          })),
        ),
      },
    )

    assert.equal(report.periodDays, 90)
    assert.equal(report.rows[0]?.averageInventoryValueBase, '90.000000')
    assert.equal(report.rows[0]?.snapshotDayCount, 30)
    assert.equal(report.rows[0]?.turnoverRatio, '1')
    assert.equal(report.rows[0]?.daysInventoryOutstanding, '90')
  })

  it('inventory turnover report falls back invalid turnover-only group values to product', async () => {
    const report = await getInventoryTurnoverReport(
      { dateFrom: '2026-05-01', dateTo: '2026-05-01', groupBy: 'customer' },
      {
        paginate: false,
        client: turnoverClient(
          [turnoverCogsRow()],
          [turnoverSnapshotRow()],
        ),
      },
    )

    assert.equal(report.groupBy, 'product')
    assert.equal(report.rows[0]?.groupKey, 'product-a')
  })

  it('inventory turnover report surfaces no-source notices and inclusive period days', async () => {
    const oneDay = await getInventoryTurnoverReport(
      { dateFrom: '2026-05-01', dateTo: '2026-05-01' },
      { paginate: false, client: turnoverClient([], []) },
    )
    const thirtyOneDays = await getInventoryTurnoverReport(
      { dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      { paginate: false, client: turnoverClient([], []) },
    )

    assert.equal(oneDay.periodDays, 1)
    assert.equal(thirtyOneDays.periodDays, 31)
    assert.match(oneDay.notices.join('\n'), /No sales-dispatch COGS/)
    assert.match(oneDay.notices.join('\n'), /No inventory snapshots/)
  })

  it('inventory turnover report excludes supplierless rows from supplier grouping with a notice', async () => {
    const product = turnoverProduct({ suppliers: [] })
    const report = await getInventoryTurnoverReport(
      { dateFrom: '2026-05-01', dateTo: '2026-05-01', groupBy: 'supplier' },
      {
        paginate: false,
        client: turnoverClient(
          [turnoverCogsRow({ totalCostBase: '40', product })],
          [turnoverSnapshotRow({ valueBase: '80', product })],
        ),
      },
    )

    assert.equal(report.rows.length, 0)
    assert.equal(report.totals.cogsBase, '0.000000')
    assert.match(report.notices.join('\n'), /excluded from supplier grouping/)
  })
})
