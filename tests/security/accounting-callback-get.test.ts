import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// onetwo3d-ims-qye3 (Codex r2/r3 F2): invoke the REAL exported GET wrapper — not
// just the injectable handler — so a revert to inline header-derived origin
// logic in the wrapper is caught at RUNTIME. GET wires the production,
// DB-backed getPublicAppUrl + isIntegrationPluginEnabled, so we mock those
// modules BEFORE importing the route (a separate file from the handler tests,
// which statically import the route and would defeat the mock). Requires the
// --experimental-test-module-mocks flag wired into the test:unit script.

const CONFIGURED = 'https://ims.example.com'

const hostile = (query: string) =>
  new Request(`${CONFIGURED}/api/accounting/callback?${query}`, {
    headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
  })

test('REAL GET: a hostile forwarded host cannot change the redirect origin (production deps wired)', async () => {
  mock.module('@/lib/public-app-url', {
    namedExports: {
      getPublicAppUrl: async () => CONFIGURED,
      getPublicAppUrlInfo: async () => ({ value: CONFIGURED, source: 'settings' as const }),
    },
  })
  mock.module('@/lib/integration-plugins', {
    namedExports: {
      isIntegrationPluginEnabled: async () => true,
      getIntegrationPluginState: async () => ({}),
    },
  })
  try {
    const { GET } = await import('@/app/api/accounting/callback/route')
    const res = await GET(hostile('error=cancelled'))
    assert.equal(res.status, 307)
    const url = new URL(res.headers.get('location') ?? '')
    assert.equal(url.origin, CONFIGURED)
    assert.doesNotMatch(res.headers.get('location') ?? '', /attacker/)
  } finally {
    mock.reset()
  }
})
