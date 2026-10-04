import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { mock } from 'node:test'

/**
 * The REAL connection-test login (`testMintsoftConnectionSettings`, which is POST /api/Auth) must carry
 * the ClientId this installation is configured with, so the hold can bind it to the granted ClientId.
 * Driven at a local loopback listener; the settings layer is doubled, the transport is real.
 */

import { setOutboundRefusalSink } from '../lib/security/outbound-write-refusal-log'

let configuredClientId = ''
setOutboundRefusalSink(async () => undefined)
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async () => new Map<string, string>([['mintsoft_client_id', configuredClientId], ['mintsoft_auth_mode', 'credentials']]),
    getSettingValue: async () => null,
    serializeSettingValue: (v: unknown) => String(v),
  },
})
mock.module('@/lib/db', {
  namedExports: { db: { wmsConnection: { findFirst: async () => null } } },
})

test('the login carries the configured ClientId: unproven and foreign are refused with no byte sent, the granted one is sent', async () => {
  const received: string[] = []
  const server = createServer((req, res) => { received.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ApiKey":"k"}') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.MINTSOFT_WRITE_ALLOWED = `${origin}|89|login=u`
  try {
    const { testMintsoftConnectionSettings } = await import('../lib/connectors/mintsoft/api/auth')
    console.log(`precondition (auth caller): grant ${origin}|89; configured ClientId varies: blank, 101, 89`)
    for (const [clientId, expectRefusal] of [['', true], ['101', true], ['89', false]] as const) {
      configuredClientId = clientId
      const attempt = testMintsoftConnectionSettings(origin, 'u', 'p')
      if (expectRefusal) await assert.rejects(attempt, /Outbound write HELD \(Mintsoft\)/, `ClientId "${clientId}"`)
      else await attempt
    }
    assert.deepEqual(received, ['POST /api/Auth'], 'only the granted ClientId reached the listener')
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
