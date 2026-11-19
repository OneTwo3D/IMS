import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRefundFallbackReturnRows } from '@/lib/domain/sales/refund-service'

/**
 * o3d-lqcjv: an in-transit refund writes no RETURN_INBOUND movement, so a later partial refund of a PART-SHIPPED kit estimated what the
 * first one already expects back from refunded units x shipped/ordered and raised a second expectation for the same components.
 * The prior refund's return document is now the record. Fake client, no database.
 * Named mutation (shown red): the returnExpectation read removed (movements only).
 *
 * Kit K, 2 ordered, 1 shipped (A x1, B x2 shipped). Refund 1 of one kit went in transit (expects A 1, B 2). Refund 2 of one kit: nothing
 * returnable is left.
 */
function client(withExpectation: boolean) {
  const order = {
    lines: [{ id: 'L', productId: 'K', description: 'Kit', qty: 2, totalBase: 20 }],
    allocations: [],
    shipments: [{
      id: 'S1',
      lines: [
        { id: 'SL-A', lineId: 'L', productId: 'A', qty: 1, costLayerSnapshot: [{ costLayerId: 'cl-a', qty: '1', unitCostBase: '3' }] },
        { id: 'SL-B', lineId: 'L', productId: 'B', qty: 2, costLayerSnapshot: [{ costLayerId: 'cl-b', qty: '2', unitCostBase: '1' }] },
      ],
    }],
    refunds: [{
      id: 'R1',
      returnWarehouseId: 'W1',
      returnShipmentQty: null,
      lines: [{ id: 'RL1', productId: 'K', description: 'Kit', qty: 1, totalBase: 10, unitPriceBase: 10, salesOrderLineId: 'L' }],
      returnExpectation: withExpectation
        ? { lines: [{ refundLineId: 'RL1', productId: 'A', qty: 1 }, { refundLineId: 'RL1', productId: 'B', qty: 2 }] }
        : null,
    }],
  }
  return {
    salesOrder: { findUnique: async () => order },
    stockMovement: { findMany: async () => [], findUnique: async () => null },
    costLayer: { findMany: async () => [] },
  }
}

const refund2 = [{ lineId: 'L', productId: 'K', description: 'Kit', qty: 1, totalBase: 10, unitPriceBase: 10, lineKind: 'sale' as const }]

test('a second partial refund of a part-shipped kit does not re-expect components already on the first in-transit document', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await buildRefundFallbackReturnRows(client(true) as any, 'O1', refund2 as any, 'R2', { skipUnshipped: true })
  assert.deepEqual(rows, [], `nothing left to return, got ${JSON.stringify(rows)}`)
})
