import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 — `pushShipmentCompletionToShopping`, the one decision point for what the storefront
 * hears when a shipment ships. Doubles: the shopping facade and the activity log.
 */

const state = {
  calls: [] as string[],
  activity: [] as Array<Record<string, unknown>>,
  trackingThrows: false,
  statusThrows: false,
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (e: Record<string, unknown>) => { state.activity.push(e) } },
})
mock.module('@/lib/shopping', {
  namedExports: {
    pushOrderDeliveryMetadata: async (id: string) => {
      state.calls.push(`tracking:${id}`)
      if (state.trackingThrows) throw new Error('boom')
      return { success: true }
    },
    pushSalesOrderStatus: async (id: string, status: string) => {
      state.calls.push(`status:${id}:${status}`)
      if (state.statusThrows) throw new Error('boom')
      return { success: true }
    },
  },
})

beforeEach(() => {
  state.calls.length = 0
  state.activity.length = 0
  state.trackingThrows = false
  state.statusThrows = false
})

async function run(input: { orderReachedShipped: boolean; pushStatus: boolean }) {
  const { pushShipmentCompletionToShopping } = await import('@/lib/fulfillment/shipment-completion-push')
  await pushShipmentCompletionToShopping({ orderId: 'so-1', orderRef: 'SO-1', ...input })
}

test('o3d-zvec.15: tracking is pushed BEFORE the status', async () => {
  await run({ orderReachedShipped: true, pushStatus: true })
  assert.deepEqual(state.calls, ['tracking:so-1', 'status:so-1:SHIPPED'])
})

test('o3d-zvec.15: an order that has not reached SHIPPED gets tracking only', async () => {
  await run({ orderReachedShipped: false, pushStatus: true })
  assert.deepEqual(state.calls, ['tracking:so-1'])
})

test('o3d-zvec.15 (f): pushStatus=false (storefront owns the status; webhook-driven) pushes no status even at SHIPPED', async () => {
  await run({ orderReachedShipped: true, pushStatus: false })
  assert.deepEqual(state.calls, ['tracking:so-1'], 'precondition: the helper ran and pushed tracking')
})

test('o3d-zvec.15: neither failing push throws out of the helper', async () => {
  state.trackingThrows = true
  state.statusThrows = true
  await run({ orderReachedShipped: true, pushStatus: true })
  assert.deepEqual(state.calls, ['tracking:so-1', 'status:so-1:SHIPPED'], 'both were attempted')
  assert.equal(state.activity.filter((a) => a.action === 'shopping_status_push_failed').length, 1)
})
