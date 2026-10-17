import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { mock } from 'node:test'

import { isOutboundMaybeSentRefusalText } from '../lib/security/outbound-write-hold-constants.ts'

/**
 * A READ THAT REDIRECTS TO A WRITE. Mintsoft mutates through GET (GET /api/Order/{id}/Cancel cancels the order), so an allowed read can
 * be redirected onto a write-classified path. The REAL transport follows the redirect and judges the legacy outbound grant per hop; the
 * producer hold must be judged per hop too. Local listener only; the legacy grant is SET and the producer grant ABSENT in the ON arm.
 *
 * Named mutation (shown red in the PR): hopGate-removed  the client stops passing the per-hop gate.
 */
mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({ baseUrl, authMode: 'api_key', staticApiKey: 'k', username: '', password: '', webhookSecret: '', clientId: '89', orderLookupConnector: null }),
    getMintsoftAccessToken: async () => 'k',
    invalidateMintsoftAccessToken: async () => undefined,
  },
})
let baseUrl = ''

test('redirect hop: GET /api/Order/5 -> /api/Order/5/Cancel is never requested while the producer hold is enforced and not live; the control reaches it', async () => {
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    if (req.url === '/api/Order/5') { res.writeHead(302, { Location: '/api/Order/5/Cancel' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"Success":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.SETTINGS_ENCRYPTION_KEY = 'a1'.repeat(32)
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
  delete process.env.MINTSOFT_WRITES_LIVE_FROM
  try {
    const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client.ts')
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    const control = await mintsoftRequest('/api/Order/5')
    console.log(`# control (hold OFF, legacy grant set): ${JSON.stringify(received)} error=${control.error ?? null}`)
    assert.deepEqual(received, ['GET /api/Order/5', 'GET /api/Order/5/Cancel'], 'CONTROL: the redirect is followed to the write path')
    received.length = 0
    process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'mintsoft'
    const held = await mintsoftRequest('/api/Order/5')
    console.log(`# ON (legacy grant set, producer grant absent): ${JSON.stringify(received)} error=${(held.error ?? '').slice(0, 90)}`)
    assert.deepEqual(received, ['GET /api/Order/5'], 'the read was sent, the redirect to the write was NOT')
    assert.ok(held.error)
    assert.equal(isOutboundMaybeSentRefusalText(held.error), true, 'the earlier request was sent, so it is a maybe-sent refusal, never a pure hold')
  } finally {
    delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    delete process.env.MINTSOFT_WRITE_ALLOWED
    server.close()
  }
})
