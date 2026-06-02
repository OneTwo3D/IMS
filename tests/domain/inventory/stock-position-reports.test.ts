import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  getNegativeStockReport,
  getStockAllocationReport,
  getStockOnHandReport,
  type StockPositionReportClient,
} from '@/lib/domain/inventory/stock-position-reports'

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value)
}

const product = {
  id: 'product-1',
  sku: 'SKU-1',
  name: 'Widget',
  type: 'SIMPLE',
  stockUnit: 'pcs',
  category: { name: 'Finished goods' },
  supplierProducts: [{ supplier: { name: 'Supplier A' } }],
}

const warehouse = { id: 'warehouse-1', code: 'WH1', name: 'Main warehouse' }

function makeClient(overrides: Partial<StockPositionReportClient>): StockPositionReportClient {
  const unused = { findMany: async () => [] }
  const unusedUnique = { findUnique: async () => null }
  return {
    warehouse: unused,
    productCategory: unused,
    supplier: unused,
    product: unused,
    stockLevel: unused,
    inventoryReservationSnapshot: unused,
    inventoryReservationSnapshotRun: unusedUnique,
    stockMovement: unused,
    ...overrides,
  }
}

test('stock-on-hand report enriches as-of rows, totals the full filtered set, and paginates', async (t) => {
  void t
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
      { productId: 'product-2', warehouseId: 'warehouse-1', qty: '5', valueBase: '15', unitCostBase: '3' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: {
      findMany: async () => [
        product,
        {
          ...product,
          id: 'product-2',
          sku: 'SKU-2',
          name: 'Gadget',
          supplierProducts: [],
        },
      ],
    },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('2') },
        { productId: 'product-2', warehouseId: 'warehouse-1', reservedQty: decimal('1') },
      ],
    },
    inventoryReservationSnapshot: { findMany: async () => [] },
  })

  const report = await getStockOnHandReport(
    { pageSize: 50 },
    { deps: { client, getOnHandAsOf } },
  )
  assert.equal(report.pageInfo.totalRows, 2)
  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.totals, {
    quantity: '15',
    reservedQty: '3',
    availableQty: '12',
    totalValueBase: '40',
  })
  assert.equal(report.reservedQtyScope, 'current_missing_snapshot')
  assert.equal(report.missingReservationSnapshotCount, 2)
  assert.equal(report.rows[0]?.reservationQtySource, 'current_missing_snapshot')
  assert.equal(report.rows[0]?.availableQty, '8')

})

test('stock-on-hand current report keeps live reservation scope', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-02T10:00:00.000Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: null,
    source: 'current' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('3') },
      ],
    },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'current')
  assert.equal(report.reservationSnapshotDate, null)
  assert.equal(report.missingReservationSnapshotCount, 0)
  assert.equal(report.rows[0]?.reservedQty, '3')
  assert.equal(report.rows[0]?.availableQty, '7')
  assert.equal(report.rows[0]?.reservationQtySource, 'current')
})

test('stock-on-hand as-of report uses reservation snapshots when available', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('9') },
      ],
    },
    inventoryReservationSnapshot: {
      findMany: async () => [
        {
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          reservedQty: decimal('2'),
          availableQty: decimal('8'),
          reservationSourceCount: 3,
        },
      ],
    },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'snapshot')
  assert.equal(report.reservationSnapshotDate, '2026-06-01')
  assert.equal(report.missingReservationSnapshotCount, 0)
  assert.equal(report.rows[0]?.reservedQty, '2')
  assert.equal(report.rows[0]?.availableQty, '8')
  assert.equal(report.rows[0]?.reservationQtySource, 'snapshot')
  assert.equal(report.rows[0]?.reservationSourceCount, 3)
})

test('stock-on-hand as-of report surfaces missing reservation snapshots and marks current fallback rows', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('4') },
      ],
    },
    inventoryReservationSnapshot: { findMany: async () => [] },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'current_missing_snapshot')
  assert.equal(report.reservationSnapshotDate, '2026-06-01')
  assert.equal(report.missingReservationSnapshotCount, 1)
  assert.equal(report.currentReservationFallbackCount, 1)
  assert.equal(report.rows[0]?.reservedQty, '4')
  assert.equal(report.rows[0]?.availableQty, '6')
  assert.equal(report.rows[0]?.reservationQtySource, 'current_missing_snapshot')
  assert.equal(report.rows[0]?.reservationSourceCount, null)
})

test('stock-on-hand as-of report treats sparse missing rows as zero reserved when the snapshot run exists', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('4') },
      ],
    },
    inventoryReservationSnapshot: { findMany: async () => [] },
    inventoryReservationSnapshotRun: {
      findUnique: async () => ({
        snapshotDate: new Date('2026-06-01T00:00:00.000Z'),
        stockLevelCount: 1,
        reservationSnapshotCount: 0,
      }),
    },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'snapshot')
  assert.equal(report.reservationSnapshotCount, 1)
  assert.equal(report.missingReservationSnapshotCount, 0)
  assert.equal(report.rows[0]?.reservedQty, '0')
  assert.equal(report.rows[0]?.availableQty, '10')
  assert.equal(report.rows[0]?.reservationQtySource, 'snapshot_zero')
  assert.equal(report.rows[0]?.reservationSourceCount, 0)
})

test('stock-on-hand as-of report marks mixed snapshot and current fallback rows when no run marker exists', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
      { productId: 'product-2', warehouseId: 'warehouse-1', qty: '5', valueBase: '15', unitCostBase: '3' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: {
      findMany: async () => [
        product,
        { ...product, id: 'product-2', sku: 'SKU-2', name: 'Gadget', supplierProducts: [] },
      ],
    },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-2', warehouseId: 'warehouse-1', reservedQty: decimal('1') },
      ],
    },
    inventoryReservationSnapshot: {
      findMany: async () => [
        {
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          reservedQty: decimal('2'),
          availableQty: decimal('8'),
          reservationSourceCount: 1,
        },
      ],
    },
    inventoryReservationSnapshotRun: { findUnique: async () => null },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'mixed_snapshot_current_missing')
  assert.equal(report.reservationSnapshotCount, 1)
  assert.equal(report.missingReservationSnapshotCount, 1)
  assert.equal(report.currentReservationFallbackCount, 1)
  assert.equal(report.rows.find((row) => row.productId === 'product-1')?.reservationQtySource, 'snapshot')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.reservationQtySource, 'current_missing_snapshot')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.reservedQty, '1')
})

test('stock-on-hand current reverse replay uses current reservations instead of reservation snapshots', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: null,
    source: 'current_reverse_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('3') },
      ],
    },
    inventoryReservationSnapshot: {
      findMany: async () => {
        throw new Error('current_reverse_replay should not load reservation snapshots')
      },
    },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'current')
  assert.equal(report.reservationSnapshotDate, null)
  assert.equal(report.rows[0]?.reservationQtySource, 'current')
  assert.equal(report.rows[0]?.reservedQty, '3')
})

test('stock-on-hand reservation snapshot lookup filters cross-pair noise', async () => {
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
      { productId: 'product-2', warehouseId: 'warehouse-2', qty: '5', valueBase: '15', unitCostBase: '3' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const warehouse2 = { id: 'warehouse-2', code: 'WH2', name: 'Second warehouse' }
  const client = makeClient({
    product: {
      findMany: async () => [
        product,
        { ...product, id: 'product-2', sku: 'SKU-2', name: 'Gadget', supplierProducts: [] },
      ],
    },
    warehouse: { findMany: async () => [warehouse, warehouse2] },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('4') },
        { productId: 'product-2', warehouseId: 'warehouse-2', reservedQty: decimal('1') },
      ],
    },
    inventoryReservationSnapshot: {
      findMany: async () => [
        {
          productId: 'product-1',
          warehouseId: 'warehouse-2',
          reservedQty: decimal('9'),
          availableQty: decimal('0'),
          reservationSourceCount: 1,
        },
      ],
    },
    inventoryReservationSnapshotRun: { findUnique: async () => null },
  })

  const report = await getStockOnHandReport(
    {},
    { paginate: false, deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.reservedQtyScope, 'current_missing_snapshot')
  assert.equal(report.rows.find((row) => row.productId === 'product-1')?.reservedQty, '4')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.reservedQty, '1')
})

test('stock allocation report adds unattributed rows so source totals reconcile to StockLevel.reservedQty', async (t) => {
  void t
  const loadReservationSourceRows = async () => [
    {
      source: 'sales_order' as const,
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      referenceId: 'order-1',
      referenceLabel: 'SO 100',
      qty: '3',
      expectedDate: '2026-06-10T00:00:00.000Z',
    },
  ]
  const client = makeClient({
    stockLevel: { findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('5') }] },
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
  })

  const report = await getStockAllocationReport(
    {},
    { deps: { client, loadReservationSourceRows } },
  )
  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.stockLevelReservedQty, '5')
  assert.equal(report.totals.reservedQty, '3')
  assert.equal(report.totals.driftQty, '2')
  const unattributed = report.rows.find((row) => row.source === 'other')
  assert.equal(unattributed?.reservedQty, '2')
  assert.equal(unattributed?.referenceId, 'other:unattributed:product-1:warehouse-1')
})

test('negative stock report replays movements from an as-of opening balance and includes current negatives', async (t) => {
  void t
  const getOnHandAsOf = async () => ({
    asOf: '2026-05-31T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: null,
    source: 'current_reverse_replay' as const,
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '1', valueBase: '1', unitCostBase: '1' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    missingValueMovementSample: [],
    valueReplayReliable: true,
  })
  const client = makeClient({
    stockMovement: {
      findMany: async () => [
        {
          id: 'movement-1',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
          type: 'SALE_DISPATCH',
          productId: 'product-1',
          fromWarehouseId: 'warehouse-1',
          toWarehouseId: null,
          qty: decimal('10'),
        },
        {
          id: 'movement-2',
          createdAt: new Date('2026-06-01T15:00:00.000Z'),
          type: 'PURCHASE_RECEIPT',
          productId: 'product-1',
          fromWarehouseId: null,
          toWarehouseId: 'warehouse-1',
          qty: decimal('7'),
        },
      ],
    },
    stockLevel: {
      findMany: async () => [
        { productId: 'product-1', warehouseId: 'warehouse-1', quantity: decimal('3') },
        { productId: 'product-2', warehouseId: 'warehouse-1', quantity: decimal('-1') },
      ],
    },
    product: {
      findMany: async () => [
        product,
        { ...product, id: 'product-2', sku: 'SKU-2', name: 'Currently negative' },
      ],
    },
    warehouse: { findMany: async () => [warehouse] },
  })

  const report = await getNegativeStockReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-02' },
    { now: () => new Date('2026-06-02T10:00:00.000Z'), deps: { client, getOnHandAsOf } },
  )

  assert.equal(report.pageInfo.totalRows, 2)
  assert.equal(report.totals.currentNegativeRows, 1)
  assert.equal(report.totals.historicalNegativeRows, 1)
  assert.equal(report.rows.find((row) => row.productId === 'product-1')?.minimumQty, '-9')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.status, 'currently_negative')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.minimumQty, '-1')
})
