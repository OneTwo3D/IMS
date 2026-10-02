import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 (arm 4) — the durable storefront-completion job is enqueued INSIDE the transaction that flips
 * the order to SHIPPED, so it commits with the flip or not at all.
 *
 * The client double hands the transaction callback a DISTINCT tx object (a child of the outer client carrying
 * `isTransaction`), and `$transaction` restores the order row when the callback throws — so "enqueued through
 * the tx", "not enqueued through the pool" and "rolled back with the flip" are all observable, not assumed.
 * Completion authority EXTERNAL keeps the shortfall query out of the way; it is not what is under test.
 */

type Order = { id: string; status: string; shippedAt?: Date | null; trackingNumber?: string | null }
type Scheduled = { client: { isTransaction?: boolean }; orderId: string; shippedAt: Date }

const state = {
  order: { id: 'so-1', status: 'ALLOCATED' } as Order,
  shipments: [{ id: 'ship-1', status: 'SHIPPED', trackingNumber: 'T1' }] as Array<{ id: string; status: string; trackingNumber: string | null }>,
  scheduled: [] as Scheduled[],
  scheduleBehaviour: 'key' as 'key' | 'null' | 'throw',
  transactions: 0,
}

mock.module('@/lib/shopping', {
  namedExports: {
    scheduleShoppingOrderCompletion: async (client: { isTransaction?: boolean }, input: { orderId: string; shippedAt: Date }) => {
      state.scheduled.push({ client, orderId: input.orderId, shippedAt: input.shippedAt })
      if (state.scheduleBehaviour === 'throw') throw new Error('outbox insert failed')
      return state.scheduleBehaviour === 'null' ? null : `key-${input.orderId}`
    },
  },
})
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => {} },
})

function makeClient() {
  const client = {
    shipment: { findMany: async () => state.shipments },
    setting: { findUnique: async () => null },
    salesOrder: {
      findUnique: async () => ({ ...state.order }),
      update: async ({ data }: { data: Partial<Order> }) => { Object.assign(state.order, data); return state.order },
    },
    $queryRaw: async () => [],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      state.transactions++
      const snapshot = { ...state.order }
      try {
        return await callback(Object.assign(Object.create(client), { isTransaction: true }))
      } catch (error) {
        state.order = snapshot
        throw error
      }
    },
  }
  return client
}

beforeEach(() => {
  state.order = { id: 'so-1', status: 'ALLOCATED' }
  state.shipments = [{ id: 'ship-1', status: 'SHIPPED', trackingNumber: 'T1' }]
  state.scheduled.length = 0
  state.scheduleBehaviour = 'key'
  state.transactions = 0
})

async function reconcile(options: Record<string, unknown>) {
  const { reconcileOrderAfterShipment } = await import('@/lib/domain/sales/shipment-service')
  return reconcileOrderAfterShipment(makeClient() as never, { orderId: 'so-1' }, undefined, { completionAuthority: 'EXTERNAL', ...options })
}

test('o3d-zvec.15 (arm 4): the completion row is created through the TRANSACTION client, with the flip', async () => {
  const result = await reconcile({ storefrontCompletion: true })

  assert.equal(state.transactions, 1, 'precondition: the flip ran in a transaction')
  assert.equal(state.order.status, 'SHIPPED', 'precondition: the order really reached SHIPPED')
  assert.equal(state.scheduled.length, 1, 'the scheduler was reached')
  assert.equal(state.scheduled[0].client.isTransaction, true, 'on the transaction client, not the pool')
  assert.deepEqual(state.scheduled[0].shippedAt, state.order.shippedAt, 'keyed on the SAME shippedAt the flip wrote')
  assert.equal(result.storefrontCompletionKey, 'key-so-1')
  assert.equal(result.orderReachedShipped, true)
})

test('o3d-zvec.15 (arm 4): an enqueue that fails rolls the flip back — no SHIPPED order without its completion job', async () => {
  state.scheduleBehaviour = 'throw'
  await assert.rejects(() => reconcile({ storefrontCompletion: true }), /outbox insert failed/)
  assert.equal(state.scheduled.length, 1, 'precondition: the scheduler was reached and threw')
  assert.equal(state.order.status, 'ALLOCATED', 'the flip was rolled back with it')
})

test('o3d-zvec.15 (arm 4): NO row for a partial shipment, a not-promoted order, an unlinked order, or storefrontCompletion off', async () => {
  const cases: Array<{ name: string; setup: () => void; options: Record<string, unknown>; expectFlip: boolean }> = [
    { name: 'partial shipment', setup: () => { state.shipments.push({ id: 'ship-2', status: 'PACKED', trackingNumber: null }) }, options: { storefrontCompletion: true }, expectFlip: false },
    { name: 'order already SHIPPED (not promoted by this call)', setup: () => { state.order.status = 'SHIPPED' }, options: { storefrontCompletion: true }, expectFlip: false },
    { name: 'unlinked order (scheduler returns no key)', setup: () => { state.scheduleBehaviour = 'null' }, options: { storefrontCompletion: true }, expectFlip: true },
    { name: 'storefrontCompletion off', setup: () => {}, options: { storefrontCompletion: false }, expectFlip: true },
    { name: 'storefrontCompletion omitted (default off)', setup: () => {}, options: {}, expectFlip: true },
  ]
  let evaluated = 0
  for (const c of cases) {
    state.order = { id: 'so-1', status: 'ALLOCATED' }
    state.shipments = [{ id: 'ship-1', status: 'SHIPPED', trackingNumber: 'T1' }]
    state.scheduled.length = 0
    state.scheduleBehaviour = 'key'
    c.setup()
    const result = await reconcile(c.options)
    assert.equal(result.orderReachedShipped === true, c.expectFlip, `${c.name}: precondition — the flip is what the case says`)
    assert.equal(result.storefrontCompletionKey, undefined, `${c.name}: no key`)
    if (!c.options.storefrontCompletion || !c.expectFlip) {
      assert.equal(state.scheduled.length, 0, `${c.name}: the scheduler is not even called`)
    }
    evaluated++
  }
  assert.equal(evaluated, 5)
})
