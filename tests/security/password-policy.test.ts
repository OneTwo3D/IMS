import assert from 'node:assert/strict'
import test from 'node:test'

import { validateUserPassword } from '@/lib/security/password-policy'

test('user password policy requires at least 12 characters', () => {
  assert.deepEqual(validateUserPassword('Short1!'), {
    ok: false,
    error: 'Password must be at least 12 characters',
  })
})

test('user password policy requires uppercase letter, number, and symbol', () => {
  assert.deepEqual(validateUserPassword('lowercase123!'), {
    ok: false,
    error: 'Password must include an uppercase letter',
  })
  assert.deepEqual(validateUserPassword('NoNumberHere!'), {
    ok: false,
    error: 'Password must include a number',
  })
  assert.deepEqual(validateUserPassword('NoSymbol1234'), {
    ok: false,
    error: 'Password must include a symbol',
  })
})

test('user password policy rejects common passwords and accepts strong passwords', () => {
  assert.deepEqual(validateUserPassword('Password123!'), {
    ok: false,
    error: 'Password is too common',
  })
  assert.deepEqual(validateUserPassword('CorrectHorse42!'), { ok: true })
})
