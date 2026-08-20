import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHmac } from 'node:crypto'

/**
 * o3d-wgl6: a WooCommerce webhook RETRIED after a credential rebind still carries the previous
 * store's payload.
 *
 * o3d-mlc7 fenced the product import against a rebind, but that fence cannot see this case. A
 * delivery from store A sits in the inbox; the operator rebinds to store B; the inbox retries.
 * Every version the import observes is a consistent store-B, so the fence has nothing to object
 * to — and store-A ids are written under store-B credentials. Retries are routine here:
 * `syncWcProductToIms` failures are all transient by design (o3d-i0y), so a delivery can sit in
 * the inbox across a rebind.
 *
 * The fix is a `settingsVersion` stamped AT RECEIPT and replayed on every attempt. These tests
 * follow that value along the whole path: receipt -> inbox row -> claim -> connector handler ->
 * `syncWcProductToIms`'s `observedVersion`.
 */

const WC_WEBHOOK_SECRET = 'wc-secret'

const state = {
  /** `observedVersion` each syncWcProductToIms call was made with. */
  observedVersions: [] as Array<string | undefined>,
  /** What syncWcProductToIms should answer. */
  syncResult: { success: true } as Record<string, unknown>,
  stockSyncCalls: [] as unknown[],
  activity: [] as Array<Record<string, unknown>>,
  settings: new Map<string, string>(),
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
    syncWcProductToIms: async (_product: unknown, observedVersion?: string) => {
      state.observedVersions.push(observedVersion)
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
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        upsert: async () => ({}),
      },
      // Reached only if the stale delivery wrongly falls through to the stock correction.
      product: { findFirst: async () => ({ id: 'ims-1', sku: 'SKU-1' }) },
    },
  },
})

type Row = Record<string, unknown>

function wcRequest(body: string, topic = 'product.updated') {
  return new Request('https://ims.example.com/api/webhooks/woocommerce/products', {
    method: 'POST',
    headers: {
      'x-wc-webhook-topic': topic,
      'x-wc-webhook-signature': createHmac('sha256', WC_WEBHOOK_SECRET).update(body).digest('base64'),
    },
    body,
  })
}

const PRODUCT_PAYLOAD = {
  id: 4242,
  sku: 'SKU-1',
  type: 'simple',
  name: 'Widget',
  status: 'publish',
  stock_quantity: 7,
}

function reset() {
  state.observedVersions = []
  state.syncResult = { success: true }
  state.stockSyncCalls = []
  state.activity = []
  state.settings = new Map([['wc_sync_enabled', 'true'], ['wc_settings_version', '1']])
}

// --- receipt: the delivery is stamped with the version it arrived under -------------------

test('an accepted delivery records the settings version it arrived under', async () => {
  reset()
  const { handleWcWebhook } = await import('@/lib/connectors/woocommerce/webhooks')
  const body = JSON.stringify(PRODUCT_PAYLOAD)
  const persisted: Row[] = []

  const response = await handleWcWebhook('products', wcRequest(body), body, {
    getMaintenanceModeResponse: async () => null,
    verifyWebhook: async () => true,
    recordWebhookReceipt: async () => {},
    getWebhookProcessingGate: async () => ({ enabled: true }),
    getCurrentWcSettingsVersion: async () => '1',
    persistWebhookEvent: async (_repository, input) => {
      persisted.push(input as unknown as Row)
      return { status: 'created', event: { id: 'evt-1' } as never }
    },
    webhookEventRepository: {} as never,
    handleOrderWebhook: async () => new Response(null, { status: 200 }),
    handleProductWebhook: async () => new Response(null, { status: 200 }),
    handleRefundWebhook: async () => new Response(null, { status: 200 }),
  })

  assert.equal(response.status, 202)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].settingsVersion, '1')
  // It must NOT be smuggled into the body: idempotency is the sha256 of the exact signed bytes,
  // so touching the payload would break redelivery dedupe.
  assert.deepEqual(persisted[0].payload, PRODUCT_PAYLOAD)
  assert.equal(persisted[0].rawBody, body)
})

// --- retry: the stamp is replayed, not re-read -------------------------------------------

test('a RETRY replays the stamp taken at receipt, not the version current now', async () => {
  reset()
  const { processWcWebhookEvent } = await import('@/lib/jobs/woocommerce/process-shopping-webhook-events')

  // Received under version 1, and now on its third attempt — after a rebind to version 2.
  state.settings.set('wc_settings_version', '2')
  const claimed = {
    id: 'evt-1',
    connector: 'woocommerce',
    resource: 'products',
    externalEventId: null,
    topic: 'product.updated',
    payloadHash: 'hash',
    payloadJson: PRODUCT_PAYLOAD,
    settingsVersion: '1',
    status: 'PROCESSING',
    attempts: 3,
    nextAttemptAt: null,
    processedAt: null,
    lastError: null,
    receivedAt: new Date(),
    updatedAt: new Date(),
  }
  const seen: Array<string | null> = []

  const result = await processWcWebhookEvent('evt-1', {
    repository: {
      claimEvent: async () => claimed,
      markProcessed: async () => claimed,
      markFailed: async () => claimed,
      markDeadLetter: async () => claimed,
      createEvent: async () => claimed,
      findByConnectorResourceAndPayloadHash: async () => claimed,
      findDueEvents: async () => [],
    } as never,
    processPayload: (async (input: { settingsVersion: string | null }) => {
      seen.push(input.settingsVersion)
      return new Response(null, { status: 200 })
    }) as never,
  })

  assert.equal(result.status, 'processed')
  assert.deepEqual(seen, ['1'], 'the retry must carry the version the delivery was RECEIVED under')
})

// --- the connector handler: refuse, acknowledge, and write nothing ------------------------

async function dispatchProduct(settingsVersion: string | null) {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'products',
    topic: 'product.updated',
    payload: PRODUCT_PAYLOAD,
    settingsVersion,
  })
}

test('the stamped version is handed to syncWcProductToIms as its observedVersion', async () => {
  reset()
  await dispatchProduct('1')
  assert.deepEqual(state.observedVersions, ['1'])
})

test('a null stamp is a pre-migration row and keeps the old, unfenced contract', async () => {
  reset()
  await dispatchProduct(null)
  assert.deepEqual(state.observedVersions, [undefined])
})

test('a delivery refused as stale-store writes nothing, pushes no stock, and is acknowledged', async () => {
  reset()
  state.syncResult = {
    success: false,
    permanent: false,
    staleSettingsVersion: true,
    error: 'WooCommerce settings changed mid-import (version 1 -> 2)',
  }

  const response = await dispatchProduct('1')

  // ACKNOWLEDGED, not retried: the payload is frozen and wc_settings_version only increments, so
  // all ~24 retries would reach the identical refusal and dead-letter. The reconcile sweep
  // re-imports the product from the store that is actually bound now.
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, staleStoreBinding: true })

  // The forced stock correction MUST NOT run: `stock_quantity` in this body is the old store's
  // figure, and force:true bypasses the dedupe and reopens completed stock rows.
  assert.deepEqual(state.stockSyncCalls, [])

  const logged = state.activity.find((entry) => entry.action === 'wc_product_webhook_stale_store')
  assert.ok(logged, 'the refusal must be visible in the activity log')
  assert.equal(logged.level, 'ERROR')
  assert.equal((logged.metadata as Row).receivedAtSettingsVersion, '1')
  assert.equal((logged.metadata as Row).sku, 'SKU-1')
})

test('an ordinary transient failure is still retried, and is not mistaken for a stale store', async () => {
  reset()
  state.syncResult = { success: false, permanent: false, error: 'database went away' }

  const response = await dispatchProduct('1')

  assert.equal(response.status, 500, 'a transient failure must stay retryable')
  assert.equal(state.activity.some((entry) => entry.action === 'wc_product_webhook_stale_store'), false)
})

test('a delivery received under the CURRENT version imports and still corrects stock', async () => {
  reset()
  const response = await dispatchProduct('1')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(state.stockSyncCalls.length, 1)
})
