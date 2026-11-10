import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { SECRET_MASK } from '@/lib/security/secret-mask'

/**
 * The stored URL, key and secret must come from ONE read. Read separately, a concurrent save between the
 * reads paired store B's credentials with store A's URL and sent them to A. The stored settings here
 * flip to store B after the first settings query, whichever shape (findUnique or findMany) it takes.
 */

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'MANAGER', sessionAuthTime: Math.floor(Date.now() / 1000) },
    }),
  },
})

const STORE_A = { wc_url: 'https://store-a.example.com', wc_consumer_key: 'ck_a', wc_consumer_secret: 'cs_a' }
const STORE_B = { wc_url: 'https://store-b.example.com', wc_consumer_key: 'ck_b', wc_consumer_secret: 'cs_b' }
let settingQueries = 0
const current = (): Record<string, string> => (settingQueries <= 1 ? STORE_A : STORE_B)

mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: (_t, model) => {
        if (typeof model !== 'string' || model === 'then') return undefined
        if (model.startsWith('$')) return async () => null
        return new Proxy({}, {
          get: (_t2, op) => async (args?: { where?: { key?: string | { in: string[] } } }) => {
            if (model !== 'setting') return op === 'findMany' ? [] : null
            if (op === 'updateMany') return { count: 0 }
            const where = args?.where?.key
            const asked = typeof where === 'string' ? [where] : where?.in ?? []
            if (asked.some((k) => k in STORE_A)) settingQueries += 1
            const snapshot = current()
            if (op === 'findUnique' && typeof where === 'string') return where in snapshot ? { key: where, value: snapshot[where as keyof typeof snapshot] } : null
            if (op === 'findMany' && where && typeof where === 'object') {
              return where.in.filter((k) => k in snapshot).map((key) => ({ key, value: snapshot[key as keyof typeof snapshot] }))
            }
            return null
          },
        })
      },
    }),
  },
})

const sent: Array<{ url: string; authorization: string }> = []
before(async () => {
  const real = await import('@/lib/security/connector-fetch')
  mock.module('@/lib/security/connector-fetch', {
    namedExports: {
      ...real,
      connectorFetch: async (url: URL, init?: { headers?: Record<string, string> }) => {
        sent.push({ url: url.toString(), authorization: init?.headers?.Authorization ?? '' })
        return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
      },
    },
  })
})

const basic = (k: string, s: string) => `Basic ${Buffer.from(`${k}:${s}`).toString('base64')}`

test('a store change between reads never pairs one store\'s credentials with the other store\'s URL', async () => {
  settingQueries = 0
  sent.length = 0
  const { testWcCredentials } = await import('@/app/actions/wc-sync')
  await testWcCredentials(STORE_A.wc_url, SECRET_MASK, '')
  assert.ok(sent.length > 0)
  for (const request of sent) {
    const toA = request.url.startsWith(STORE_A.wc_url)
    assert.equal(request.authorization, toA ? basic('ck_a', 'cs_a') : basic('ck_b', 'cs_b'), `${request.url} got the other store's credentials`)
  }
})

test('the stored URL and both credentials are read in a single settings query', async () => {
  settingQueries = 0
  sent.length = 0
  const { testWcCredentials } = await import('@/app/actions/wc-sync')
  await testWcCredentials(STORE_A.wc_url, SECRET_MASK, '')
  assert.equal(settingQueries, 1)
})
