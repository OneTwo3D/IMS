import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-gtk: what handleProductWebhook does with the permanent/transient classification.
//
// A PERMANENT mapping conflict is a resolved outcome, not a pending one — re-delivering the same
// payload re-hits the same constraint — so the delivery is acknowledged (2xx) and logged loudly at
// ERROR instead of retrying ~24 times into the inbox dead-letter queue. A TRANSIENT failure keeps
// today's behaviour and stays on the branch o3d-i0y (PR #551) converts into a retryable 500.

type LoggedActivity = {
  action?: string
  level?: string
  description?: string
  metadata?: Record<string, unknown>
}

const activityLog: LoggedActivity[] = []
let syncResult: { success: boolean; error?: string; permanent?: boolean } = { success: true }
const settingUpserts: string[] = []

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => {
      activityLog.push(entry)
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: {
    syncWcProductToIms: async () => syncResult,
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        // o3d-wgl6: the handler reads the bound store URL first; these tests are about the
        // permanent/transient split, so every delivery names the store that is bound.
        findUnique: async ({ where }: { where: { key: string } }) =>
          where.key === 'wc_url' ? { key: 'wc_url', value: 'https://shop.example.com' } : null,
        upsert: async ({ where }: { where: { key: string } }) => {
          settingUpserts.push(where.key)
          return {}
        },
      },
      product: { findFirst: async () => null },
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', {
  namedExports: {
    enqueueAndProcessImmediateWcStockSync: async () => {},
    recordIncomingWcWebhook: async () => {},
    shouldSuppressWcWebhookEcho: async () => false,
  },
})

const PRODUCT_PAYLOAD = {
  id: 42,
  sku: 'WIDGET-1',
  type: 'simple',
  name: 'Widget',
  status: 'publish',
}

async function processProductWebhook() {
  const { processWcWebhookPayload } = await import('@/lib/connectors/woocommerce/webhooks')
  return processWcWebhookPayload({
    resource: 'products',
    topic: 'product.updated',
    payload: PRODUCT_PAYLOAD,
    originAttestation: 'store:shop.example.com',
  })
}

function reset() {
  activityLog.length = 0
  settingUpserts.length = 0
}

test('a PERMANENT mapping conflict is acknowledged and logged as rejected, not retried (o3d-gtk)', async () => {
  reset()
  syncResult = {
    success: false,
    permanent: true,
    error: 'Unique constraint failed on the fields: (`barcode`)',
  }

  const response = await processProductWebhook()

  assert.ok(response.status < 400, `a permanent conflict must be ACKNOWLEDGED, got ${response.status}`)

  const rejected = activityLog.find((entry) => entry.action === 'wc_product_webhook_rejected')
  assert.ok(rejected, 'the rejection must be logged loudly so an operator can act on it')
  assert.equal(rejected.level, 'ERROR', 'nothing will import this product until the duplicate is resolved')
  assert.equal(rejected.metadata?.permanent, true)
  assert.equal(rejected.metadata?.sku, 'WIDGET-1')
  // Two kinds of permanent conflict reach this branch — a mapping collision (o3d-gtk/o3d-fsi)
  // and a structure refusal (o3d-y89x) — so the operator-facing line must name both remedies
  // rather than sending them hunting a duplicate SKU that may not exist.
  assert.match(String(rejected.description), /permanent mapping or structure conflict/i)
  assert.match(String(rejected.description), /\/sync\/exceptions/, 'and points at the inbox')
  assert.equal(rejected.metadata?.error, 'Unique constraint failed on the fields: (`barcode`)',
    'the specific conflict still travels in the metadata')

  assert.equal(
    activityLog.some((entry) => entry.action === 'wc_product_webhook'),
    false,
    'a permanent rejection must not also be logged as a plain retryable failure',
  )
  assert.equal(
    settingUpserts.includes('last_wc_product_sync_at'),
    false,
    'a rejected product must not advance the shared product cursor',
  )
})

test('a TRANSIENT failure keeps the retryable failure log (o3d-gtk)', async () => {
  reset()
  syncResult = { success: false, error: 'Timed out fetching a new connection from the connection pool' }

  await processProductWebhook()

  assert.equal(
    activityLog.some((entry) => entry.action === 'wc_product_webhook_rejected'),
    false,
    'a transient failure must NEVER be acknowledged as a permanent rejection',
  )
  const failed = activityLog.find((entry) => entry.action === 'wc_product_webhook')
  assert.ok(failed, 'it stays on the retryable branch')
  assert.equal(failed.level, 'WARNING')
})

test('a successful import still advances the product cursor (o3d-gtk regression guard)', async () => {
  reset()
  syncResult = { success: true }

  const response = await processProductWebhook()

  assert.ok(response.status < 400)
  assert.ok(settingUpserts.includes('last_wc_product_sync_at'), 'success advances the cursor')
  assert.equal(activityLog.length, 0, 'a clean import logs nothing')
})
