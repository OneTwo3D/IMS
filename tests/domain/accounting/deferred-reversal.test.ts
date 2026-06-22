import assert from 'node:assert/strict'
import test from 'node:test'

import { loadFullyShippedNetOfRefundsOrderIds } from '@/lib/domain/accounting/deferred-reversal'

type OrderLine = { id: string; orderId: string; qty: number; productId: string | null; product: { type: string } | null }
type ShipLine = { lineId: string; qty: number }
type RefundLine = { salesOrderLineId: string | null; qty: number; costLayerSnapshot: unknown }

function mockClient(input: { orderLines: OrderLine[]; shipmentLines: ShipLine[]; refundLines: RefundLine[] }) {
  return {
    salesOrderLine: { findMany: async () => input.orderLines },
    shipmentLine: { findMany: async () => input.shipmentLines },
    salesOrderRefundLine: { findMany: async () => input.refundLines },
  } as never
}

const alloc = (qty: number) => [{ costLayerId: 'cl', qty, unitCostBase: 1, source: 'allocation' as const }]
const shipped = (qty: number) => [{ costLayerId: 'cl', qty, unitCostBase: 1, source: 'shipment' as const }]

test('scjz.68: loadFullyShippedNetOfRefundsOrderIds — fully shipped, refunded-unshipped, returns, services', async () => {
  const result = await loadFullyShippedNetOfRefundsOrderIds(mockClient({
    orderLines: [
      { id: 'L1', orderId: 'fully', qty: 2, productId: 'p', product: { type: 'SIMPLE' } },
      { id: 'L2', orderId: 'refunded', qty: 2, productId: 'p', product: { type: 'SIMPLE' } },
      { id: 'L3', orderId: 'partial', qty: 2, productId: 'p', product: { type: 'SIMPLE' } },
      { id: 'L4', orderId: 'return', qty: 2, productId: 'p', product: { type: 'SIMPLE' } },
      { id: 'L5', orderId: 'service', qty: 1, productId: 'svc', product: { type: 'NON_INVENTORY' } },
      { id: 'L6', orderId: 'service', qty: 1, productId: 'p', product: { type: 'SIMPLE' } },
    ],
    shipmentLines: [
      { lineId: 'L1', qty: 2 }, // fully shipped
      { lineId: 'L2', qty: 1 }, // 1 shipped, 1 will be refunded-unshipped
      { lineId: 'L3', qty: 1 }, // 1 shipped, 1 NOT accounted for
      { lineId: 'L4', qty: 1 }, // 1 shipped, 1 unshipped; the refund below is a RETURN of a shipped unit
      { lineId: 'L6', qty: 1 }, // the shippable line of the service order
    ],
    refundLines: [
      { salesOrderLineId: 'L2', qty: 1, costLayerSnapshot: alloc(1) },   // unshipped refund -> covers the gap
      { salesOrderLineId: 'L4', qty: 1, costLayerSnapshot: shipped(1) }, // return of a shipped unit -> does NOT cover the unshipped one
    ],
  }), ['fully', 'refunded', 'partial', 'return', 'service'])

  assert.equal(result.has('fully'), true)
  assert.equal(result.has('refunded'), true)   // 1 shipped + 1 refunded-unshipped >= 2
  assert.equal(result.has('partial'), false)   // 1 shipped, 1 unaccounted
  assert.equal(result.has('return'), false)    // return doesn't reduce the ship obligation
  assert.equal(result.has('service'), true)    // non-inventory line ignored; shippable line fully shipped
})

test('scjz.68: empty order list returns empty set', async () => {
  const result = await loadFullyShippedNetOfRefundsOrderIds(mockClient({ orderLines: [], shipmentLines: [], refundLines: [] }), [])
  assert.equal(result.size, 0)
})
