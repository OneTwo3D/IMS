import assert from 'node:assert/strict'
import test from 'node:test'
import { WOOCOMMERCE_INTEGRATION_NOT_CONFIGURED_ERROR, wcFetch, wcPost, wcPut } from '../lib/connectors/woocommerce/api.ts'

const unsafeCredentials = {
  url: 'https://127.0.0.1:8443',
  key: 'ck_test',
  secret: 'cs_test',
}

test('WooCommerce API wrappers reject unsafe explicit credentials before network fetch', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  let fetchCalls = 0
  const warnings: unknown[][] = []
  globalThis.fetch = (() => {
    fetchCalls += 1
    throw new Error('fetch should not be called')
  }) as typeof fetch
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }

  try {
    assert.deepEqual(await wcFetch('/products', {}, unsafeCredentials), {
      data: null,
      totalPages: 0,
      totalItems: 0,
      error: WOOCOMMERCE_INTEGRATION_NOT_CONFIGURED_ERROR,
    })
    assert.deepEqual(await wcPost('/products', {}, unsafeCredentials), {
      data: null,
      error: WOOCOMMERCE_INTEGRATION_NOT_CONFIGURED_ERROR,
    })
    assert.deepEqual(await wcPut('/products/1', {}, unsafeCredentials), {
      data: null,
      error: WOOCOMMERCE_INTEGRATION_NOT_CONFIGURED_ERROR,
    })
    assert.equal(fetchCalls, 0)
    assert.match(JSON.stringify(warnings), /loopback/)
    assert.equal(JSON.stringify(warnings).includes('wc_url'), false)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})
