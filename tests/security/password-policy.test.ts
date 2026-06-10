import assert from 'node:assert/strict'
import test from 'node:test'

import { validateUserPassword } from '../../lib/security/password-policy.ts'

test('user password policy enforces length and complexity', () => {
  assert.equal(validateUserPassword('Short1!'), 'Password must be at least 12 characters')
  assert.equal(validateUserPassword('password123!'), 'Password is too common')
  assert.equal(validateUserPassword('lowercase123!'), 'Password must include an uppercase letter')
  assert.equal(validateUserPassword('UPPERCASE123!'), 'Password must include a lowercase letter')
  assert.equal(validateUserPassword('NoNumberHere!'), 'Password must include a number')
  assert.equal(validateUserPassword('NoSymbolHere1'), 'Password must include a symbol')
  assert.equal(validateUserPassword('StrongEnough1!'), null)
})
