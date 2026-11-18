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

import { PASSWORD_RESET_COOLDOWN_MS, passwordResetEmailAllowed } from '../lib/auth/password-reset.ts'

function countingLimiter() {
  const counts = new Map<string, number>()
  return {
    counts,
    limiter: async (key: string, max: number) => {
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return { allowed: next <= max }
    },
  }
}

test('reset requests: a cooldown (one email per address per window), never a hard block', async () => {
  const { limiter } = countingLimiter()
  assert.equal(await passwordResetEmailAllowed({ email: 'v@example.com', ip: '203.0.113.1', limiter }), true)
  assert.equal(await passwordResetEmailAllowed({ email: 'v@example.com', ip: '203.0.113.2', limiter }), false, 'second email inside the cooldown is not sent')
  assert.ok(PASSWORD_RESET_COOLDOWN_MS <= 5 * 60_000, 'cooldown is minutes, not an hourly block')
})

test('reset requests from an unknown IP use no shared hard bucket: only the per-address cooldown', async () => {
  const { counts, limiter } = countingLimiter()
  for (let i = 0; i < 50; i += 1) await passwordResetEmailAllowed({ email: `bomb${i}@example.com`, ip: 'unknown', limiter })
  assert.equal([...counts.keys()].some((k) => k.startsWith('pwreset-ip:') || k.startsWith('pwreset:')), false)
  // an attacker hammering one address cannot consume anything that a later window will not forgive:
  // every request after the first merely hits the cooldown bucket
  for (let i = 0; i < 20; i += 1) await passwordResetEmailAllowed({ email: 'victim@example.com', ip: 'unknown', limiter })
  assert.deepEqual([...counts.keys()].filter((k) => k.includes('victim')), ['pwreset-cool:victim@example.com'])
})

test('reset requests: the per-IP hard caps still bound one known source', async () => {
  const { limiter } = countingLimiter()
  let sent = 0
  for (let i = 0; i < 40; i += 1) if (await passwordResetEmailAllowed({ email: `u${i}@example.com`, ip: '203.0.113.9', limiter })) sent += 1
  assert.equal(sent, 20, 'distinct addresses from one IP stop at the per-IP cap of 20 / 15 min')
})
