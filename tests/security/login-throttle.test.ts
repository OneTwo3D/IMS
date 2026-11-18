import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOGIN_ACCOUNT_MAX_FAILURES,
  LOGIN_FAILURE_BACKOFF_MS,
  loginAttemptAllowed,
  loginThrottleKeys,
  recordLoginFailure,
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

test('unauthenticated attempts can never lock an account out: any number of failures, from any IP, still reaches the password check', async () => {
  const { limiter } = fakeLimiter()
  const slept: number[] = []
  for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES * 3; i += 1) {
    // the attacker's failures (rotating addresses) are charged to the account...
    await recordLoginFailure({ email: 'victim@example.com', limiter, sleep: async (ms) => { slept.push(ms) } })
  }
  // ...yet the real user, from their own fresh IP, or from 'unknown', is never refused
  for (const ip of ['198.51.100.77', 'unknown']) {
    assert.equal(await loginAttemptAllowed({ email: 'Victim@Example.com', clientIp: ip, ipIsTrustworthy: ip !== 'unknown', limiter }), true)
  }
  assert.ok(slept.length > 0, 'past the cap failing attempts are slowed')
})

test('the per-account bucket is charged on failure only, and backs off past the cap', async () => {
  const { counts, limiter } = fakeLimiter()
  const key = loginThrottleKeys('a@example.com', 'unknown').accountFailures
  await loginAttemptAllowed({ email: 'a@example.com', clientIp: '203.0.113.5', ipIsTrustworthy: true, limiter })
  assert.equal(counts.has(key), false, 'a check alone (a success path) never charges the account')

  const slept: number[] = []
  const sleep = async (ms: number) => { slept.push(ms) }
  for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i += 1) assert.equal(await recordLoginFailure({ email: 'a@example.com', limiter, sleep }), 0)
  assert.equal(await recordLoginFailure({ email: 'a@example.com', limiter, sleep }), LOGIN_FAILURE_BACKOFF_MS)
  assert.deepEqual(slept, [LOGIN_FAILURE_BACKOFF_MS])
})

test('with an unknown IP no shared hard bucket is used at all', async () => {
  const { counts, limiter } = fakeLimiter()
  for (let i = 0; i < 100; i += 1) {
    assert.equal(await loginAttemptAllowed({ email: 'x@example.com', clientIp: 'unknown', ipIsTrustworthy: false, limiter }), true)
  }
  assert.equal(counts.size, 0)
})

test('a known source IP is hard-capped (it can only block that address) and the spray cap needs a trustworthy IP', async () => {
  const keys = loginThrottleKeys('x@example.com', '203.0.113.5')
  const trusted = fakeLimiter()
  let blocked = false
  for (let i = 0; i < 11; i += 1) {
    blocked = !(await loginAttemptAllowed({ email: 'x@example.com', clientIp: '203.0.113.5', ipIsTrustworthy: true, limiter: trusted.limiter }))
  }
  assert.equal(blocked, true)
  assert.equal(trusted.counts.has(keys.ip), true)
  // another address is unaffected
  assert.equal(await loginAttemptAllowed({ email: 'x@example.com', clientIp: '203.0.113.6', ipIsTrustworthy: true, limiter: trusted.limiter }), true)

  const untrusted = fakeLimiter()
  await loginAttemptAllowed({ email: 'x@example.com', clientIp: '203.0.113.5', ipIsTrustworthy: false, limiter: untrusted.limiter })
  assert.equal(untrusted.counts.has(keys.ip), false)
})
