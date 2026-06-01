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
          },
          line: {
            sku: 'SKU-1',
            description: 'Cancelled item',
          },
        },
      ],
    },
    shipmentLine: {
      findMany: async () => [
        {
          lineId: 'line-1',
          productId: 'product-1',
          qty: '2',
          shipment: {
            warehouseId: 'warehouse-1',
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
