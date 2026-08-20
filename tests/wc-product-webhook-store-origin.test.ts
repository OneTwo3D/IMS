import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createHmac } from 'node:crypto'

/**
 * o3d-wgl6: a WooCommerce webhook processed AFTER a credential rebind still carries the
 * previous store's payload.
 *
 * o3d-mlc7 fenced the product import against a rebind, but that fence cannot see this case. A
 * delivery from store A sits in the inbox; the operator rebinds to store B; the inbox retries.
 * Every settings value the import observes is a consistent store-B, so the fence has nothing to
 * object to — and store-A ids are written under store-B credentials. Retries are routine here:
 * `syncWcProductToIms` failures are all transient by design (o3d-i0y), so a delivery can sit in
 * the inbox across a rebind.
 *
 * The first fix stamped the delivery with the settings VERSION current at receipt. These tests
 * exist largely to pin down why that was wrong and is not coming back:
 *
 *   - a stamp taken on OUR side records when we saw the delivery, not who sent it, so a
 *     delivery in flight across the rebind is stamped with the NEW version and passes; and
 *   - the version moves for things that are not a store change at all (a same-store key
 *     rotation, a product-id cache reset), so it refused deliveries that were perfectly valid.
 *
 * What is recorded instead is the store's own statement of its identity, carried in the
 * delivery. It does not move while the row waits in the inbox.
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
const STORE_B = 'https://store-b.example.com'

function wcRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('https://ims.example.com/api/webhooks/woocommerce/products', {
    method: 'POST',
    headers: {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-signature': createHmac('sha256', WC_WEBHOOK_SECRET).update(body).digest('base64'),
      ...headers,
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
  state.syncCalls = []
  state.syncResult = { success: true }
  state.stockSyncCalls = []
  state.activity = []
  state.settings = new Map([['wc_sync_enabled', 'true'], ['wc_url', STORE_A]])
  state.settingReads = []
}

async function receive(
  body: string,
  headers: Record<string, string> = {},
): Promise<Row[]> {
  const { handleWcWebhook } = await import('@/lib/connectors/woocommerce/webhooks')
  const persisted: Row[] = []
  const response = await handleWcWebhook('products', wcRequest(body, headers), body, {
    getMaintenanceModeResponse: async () => null,
    verifyWebhook: async () => true,
    recordWebhookReceipt: async () => {},
    getWebhookProcessingGate: async () => ({ enabled: true }),
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
  return persisted
}

async function dispatchProduct(originAttestation: string) {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'products',
    topic: 'product.updated',
    payload: PRODUCT_PAYLOAD,
    originAttestation,
  })
}

function refusal() {
  return state.activity.find((entry) => entry.action === 'wc_product_webhook_foreign_store')
}

// --- receipt: what the STORE said, not what our settings said ------------------------------

test('receipt records the store the delivery names, from the delivery itself', async () => {
  reset()
  const body = JSON.stringify(PRODUCT_PAYLOAD)

  const persisted = await receive(body, { 'x-wc-webhook-source': `${STORE_A}/` })

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].originAttestation, 'store:store-a.example.com')
  // NOT smuggled into the body: idempotency is the sha256 of the exact signed bytes, so
  // touching the payload would break redelivery dedupe.
  assert.deepEqual(persisted[0].payload, PRODUCT_PAYLOAD)
  assert.equal(persisted[0].rawBody, body)
})

test('a delivery ALREADY IN FLIGHT when the rebind lands is recorded as the OLD store', async () => {
  reset()
  // The rebind has committed: every setting now says store B. The delivery was sent by store A
  // moments earlier and is only now being accepted. This is the exact case a receipt-time
  // settings stamp gets wrong — it would record store B and wave the store-A body through.
  state.settings.set('wc_url', STORE_B)
  const body = JSON.stringify(PRODUCT_PAYLOAD)

  const persisted = await receive(body, { 'x-wc-webhook-source': `${STORE_A}/` })

  assert.equal(persisted[0].originAttestation, 'store:store-a.example.com')
})

test('with no source header, the signed body is asked instead', async () => {
  reset()
  // `permalink` is inside the HMAC-signed body, so it is the stronger of the two statements —
  // it is the fallback only because it is not present on every resource.
  const body = JSON.stringify({ ...PRODUCT_PAYLOAD, permalink: `${STORE_A}/product/widget/` })

  const persisted = await receive(body)

  assert.equal(persisted[0].originAttestation, 'store:store-a.example.com')
})

test('a delivery that names no store records THAT, positively, rather than a blank', async () => {
  reset()
  const body = JSON.stringify(PRODUCT_PAYLOAD)

  const persisted = await receive(body)

  assert.equal(persisted[0].originAttestation, 'unproven:not-stated')
})

// --- retry: the recorded origin is replayed, never re-derived ------------------------------

test('a RETRY carries the origin recorded at receipt, not anything read now', async () => {
  reset()
  const { processWcWebhookEvent } = await import('@/lib/jobs/woocommerce/process-shopping-webhook-events')

  state.settings.set('wc_url', STORE_B)
  const claimed = {
    id: 'evt-1',
    connector: 'woocommerce',
    resource: 'products',
    externalEventId: null,
    topic: 'product.updated',
    payloadHash: 'hash',
    payloadJson: PRODUCT_PAYLOAD,
    originAttestation: 'store:store-a.example.com',
    status: 'PROCESSING',
    attempts: 3,
    nextAttemptAt: null,
    processedAt: null,
    lastError: null,
    receivedAt: new Date(),
    updatedAt: new Date(),
  }
  const seen: string[] = []

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
    processPayload: (async (input: { originAttestation: string }) => {
      seen.push(input.originAttestation)
      return new Response(null, { status: 200 })
    }) as never,
  })

  assert.equal(result.status, 'processed')
  assert.deepEqual(seen, ['store:store-a.example.com'], 'the retry must carry the SENDING store')
})

// --- the handler: refuse a foreign store, write nothing, push no stock ----------------------

test('a delivery from the previous store imports nothing, pushes no stock, and is acknowledged', async () => {
  reset()
  state.settings.set('wc_url', STORE_B)

  const response = await dispatchProduct('store:store-a.example.com')

  // ACKNOWLEDGED, not retried: the payload is frozen, so no retry can make a store-A body
  // describe store B — all ~24 attempts would reach this refusal and dead-letter.
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, foreignStore: true, verdict: 'foreign-store' })

  assert.deepEqual(state.syncCalls, [], 'nothing may be imported from a store we are not bound to')
  // The forced stock correction is the second door into the same cross-store write:
  // `stock_quantity` here is store A's figure, and force:true bypasses the echo dedupe and
  // reopens completed stock rows.
  assert.deepEqual(state.stockSyncCalls, [])

  const logged = refusal()
  assert.ok(logged, 'the refusal must be visible in the activity log')
  assert.equal(logged.level, 'ERROR')
  assert.equal((logged.metadata as Row).verdict, 'foreign-store')
  assert.equal((logged.metadata as Row).deliveryHost, 'store-a.example.com')
  assert.equal((logged.metadata as Row).boundHost, 'store-b.example.com')
})

test('a same-store credential rotation does NOT suppress the import or the stock correction', async () => {
  reset()
  // A key rotation and a "reset cached product IDs" both bump `wc_settings_version` while
  // leaving the store exactly where it was. Judging the delivery on the version refused these;
  // judging it on who sent it does not.
  state.settings.set('wc_settings_version', '9')

  const response = await dispatchProduct('store:store-a.example.com')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(state.syncCalls.length, 1)
  assert.equal(state.stockSyncCalls.length, 1, 'a legitimate stock correction must still run')
  assert.equal(refusal(), undefined)
  assert.equal(
    state.settingReads.includes('wc_settings_version'),
    false,
    'the delivery is judged on WHO SENT IT, never on a version that moves for reasons that are not a store change',
  )
})

test('the import is not given an observedVersion — the origin check is what fences a delivery', async () => {
  reset()
  await dispatchProduct('store:store-a.example.com')
  assert.deepEqual(state.syncCalls.map((args) => args.length), [1])
})

test('a `www.` difference between the bound URL and the store\'s own is the SAME store', async () => {
  reset()
  state.settings.set('wc_url', 'https://www.store-a.example.com')

  const response = await dispatchProduct('store:store-a.example.com')

  assert.equal(response.status, 200)
  assert.equal(state.syncCalls.length, 1, 'a canonical-host difference must not refuse a real delivery')
})

// --- rows that cannot name their sender ----------------------------------------------------

test('a PRE-MIGRATION row is refused, not waved through, and says which era wrote it', async () => {
  reset()
  // The o3d-t74p leniency in one line: a row that no code ever examined must not read as
  // "fine". It names no store, and nothing about it can ever be proven, so it is refused —
  // and the marker says it is a pre-migration row rather than a modern one that found nothing.
  const response = await dispatchProduct('unproven:pre-attestation')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, foreignStore: true, verdict: 'unproven' })
  assert.deepEqual(state.syncCalls, [])
  assert.deepEqual(state.stockSyncCalls, [])
  assert.equal((refusal()?.metadata as Row).originAttestation, 'unproven:pre-attestation')
})

test('a modern row that found no store is refused too, and is told apart from a pre-migration one', async () => {
  reset()

  const response = await dispatchProduct('unproven:not-stated')

  assert.equal(response.status, 200)
  assert.deepEqual(state.syncCalls, [])
  assert.equal((refusal()?.metadata as Row).originAttestation, 'unproven:not-stated')
})

test('an unreadable OWN binding lets the delivery through rather than discarding it', async () => {
  reset()
  // The delivery named a store; it is `wc_url` that is missing. That is our misconfiguration,
  // fixed in minutes — acknowledging (and so permanently discarding) valid deliveries over it
  // would be the wrong direction. The import fails "not configured" and retries instead.
  state.settings.delete('wc_url')
  state.syncResult = { success: false, permanent: false, error: 'WooCommerce integration is not configured.' }

  const response = await dispatchProduct('store:store-a.example.com')

  assert.equal(response.status, 500, 'it must stay retryable, not be acknowledged away')
  assert.equal(state.syncCalls.length, 1)
  assert.equal(refusal(), undefined)
})

test('an ordinary transient failure is still retried, and is not mistaken for a foreign store', async () => {
  reset()
  state.syncResult = { success: false, permanent: false, error: 'database went away' }

  const response = await dispatchProduct('store:store-a.example.com')

  assert.equal(response.status, 500)
  assert.equal(refusal(), undefined)
})
