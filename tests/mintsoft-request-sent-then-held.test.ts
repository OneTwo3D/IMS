import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { mock } from 'node:test'

import { OutboundWriteHeldError, outboundWriteRefusal } from '../lib/security/outbound-write-grant'
import { isOutboundMaybeSentRefusalText, isOutboundWriteHeldText } from '../lib/security/outbound-write-hold-constants'
import { setOutboundRefusalSink } from '../lib/security/outbound-write-refusal-log'

/**
 * mintsoftRequest: a hold on a LATER step of a call whose first request WAS sent (the 401, then a held key
 * refresh) is a maybe-sent failure, not "nothing sent". Real client and transport, local listener, auth
 * layer doubled. A hold BEFORE anything is sent stays a hold (the control).
 */

setOutboundRefusalSink(async () => undefined)

let tokenCalls = 0
let throwOnCall = 2
let baseUrl = ''

function heldError(): OutboundWriteHeldError {
  const refusal = outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'POST', url: 'https://api.mintsoft.co.uk/api/Auth', writeScopeId: '89', env: {} })
  assert.ok(refusal)
  return new OutboundWriteHeldError(refusal, 0)
}

mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({
      baseUrl, authMode: 'credentials', staticApiKey: '', username: 'u', password: 'p', webhookSecret: '', clientId: '89', orderLookupConnector: null,
    }),
    getMintsoftAccessToken: async () => {
      tokenCalls += 1
      if (tokenCalls === throwOnCall) throw heldError()
      return 'k'
    },
    invalidateMintsoftAccessToken: async () => undefined,
  },
})

test('a hold on the key refresh AFTER a sent request is re-worded as maybe-sent; a hold before any send stays a hold', async () => {
  const received: string[] = []
  const server = createServer((req, res) => { received.push(`${req.method} ${req.url}`); res.writeHead(401); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
  try {
    const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
    console.log(`precondition (sent then held): PUT is granted and answers 401 on ${baseUrl}; the key refresh that follows is held`)
    tokenCalls = 0; throwOnCall = 2
    const afterSend = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
    assert.deepEqual(received, ['PUT /api/Order'], 'the PUT really was sent, exactly once')
    assert.equal(afterSend.held, undefined, 'not flagged held')
    assert.equal(isOutboundWriteHeldText(afterSend.error), false, 'not recognised as a hold by any queue')
    assert.equal(isOutboundMaybeSentRefusalText(afterSend.error), true, 'recognised as a refusal after an earlier send')
    assert.match(afterSend.error ?? '', /HAD ALREADY been sent/)

    received.length = 0
    tokenCalls = 0; throwOnCall = 1
    const beforeSend = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
    assert.deepEqual(received, [], 'control: nothing was sent')
    assert.equal(beforeSend.held, true)
    assert.equal(isOutboundWriteHeldText(beforeSend.error), true)
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
