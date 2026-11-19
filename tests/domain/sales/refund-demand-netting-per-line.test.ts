import assert from 'node:assert/strict'
import test from 'node:test'

import { loadNettedRefundLines } from '../../../lib/domain/sales/refund-demand-netting'

/**
 * Mocked only: an in-memory client. Nothing here reaches the database, the network or any warehouse.
 * One order, two order lines A and B of the SAME product P (5 each), one refund of 3 from each.
 */
type Fx = {
  shipped: Array<{ lineId: string; productId: string; qty: number }>
  movements: Array<{ referenceId: string; productId: string; qty: number; idempotencyKey: string | null }>
}

function client(fx: Fx, refundLines: unknown[]) {
  return {
    salesOrderRefundLine: { findMany: async () => refundLines },
    stockMovement: { findMany: async () => fx.movements },
    salesOrderLine: {
      findMany: async () => [
        { id: 'A', productId: 'P', fulfillmentRequirements: null },
        { id: 'B', productId: 'P', fulfillmentRequirements: null },
      ],
    },
    shipmentLine: { findMany: async () => fx.shipped },
    product: {
      findMany: async () => [{ id: 'P', type: 'SIMPLE', fulfillmentGraphVersion: 0, productComponents: [] }],
    },
  }
}

const refund = { orderId: 'O', returnWarehouseId: 'W', chargeback: false, accountingRetryRequired: false }
const refundLines = (order: string[]) => order.map((id) => ({
  id: `RL-${id}`, salesOrderLineId: id, productId: 'P', qty: 3, refundId: 'R', refund,
}))
const key = (lineId: string) => `refund:R:line:RL-${lineId}:warehouse:W:product:P`

// A shipped 1 then 2 more AFTER the refund (so 3); B shipped 5. Refund took 3 from each:
// A: 1 returned (movement 1), B: 3 returned (movement 3).
const fx: Fx = {
  shipped: [
    { lineId: 'A', productId: 'P', qty: 3 },
    { lineId: 'B', productId: 'P', qty: 5 },
  ],
  movements: [
    { referenceId: 'R', productId: 'P', qty: 1, idempotencyKey: key('A') },
    { referenceId: 'R', productId: 'P', qty: 3, idempotencyKey: key('B') },
  ],
}

for (const order of [['A', 'B'], ['B', 'A']]) {
  test(`two refund lines of one product: each line nets only its OWN returned units (read order ${order.join('')})`, async () => {
    const netted = await loadNettedRefundLines(client(fx, refundLines(order)), {})
    const cancelled = Object.fromEntries(netted.map((l) => [l.salesOrderLineId, Number(l.qty)]))
    // A: 3 refunded, 1 came back, 2 cancelled. B: 3 refunded, 3 came back, 0 cancelled.
    assert.deepEqual(cancelled, { A: 2, B: 0 })
  })
}
