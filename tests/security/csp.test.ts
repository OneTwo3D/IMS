import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCsp, cspHeaderName, generateNonce, getCspMode } from '@/lib/security/csp'

test('getCspMode defaults to report-only and parses explicit modes', () => {
  assert.equal(getCspMode({}), 'report-only')
  assert.equal(getCspMode({ CSP_MODE: '' }), 'report-only')
  assert.equal(getCspMode({ CSP_MODE: 'nonsense' }), 'report-only')
  assert.equal(getCspMode({ CSP_MODE: 'enforce' }), 'enforce')
  assert.equal(getCspMode({ CSP_MODE: ' ENFORCE ' }), 'enforce')
  assert.equal(getCspMode({ CSP_MODE: 'off' }), 'off')
})

test('cspHeaderName maps enforce vs report-only', () => {
  assert.equal(cspHeaderName('enforce'), 'Content-Security-Policy')
  assert.equal(cspHeaderName('report-only'), 'Content-Security-Policy-Report-Only')
})

test('generateNonce returns distinct base64 nonces', () => {
  const a = generateNonce()
  const b = generateNonce()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9+/]+={0,2}$/)
  // 16 bytes -> 24 base64 chars
  assert.equal(a.length, 24)
})

test('buildCsp pins script-src to the nonce with strict-dynamic', () => {
  const csp = buildCsp('abc123', false)
  assert.match(csp, /script-src [^;]*'nonce-abc123'/)
  assert.match(csp, /script-src [^;]*'strict-dynamic'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /base-uri 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  // production must not allow eval or ws
  assert.doesNotMatch(csp, /unsafe-eval/)
  assert.doesNotMatch(csp, /\bws:/)
})

test('buildCsp allows eval and websockets only in development', () => {
  const dev = buildCsp('n', true)
  assert.match(dev, /script-src [^;]*'unsafe-eval'/)
  assert.match(dev, /connect-src [^;]*ws:/)
})
