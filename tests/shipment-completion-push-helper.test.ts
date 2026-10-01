import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 — the post-commit half of the completion decision, and the manual-ship enqueue gate.
 * Doubles: the shopping facade and the activity log.
 */

const state = {
  calls: [] as string[],
  scheduled: [] as Array<{ tx: unknown; orderId: string }>,
  scheduleResult: 'key-1' as string | null,
  activity: [] as Array<Record<string, unknown>>,
  attempt: 'ok' as 'ok' | 'reject' | 'hang',
  trackingThrows: false,
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
    processShoppingOrderCompletions: async (o: { idempotencyKeys?: string[] }) => {
      state.calls.push(`attempt:${o.idempotencyKeys?.join(',')}`)
      if (state.attempt === 'reject') throw new Error('boom')
      if (state.attempt === 'hang') return new Promise(() => {})
      return {}
    },
    scheduleShoppingOrderCompletion: async (tx: unknown, input: { orderId: string }) => {
      state.scheduled.push({ tx, orderId: input.orderId })
      return state.scheduleResult
    },
  },
})

beforeEach(() => {
  state.calls.length = 0
  state.scheduled.length = 0
  state.scheduleResult = 'key-1'
  state.activity.length = 0
  state.attempt = 'ok'
  state.trackingThrows = false
})

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('o3d-zvec.15: with a completion key the helper makes ONE attempt on it and pushes no separate tracking', async () => {
  const { pushShipmentCompletionToShopping } = await import('@/lib/fulfillment/shipment-completion-push')
  await pushShipmentCompletionToShopping({ orderId: 'so-1', completionKey: 'key-1' })
  await settle()
  assert.deepEqual(state.calls, ['attempt:key-1'])
})

test('o3d-zvec.15: without a key (partial shipment, EXTERNAL, unlinked) it pushes tracking only', async () => {
  const { pushShipmentCompletionToShopping } = await import('@/lib/fulfillment/shipment-completion-push')
  await pushShipmentCompletionToShopping({ orderId: 'so-1', completionKey: null })
  await settle()
  assert.deepEqual(state.calls, ['tracking:so-1'])
})

test('o3d-zvec.15: a rejecting attempt neither throws out of the helper nor goes unlogged; a hanging one does not block it', async () => {
  const { pushShipmentCompletionToShopping } = await import('@/lib/fulfillment/shipment-completion-push')
  let evaluated = 0
  for (const attempt of ['reject', 'hang'] as const) {
    state.calls.length = 0
    state.activity.length = 0
    state.attempt = attempt
    await pushShipmentCompletionToShopping({ orderId: 'so-1', completionKey: 'key-1' }) // would never return if awaited on `hang`
    await settle()
    assert.deepEqual(state.calls, ['attempt:key-1'], `${attempt}: the attempt was reached`)
    assert.equal(state.activity.filter((a) => a.action === 'wc_completion_attempt_failed').length, attempt === 'reject' ? 1 : 0, attempt)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-zvec.15: a throwing tracking push (no key) does not throw out of the helper', async () => {
  state.trackingThrows = true
  const { pushShipmentCompletionToShopping } = await import('@/lib/fulfillment/shipment-completion-push')
  await pushShipmentCompletionToShopping({ orderId: 'so-1', completionKey: null })
  assert.deepEqual(state.calls, ['tracking:so-1'], 'precondition: the throwing double was reached')
})

test('o3d-zvec.15 (arm 13): the manual SHIPPED path enqueues on the TRANSACTION client when it owns the storefront status, and not otherwise', async () => {
  const { scheduleManualShipCompletion } = await import('@/lib/fulfillment/shipment-completion-push')
  const tx = { marker: 'the-locked-transaction' }

  const on = await scheduleManualShipCompletion(tx as never, { orderId: 'so-1', enabled: true })
  assert.equal(on, 'key-1')
  assert.equal(state.scheduled.length, 1, 'precondition: the scheduler was reached when enabled')
  assert.equal(state.scheduled[0].tx, tx, 'on the very client it was handed (the transaction), not the pool')

  state.scheduled.length = 0
  const off = await scheduleManualShipCompletion(tx as never, { orderId: 'so-1', enabled: false })
  assert.equal(off, null)
  assert.deepEqual(state.scheduled, [], 'pushStatusToWooCommerce:false / unlinked: no row')
})
