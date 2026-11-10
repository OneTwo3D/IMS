import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHmac } from 'node:crypto'

/**
 * Order and refund deliveries are judged on the store that sent them, as products are
 * (tests/wc-product-webhook-store-origin.test.ts). A staging clone copies the webhook secret and
 * delivery URL, so a signature alone does not say which store an order came from.
 */

const WC_WEBHOOK_SECRET = 'wc-secret'

const state = {
  /** Every argument list `syncWcProductToIms` was called with. */
  syncCalls: [] as unknown[][],
  syncResult: { success: true } as Record<string, unknown>,
  stockSyncCalls: [] as unknown[],
  activity: [] as Array<Record<string, unknown>>,
  settings: new Map<string, string>(),
  /** Every settings key the handler read, so a version-based decision cannot hide. */
  settingReads: [] as string[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/jobs/shopping/drain-inbox', { namedExports: { scheduleInboxDrain: () => {} } })
mock.module('@/lib/connectors/woocommerce/sync/webhook-verify', {
  namedExports: {
    verifyWcWebhook: async (body: string, signature: string | null) =>
      signature === createHmac('sha256', WC_WEBHOOK_SECRET).update(body).digest('base64'),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: {
    syncWcProductToIms: async (...args: unknown[]) => {
      state.syncCalls.push(args)
      return state.syncResult
    },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async (...args: unknown[]) => { state.stockSyncCalls.push(args) },
    recordIncomingWcWebhook: async () => {},
    shouldSuppressWcWebhookEcho: async () => false,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          state.settingReads.push(where.key)
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        upsert: async () => ({}),
      },
      // Reached only if a refused delivery wrongly falls through to the stock correction.
      product: { findFirst: async () => ({ id: 'ims-1', sku: 'SKU-1' }) },
    },
  },
})


type Row = Record<string, unknown>

const STORE_A = 'https://store-a.example.com'

function reset() {
  state.activity = []
  state.settings = new Map([['wc_sync_enabled', 'true'], ['wc_url', STORE_A]])
}

function spies() {
  const calls = { order: [] as unknown[], refund: [] as unknown[] }
  const dependencies = {
    handleOrderWebhook: async (payload: unknown) => { calls.order.push(payload); return Response.json({ ok: true, imported: true }) },
    handleRefundWebhook: async (payload: unknown) => { calls.refund.push(payload); return Response.json({ ok: true, imported: true }) },
    handleProductWebhook: async () => Response.json({ ok: true }),
  }
  return { calls, dependencies }
}

async function dispatch(
  resource: 'orders' | 'refunds',
  originAttestation: string,
  payload: unknown,
  dependencies: ReturnType<typeof spies>['dependencies'],
) {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload(
    { resource, topic: resource === 'orders' ? 'order.created' : 'order.refunded', payload, originAttestation },
    dependencies,
  )
}

const ORDER = { id: 9001, status: 'processing' }
const REFUND = { id: 77, order_id: 9001 }

for (const [resource, payload, key] of [
  ['orders', ORDER, 'order'],
  ['refunds', REFUND, 'refund'],
] as const) {
  test(`${key}: a delivery from another store is refused, logged and acknowledged, never imported`, async () => {
    reset()
    const { calls, dependencies } = spies()

    const response = await dispatch(resource, 'store:store-b.example.com', payload, dependencies)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, foreignStore: true, verdict: 'foreign-store' })
    assert.deepEqual(calls[key], [], 'nothing may be imported from a store we are not bound to')
    const logged = state.activity.find((entry) => entry.action === `wc_${key}_webhook_foreign_store`)
    assert.ok(logged, 'the refusal must be visible in the activity log')
    assert.equal(logged.level, 'ERROR')
    assert.equal((logged.metadata as Row).deliveryStore, 'store-b.example.com')
    assert.equal((logged.metadata as Row).boundStore, 'store-a.example.com')
  })

  test(`${key}: a delivery that does not say which store sent it is refused`, async () => {
    reset()
    const { calls, dependencies } = spies()

    const response = await dispatch(resource, 'unproven:not-stated', payload, dependencies)

    assert.deepEqual(await response.json(), { ok: true, foreignStore: true, verdict: 'unproven' })
    assert.deepEqual(calls[key], [])
    assert.ok(state.activity.some((entry) => entry.action === `wc_${key}_webhook_foreign_store`))
  })

  test(`${key}: a delivery from the bound store is imported (www. and scheme differences are the same store)`, async () => {
    reset()
    state.settings.set('wc_url', 'http://www.store-a.example.com/')
    const { calls, dependencies } = spies()

    const response = await dispatch(resource, 'store:store-a.example.com', payload, dependencies)

    assert.deepEqual(await response.json(), { ok: true, imported: true })
    assert.equal(calls[key].length, 1)
    assert.deepEqual(state.activity, [])
  })

  test(`${key}: an unreadable binding HOLDS the delivery (503, retried, visible), neither importing nor dropping it`, async () => {
    reset()
    state.settings.delete('wc_url')
    const { calls, dependencies } = spies()

    const response = await dispatch(resource, 'store:store-a.example.com', payload, dependencies)

    assert.equal(response.status, 503, 'a retryable status: the inbox retries, then dead-letters visibly')
    assert.equal((await response.json() as Row).held, true)
    assert.deepEqual(calls[key], [])
    const logged = state.activity.find((entry) => entry.action === `wc_${key}_webhook_held`)
    assert.ok(logged, 'the hold must be visible to an operator')
    assert.equal(logged.level, 'ERROR')
    assert.equal((logged.metadata as Row).verdict, 'binding-unreadable')
  })

  test(`${key}: evidence of only a location UNDER the store (permalink/self-link) is held, not accepted`, async () => {
    reset()
    const { calls, dependencies } = spies()

    const response = await dispatch(resource, 'store-under:store-a.example.com/shop/order/9001', payload, dependencies)

    assert.equal(response.status, 503)
    assert.deepEqual(calls[key], [])
    const logged = state.activity.find((entry) => entry.action === `wc_${key}_webhook_held`)
    assert.ok(logged)
    assert.equal((logged.metadata as Row).originScope, 'under')
  })
}
