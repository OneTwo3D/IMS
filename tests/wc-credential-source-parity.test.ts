import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-ecbj: the two halves of the WooCommerce connector must resolve their API credentials
 * from the same place.
 *
 * `getWcCredentials()` (lib/connectors/woocommerce/api.ts) serves the order import, the FX
 * push, the partial-shipment push, links.ts, delivery.ts and every call that passes no
 * explicit `creds`. It reads through `getSettingValues`, which PREFERS the environment.
 *
 * `snapshotSyncContext` (sync/stock-sync.ts) and `snapshotProductSyncContext`
 * (sync/product-sync.ts) cannot: they must capture the credentials and `wc_settings_version`
 * together inside one advisory-lock transaction (o3d-mlc7), so they read the settings ROWS.
 *
 * While `wc_consumer_key` / `wc_consumer_secret` were in SETTING_ENV_FALLBACKS, a stale
 * secret in `.env` therefore made one installation import orders under the environment's
 * credential and push stock under the database's. Nothing errors: the losing half just
 * collects 401s that the sync reports as an ordinary transient WC API error.
 *
 * These tests drive the REAL entry points on both sides against one settings table with the
 * environment deliberately disagreeing with it.
 */

type Row = { key: string; value: string }

const state = {
  settings: [] as Row[],
  /** The credentials that actually went out on the wire, decoded from the Basic auth header. */
  wireCalls: [] as Array<{ url: string; key: string; secret: string }>,
}

function setSettings(rows: Row[]) {
  state.settings.splice(0, state.settings.length, ...rows)
}

function keysIn(where: unknown): string[] | null {
  const key = (where as { key?: { in?: unknown } } | undefined)?.key
  const list = (key as { in?: unknown } | undefined)?.in
  return Array.isArray(list) ? list.map(String) : null
}

const settingDelegate = {
  findMany: async ({ where }: { where?: unknown } = {}) => {
    const wanted = keysIn(where)
    if (!wanted) return state.settings.map((row) => ({ ...row }))
    return state.settings.filter((row) => wanted.includes(row.key)).map((row) => ({ ...row }))
  },
  findUnique: async ({ where }: { where: { key: string } }) =>
    state.settings.find((row) => row.key === where.key) ?? null,
  // The settings store re-encrypts a plaintext sensitive value on read when an encryption
  // key is configured. Nothing here asserts on it; it must simply not explode.
  updateMany: async () => ({ count: 0 }),
}

const dbMock = {
  setting: settingDelegate,
  warehouse: { findMany: async () => [] },
  product: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === 'ims-1'
        ? {
            id: 'ims-1',
            sku: 'SKU-1',
            name: 'Widget',
            description: '',
            salesPriceBase: null,
            salePriceBase: null,
            barcode: null,
            type: 'SIMPLE',
            externalProductId: BigInt(4242),
            lifecycleStatus: 'ACTIVE',
            parent: null,
          }
        : null,
  },
  shoppingSyncLog: { create: async () => ({ id: 'log-1' }) },
  $executeRaw: async () => 1,
  $transaction: async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(dbMock)
    return Promise.all(arg as Promise<unknown>[])
  },
}

mock.module('@/lib/db', { namedExports: { db: dbMock } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

/**
 * The HTTP boundary, not api.ts. Mocking `wcFetch`/`wcPut` would also replace the real
 * `getWcCredentials` (same module), which is half of what is under test. Recording the
 * Basic auth header instead asserts the credential that actually reached WooCommerce.
 */
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: URL | string, init?: { headers?: Record<string, string> }) => {
      const authorization = init?.headers?.Authorization ?? ''
      const [key, ...rest] = Buffer.from(authorization.replace(/^Basic /, ''), 'base64')
        .toString('utf8')
        .split(':')
      state.wireCalls.push({ url: String(url), key, secret: rest.join(':') })
      return new Response(JSON.stringify({ id: 4242, sku: 'SKU-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  },
})

const STORE_URL = 'https://store.example.com'

function withEnvCredentials<T>(key: string, secret: string, run: () => Promise<T>): Promise<T> {
  const previousKey = process.env.WC_CONSUMER_KEY
  const previousSecret = process.env.WC_CONSUMER_SECRET
  process.env.WC_CONSUMER_KEY = key
  process.env.WC_CONSUMER_SECRET = secret
  const restore = () => {
    if (previousKey == null) delete process.env.WC_CONSUMER_KEY
    else process.env.WC_CONSUMER_KEY = previousKey
    if (previousSecret == null) delete process.env.WC_CONSUMER_SECRET
    else process.env.WC_CONSUMER_SECRET = previousSecret
  }
  return run().then(
    (value) => { restore(); return value },
    (error) => { restore(); throw error },
  )
}

test('a stale WC_CONSUMER_SECRET in .env does not override the Settings row the syncs read', async () => {
  setSettings([
    { key: 'wc_url', value: STORE_URL },
    { key: 'wc_consumer_key', value: 'ck_settings' },
    { key: 'wc_consumer_secret', value: 'cs_settings' },
    { key: 'wc_settings_version', value: '7' },
  ])

  const { getWcCredentials } = await import('@/lib/connectors/woocommerce/api')
  const credentials = await withEnvCredentials('ck_stale_env', 'cs_stale_env', getWcCredentials)

  assert.deepEqual(credentials, {
    url: STORE_URL,
    key: 'ck_settings',
    secret: 'cs_settings',
  })
})

test('the order-import resolver and the product-sync advisory-lock snapshot pin the SAME credentials', async () => {
  setSettings([
    { key: 'wc_url', value: STORE_URL },
    { key: 'wc_consumer_key', value: 'ck_settings' },
    { key: 'wc_consumer_secret', value: 'cs_settings' },
    { key: 'wc_settings_version', value: '7' },
  ])
  state.wireCalls.length = 0

  const { getWcCredentials } = await import('@/lib/connectors/woocommerce/api')
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')

  const { credentials, pushResult } = await withEnvCredentials('ck_stale_env', 'cs_stale_env', async () => ({
    credentials: await getWcCredentials(),
    pushResult: await pushImsProductToWc('ims-1'),
  }))

  assert.equal(pushResult.success, true, pushResult.error)
  assert.ok(state.wireCalls.length > 0, 'the push made no WooCommerce call to observe')
  assert.deepEqual(
    [...new Set(state.wireCalls.map((call) => `${call.key}:${call.secret}`))],
    ['ck_settings:cs_settings'],
    'every call in the run must use the one pinned credential',
  )
  // What the snapshot pinned and actually sent to WooCommerce...
  assert.deepEqual(
    { key: state.wireCalls[0].key, secret: state.wireCalls[0].secret },
    { key: 'ck_settings', secret: 'cs_settings' },
  )
  // ...is what every bare wcFetch/wcPost would have used too — not one from .env and one
  // from the database.
  assert.deepEqual(credentials, {
    url: STORE_URL,
    key: state.wireCalls[0].key,
    secret: state.wireCalls[0].secret,
  })
})

test('credentials present ONLY in the environment leave BOTH paths unconfigured, not one of each', async () => {
  // The exact shape a half-applied override produced: `.env` complete, Settings never filled
  // in. The stock sync always refused this; the order import happily ran. They must agree.
  setSettings([
    { key: 'wc_url', value: STORE_URL },
    { key: 'wc_stock_sync_enabled', value: 'true' },
    { key: 'wc_settings_version', value: '7' },
  ])

  const { getWcCredentials } = await import('@/lib/connectors/woocommerce/api')
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')

  const { credentials, stockResult } = await withEnvCredentials('ck_only_env', 'cs_only_env', async () => ({
    credentials: await getWcCredentials(),
    stockResult: await pushStockToWc(),
  }))

  assert.equal(credentials, null)
  assert.equal(stockResult.message, 'WooCommerce credentials are not configured')
  assert.equal(stockResult.aborted, true)
})

test('an unusable store URL is reported as a URL problem, not as "not configured"', async () => {
  setSettings([
    { key: 'wc_url', value: 'http://169.254.169.254' },
    { key: 'wc_consumer_key', value: 'ck_settings' },
    { key: 'wc_consumer_secret', value: 'cs_settings' },
  ])

  const { getWcCredentials } = await import('@/lib/connectors/woocommerce/api')
  await assert.rejects(
    () => getWcCredentials(),
    (error: Error) => {
      assert.match(error.message, /WooCommerce/)
      assert.doesNotMatch(error.message, /not configured/)
      return true
    },
  )
})
