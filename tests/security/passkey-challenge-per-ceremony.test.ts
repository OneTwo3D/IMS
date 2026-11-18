import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Passkey challenge issuance is public. Each call stores its challenge under its own ceremony key, so an
 * anonymous caller cannot invalidate a login in flight; and because each call writes a row, issuance is bounded
 * (per-IP rate limit, expired rows pruned on issue; deliberately no global cap, which would be a lockout).
 */
process.env.TRUSTED_PROXY_IPS = '10.0.0.1'

const store = new Map<string, { value: string; expiresAt: Date }>()
let currentIp = '203.0.113.10'
let forcedOutstanding: number | null = null
const pruneCalls: Array<Record<string, unknown>> = []

mock.module('next/headers', {
  namedExports: { headers: async () => new Headers({ 'x-forwarded-for': `${currentIp}, 10.0.0.1` }) },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      oneTimeToken: {
        upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string; expiresAt: Date } }) => { store.set(where.key, create) },
        findUnique: async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { key: where.key, ...store.get(where.key)! } : null),
        delete: async ({ where }: { where: { key: string } }) => { store.delete(where.key) },
        deleteMany: async (args: { where: Record<string, unknown> }) => {
          pruneCalls.push(args.where)
          const now = Date.now()
          for (const [k, v] of store) if (v.expiresAt.getTime() < now) store.delete(k)
          return { count: 0 }
        },
        count: async () => forcedOutstanding ?? [...store.values()].filter((v) => v.expiresAt.getTime() >= Date.now()).length,
      },
    },
  },
})
mock.module('@/lib/auth/server', { namedExports: { getSession: async () => null } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => 'https://ims.example.test' } })

async function issue() {
  const { getPasskeyAuthenticationOptions } = await import('../../app/actions/passkey')
  return getPasskeyAuthenticationOptions()
}

test('a second anonymous challenge request does not invalidate the first ceremony', async () => {
  currentIp = '203.0.113.11'
  const first = await issue()
  const second = await issue()
  assert.ok('challengeKey' in first && 'challengeKey' in second)
  if (!('challengeKey' in first) || !('challengeKey' in second)) return
  assert.notEqual(first.challengeKey, second.challengeKey)
  const { consumeAuthToken } = await import('../../lib/auth/token-store')
  assert.equal(await consumeAuthToken(`passkey_challenge:${first.challengeKey}`), first.options?.challenge)
  assert.equal(await consumeAuthToken(`passkey_challenge:${second.challengeKey}`), second.options?.challenge)
})

test('issuance is rate limited per IP, and another IP is unaffected', async () => {
  currentIp = '203.0.113.20'
  let refused = 0
  for (let i = 0; i < 40; i += 1) {
    const r = await issue()
    if ('error' in r) refused += 1
  }
  assert.equal(refused, 10, '30 allowed per window, the other 10 refused')
  currentIp = '203.0.113.21'
  assert.ok('challengeKey' in (await issue()), 'a different IP has its own bucket')
})

test('there is no global cap: many outstanding ceremonies from other IPs never lock a new user out; expired rows are pruned on issue', async () => {
  currentIp = '203.0.113.30'
  pruneCalls.length = 0
  forcedOutstanding = 5000 // a huge pile of outstanding rows from elsewhere
  const result = await issue()
  assert.ok('challengeKey' in result, 'issuance must not depend on how many ceremonies other callers hold')
  assert.equal(pruneCalls.length, 1, 'prune ran on issue')
  assert.match(JSON.stringify(pruneCalls[0]), /passkey_challenge:auth:/)
  forcedOutstanding = null
})
