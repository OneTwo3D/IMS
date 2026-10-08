import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { mock } from 'node:test'

import { OutboundWriteHeldError, outboundWriteRefusal } from '../lib/security/outbound-write-grant'
import { isOutboundMaybeSentRefusalText, isOutboundWriteHeldText } from '../lib/security/outbound-write-hold-constants'
import * as realTransport from '../lib/security/connector-fetch'
import { setOutboundRefusalSink } from '../lib/security/outbound-write-refusal-log'

/**
 * WHAT THE EARLIER RESPONSE PROVES, AND SO WHAT A LATER HOLD MEANS (mintsoftRequest).
 *
 * Only an HTTP 401 on the request being retried is proof it was NOT processed (Mintsoft refuses an
 * unauthenticated request before the handler runs). So a hold on the key refresh that follows a 401 refuses a
 * LOGIN, not a create: a PURE hold. Every other earlier outcome (403, 404, 409, 422, 5xx, a timeout, a dropped
 * connection) proves nothing about whether the handler ran: it is returned as an ordinary failure (spends an
 * attempt, parks ambiguous when it is a create), never as a hold. Real client and transport, local listener.
 */

setOutboundRefusalSink(async () => undefined)

// The real transport, optionally handing back a COPY of each response so its hop provenance is unavailable.
let hideProvenance = false
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetchRedirectsFollowed: realTransport.connectorFetchRedirectsFollowed,
    connectorFetch: async (...args: Parameters<typeof realTransport.connectorFetch>) => {
      const response = await realTransport.connectorFetch(...args)
      if (!hideProvenance) return response
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
    },
  },
})

let baseUrl = ''
let tokenCalls = 0
let refreshSucceeds = false

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
    getMintsoftAccessToken: async (options?: { forceRefresh?: boolean }) => {
      tokenCalls += 1
      if (options?.forceRefresh && !refreshSucceeds) throw heldError() // the key refresh after a 401 is held
      return 'k'
    },
    invalidateMintsoftAccessToken: async () => undefined,
  },
})

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_client_id: '89', mintsoft_courier_service_map: '', mintsoft_default_courier_service_id: '',
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
    }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      const trimmed = (value ?? '').trim()
      return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : null
    },
  },
})

test('table: an earlier 401 + held refresh is a PURE hold; 403/404/409/422/500/502/timeout are ordinary failures that are neither a hold nor a maybe-sent refusal', async () => {
  let respondWith: number | 'drop' = 401
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    if (respondWith === 'drop') { req.socket.destroy(); return }
    res.writeHead(respondWith); res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
  try {
    const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
    const table: Array<[number | 'drop', 'hold' | 'ordinary']> = [
      [401, 'hold'], [403, 'ordinary'], [404, 'ordinary'], [409, 'ordinary'], [422, 'ordinary'], [500, 'ordinary'], [502, 'ordinary'], ['drop', 'ordinary'],
    ]
    console.log(`precondition (earlier response): PUT granted on ${baseUrl}; ${table.length} earlier outcomes; the key refresh is held whenever it is reached`)
    for (const [status, expected] of table) {
      respondWith = status
      received.length = 0
      tokenCalls = 0
      const result = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
      assert.deepEqual(received, ['PUT /api/Order'], `${status}: the PUT was sent exactly once and never replayed`)
      if (expected === 'hold') {
        assert.equal(result.held, true, `${status}: a hold on the refresh after a 401 is a PURE hold`)
        assert.equal(isOutboundWriteHeldText(result.error), true)
        assert.equal(tokenCalls, 2, 'the refresh step was reached')
      } else {
        assert.equal(result.held, undefined, `${status}: not a hold`)
        assert.equal(isOutboundWriteHeldText(result.error), false)
        assert.equal(isOutboundMaybeSentRefusalText(result.error), false)
        assert.ok(result.error, `${status}: an ordinary failure is reported`)
        assert.equal(tokenCalls, 1, `${status}: no refresh step, so no hold can follow`)
      }
    }
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a hold on the FIRST request itself (nothing sent) is a pure hold too', async () => {
  const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
  baseUrl = 'https://api.mintsoft.co.uk'
  delete process.env.MINTSOFT_WRITE_ALLOWED
  const result = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
  assert.equal(result.held, true)
  assert.equal(isOutboundWriteHeldText(result.error), true)
})

test('through pushMintsoftOrder: a create that drew a 401 and then a held key refresh surfaces as a PURE hold (the sweep clears its own claim stamp and spends no attempt)', async () => {
  const received: string[] = []
  const server = createServer((req, res) => { received.push(`${req.method} ${req.url}`); res.writeHead(401); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
  try {
    const { pushMintsoftOrder } = await import('../lib/connectors/mintsoft/api/order-push')
    console.log('precondition (401 then held refresh, via the push): the only PUT drew a 401; the login that would renew the key is held')
    const input = {
      orderNumber: 'WC-1', externalReference: 'REF-1', externalWarehouseId: '3', currency: 'GBP', email: 'a@example.com', phone: null, vatNumber: null,
      comments: null, courierService: null, totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0,
      lines: [{ sku: 'S', quantity: 1, unitPriceExVat: 1, unitPriceVat: 0.2, description: 'W' }],
      shippingAddress: { firstName: 'A', lastName: 'B', company: '', address1: '1', address2: '', town: 'T', county: '', postCode: 'P', country: 'GB' },
    }
    const error = await pushMintsoftOrder(input as never).then(() => null, (e: unknown) => e as Error)
    assert.ok(error)
    assert.deepEqual(received, ['PUT /api/Order'], 'exactly one PUT, rejected before processing')
    assert.equal(isOutboundWriteHeldText(error.message), true, 'a PURE hold: the sweep recognises it and clears the stamp by compare-and-set')
    assert.equal(isOutboundMaybeSentRefusalText(error.message), false)
  } finally {
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('table (settled rule): a 401 is proof of non-processing ONLY with zero followed redirects; after a redirect hop, or with the hop count unavailable, a held refresh is maybe-sent', async () => {
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    if (req.url === '/api/Order' && redirectFirst) { res.writeHead(307, { location: '/api/OrderMoved' }); res.end(); return }
    res.writeHead(401); res.end()
  })
  let redirectFirst = false
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
  try {
    const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
    const cases: Array<[string, { redirect: boolean; hide: boolean }, 'hold' | 'maybe-sent']> = [
      ['401 on the original request, zero hops', { redirect: false, hide: false }, 'hold'],
      ['401 after one followed redirect hop', { redirect: true, hide: false }, 'maybe-sent'],
      ['401 with the hop count unavailable', { redirect: false, hide: true }, 'maybe-sent'],
    ]
    console.log(`precondition (hop provenance): ${cases.length} cases; every refresh step is held`)
    for (const [name, mode, expected] of cases) {
      redirectFirst = mode.redirect
      hideProvenance = mode.hide
      received.length = 0
      const result = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
      hideProvenance = false
      assert.deepEqual(received, mode.redirect ? ['PUT /api/Order', 'PUT /api/OrderMoved'] : ['PUT /api/Order'], `${name}: no replay after the refusal`)
      if (expected === 'hold') {
        assert.equal(result.held, true, name)
        assert.equal(isOutboundWriteHeldText(result.error), true, name)
      } else {
        assert.equal(result.held, undefined, name)
        assert.equal(isOutboundWriteHeldText(result.error), false, `${name}: must NOT be a hold`)
        assert.equal(isOutboundMaybeSentRefusalText(result.error), true, `${name}: maybe-sent`)
      }
    }
  } finally {
    hideProvenance = false
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('unproven 401 + a refresh that WOULD succeed: a mutating request is never replayed; zero-hop 401 and reads are', async () => {
  const received: string[] = []
  let redirectFirst = false
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    if (redirectFirst && (req.url === '/api/Order' || req.url === '/api/Order/5')) { res.writeHead(307, { location: `/moved${req.url}` }); res.end(); return }
    res.writeHead(received.filter((r) => r.endsWith(req.url ?? '')).length > 1 ? 200 : 401, { 'content-type': 'application/json' }); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.E2E_TEST_MODE = '1'
  process.env.MINTSOFT_WRITE_ALLOWED = `${baseUrl}|89`
  refreshSucceeds = true
  try {
    const { mintsoftRequest } = await import('../lib/connectors/mintsoft/api/client')
    console.log('precondition (no replay): login IS granted and the refresh would succeed in every case')
    redirectFirst = true; received.length = 0
    const put = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
    assert.deepEqual(received, ['PUT /api/Order', 'PUT /moved/api/Order'], 'redirected PUT then 401: exactly the two hops of ONE request, no refresh-and-replay')
    assert.equal(isOutboundMaybeSentRefusalText(put.error), true, 'maybe-sent')
    assert.equal(put.held, undefined)
    redirectFirst = false; received.length = 0
    const zero = await mintsoftRequest('/api/Order', { method: 'PUT', body: '{"ClientId":89}' })
    assert.deepEqual(received, ['PUT /api/Order', 'PUT /api/Order'], 'proven zero-hop 401: refreshed and replayed once')
    assert.equal(zero.status, 200)
    redirectFirst = true; received.length = 0
    const get = await mintsoftRequest('/api/Order/5')
    assert.equal(received.length >= 3, true, 'a READ is replayed after refresh even when the 401 followed a redirect')
    assert.equal(get.status, 200)
  } finally {
    refreshSucceeds = false
    delete process.env.MINTSOFT_WRITE_ALLOWED
    delete process.env.E2E_TEST_MODE
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
