import assert from 'node:assert/strict'
import test from 'node:test'
import * as scrubNs from '../lib/domain/wms/error-scrub.ts'

const { scrubWmsError } = 'default' in scrubNs
  ? (scrubNs.default as typeof import('../lib/domain/wms/error-scrub.ts'))
  : scrubNs

test('scrubWmsError redacts email, IBAN, and UK postcode from a WMS error', () => {
  const out = scrubWmsError(
    new Error('Mintsoft rejected order for jane.doe@example.com at EC1A 1BB (IBAN GB29NWBK60161331926819)'),
  )
  assert.match(out, /\[redacted-email\]/)
  assert.match(out, /\[redacted-postcode\]/)
  assert.match(out, /\[redacted-iban\]/)
  assert.doesNotMatch(out, /jane\.doe@example\.com/)
  assert.doesNotMatch(out, /GB29NWBK60161331926819/)
})

test('scrubWmsError handles non-Error inputs and applies the fallback', () => {
  assert.equal(scrubWmsError('plain string error'), 'plain string error')
  assert.equal(scrubWmsError(undefined, 'fallback msg'), 'fallback msg')
  assert.equal(scrubWmsError(null, 'fallback msg'), 'fallback msg')
})

test('scrubWmsError caps overly long messages', () => {
  const out = scrubWmsError('x'.repeat(500))
  assert.ok(out.length <= 300)
  assert.match(out, /\.\.\.$/)
})
