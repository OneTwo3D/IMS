import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOGIN_ACCOUNT_MAX_ATTEMPTS,
  loginAttemptAllowed,
  loginThrottleKeys,
} from '../../lib/auth/login-throttle.ts'

/** A counting limiter with the same contract as checkRateLimit (counts the call, then compares). */
function fakeLimiter() {
  const counts = new Map<string, number>()
  const limiter = async (key: string, max: number) => {
    const next = (counts.get(key) ?? 0) + 1
    counts.set(key, next)
    return { allowed: next <= max }
  }
  return { counts, limiter }
}

test('rotating source addresses cannot dodge the per-account cap', async () => {
  const { limiter } = fakeLimiter()
  let blockedAt = -1
  for (let i = 1; i <= LOGIN_ACCOUNT_MAX_ATTEMPTS + 5; i += 1) {
    // a fresh IP every attempt: the email+IP bucket never fills
    const ok = await loginAttemptAllowed({ email: 'Victim@Example.com', clientIp: `198.51.100.${i % 250}x${i}`, ipIsTrustworthy: true, limiter })
    if (!ok && blockedAt < 0) blockedAt = i
  }
  assert.equal(blockedAt, LOGIN_ACCOUNT_MAX_ATTEMPTS + 1)
})

test('another account is unaffected by one account being throttled', async () => {
  const { limiter } = fakeLimiter()
  for (let i = 0; i < LOGIN_ACCOUNT_MAX_ATTEMPTS + 1; i += 1) {
    await loginAttemptAllowed({ email: 'a@example.com', clientIp: `10.9.${i}.1`, ipIsTrustworthy: true, limiter })
  }
  assert.equal(await loginAttemptAllowed({ email: 'b@example.com', clientIp: '10.9.0.1', ipIsTrustworthy: true, limiter }), true)
})

test('the per-IP spraying cap applies only when the IP is trustworthy and known', async () => {
  const keys = (ip: string) => loginThrottleKeys('x@example.com', ip).ip
  const trusted = fakeLimiter()
  await loginAttemptAllowed({ email: 'x@example.com', clientIp: '203.0.113.5', ipIsTrustworthy: true, limiter: trusted.limiter })
  assert.equal(trusted.counts.has(keys('203.0.113.5')), true)

  const untrusted = fakeLimiter()
  await loginAttemptAllowed({ email: 'x@example.com', clientIp: '203.0.113.5', ipIsTrustworthy: false, limiter: untrusted.limiter })
  await loginAttemptAllowed({ email: 'x@example.com', clientIp: 'unknown', ipIsTrustworthy: true, limiter: untrusted.limiter })
  assert.equal(untrusted.counts.has(keys('203.0.113.5')), false)
  assert.equal(untrusted.counts.has(keys('unknown')), false)
})
