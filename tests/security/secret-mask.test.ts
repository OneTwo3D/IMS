import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SECRET_MASK,
  isMaskedSecret,
  maskSecret,
  shouldFreshGateSecretWrite,
} from '../../lib/security/secret-mask.ts'

test('secret masking uses one canonical token for all connector forms', () => {
  const masked = maskSecret('shhh-secret-value', 7)
  assert.equal(masked, `shhh-se${SECRET_MASK}`)
  assert.equal(isMaskedSecret(masked), true)
  assert.equal(isMaskedSecret('plain-secret-value'), false)
})

test('fresh-auth secret write detection skips only canonical masked placeholders', () => {
  assert.equal(shouldFreshGateSecretWrite({ secret: `prefix${SECRET_MASK}` }, 'secret'), false)
  assert.equal(shouldFreshGateSecretWrite({ secret: 'plain-secret-value' }, 'secret'), true)
  assert.equal(shouldFreshGateSecretWrite({ secret: 'plain*single-star' }, 'secret'), true)
  assert.equal(shouldFreshGateSecretWrite({}, 'secret'), false)
})
