import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * - /api/auth/step-up refuses a session that has not cleared its 2FA challenge, before it
 *   consumes any rate-limit budget or looks at a code.
 * - /api/auth/totp-setup (stage + confirm) refuses a session whose last sign-in is stale.
 */
process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)

type TestSession = { user: Record<string, unknown> } | null
const state: { session: TestSession; dbCalls: number; rateCalls: number } = { session: null, dbCalls: 0, rateCalls: 0 }

const nowSec = () => Math.floor(Date.now() / 1000)
function user(over: Record<string, unknown>) {
  return {
    id: 'u1', email: 'u1@example.com', name: 'U', role: 'ADMIN', supplierId: null,
    totpEnabled: false, totpVerified: true, sessionVersion: 1, sessionAuthTime: nowSec(), sessionInvalidReason: null,
    ...over,
  }
}

mock.module('@/lib/auth', { namedExports: { auth: async () => state.session } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      user: {
        findUnique: async () => { state.dbCalls += 1; return { id: 'u1', passwordHash: null, totpEnabled: false, active: true } },
        update: async () => { state.dbCalls += 1 },
      },
      oneTimeToken: { upsert: async () => {}, deleteMany: async () => ({}), create: async () => ({}) },
    },
  },
})
mock.module('@/lib/rate-limit', {
  namedExports: {
    checkRateLimit: async () => { state.rateCalls += 1; return { allowed: true, retryAfterSec: 0, remaining: 5 } },
    clearRateLimit: async () => {},
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

function req(body: unknown) {
  return new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

test('step-up rejects a 2FA-pending session without touching the rate limiter or the DB', async () => {
  const { POST } = await import('../../app/api/auth/step-up/route.ts')
  state.session = { user: user({ totpEnabled: true, totpVerified: false }) }
  state.dbCalls = 0
  state.rateCalls = 0
  const res = await POST(req({ password: 'pw', code: '123456' }) as never)
  assert.equal(res.status, 403)
  assert.equal((await res.json()).code, 'second_factor_pending')
  assert.equal(state.rateCalls, 0, 'no step-up guess budget is available to a pending session')
  assert.equal(state.dbCalls, 0)
})

test('step-up still serves a fully verified session (login flow unchanged)', async () => {
  const { POST } = await import('../../app/api/auth/step-up/route.ts')
  state.session = { user: user({ totpEnabled: true, totpVerified: true }) }
  state.rateCalls = 0
  const res = await POST(req({ password: 'pw', code: '123456' }) as never)
  // reaches the password check (user has no hash -> 400 'Incorrect password'), i.e. past the gate
  assert.equal(res.status, 400)
  assert.equal(state.rateCalls, 1)
})

test('TOTP setup refuses a stale session (stage and confirm) and allows a fresh one', async () => {
  const route = await import('../../app/api/auth/totp-setup/route.ts')
  state.session = { user: user({ sessionAuthTime: nowSec() - 3 * 3600 }) }
  state.dbCalls = 0
  const stale = await route.POST(req({ code: '123456' }) as never)
  assert.equal(stale.status, 403)
  assert.equal((await stale.json()).code, 'fresh_auth_required')
  const staleGet = await route.GET()
  assert.equal(staleGet.status, 403)
  assert.equal(state.dbCalls, 0, 'a stale session cannot stage a secret')

  state.session = { user: user({ sessionAuthTime: nowSec() - 30 }) }
  const fresh = await route.GET()
  assert.equal(fresh.status, 200)
  assert.equal(state.dbCalls, 1)
})
