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
mock.module('@/lib/db', { namedExports: { db: { wmsConnection: { findFirst: async () => null }, setting: { findMany: async () => [], findUnique: async () => null } } } })
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, key === 'mintsoft_client_id' ? '89' : ''] as const)),
    getSettingValue: async (key: string) => (key === 'mintsoft_client_id' ? '89' : null),
  },
})

async function listener() {
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
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
  try {
    const { testMintsoftConnectionSettings } = await import('../lib/connectors/mintsoft/api/auth.ts')
    await assert.rejects(testMintsoftConnectionSettings(base, 'u', 'p'), /redirect/i)
    console.log(`# login requests: ${JSON.stringify(received)}`)
    assert.deepEqual(received, ['POST /api/Auth'], 'the redirect target was never requested')
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    server.close()
  }
})
