import assert from 'node:assert/strict'
import test from 'node:test'
import { wcFetch, wcPost, wcPut } from '../lib/connectors/woocommerce/api.ts'

const unsafeCredentials = {
  url: 'https://127.0.0.1:8443',
  key: 'ck_test',
  secret: 'cs_test',
}

test('WooCommerce API wrappers reject unsafe explicit credentials before network fetch', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (() => {
    fetchCalls += 1
    throw new Error('fetch should not be called')
  }) as typeof fetch

  try {
    assert.deepEqual(await wcFetch('/products', {}, unsafeCredentials), {
      data: null,
      totalPages: 0,
      totalItems: 0,
      error: 'WooCommerce URL cannot target loopback, link-local, private, or metadata network addresses.',
    })
    assert.deepEqual(await wcPost('/products', {}, unsafeCredentials), {
      data: null,
      error: 'WooCommerce URL cannot target loopback, link-local, private, or metadata network addresses.',
    })
    assert.deepEqual(await wcPut('/products/1', {}, unsafeCredentials), {
      data: null,
      error: 'WooCommerce URL cannot target loopback, link-local, private, or metadata network addresses.',
    })
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
