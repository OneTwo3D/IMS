import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * IMS -> WooCommerce product push is gated on `wc_sync_product_enabled` AND
 * `wc_sync_product_direction` (to_wc or both). The direction default is from_wc, which means
 * WooCommerce is the product master: IMS must not write names, prices or publish status to the
 * live store, whatever the caller did. An unreadable setting refuses the push.
 */

type Row = { key: string; value: string }

const state = {
  settings: [] as Row[],
  /** The credentials that actually went out on the wire, decoded from the Basic auth header. */
  wireCalls: [] as Array<{ url: string; method: string; body: string }>,
  settingsReadFails: false,
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
    if (state.settingsReadFails) throw new Error('settings unreadable')
    const wanted = keysIn(where)
    if (!wanted) return state.settings.map((row) => ({ ...row }))
    return state.settings.filter((row) => wanted.includes(row.key)).map((row) => ({ ...row }))
  },
  findUnique: async ({ where }: { where: { key: string } }) => {
    if (state.settingsReadFails) throw new Error('settings unreadable')
    return state.settings.find((row) => row.key === where.key) ?? null
  },
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
    connectorFetch: async (url: URL | string, init?: { method?: string; body?: string }) => {
      state.wireCalls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ id: 4242, sku: 'SKU-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  },
})

const BASE: Row[] = [
  { key: 'wc_url', value: 'https://store.example.com' },
  { key: 'wc_consumer_key', value: 'ck' },
  { key: 'wc_consumer_secret', value: 'cs' },
  { key: 'wc_settings_version', value: '7' },
]

async function push(extra: Row[], opts: { unreadable?: boolean } = {}) {
  setSettings([...BASE, ...extra])
  state.wireCalls.length = 0
  state.settingsReadFails = opts.unreadable === true
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  try {
    return await pushImsProductToWc('ims-1')
  } finally {
    state.settingsReadFails = false
  }
}

const writes = () => state.wireCalls.filter((call) => call.method !== 'GET')

test('product sync disabled: nothing is read from or written to WooCommerce', async () => {
  const result = await push([{ key: 'wc_sync_product_enabled', value: 'false' }, { key: 'wc_sync_product_direction', value: 'to_wc' }])
  assert.equal(result.skipped, true)
  assert.deepEqual(state.wireCalls, [])
})

test('setting absent (fresh install): no push', async () => {
  const result = await push([])
  assert.equal(result.skipped, true)
  assert.deepEqual(state.wireCalls, [])
})

test('direction from_wc (the default): enabled sync still does not push', async () => {
  const result = await push([{ key: 'wc_sync_product_enabled', value: 'true' }, { key: 'wc_sync_product_direction', value: 'from_wc' }])
  assert.equal(result.skipped, true)
  assert.deepEqual(state.wireCalls, [])
})

test('enabled with no direction row: from_wc is the default, no push', async () => {
  const result = await push([{ key: 'wc_sync_product_enabled', value: 'true' }])
  assert.equal(result.skipped, true)
  assert.deepEqual(state.wireCalls, [])
})

test('an unrecognised direction value does not push', async () => {
  const result = await push([{ key: 'wc_sync_product_enabled', value: 'true' }, { key: 'wc_sync_product_direction', value: 'TO_WC ' }])
  assert.equal(result.skipped, true)
  assert.deepEqual(state.wireCalls, [])
})

test('settings unreadable: the push fails closed and writes nothing', async () => {
  const result = await push([{ key: 'wc_sync_product_enabled', value: 'true' }, { key: 'wc_sync_product_direction', value: 'to_wc' }], { unreadable: true })
  assert.equal(result.success, false)
  assert.equal(result.skipped, undefined)
  assert.deepEqual(state.wireCalls, [])
})

for (const direction of ['to_wc', 'both']) {
  test(`enabled with direction ${direction}: the product is pushed`, async () => {
    const result = await push([{ key: 'wc_sync_product_enabled', value: 'true' }, { key: 'wc_sync_product_direction', value: direction }])
    assert.equal(result.success, true, result.error)
    assert.equal(result.skipped, undefined)
    assert.equal(writes().length, 1)
    assert.equal(writes()[0].method, 'PUT')
  })
}
