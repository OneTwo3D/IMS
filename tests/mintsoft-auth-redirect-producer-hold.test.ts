import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { mock } from 'node:test'

/**
 * THE TWO DIRECT connectorFetch CALLS OF THE AUTH MODULE, WITH A REDIRECT ONTO A WRITE PATH (real transport, local listener only).
 * Key minting (POST /api/Auth) must refuse every redirect: a 302 onto GET /api/Order/5/Cancel would otherwise be followed under the
 * login grant. The fixed-key test (a GET, no write scope) is gated per hop too, but the legacy hold already refuses a scoped write there, so only the census (MINT-3) proves that gate. The legacy outbound grant is SET and the producer grant ABSENT.
 *
 * Named mutation (shown red in the PR): refuse-redirects-removed (login)..
 */
const state = { baseUrl: '' }
const tx = {
  setting: { upsert: async () => ({}) },
  wmsConnection: { findFirst: async () => null, update: async () => ({}), upsert: async () => ({}) },
}
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsConnection: { findFirst: async () => (state.baseUrl ? { id: 'c1', baseUrl: state.baseUrl, tokenExpiresAt: new Date(0), orderLookupConnector: null } : null) },
      setting: { findMany: async () => [], findUnique: async () => null },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  },
})
mock.module('@/lib/connectors/mintsoft/api/auth-lock', {
  namedExports: { withMintsoftAuthLock: async (_name: string, fn: (h: { assertHeld: () => Promise<void> }) => Promise<unknown>) => fn({ assertHeld: async () => undefined }) },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, key === 'mintsoft_client_id' ? '89' : key === 'mintsoft_username' ? 'u' : key === 'mintsoft_password' ? 'p' : ''] as const)),
    getSettingValue: async (key: string) => (key === 'mintsoft_client_id' ? '89' : key === 'mintsoft_api_key' ? 'expired-key' : null),
    serializeSettingValue: (_key: string, value: string) => value,
  },
})

async function listener() {
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    if (req.url === '/api/Auth307') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('"key-after-redirect"'); return }
    if (req.url === '/api/Auth' && process.env.AUTH_TEST_REDIRECT === '307') { res.writeHead(307, { Location: '/api/Auth307' }); res.end(); return }
    if (req.url === '/api/Auth' || req.url === '/api/Warehouse') { res.writeHead(302, { Location: '/api/Order/5/Cancel' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"Success":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, received, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

test('login: a 302 from POST /api/Auth onto the Cancel path is never followed (even with the legacy login grant present)', async () => {
  const { server, received, base } = await listener()
  process.env.E2E_TEST_MODE = '1'
  process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
  process.env.MINTSOFT_WRITE_ALLOWED = `${base}|89|login=u`
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'mintsoft'
  process.env.MINTSOFT_WRITES_LIVE_FROM = '2026-06-01T00:00:00Z'
  try {
    const { testMintsoftConnectionSettings } = await import('../lib/connectors/mintsoft/api/auth.ts')
    await assert.rejects(testMintsoftConnectionSettings(base, 'u', 'p'), /redirect/i)
    console.log(`# login requests: ${JSON.stringify(received)}`)
    assert.deepEqual(received, ['POST /api/Auth'], 'the redirect target was never requested')
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    delete process.env.MINTSOFT_WRITES_LIVE_FROM
    server.close()
  }
})

test('login, producer hold NOT enforced (switch OFF, legacy): a 307 from POST /api/Auth is followed exactly as before', async () => {
  const { server, received, base } = await listener()
  process.env.E2E_TEST_MODE = '1'
  process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
  process.env.MINTSOFT_WRITE_ALLOWED = `${base}|89|login=u`
  process.env.AUTH_TEST_REDIRECT = '307'
  delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  try {
    const { testMintsoftConnectionSettings } = await import('../lib/connectors/mintsoft/api/auth.ts')
    await testMintsoftConnectionSettings(base, 'u', 'p')
    console.log(`# OFF login requests: ${JSON.stringify(received)}`)
    assert.deepEqual(received, ['POST /api/Auth', 'POST /api/Auth307'], 'the redirect was followed (legacy)')
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.AUTH_TEST_REDIRECT
    server.close()
  }
})

test('login, producer hold enforced (switch ON): the same 307 is refused and no second hop is requested', async () => {
  const { server, received, base } = await listener()
  process.env.E2E_TEST_MODE = '1'
  process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
  process.env.MINTSOFT_WRITE_ALLOWED = `${base}|89|login=u`
  process.env.AUTH_TEST_REDIRECT = '307'
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'mintsoft'
  process.env.MINTSOFT_WRITES_LIVE_FROM = '2026-06-01T00:00:00Z'
  try {
    const { testMintsoftConnectionSettings } = await import('../lib/connectors/mintsoft/api/auth.ts')
    await assert.rejects(testMintsoftConnectionSettings(base, 'u', 'p'), /redirect/i)
    assert.deepEqual(received, ['POST /api/Auth'], 'no second hop')
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.AUTH_TEST_REDIRECT
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    delete process.env.MINTSOFT_WRITES_LIVE_FROM
    server.close()
  }
})

test('login while the destination is HELD (enforced, legacy login grant present, no live-from): key minting is refused before anything is sent', async () => {
  const { server, received, base } = await listener()
  process.env.E2E_TEST_MODE = '1'
  process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
  process.env.MINTSOFT_WRITE_ALLOWED = `${base}|89|login=u`
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'mintsoft'
  delete process.env.MINTSOFT_WRITES_LIVE_FROM
  try {
    const { testMintsoftConnectionSettings } = await import('../lib/connectors/mintsoft/api/auth.ts')
    const { MintsoftKeyMintingHeldError } = await import('../lib/connectors/mintsoft/producer-egress.ts')
    await assert.rejects(testMintsoftConnectionSettings(base, 'u', 'p'), (error: unknown) => {
      assert.ok(error instanceof MintsoftKeyMintingHeldError)
      assert.doesNotMatch((error as Error).message, /\bp\b.*password|u\|/i)
      return true
    })
    assert.deepEqual(received, [], 'POST /api/Auth was never issued')
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    server.close()
  }
})

test('read with an EXPIRED stored key while HELD does not issue POST /api/Auth (switch OFF it still does: the legacy refresh)', async () => {
  for (const enforced of [true, false]) {
    const { server, received, base } = await listener()
    process.env.E2E_TEST_MODE = '1'
    process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
    process.env.MINTSOFT_WRITE_ALLOWED = `${base}|89|login=u`
    if (enforced) process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'mintsoft'
    try {
      state.baseUrl = base
      const { getMintsoftAccessToken } = await import('../lib/connectors/mintsoft/api/auth.ts')
      await getMintsoftAccessToken({ forceRefresh: true }).catch(() => undefined)
      console.log(`# expired-key read enforced=${enforced}: ${JSON.stringify(received)}`)
      assert.equal(received.includes('POST /api/Auth'), !enforced)
    } finally {
      delete process.env.MINTSOFT_WRITE_ALLOWED
      delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
      server.close()
    }
  }
})
