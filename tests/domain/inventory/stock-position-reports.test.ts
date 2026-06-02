import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  getNegativeStockReport,
  getStockAllocationReport,
  getStockOnHandReport,
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

test('stock-on-hand report enriches as-of rows, totals the full filtered set, and paginates', async (t) => {
  void t
  const getOnHandAsOf = async () => ({
    asOf: '2026-06-01T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: '2026-06-01',
    source: 'snapshot_forward_replay',
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '10', valueBase: '25', unitCostBase: '2.5' },
      { productId: 'product-2', warehouseId: 'warehouse-1', qty: '5', valueBase: '15', unitCostBase: '3' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    valueReplayReliable: true,
  })
  const client = {
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
  }

  const report = await getStockOnHandReport(
    { pageSize: 1 },
    { deps: { client: client as never, getOnHandAsOf: getOnHandAsOf as never } },
  )
  assert.equal(report.pageInfo.totalRows, 2)
  assert.equal(report.rows.length, 1)
  assert.deepEqual(report.totals, {
    quantity: '15',
    reservedQty: '3',
    availableQty: '12',
    totalValueBase: '40',
  })
  assert.equal(report.rows[0]?.availableQty, '8')

})

test('stock allocation report adds unattributed rows so source totals reconcile to StockLevel.reservedQty', async (t) => {
  void t
  const loadReservationSourceRows = async () => [
    {
      source: 'sales_order',
      productId: 'product-1',
      warehouseId: 'warehouse-1',
      referenceId: 'order-1',
      referenceLabel: 'SO 100',
      qty: '3',
      expectedDate: '2026-06-10T00:00:00.000Z',
    },
  ]
  const client = {
    stockLevel: { findMany: async () => [{ productId: 'product-1', warehouseId: 'warehouse-1', reservedQty: decimal('5') }] },
    product: { findMany: async () => [product] },
    warehouse: { findMany: async () => [warehouse] },
  }

  const report = await getStockAllocationReport(
    {},
    { deps: { client: client as never, loadReservationSourceRows: loadReservationSourceRows as never } },
  )
  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.stockLevelReservedQty, '5')
  assert.equal(report.totals.reservedQty, '5')
  assert.equal(report.totals.driftQty, '2')
  const unattributed = report.rows.find((row) => row.source === 'other')
  assert.equal(unattributed?.reservedQty, '2')
})

test('negative stock report replays movements from an as-of opening balance and includes current negatives', async (t) => {
  void t
  const getOnHandAsOf = async () => ({
    asOf: '2026-05-31T23:59:59.999Z',
    generatedAt: '2026-06-02T10:00:00.000Z',
    anchorDate: null,
    source: 'current_reverse_replay',
    rows: [
      { productId: 'product-1', warehouseId: 'warehouse-1', qty: '1', valueBase: '1', unitCostBase: '1' },
    ],
    missingValueMovementCount: 0,
    orphanWarehouseMovementCount: 0,
    valueReplayReliable: true,
  })
  const client = {
    stockMovement: {
      findMany: async () => [
        {
          id: 'movement-1',
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
          type: 'SALE_DISPATCH',
          productId: 'product-1',
          fromWarehouseId: 'warehouse-1',
          toWarehouseId: null,
          qty: decimal('3'),
        },
        {
          id: 'movement-2',
          createdAt: new Date('2026-06-01T15:00:00.000Z'),
          type: 'PURCHASE_RECEIPT',
          productId: 'product-1',
          fromWarehouseId: null,
          toWarehouseId: 'warehouse-1',
          qty: decimal('5'),
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
  }

  const report = await getNegativeStockReport(
    { dateFrom: '2026-06-01', dateTo: '2026-06-02' },
    { now: () => new Date('2026-06-02T10:00:00.000Z'), deps: { client: client as never, getOnHandAsOf: getOnHandAsOf as never } },
  )

  assert.equal(report.pageInfo.totalRows, 2)
  assert.equal(report.totals.currentNegativeRows, 1)
  assert.equal(report.totals.historicalNegativeRows, 1)
  assert.equal(report.rows.find((row) => row.productId === 'product-1')?.minimumQty, '-2')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.status, 'currently_negative')
  assert.equal(report.rows.find((row) => row.productId === 'product-2')?.minimumQty, '-1')
})
