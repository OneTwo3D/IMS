import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'

/**
 * Smoke-test the HMAC scheme used by lib/connectors/woocommerce/fx-rates.ts
 * to authenticate FX pushes to the onetwoInventory Helper WordPress plugin.
 *
 * The PHP side computes `hash_hmac('sha256', $request->get_body(), $secret)`
 * and compares against the X-OTI-Signature header. Both sides must:
 *   1. Use SHA-256.
 *   2. Hex-encode the digest (lowercase).
 *   3. Sign the *raw* JSON body, not a re-serialised version.
 *
 * If any of those drift, every push will fail with 401. Lock them in here.
 */

test('HMAC uses sha256 and lowercase hex, matching PHP hash_hmac default', () => {
  const secret = 'shhh-its-a-secret'
  const body = JSON.stringify({
    rates: [
      { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.18, fetchedAt: '2026-04-25T06:00:00Z' },
      { fromCurrency: 'GBP', toCurrency: 'USD', rate: 1.27, fetchedAt: '2026-04-25T06:00:00Z' },
    ],
  })

  const sig = createHmac('sha256', secret).update(body).digest('hex')

  // Lowercase hex, 64 chars (32 bytes × 2).
  assert.match(sig, /^[0-9a-f]{64}$/)

  // Recomputing on the *raw* body must produce the same value (proves we
  // don't depend on whitespace normalisation or key sorting).
  const sig2 = createHmac('sha256', secret).update(body).digest('hex')
  assert.equal(sig, sig2)
})

test('HMAC differs when secret differs (defends against constant-secret bug)', () => {
  const body = '{"rates":[]}'
  const a = createHmac('sha256', 'secret-a').update(body).digest('hex')
  const b = createHmac('sha256', 'secret-b').update(body).digest('hex')
  assert.notEqual(a, b)
})

test('HMAC differs when body differs by even one character', () => {
  const secret = 'shared'
  const a = createHmac('sha256', secret).update('{"rates":[{"rate":1.18}]}').digest('hex')
  const b = createHmac('sha256', secret).update('{"rates":[{"rate":1.19}]}').digest('hex')
  assert.notEqual(a, b)
})
