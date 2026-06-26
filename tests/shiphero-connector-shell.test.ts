import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { extractShipheroAuthToken, verifyShipheroWebhookSignature } from '../lib/connectors/shiphero/api/auth.ts'
import {
  isShipheroInvalidTokenErrors,
  looksLikeShipheroThrottle,
  shipheroErrorsAreTransient,
} from '../lib/connectors/shiphero/api/client.ts'
import { extractShipheroWarehouses, normalizeShipheroWarehouse } from '../lib/connectors/shiphero/api/normalizers.ts'

test('extractShipheroAuthToken reads access_token + expires_in across shapes', () => {
  assert.deepEqual(extractShipheroAuthToken({ access_token: 'abc', expires_in: 3600 }), { token: 'abc', expiresInSeconds: 3600 })
  assert.deepEqual(extractShipheroAuthToken({ accessToken: 'x' }), { token: 'x', expiresInSeconds: null })
  assert.deepEqual(extractShipheroAuthToken({ access_token: 't', expires_in: '7200' }), { token: 't', expiresInSeconds: 7200 })
  assert.deepEqual(extractShipheroAuthToken({ access_token: '  spaced  ' }), { token: 'spaced', expiresInSeconds: null })
  assert.equal(extractShipheroAuthToken({ access_token: 't', expires_in: 'abc' })?.expiresInSeconds, null)
  assert.equal(extractShipheroAuthToken({ access_token: '' }), null)
  assert.equal(extractShipheroAuthToken({}), null)
  assert.equal(extractShipheroAuthToken(null), null)
})

test('looksLikeShipheroThrottle fires on credit fields or throttle messages, not auth errors', () => {
  assert.equal(looksLikeShipheroThrottle({ message: 'Not enough credits', code: 30 }), true)
  assert.equal(looksLikeShipheroThrottle({ required_credits: 5 }), true) // field presence
  assert.equal(looksLikeShipheroThrottle({ remaining_credits: 0 }), true)
  assert.equal(looksLikeShipheroThrottle({ message: 'Rate limit exceeded' }), true)
  assert.equal(looksLikeShipheroThrottle({ message: 'Invalid token' }), false)
  assert.equal(looksLikeShipheroThrottle(null), false)
})

test('isShipheroInvalidTokenErrors classifies auth failures but skips throttle (code-30 collision)', () => {
  assert.equal(isShipheroInvalidTokenErrors([{ message: 'Invalid token' }]), true)
  assert.equal(isShipheroInvalidTokenErrors([{ message: 'Unauthorized' }]), true)
  assert.equal(isShipheroInvalidTokenErrors([{ message: 'authentication failed' }]), true)
  // A quota error that ALSO carries an auth-shaped word + code 30 must NOT be
  // treated as an invalid token, or we'd burn a refresh and retry the over-budget query.
  assert.equal(isShipheroInvalidTokenErrors([{ message: 'not enough credits — not authorized', required_credits: 5 }]), false)
  assert.equal(isShipheroInvalidTokenErrors([{ message: 'some other error' }]), false)
  assert.equal(isShipheroInvalidTokenErrors([]), false)
  assert.equal(isShipheroInvalidTokenErrors(null), false)
})

test('shipheroErrorsAreTransient is true only for throttle-shaped errors', () => {
  assert.equal(shipheroErrorsAreTransient([{ message: 'rate limit' }]), true)
  assert.equal(shipheroErrorsAreTransient([{ required_credits: 9 }]), true)
  assert.equal(shipheroErrorsAreTransient([{ message: 'invalid token' }]), false)
  assert.equal(shipheroErrorsAreTransient([]), false)
})

test('normalizeShipheroWarehouse prefers legacy_id and falls back for the name', () => {
  assert.deepEqual(normalizeShipheroWarehouse({ legacy_id: 123, identifier: 'Main', id: 'uuid-x' }), { externalId: '123', name: 'Main' })
  assert.deepEqual(normalizeShipheroWarehouse({ id: 'uuid-x', profile: 'Backup' }), { externalId: 'uuid-x', name: 'Backup' })
  assert.deepEqual(normalizeShipheroWarehouse({ legacy_id: 5 }), { externalId: '5', name: '5' }) // name falls back to id
  assert.equal(normalizeShipheroWarehouse({}), null) // no id at all
  assert.equal(normalizeShipheroWarehouse(null), null)
})

test('extractShipheroWarehouses maps arrays and drops junk', () => {
  assert.deepEqual(
    extractShipheroWarehouses([{ legacy_id: 1, identifier: 'A' }, { id: 'b', profile: 'B' }, 'junk', null]),
    [{ externalId: '1', name: 'A' }, { externalId: 'b', name: 'B' }],
  )
  assert.deepEqual(extractShipheroWarehouses(null), [])
  assert.deepEqual(extractShipheroWarehouses({}), [])
})

test('verifyShipheroWebhookSignature accepts hex/base64 HMAC and rejects bad input', () => {
  const secret = 'sh-secret'
  const body = '{"event":"shipment_update","id":42}'
  const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  const base64 = createHmac('sha256', secret).update(body, 'utf8').digest('base64')

  assert.equal(verifyShipheroWebhookSignature(body, hex, secret), true)
  assert.equal(verifyShipheroWebhookSignature(body, base64, secret), true)
  assert.equal(verifyShipheroWebhookSignature(body, `sha256=${hex}`, secret), true) // prefix stripped
  assert.equal(verifyShipheroWebhookSignature(body, 'deadbeef', secret), false)
  assert.equal(verifyShipheroWebhookSignature(body, hex, ''), false) // no secret
  assert.equal(verifyShipheroWebhookSignature(body, null, secret), false) // no signature
})
