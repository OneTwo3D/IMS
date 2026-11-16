import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-mu0a: the GTIN/MPN identifier split on the WooCommerce side.
 *
 * IMS -> WooCommerce writes are behind `product_identifier_split_enabled` (default off). With it off the PUT body is
 * what IMS has always sent (`global_unique_id` for any all-digits barcode, no meta_data); with it on `global_unique_id`
 * is gated on isGtin and the MPN is written to Yoast's identifier store, where the sync plugin writes it.
 */

type Row = { key: string; value: string }
const GTIN = '4006381333931'

const state = {
  settings: [] as Row[],
  product: {} as Record<string, unknown>,
  /** The WooCommerce object GET answers with. */
  wcObject: {} as Record<string, unknown>,
  wireCalls: [] as Array<{ url: string; method: string; body: string }>,
  logs: [] as Array<Record<string, unknown>>,
  /** What a PUT answers with; null echoes the request's meta_data back (a WooCommerce that stores it). */
  putResponse: null as Record<string, unknown> | null,
}

const dbMock = {
  setting: {
    findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
      const wanted = where?.key?.in
      return state.settings.filter((row) => !wanted || wanted.includes(row.key)).map((row) => ({ ...row }))
    },
    findUnique: async ({ where }: { where: { key: string } }) => state.settings.find((row) => row.key === where.key) ?? null,
    updateMany: async () => ({ count: 0 }),
  },
  warehouse: { findMany: async () => [] },
  product: { findUnique: async () => state.product },
  shoppingSyncLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.logs.push(data); return { id: 'log-1' } } },
  $executeRaw: async () => 1,
  $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(dbMock) : Promise.all(arg as Promise<unknown>[])),
}
mock.module('@/lib/db', { namedExports: { db: dbMock } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: URL | string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const body = String(init?.body ?? '')
      state.wireCalls.push({ url: String(url), method, body })
      let payload: Record<string, unknown> = state.wcObject
      if (method === 'PUT') {
        payload = state.putResponse ?? { ...state.wcObject, meta_data: (JSON.parse(body) as { meta_data?: unknown }).meta_data ?? state.wcObject.meta_data }
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  },
})

const BASE: Row[] = [
  { key: 'wc_url', value: 'https://store.example.com' },
  { key: 'wc_consumer_key', value: 'ck' },
  { key: 'wc_consumer_secret', value: 'cs' },
  { key: 'wc_settings_version', value: '7' },
  { key: 'wc_sync_product_enabled', value: 'true' },
  { key: 'wc_sync_product_direction', value: 'to_wc' },
]

async function push(over: { flag?: string; product?: Record<string, unknown>; meta?: unknown[]; variation?: boolean }) {
  state.settings = [...BASE, ...(over.flag === undefined ? [] : [{ key: 'product_identifier_split_enabled', value: over.flag }])]
  state.product = {
    id: 'ims-1', sku: 'SKU-1', name: 'Widget', salesPriceBase: null, salePriceBase: null, barcode: null, mpn: null,
    type: over.variation ? 'VARIANT' : 'SIMPLE', externalProductId: BigInt(4242), lifecycleStatus: 'ACTIVE',
    parent: over.variation ? { sku: 'PARENT', externalProductId: BigInt(99) } : null,
    ...over.product,
  }
  state.wcObject = { id: 4242, sku: 'SKU-1', meta_data: over.meta ?? [] }
  state.wireCalls.length = 0
  state.logs.length = 0
  state.putResponse = null
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const result = await pushImsProductToWc('ims-1')
  const put = state.wireCalls.find((call) => call.method === 'PUT')
  return { result, put, body: put ? JSON.parse(put.body) as Record<string, unknown> : null }
}

const LEGACY_ALL_DIGITS_BODY = '{"name":"Widget","status":"publish","sale_price":"","global_unique_id":"00000287"}'

test('flag OFF (absent): the PUT body is byte-identical to the legacy body, even with an mpn on the product', async () => {
  const { result, put } = await push({ product: { barcode: '00000287', mpn: 'LN00000282' } })
  assert.equal(result.success, true)
  assert.equal(put?.body, LEGACY_ALL_DIGITS_BODY, 'an all-digits counter is still pushed as global_unique_id, exactly as before')
  assert.equal(state.logs[0]?.errorMessage, undefined)
})

test('flag OFF for every non-true value, and for a part number: same legacy body', async () => {
  for (const flag of ['false', '', 'TRUE', '1', ' true']) {
    const { put } = await push({ flag, product: { barcode: '00000287', mpn: 'LN1' } })
    assert.equal(put?.body, LEGACY_ALL_DIGITS_BODY, `flag ${JSON.stringify(flag)}`)
  }
  const letters = await push({ product: { barcode: 'LN00000287', mpn: 'LN1' } })
  assert.equal(letters.put?.body, '{"name":"Widget","status":"publish","sale_price":""}')
})

test('flag ON: a zero-padded counter is not sent as global_unique_id; it is written as the MPN', async () => {
  const { result, body } = await push({ flag: 'true', product: { barcode: '00000287', mpn: null } })
  assert.equal(result.success, true)
  assert.equal('global_unique_id' in body!, false)
  assert.deepEqual(body!.meta_data, [{
    key: 'wpseo_global_identifier_values',
    value: { gtin8: '', gtin12: '', gtin13: '', gtin14: '', isbn: '', mpn: '00000287' },
  }])
})

test('flag ON: a real GTIN goes to global_unique_id and the MPN to Yoast, preserving the store\'s other sub-keys', async () => {
  const meta = [{ id: 7, key: 'wpseo_global_identifier_values', value: { gtin13: '9999999999994', isbn: 'x', mpn: '' } }]
  const { body } = await push({ flag: 'true', product: { barcode: GTIN, mpn: 'LN00000287' }, meta })
  assert.equal(body!.global_unique_id, GTIN)
  assert.deepEqual(body!.meta_data, [{
    key: 'wpseo_global_identifier_values',
    value: { gtin8: '', gtin12: '', gtin13: '9999999999994', gtin14: '', isbn: 'x', mpn: 'LN00000287' },
  }])
})

test('flag ON: a variation writes the VARIATION identifier key, not the parent one', async () => {
  const { body } = await push({ flag: 'true', variation: true, product: { barcode: null, mpn: 'LN00000008' } })
  const written = body!.meta_data as Array<{ key: string }>
  assert.deepEqual(written.map((entry) => entry.key), ['wpseo_variation_global_identifiers_values'])
})

test('flag ON: an MPN already stored is not written again', async () => {
  const meta = [{ key: 'wpseo_global_identifier_values', value: { mpn: 'LN00000287' } }]
  const { body } = await push({ flag: 'true', product: { barcode: null, mpn: 'LN00000287' }, meta })
  assert.equal('meta_data' in body!, false)
})

test('flag ON: an identifier store in an unrecognised shape is left untouched and the refusal is recorded, not silent', async () => {
  const meta = [{ key: 'wpseo_global_identifier_values', value: 'a:1:{s:4:"mpn";s:1:"x";}' }]
  const { result, body } = await push({ flag: 'true', product: { barcode: null, mpn: 'LN1' }, meta })
  assert.equal(result.success, true)
  assert.equal('meta_data' in body!, false)
  assert.match(String(result.warning), /unrecognised shape/)
  assert.match(String(state.logs[0]?.errorMessage), /unrecognised shape/)
})

test('flag ON: two part numbers on one product: the second is reported, never dropped silently', async () => {
  const { result, body } = await push({ flag: 'true', product: { barcode: 'LN00000059', mpn: 'LN00000282' } })
  assert.equal((body!.meta_data as Array<{ value: { mpn: string } }>)[0]!.value.mpn, 'LN00000282')
  assert.match(String(result.warning), /LN00000059/)
})

test('flag ON: WooCommerce answering 200 without storing the MPN is a failed push', async () => {
  state.settings = [...BASE, { key: 'product_identifier_split_enabled', value: 'true' }]
  state.product = { id: 'ims-1', sku: 'SKU-1', name: 'Widget', salesPriceBase: null, salePriceBase: null, barcode: null, mpn: 'LN1', type: 'SIMPLE', externalProductId: BigInt(4242), lifecycleStatus: 'ACTIVE', parent: null }
  state.wcObject = { id: 4242, sku: 'SKU-1', meta_data: [] }
  state.putResponse = { id: 4242, sku: 'SKU-1', meta_data: [] }
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const result = await pushImsProductToWc('ims-1')
  assert.equal(result.success, false)
  assert.match(String(result.error), /did not store the MPN/)
})

test('planWcIdentifierWrite: Yoast empty placeholders are safe to create over, other shapes are not', async () => {
  const { planWcIdentifierWrite } = await import('@/lib/connectors/woocommerce/sync/product-identifiers')
  for (const placeholder of ['', [], null]) {
    const plan = planWcIdentifierWrite({ barcode: null, mpn: 'M1', currentMeta: [{ key: 'wpseo_global_identifier_values', value: placeholder }], isVariation: false })
    assert.equal(plan.payload.meta_data?.[0]?.value.mpn, 'M1')
  }
  for (const odd of [['x'], 12, true]) {
    const plan = planWcIdentifierWrite({ barcode: null, mpn: 'M1', currentMeta: [{ key: 'wpseo_global_identifier_values', value: odd }], isVariation: false })
    assert.equal(plan.payload.meta_data, undefined)
    assert.ok(plan.warning)
  }
  const none = planWcIdentifierWrite({ barcode: null, mpn: null, currentMeta: undefined, isVariation: false })
  assert.deepEqual(none, { payload: {} })
})
