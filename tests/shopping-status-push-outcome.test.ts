import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 (HIGH 2) — the facade must not turn a failed WooCommerce status push into success.
 * `pushSalesOrderStatus` used to `await pushImsStatusToWc(...)` and return `{ success: true }`
 * unconditionally, so the caller's failure log could never fire. Doubles: the connector's pusher, the
 * settings the facade reads to decide a connector is runnable.
 */

type Outcome = { kind: string; error?: string; wcStatus?: string; class?: string }
const state = { outcome: { kind: 'pushed' } as Outcome, calls: 0, configured: true }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async () => (state.configured ? { value: 'configured' } : null),
        findMany: async () => [],
      },
    },
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => ({ woocommerce: true }),
    isIntegrationPluginEnabled: async () => true,
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: { pushImsStatusToWc: async () => { state.calls++; return state.outcome } },
})

beforeEach(() => { state.outcome = { kind: 'pushed' }; state.calls = 0; state.configured = true })

test('o3d-zvec.15 (arm 3): read-failed, write-failed and error are FAILURES; everything else is success with the outcome attached', async () => {
  const { pushSalesOrderStatus } = await import('@/lib/shopping')
  const failures: Outcome[] = [
    { kind: 'read-failed', error: 'HTTP 503' },
    { kind: 'write-failed', error: 'HTTP 500' },
    { kind: 'error', error: 'socket hang up' },
  ]
  const successes: Outcome[] = [
    { kind: 'pushed' },
    { kind: 'already-at-target' },
    { kind: 'not-applicable' },
    { kind: 'ineligible', wcStatus: 'cancelled', class: 'finalised' },
    { kind: 'ineligible', wcStatus: 'on-hold', class: 'not-ready' },
  ]
  let evaluated = 0
  for (const outcome of failures) {
    state.outcome = outcome; state.calls = 0
    const result = await pushSalesOrderStatus('so-1', 'SHIPPED')
    assert.equal(state.calls, 1, `${outcome.kind}: precondition — the connector pusher was reached`)
    assert.equal(result.success, false, `${outcome.kind} must not be reported as success`)
    assert.equal(result.error, `WooCommerce: ${outcome.error}`)
    assert.deepEqual(result.outcome, outcome)
    evaluated++
  }
  for (const outcome of successes) {
    state.outcome = outcome; state.calls = 0
    const result = await pushSalesOrderStatus('so-1', 'SHIPPED')
    assert.equal(state.calls, 1, `${outcome.kind}: precondition — the connector pusher was reached`)
    assert.equal(result.success, true, `${outcome.kind}`)
    assert.deepEqual(result.outcome, outcome)
    evaluated++
  }
  assert.equal(evaluated, 8)
})

test('o3d-zvec.15 (arm 3): no runnable connector is a skipped success, the pusher is never reached', async () => {
  state.configured = false
  const { pushSalesOrderStatus } = await import('@/lib/shopping')
  const result = await pushSalesOrderStatus('so-1', 'SHIPPED')
  assert.deepEqual(result, { success: true, skipped: true })
  assert.equal(state.calls, 0)
})
