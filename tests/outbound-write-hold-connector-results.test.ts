import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * What each connector layer hands its callers when the outbound-write hold refuses a request, driven
 * through the REAL layers against vendor-looking URLs. The hold refuses before any DNS lookup or
 * socket, and tests/no-outbound-network.cjs would fail this file if anything tried to leave: that is
 * the precondition that "nothing was sent" is observed here, not assumed.
 */

mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({
      baseUrl: 'https://api.mintsoft.co.uk', authMode: 'api_key', staticApiKey: 'k', username: '', password: '', webhookSecret: '', clientId: '89', orderLookupConnector: null,
    }),
    getMintsoftAccessToken: async () => 'k',
    invalidateMintsoftAccessToken: async () => undefined,
  },
})

const creds = { url: 'https://shop.example.com', key: 'ck_x', secret: 'cs_x' }

test('WooCommerce wcPost/wcPut return the hold text with held:true and never throw; wcFetch (a read) is not held', async () => {
  delete process.env.WC_WRITEBACK_ALLOWED_ORIGIN
  const { wcPost, wcPut } = await import('../lib/connectors/woocommerce/api')
  console.log('precondition (wc results): no WC_WRITEBACK_ALLOWED_ORIGIN, store https://shop.example.com, no-outbound-network trap active')
  const put = await wcPut('/orders/1', { status: 'completed' }, creds)
  const post = await wcPost('/webhooks', {}, creds)
  for (const result of [put, post]) {
    assert.equal(result.held, true)
    assert.equal(result.data, null)
    assert.match(result.error ?? '', /^Outbound write HELD \(WooCommerce\)/)
    assert.match(result.error ?? '', /so nothing was sent to WooCommerce/)
  }
})

test('Mintsoft: a held write is a 500 with held:true and the hold text; a held GET /Cancel too; the key is never read as a rejection', async () => {
  delete process.env.MINTSOFT_WRITE_ALLOWED
  const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
  console.log('precondition (mintsoft results): no MINTSOFT_WRITE_ALLOWED, base https://api.mintsoft.co.uk, no-outbound-network trap active')
  const create = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
  const cancel = await mintsoftRequest('/api/Order/5/Cancel')
  for (const result of [create, cancel]) {
    assert.equal(result.held, true)
    assert.equal(result.status, 500)
    assert.match(result.error ?? '', /^Outbound write HELD \(Mintsoft\)/)
  }
})

test('the partial-shipment and FX paths report the hold text verbatim, not String(error)', async () => {
  delete process.env.WC_WRITEBACK_ALLOWED_ORIGIN
  const settings = new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 's'], ['wc_fx_push_enabled', 'true']])
  mock.module('@/lib/settings-store', {
    namedExports: { getSettingValues: async () => settings, getSettingValue: async (k: string) => settings.get(k) ?? null },
  })
  mock.module('@/lib/db', {
    namedExports: { db: { shoppingOrderLink: { findFirst: async () => ({ externalOrderId: '42' }) } } },
  })
  const { pushPartialShipmentToWc } = await import('../lib/connectors/woocommerce/sync/partial-shipment')
  const { pushFxRatesToWc } = await import('../lib/connectors/woocommerce/fx-rates')
  const partial = await pushPartialShipmentToWc('order-1', { part: 1, totalParts: 2, trackingNumber: 'T', items: [{ sku: 'A', qty: 1 }] })
  assert.equal(partial.ok, false)
  assert.match(partial.error ?? '', /^Outbound write HELD \(WooCommerce\)/, 'not prefixed with the error class')
  const fx = await pushFxRatesToWc([{ currency: 'USD', rate: 1.2 } as never])
  assert.equal(fx.pushed, 0)
  assert.match(fx.errors[0] ?? '', /^Outbound write HELD \(WooCommerce\)/)
})
