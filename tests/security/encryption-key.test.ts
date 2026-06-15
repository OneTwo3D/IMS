import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import { parseAesEncryptionKey } from '@/lib/security/encryption-key'

// audit-gzz2: the key parser must accept the three formats an operator/installer
// would plausibly produce, all yielding a 32-byte AES key.

test('accepts base64 that decodes to 32 bytes (openssl rand -base64 32)', () => {
  const key = randomBytes(32)
  const parsed = parseAesEncryptionKey(key.toString('base64'))
  assert.ok(parsed)
  assert.equal(parsed?.length, 32)
  assert.ok(parsed?.equals(key))
})

test('accepts a 64-char hex key (openssl rand -hex 32) — the previously-rejected format', () => {
  const key = randomBytes(32)
  const parsed = parseAesEncryptionKey(key.toString('hex'))
  assert.ok(parsed, 'hex key should now parse')
  assert.equal(parsed?.length, 32)
  assert.ok(parsed?.equals(key), 'hex must decode to the same 32 bytes')
})

test('accepts a raw 32-byte utf8 string', () => {
  const raw = 'abcdefghijklmnopqrstuvwxyz123456' // exactly 32 ascii bytes
  const parsed = parseAesEncryptionKey(raw)
  assert.equal(parsed?.length, 32)
})

test('trims surrounding whitespace', () => {
  const key = randomBytes(32)
  assert.ok(parseAesEncryptionKey(`  ${key.toString('hex')}\n`)?.equals(key))
})

test('rejects missing / empty / wrong-length keys', () => {
  assert.equal(parseAesEncryptionKey(undefined), null)
  assert.equal(parseAesEncryptionKey(null), null)
  assert.equal(parseAesEncryptionKey(''), null)
  assert.equal(parseAesEncryptionKey('   '), null)
  assert.equal(parseAesEncryptionKey('too-short'), null)
  // 31-byte and 33-byte raw strings
  assert.equal(parseAesEncryptionKey('a'.repeat(31)), null)
  assert.equal(parseAesEncryptionKey('a'.repeat(33)), null)
})

test('hex is decoded as hex (32 bytes), not base64 (which would be 48 bytes) or utf8 (64)', () => {
  // A 64-hex string decodes to 48 bytes as base64 and 64 bytes as utf8 — both
  // invalid — so the old resolver returned null. Confirm we get exactly 32.
  const parsed = parseAesEncryptionKey('0'.repeat(64))
  assert.equal(parsed?.length, 32)
  assert.ok(parsed?.equals(Buffer.alloc(32, 0)))
})
