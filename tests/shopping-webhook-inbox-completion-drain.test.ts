import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * o3d-zvec.15 — the `shopping-webhook-inbox` cron is the drain for queued WooCommerce order completions.
 * It must run whenever the WooCommerce plugin is enabled — NOT only when `wc_sync_enabled` is on, because the
 * status push has never been gated by that setting — and a failing drain must not fail the tick.
 */
const state = { pluginEnabled: true, syncEnabled: false, drainCalls: 0, drainThrows: false, inboxCalls: 0, statusDrainCalls: 0, statusDrainThrows: false }

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', {
  namedExports: { CRON_RATE_LIMIT_FIVE_MINUTE_MAX: 1, enforceCronRateLimit: async () => null },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/ops/cron-run', {
  namedExports: {
    runCronWithLogging: async (input: { run: () => Promise<Record<string, unknown>> }) => ({ runId: 'run-1', result: await input.run() }),
    appendCronRunId: (result: Record<string, unknown>, runId: string) => ({ ...result, runId }),
    cronRunResponseInit: () => undefined,
  },
})
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => state.pluginEnabled } })
mock.module('@/lib/db', {
  namedExports: { db: { setting: { findUnique: async () => ({ value: state.syncEnabled ? 'true' : 'false' }) } } },
})
mock.module('@/lib/jobs/woocommerce/process-shopping-webhook-events', {
  namedExports: { processPendingWcWebhookEvents: async () => { state.inboxCalls++; return { processed: 0 } } },
})
mock.module('@/lib/shopping', {
  namedExports: {
    // o3d-6ldlj: the cancel/hold drain
    processShoppingOrderStatusPushes: async () => {
      state.statusDrainCalls++
      if (state.statusDrainThrows) throw new Error('status drain unavailable')
      return { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
    },
    processShoppingOrderCompletions: async () => {
      state.drainCalls++
      if (state.drainThrows) throw new Error('database unavailable')
      return { claimed: 2, succeeded: 2, retried: 0, deadLettered: 0, skipped: 0, errors: [] }
    },
  },
})

beforeEach(() => { state.pluginEnabled = true; state.syncEnabled = false; state.drainCalls = 0; state.drainThrows = false; state.inboxCalls = 0; state.statusDrainCalls = 0; state.statusDrainThrows = false })

async function tick() {
  const { GET } = await import('@/app/api/cron/shopping-webhook-inbox/route')
  const response = await GET(new Request('http://localhost/api/cron/shopping-webhook-inbox'))
  return (await response.json()) as { connectors: { woocommerce: Record<string, unknown> } }
}

test('o3d-zvec.15: completions are drained with inbound sync OFF (the plugin gate only)', async () => {
  const body = await tick()
  assert.equal(state.inboxCalls, 0, 'precondition: the inbound inbox really was skipped (sync off)')
  assert.equal(state.drainCalls, 1)
  assert.deepEqual(body.connectors.woocommerce.orderCompletions, { claimed: 2, succeeded: 2, retried: 0, deadLettered: 0, skipped: 0, errors: [] })
})

test('o3d-zvec.15: with the WooCommerce plugin disabled nothing is drained', async () => {
  state.pluginEnabled = false
  const body = await tick()
  assert.equal(state.drainCalls, 0)
  assert.deepEqual(body.connectors.woocommerce.orderCompletions, { skipped: true, reason: 'woocommerce_plugin_disabled' })
})

test('o3d-zvec.15: a failing drain is reported in the tick and does not throw out of it', async () => {
  state.drainThrows = true
  const body = await tick()
  assert.equal(state.drainCalls, 1, 'precondition: the throwing drain was reached')
  assert.equal((body.connectors.woocommerce.orderCompletions as { error?: string }).error, 'database unavailable')
})

test('o3d-6ldlj: cancel/hold pushes are drained with inbound sync OFF (the plugin gate only), and reported beside the completions', async () => {
  const body = await tick()
  assert.equal(state.inboxCalls, 0, 'precondition: the inbound inbox really was skipped (sync off)')
  assert.equal(state.statusDrainCalls, 1)
  assert.deepEqual(body.connectors.woocommerce.orderStatusPushes, { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0, skipped: 0, errors: [] })
})

test('o3d-6ldlj: with the WooCommerce plugin disabled neither cancel/hold pushes nor completions are drained', async () => {
  state.pluginEnabled = false
  const body = await tick()
  assert.equal(state.statusDrainCalls, 0)
  assert.equal(state.drainCalls, 0)
  assert.deepEqual(body.connectors.woocommerce.orderStatusPushes, { skipped: true, reason: 'woocommerce_plugin_disabled' })
})

test('o3d-6ldlj: a failing cancel/hold drain is reported in the tick, does not throw out of it, and does not stop the completion drain; and vice versa', async () => {
  state.statusDrainThrows = true
  const body = await tick()
  assert.equal(state.statusDrainCalls, 1, 'precondition: the throwing drain was reached')
  assert.equal((body.connectors.woocommerce.orderStatusPushes as { error?: string }).error, 'status drain unavailable')
  assert.equal(state.drainCalls, 1, 'the completion drain still ran')
  assert.deepEqual(body.connectors.woocommerce.orderCompletions, { claimed: 2, succeeded: 2, retried: 0, deadLettered: 0, skipped: 0, errors: [] })

  state.statusDrainThrows = false
  state.drainThrows = true
  const second = await tick()
  assert.equal(state.statusDrainCalls, 2, 'the cancel/hold drain ran although the completion drain threw')
  assert.equal((second.connectors.woocommerce.orderStatusPushes as { claimed?: number }).claimed, 1)
})
