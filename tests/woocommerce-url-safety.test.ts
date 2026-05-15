import assert from 'node:assert/strict'
import test from 'node:test'
import { validateWooCommerceBaseUrl } from '../lib/connectors/woocommerce/url-safety.ts'

test('WooCommerce URL validation requires https for public stores', () => {
  const original = process.env.E2E_TEST_MODE
  delete process.env.E2E_TEST_MODE
  try {
    assert.deepEqual(validateWooCommerceBaseUrl('http://store.example.test'), {
      ok: false,
      error: 'WooCommerce URL must use https.',
    })
    assert.equal(validateWooCommerceBaseUrl('https://store.example.test/').ok, true)
  } finally {
    process.env.E2E_TEST_MODE = original
  }
})

test('WooCommerce URL validation blocks localhost outside e2e mode', () => {
  const original = process.env.E2E_TEST_MODE
  delete process.env.E2E_TEST_MODE
  try {
    assert.deepEqual(validateWooCommerceBaseUrl('https://127.0.0.1:8443'), {
      ok: false,
      error: 'WooCommerce URL cannot target loopback, link-local, private, or metadata network addresses.',
    })
  } finally {
    process.env.E2E_TEST_MODE = original
  }
})

test('WooCommerce URL validation allows only loopback http in e2e mode', () => {
  const original = process.env.E2E_TEST_MODE
  process.env.E2E_TEST_MODE = '1'
  try {
    assert.equal(validateWooCommerceBaseUrl('http://127.0.0.1:8080').ok, true)
    assert.deepEqual(validateWooCommerceBaseUrl('http://10.0.0.5:8080'), {
      ok: false,
      error: 'WooCommerce URL must use https.',
    })
  } finally {
    process.env.E2E_TEST_MODE = original
  }
})
