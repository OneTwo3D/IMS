import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  PASSWORD_RESET_TTL_MS,
  buildPasswordResetUrl,
  generatePasswordResetToken,
  passwordResetTokenKey,
} from '../lib/auth/password-reset.ts'

test('generatePasswordResetToken returns a 256-bit hex token, unique per call', () => {
  const a = generatePasswordResetToken()
  const b = generatePasswordResetToken()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

test('passwordResetTokenKey stores only the SHA-256 hash of the token (never the raw token)', () => {
  const token = 'deadbeef'.repeat(8)
  const key = passwordResetTokenKey(token)
  const expected = `password_reset:${createHash('sha256').update(token).digest('hex')}`
  assert.equal(key, expected)
  assert.ok(!key.includes(token), 'raw token must not appear in the key')
})

test('passwordResetTokenKey is deterministic for the same token', () => {
  const token = generatePasswordResetToken()
  assert.equal(passwordResetTokenKey(token), passwordResetTokenKey(token))
})

test('buildPasswordResetUrl points at /reset-password with the encoded token', () => {
  const url = buildPasswordResetUrl('https://ims.example.com', 'abc123')
  assert.equal(url, 'https://ims.example.com/reset-password?token=abc123')
})

test('buildPasswordResetUrl tolerates a trailing slash on the base URL', () => {
  assert.equal(
    buildPasswordResetUrl('https://ims.example.com/', 'tok'),
    'https://ims.example.com/reset-password?token=tok',
  )
})

test('buildPasswordResetUrl url-encodes token characters', () => {
  const url = buildPasswordResetUrl('https://x.test', 'a b/c?d')
  assert.equal(url, 'https://x.test/reset-password?token=a%20b%2Fc%3Fd')
})

test('PASSWORD_RESET_TTL_MS is one hour', () => {
  assert.equal(PASSWORD_RESET_TTL_MS, 60 * 60_000)
})
