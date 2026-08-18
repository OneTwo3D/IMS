import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getReservationBreakdown,
  loadReservationSourceRows,
  type ReservationBreakdownClient,
} from '@/lib/domain/inventory/reservation-breakdown'

function createClient(): ReservationBreakdownClient {
  return {
    orderAllocation: {
      findMany: async () => [
        {
          id: 'alloc-1',
          orderId: 'order-1',
          lineId: 'line-1',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          qty: '5',
          order: {
            orderNumber: 'SO-1',
            externalOrderNumber: null,
            expectedDelivery: new Date('2026-02-03T00:00:00.000Z'),
            status: 'ALLOCATED',
            refundStatus: 'NONE',
          },
          line: {
            sku: 'SKU-1',
            description: 'Stock item',
          },
        },
        {
          id: 'alloc-terminal',
          orderId: 'order-cancelled',
          lineId: 'line-cancelled',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          qty: '9',
          order: {
            orderNumber: 'SO-CANCELLED',
            externalOrderNumber: null,
            expectedDelivery: null,
            status: 'CANCELLED',
            refundStatus: 'NONE',
          },
          line: {
            sku: 'SKU-1',
            description: 'Cancelled item',
          },
        },
      ],
    },
    shipmentLine: {
      // o3d-4kfh: the query asks for every COMMITTED (non-PENDING) line and splits it by status,
      // so the status is part of the row. Omitting it made every line look un-dispatched and the
      // residual silently became the whole allocation.
      findMany: async () => [
        {
          lineId: 'line-1',
          productId: 'product-1',
          qty: '2',
          shipment: {
            warehouseId: 'warehouse-1',
            status: 'SHIPPED',
          },
        },
      ],
    },
    productionOrder: {
      findMany: async () => [
        {
          id: 'mo-1',
          reference: 'MO-1',
          orderType: 'ASSEMBLY',
          outputProductId: 'finished-1',
          warehouseId: 'warehouse-1',
          qtyPlanned: '4',
          scheduledAt: new Date('2026-02-04T00:00:00.000Z'),
          outputProduct: {
            productComponents: [
              { componentId: 'product-1', qty: '0.5' },
              { componentId: 'other-product', qty: '1' },
            ],
          },
        },
        {
          id: 'mo-2',
          reference: 'MO-2',
          orderType: 'DISASSEMBLY',
          outputProductId: 'product-1',
          warehouseId: 'warehouse-1',
          qtyPlanned: '1.25',
          scheduledAt: null,
          outputProduct: {
            productComponents: [],
          },
        },
      ],
    },
    stockLevel: {
      findUnique: async () => ({
        reservedQty: '7',
      }),
    },
  }
}

test('reservation source rows subtract committed shipment quantities and include manufacturing reservations', async () => {
  const rows = await loadReservationSourceRows(createClient(), {
    productId: 'product-1',
    warehouseId: 'warehouse-1',
  })

  assert.deepEqual(rows.map((row) => [row.source, row.referenceId, row.qty]), [
    ['production_order', 'mo-1', '2'],
    ['production_order', 'mo-2', '1.25'],
    ['sales_order', 'order-1', '3'],
  ])
  assert.equal(
    rows.some((row) => row.referenceId === 'order-cancelled'),
    false,
  )
})

test('reservation breakdown reports known and unattributed reserved quantities', async () => {
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    client: createClient(),
  })

  assert.equal(breakdown.stockLevelReservedQty, '7')
  assert.equal(breakdown.knownReservedQty, '6.25')
  assert.equal(breakdown.unattributedQty, '0.75')
  assert.equal(breakdown.driftQty, '0.75')
  assert.deepEqual(breakdown.rows.map((row) => row.source), [
    'production_order',
    'production_order',
    'sales_order',
    'other',
  ])
})

test('reservation breakdown can omit unattributed row for strict source reconciliation', async () => {
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    includeUnattributed: false,
    client: createClient(),
  })

  assert.equal(breakdown.rows.some((row) => row.source === 'other'), false)
  assert.equal(breakdown.driftQty, '0.75')
})

// ---------------------------------------------------------------------------
// o3d-4kfh — zero-demand orders (CANCELLED / fully refunded) still hold their COMMITTED
// reservation. Allocation retains the committed set and only dispatch decrements reservedQty, so a
// full refund on an order with a PICKING or PACKED shipment leaves that portion reserved. Dropping
// those rows reported a correctly-held reservation as unattributed drift.
// ---------------------------------------------------------------------------

type ZeroDemandFixture = {
  status: string
  refundStatus: string
  allocatedQty: string
  /** [qty, shipment status] per committed shipment line on the row. */
  shipmentLines: Array<[string, string]>
  reservedQty: string
}

function zeroDemandClient(fixture: ZeroDemandFixture): ReservationBreakdownClient {
  return {
    orderAllocation: {
      findMany: async ({ where }: { where?: { order?: unknown } } = {}) => {
        // Guards the double AND the query: the exclusion this fix removes lived in `where.order`,
        // so a double that silently answered the old shape would hide its return.
        assert.equal(
          (where as { order?: unknown } | undefined)?.order,
          undefined,
          'zero-demand orders must no longer be filtered out in the query',
        )
        return [{
          id: 'alloc-1',
          orderId: 'order-1',
          lineId: 'line-1',
          productId: 'product-1',
          warehouseId: 'warehouse-1',
          qty: fixture.allocatedQty,
          order: {
            orderNumber: 'SO-1',
            externalOrderNumber: null,
            expectedDelivery: null,
            status: fixture.status,
            refundStatus: fixture.refundStatus,
          },
          line: { sku: 'SKU-1', description: 'Stock item' },
        }]
      },
    },
    shipmentLine: {
      // Honours the non-PENDING predicate the query passes, so a PENDING draft really is invisible
      // here rather than being credited as a commitment.
      findMany: async ({ where }: { where: { shipment: { status: { not: string } } } }) => fixture
        .shipmentLines
        .filter(([, status]) => status !== where.shipment.status.not)
        .map(([qty, status]) => ({
          lineId: 'line-1',
          productId: 'product-1',
          qty,
          shipment: { warehouseId: 'warehouse-1', status },
        })),
    },
    productionOrder: { findMany: async () => [] },
    stockLevel: { findUnique: async () => ({ reservedQty: fixture.reservedQty }) },
  } as unknown as ReservationBreakdownClient
}

test('o3d-4kfh: a FULLY REFUNDED order with a PICKING shipment is a KNOWN reservation source', async () => {
  // 10 allocated, 4 picked, nothing dispatched, demand zero. The 4 picked units are still reserved
  // on the stock level; the other 6 are stale outstanding quantity with nothing behind them.
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    client: zeroDemandClient({
      status: 'ALLOCATED',
      refundStatus: 'FULL',
      allocatedQty: '10',
      shipmentLines: [['4', 'PICKING']],
      reservedQty: '4',
    }),
  })

  assert.equal(breakdown.knownReservedQty, '4', 'the committed portion is attributed, not dropped')
  assert.equal(breakdown.unattributedQty, '0', 'so the reservation is fully explained')
  assert.deepEqual(breakdown.rows.map((row) => [row.source, row.qty]), [['sales_order', '4']])
  assert.match(String(breakdown.rows[0].referenceLabel), /committed shipment on fully refunded order/)
})

test('o3d-4kfh: a CANCELLED order with a PACKED shipment is credited the same way', async () => {
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    client: zeroDemandClient({
      status: 'CANCELLED',
      refundStatus: 'NONE',
      allocatedQty: '6',
      shipmentLines: [['6', 'PACKED']],
      reservedQty: '6',
    }),
  })

  assert.equal(breakdown.knownReservedQty, '6')
  assert.equal(breakdown.unattributedQty, '0')
  assert.match(String(breakdown.rows[0].referenceLabel), /committed shipment on cancelled order/)
})

test('o3d-4kfh: only the COMMITTED portion is credited — stale outstanding qty stays unattributed', async () => {
  // The magnitude matters as much as the presence. 10 allocated with 4 picked and a reservedQty of
  // 10 means 6 units really are leaked: crediting the whole residual would explain away a genuine
  // integrity failure, and crediting nothing (the old behaviour) over-reported it as 10.
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    client: zeroDemandClient({
      status: 'ALLOCATED',
      refundStatus: 'FULL',
      allocatedQty: '10',
      shipmentLines: [['4', 'PICKING']],
      reservedQty: '10',
    }),
  })

  assert.equal(breakdown.knownReservedQty, '4')
  assert.equal(breakdown.unattributedQty, '6', 'the stale 6 is still reported as drift')
})

test('o3d-4kfh: a DISPATCHED line on a zero-demand order credits nothing (dispatch already released it)', async () => {
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    client: zeroDemandClient({
      status: 'ALLOCATED',
      refundStatus: 'FULL',
      allocatedQty: '10',
      shipmentLines: [['10', 'SHIPPED']],
      reservedQty: '0',
    }),
  })

  assert.equal(breakdown.knownReservedQty, '0')
  assert.deepEqual(breakdown.rows.filter((row) => row.source === 'sales_order'), [])
})

test('o3d-4kfh: a PENDING draft shipment on a zero-demand order is NOT a commitment', async () => {
  // A PENDING shipment is a draft nothing has acted on. Crediting it would explain away a real
  // stranded reservation on an order that will never ship.
  const breakdown = await getReservationBreakdown({
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    client: zeroDemandClient({
      status: 'ALLOCATED',
      refundStatus: 'FULL',
      allocatedQty: '10',
      shipmentLines: [['10', 'PENDING']],
      reservedQty: '10',
    }),
  })

  assert.equal(breakdown.knownReservedQty, '0')
  assert.equal(breakdown.unattributedQty, '10', 'the whole stranded reservation is still reported')
})
