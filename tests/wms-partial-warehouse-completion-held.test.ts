import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * Owner ruling 2026-11-18: after a WMS despatch ships only its own warehouse's part of a mixed-warehouse order, the order must stay unshipped and NO
 * storefront completion may be enqueued until the last shipment (another warehouse's, shipped in IMS) ships. Exercises the real order promotion
 * under both completion authorities; the client double records the order flip and the completion scheduling.
 */
type Order = { id: string; status: string }
const state = {
  order: { id: 'so-1', status: 'PACKING' } as Order,
  shipments: [] as Array<{ id: string; status: string; trackingNumber: string | null }>,
  scheduled: 0,
}

mock.module('@/lib/shopping', {
  namedExports: { scheduleShoppingOrderCompletion: async () => { state.scheduled++; return 'key-so-1' } },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })

function makeClient() {
  const client = {
    shipment: { findMany: async () => state.shipments },
    setting: { findUnique: async () => null },
    salesOrder: {
      findUnique: async () => ({ ...state.order }),
      update: async ({ data }: { data: Partial<Order> }) => { Object.assign(state.order, data); return state.order },
    },
    $queryRaw: async () => [],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(Object.assign(Object.create(client), { isTransaction: true })),
  }
  return client
}

beforeEach(() => {
  state.order = { id: 'so-1', status: 'PACKING' }
  state.shipments = [
    { id: 'wms', status: 'SHIPPED', trackingNumber: 'MS1' },
    { id: 'home', status: 'PACKED', trackingNumber: null },
  ]
  state.scheduled = 0
})

async function reconcile(options: Record<string, unknown>) {
  const { reconcileOrderAfterShipment } = await import('@/lib/domain/sales/shipment-service')
  return reconcileOrderAfterShipment(makeClient() as never, { orderId: 'so-1' }, undefined, options as never)
}

test('with another warehouse shipment still open the order is not shipped and no storefront completion is enqueued', async () => {
  const result = await reconcile({ completionAuthority: 'EXTERNAL', storefrontCompletion: true })
  assert.equal(state.order.status, 'PACKING', 'the order keeps its in-fulfilment status (the codebase has no PARTIALLY_SHIPPED; open shipments are the partial state)')
  assert.equal(state.scheduled, 0)
  assert.equal(result.orderReachedShipped, undefined)
  assert.equal(result.shouldGenerateInvoice, false)
})

test('the completion is enqueued, with the flip, only once the LAST shipment ships (the other warehouse shipment ships last)', async () => {
  state.shipments[1].status = 'SHIPPED'
  const result = await reconcile({ completionAuthority: 'EXTERNAL', storefrontCompletion: true })
  assert.equal(state.order.status, 'SHIPPED')
  assert.equal(state.scheduled, 1)
  assert.equal(result.orderReachedShipped, true)
})

test('the WMS re-apply tick (nothing left to ship in its warehouse) never completes the order while the other warehouse is open', async () => {
  const first = await reconcile({ completionAuthority: 'EXTERNAL', storefrontCompletion: true })
  const second = await reconcile({ completionAuthority: 'EXTERNAL', storefrontCompletion: true })
  assert.equal(first.orderReachedShipped, undefined)
  assert.equal(second.orderReachedShipped, undefined)
  assert.equal(state.scheduled, 0)
  assert.equal(state.order.status, 'PACKING')
})
