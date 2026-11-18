import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOGIN_COOLDOWN_MAX_MS,
  LOGIN_FREE_FAILURES,
  LOGIN_IP_DELAY_MS,
  LOGIN_IP_FREE_FAILURES,
  beginLoginAttempt,
  loginCooldownMs,
  signDeviceCookie,
  verifyDeviceCookie,
  type LoginStore,
} from '../../lib/auth/login-throttle.ts'

/** In-memory LoginStore with the same contract as the DB one (unique claim, TTL), on a controllable clock. */
function harness() {
  let nowMs = 1_700_000_000_000
  const rows = new Map<string, { value: string; expiresAtMs: number }>()
  const live = (key: string) => {
    const row = rows.get(key)
    return row && row.expiresAtMs > nowMs ? row : null
  }
  const store: LoginStore = {
    async claim(key, ttlMs) {
      await Promise.resolve()
      if (live(key)) return false
      rows.set(key, { value: '1', expiresAtMs: nowMs + ttlMs })
      return true
    },
    async release(key) { rows.delete(key) },
    async get(key) { return live(key) },
    async set(key, value, expiresAtMs) { rows.set(key, { value, expiresAtMs }) },
    async del(key) { rows.delete(key) },
  }
  const nowMsRef = () => nowMs
  const slept: number[] = []
  const common = { store, now: () => nowMs, sleep: async (ms: number) => { slept.push(ms) } }
  /** One login attempt; `correct` decides whether the password verifies. Returns the throttle verdict. */
  async function login(email: string, ip: string, correct: boolean, opts: { trusted?: boolean; device?: ReturnType<typeof verifyDeviceCookie>; verifyTime?: () => Promise<void> } = {}) {
    const attempt = await beginLoginAttempt({ email, clientIp: ip, ipIsTrustworthy: opts.trusted ?? true, device: opts.device ?? null, ...common })
    if (!attempt.allowed) return attempt
    let verified = false
    try {
      await (opts.verifyTime?.() ?? Promise.resolve())
      verified = correct
    } finally {
      await attempt.finish(verified ? 'success' : 'failure')
    }
    return { allowed: true as const, verified }
  }
  const clock = () => nowMsRef()
  return { login, clock, advance: (ms: number) => { nowMs += ms }, slept, rows }
}

test('the cooldown is free for the first failures, then doubles, and is capped at 15 minutes', () => {
  for (let i = 0; i < LOGIN_FREE_FAILURES; i += 1) assert.equal(loginCooldownMs(i), 0)
  assert.deepEqual([5, 6, 7, 8].map(loginCooldownMs), [1000, 2000, 4000, 8000])
  assert.equal(loginCooldownMs(1000), LOGIN_COOLDOWN_MAX_MS)
  assert.equal(LOGIN_COOLDOWN_MAX_MS, 15 * 60_000)
})

test('after the free failures an attacker is refused before the password check, with a growing wait', async () => {
  const h = harness()
  let verifications = 0
  const guess = () => h.login('victim@example.com', '203.0.113.9', false, { verifyTime: async () => { verifications += 1 } })
  for (let i = 0; i < LOGIN_FREE_FAILURES; i += 1) assert.equal((await guess()).allowed, true)
  const waits: number[] = []
  for (let round = 0; round < 4; round += 1) {
    const refused = await guess()
    assert.equal(refused.allowed, false)
    assert.equal(verifications, LOGIN_FREE_FAILURES + round, 'refused attempts do no password work')
    // wait out the cooldown, then fail once more: the next cooldown is longer
    const wait = (refused as { retryAfterSec: number }).retryAfterSec
    waits.push(wait)
    h.advance(wait * 1000)
    assert.equal((await guess()).allowed, true)
  }
  assert.deepEqual(waits, [1, 2, 4, 8])
})

test('the cooldown never exceeds 15 minutes however many failures pile up, and the owner can then sign in', async () => {
  const h = harness()
  for (let i = 0; i < 60; i += 1) {
    const r = await h.login('v@example.com', '203.0.113.9', false)
    if (!r.allowed) h.advance((r as { retryAfterSec: number }).retryAfterSec * 1000)
  }
  await h.login('v@example.com', '203.0.113.9', false)
  const refused = await h.login('v@example.com', '198.51.100.1', true)
  assert.equal(refused.allowed, false)
  assert.ok((refused as { retryAfterSec: number }).retryAfterSec <= 15 * 60)
  h.advance((refused as { retryAfterSec: number }).retryAfterSec * 1000)
  assert.deepEqual(await h.login('v@example.com', '198.51.100.1', true), { allowed: true, verified: true })
})

test('a correct password after the cooldown signs in and clears the account counter', async () => {
  const h = harness()
  for (let i = 0; i < LOGIN_FREE_FAILURES + 2; i += 1) {
    const r = await h.login('o@example.com', '203.0.113.9', false)
    if (!r.allowed) h.advance((r as { retryAfterSec: number }).retryAfterSec * 1000)
  }
  const early = await h.login('o@example.com', '198.51.100.7', true)
  assert.equal(early.allowed, false, 'inside the cooldown even the right password waits')
  h.advance((early as { retryAfterSec: number }).retryAfterSec * 1000)
  assert.deepEqual(await h.login('o@example.com', '198.51.100.7', true), { allowed: true, verified: true })
  // counter cleared: failing now is free again
  for (let i = 0; i < LOGIN_FREE_FAILURES; i += 1) assert.equal((await h.login('o@example.com', '198.51.100.7', false)).allowed, true)
})

test('concurrent guesses cannot bypass the counter: one password check per account at a time', async () => {
  const h = harness()
  let inFlight = 0
  let maxInFlight = 0
  let verifications = 0
  const results = await Promise.all(Array.from({ length: 50 }, () => h.login('c@example.com', 'unknown', false, {
    trusted: false,
    verifyTime: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      verifications += 1
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
    },
  })))
  assert.equal(maxInFlight, 1)
  assert.equal(verifications, 1, 'the other 49 were turned away before any password work')
  assert.equal(results.filter((r) => !r.allowed).length, 49)
  assert.ok(results.filter((r) => !r.allowed).every((r) => (r as { reason: string }).reason === 'busy'))
})

test('an attacker on the victim\'s shared IP cannot block the victim beyond the per-account cooldown', async () => {
  const h = harness()
  const sharedIp = '203.0.113.50'
  // attacker sprays many other accounts from the shared IP, well past the IP threshold
  for (let i = 0; i < LOGIN_IP_FREE_FAILURES + 30; i += 1) {
    assert.equal((await h.login(`other${i}@example.com`, sharedIp, false)).allowed, true)
  }
  h.slept.length = 0
  // the victim has no failures of their own: the correct password verifies, only slowed by a fixed delay
  assert.deepEqual(await h.login('victim@example.com', sharedIp, true), { allowed: true, verified: true })
  assert.deepEqual(h.slept, [LOGIN_IP_DELAY_MS])
  // and an attacker hammering the victim's account raises only the victim's per-account cooldown
  for (let i = 0; i < LOGIN_FREE_FAILURES; i += 1) await h.login('victim@example.com', sharedIp, false)
  const blocked = await h.login('victim@example.com', sharedIp, true)
  assert.equal(blocked.allowed, false)
  assert.ok((blocked as { retryAfterSec: number }).retryAfterSec <= 1, 'the first cooldown is one second')
  h.advance(1000)
  assert.deepEqual(await h.login('victim@example.com', sharedIp, true), { allowed: true, verified: true })
})

test('the unknown-IP mode (no trusted proxy) still bounds guessing per account', async () => {
  const h = harness()
  let verifications = 0
  let refused = 0
  for (let i = 0; i < 100; i += 1) {
    const r = await h.login('u@example.com', 'unknown', false, { trusted: false, verifyTime: async () => { verifications += 1 } })
    if (!r.allowed) refused += 1
  }
  assert.equal(verifications, LOGIN_FREE_FAILURES, 'with no time passing only the free failures reach bcrypt')
  assert.equal(refused, 100 - LOGIN_FREE_FAILURES)
  // across 15 minutes of guessing the attacker gets a handful of checks, not hundreds
  let guesses = 0
  for (let t = 0; t < 15 * 60; t += 1) {
    const r = await h.login('u@example.com', 'unknown', false, { trusted: false })
    if (r.allowed) guesses += 1
    h.advance(1000)
  }
  assert.ok(guesses <= 12, `only ${guesses} guesses in 15 minutes`)
})

test('an exception between begin and finish still releases the claim', async () => {
  const h = harness()
  await assert.rejects(h.login('e@example.com', '203.0.113.1', true, { verifyTime: async () => { throw new Error('db down') } }))
  assert.equal((await h.login('e@example.com', '203.0.113.1', true)).allowed, true)
})

const SECRET = 'test-secret'

test('device cookie: signed, bound to the account, expires, and tamper-proof', () => {
  const now = 1_700_000_000_000
  const cookie = signDeviceCookie('user1', SECRET, now)
  assert.ok(verifyDeviceCookie(cookie, 'user1', SECRET, now))
  assert.equal(verifyDeviceCookie(cookie, 'user2', SECRET, now), null, 'bound to the account')
  assert.equal(verifyDeviceCookie(cookie, 'user1', 'other-secret', now), null, 'wrong secret')
  assert.equal(verifyDeviceCookie(cookie + 'x', 'user1', SECRET, now), null, 'tampered')
  assert.equal(verifyDeviceCookie(cookie, 'user1', SECRET, now + 181 * 86_400_000), null, 'expired')
  assert.equal(verifyDeviceCookie(null, 'user1', SECRET, now), null)
})

test('an attacker failing continuously without a cookie does not block a legitimate user with a valid device cookie', async () => {
  const h = harness()
  const device = verifyDeviceCookie(signDeviceCookie('u1', SECRET, h.clock()), 'u1', SECRET, h.clock())
  assert.ok(device)
  for (let round = 0; round < 40; round += 1) {
    // the attacker fails as soon as each cooldown expires, so the account is permanently cooling down
    const r = await h.login('owner@example.com', '203.0.113.9', false)
    if (!r.allowed) h.advance((r as { retryAfterSec: number }).retryAfterSec * 1000)
    await h.login('owner@example.com', '203.0.113.9', false)
    // the owner with the cookie still gets through with the correct password, every time
    assert.deepEqual(await h.login('owner@example.com', '198.51.100.7', true, { device }), { allowed: true, verified: true })
    // re-establish the attacker's cooldown (the owner's success cleared the account counter)
    for (let i = 0; i < LOGIN_FREE_FAILURES + 2; i += 1) await h.login('owner@example.com', '203.0.113.9', false)
    const noCookie = await h.login('owner@example.com', '198.51.100.7', true)
    assert.equal(noCookie.allowed, false, 'without the cookie the owner still waits out the cooldown')
    h.advance(30_000)
  }
})

test('the account cooldown still refuses a cookie-less correct password while the attacker holds it', async () => {
  const h = harness()
  for (let i = 0; i < LOGIN_FREE_FAILURES + 1; i += 1) await h.login('o2@example.com', '203.0.113.9', false)
  assert.equal((await h.login('o2@example.com', '198.51.100.7', true)).allowed, false)
})

test('a device cookie that keeps failing is put into its own cooldown and then meets the account cooldown', async () => {
  const h = harness()
  const device = verifyDeviceCookie(signDeviceCookie('u3', SECRET, h.clock()), 'u3', SECRET, h.clock())
  assert.ok(device)
  let verifications = 0
  const guess = () => h.login('s@example.com', '203.0.113.9', false, { device, verifyTime: async () => { verifications += 1 } })
  for (let i = 0; i < 100; i += 1) await guess()
  // the cookie-holder got the free failures on the device counter, then the device cooldown, then the account
  // free failures, then the account cooldown: a bounded number of guesses, not unlimited
  assert.equal(verifications, LOGIN_FREE_FAILURES * 2)
  const refused = await guess()
  assert.equal(refused.allowed, false)
})

test('the per-IP delay never refuses: concurrent sign-ins from one IP past the threshold all reach the password check', async () => {
  const h = harness()
  const ip = '203.0.113.77'
  for (let i = 0; i < LOGIN_IP_FREE_FAILURES + 5; i += 1) await h.login(`spray${i}@example.com`, ip, false)
  h.slept.length = 0
  let verifications = 0
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => h.login(`user${i}@example.com`, ip, true, {
    verifyTime: async () => { verifications += 1; await new Promise((r) => setTimeout(r, 2)) },
  })))
  assert.equal(verifications, 25)
  assert.ok(results.every((r) => r.allowed))
  assert.equal(h.slept.length, 25, 'each is only delayed')
  // the same for the shared unknown-IP bucket
  const u = harness()
  for (let i = 0; i < 205; i += 1) await u.login(`s${i}@example.com`, 'unknown', false, { trusted: false })
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => u.login(`w${i}@example.com`, 'unknown', true, { trusted: false })))
  assert.ok(out.every((r) => r.allowed))
})
