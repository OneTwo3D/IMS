import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import test, { after, beforeEach } from 'node:test'

import { connectorFetch } from '../../lib/security/connector-fetch.ts'
import { isOutboundWriteHeldError, OutboundWriteHeldError } from '../../lib/security/outbound-write-grant.ts'
import {
  resetOutboundRefusalRateLimit,
  setOutboundRefusalSink,
} from '../../lib/security/outbound-write-refusal-log.ts'

/**
 * THE OUTBOUND-WRITE HOLD, PROVEN THROUGH THE REAL `connectorFetch` AGAINST LOCAL LOOPBACK LISTENERS.
 *
 * Every request here goes to a listener this file starts on 127.0.0.1. NO vendor host is ever named or
 * contacted. The assertion that matters is on the LISTENER'S request log - the bytes that arrived - not
 * on a return value, so a hold that is present but ineffective fails.
 *
 * Arms (each has a printed precondition and one named mutation, recorded in the PR):
 *  (a) GATE: with no grant every write class is refused and no byte reaches the listener.
 *      Mutation: delete the `outboundWriteRefusal` call in connectorFetch.
 *  (b) MINTSOFT BY PATH: GET .../Cancel is refused although it is a GET.
 *      Mutation: classify Mintsoft by method (read when GET).
 *  (c) REDIRECT: a grant for origin A refuses origin B after a redirect.
 *      Mutation: evaluate only before the loop (once, for the first hop).
 *  (d) UNREADABLE GRANT: a list, a path, credentials, a flag all deny.
 *      Mutation: accept a comma list (take the first entry).
 */

type Received = { method: string; url: string; body: string }

type Listener = { origin: string; server: Server; received: Received[]; redirectTo: string | null }

const listeners: Listener[] = []

async function startListener(redirectTo: string | null = null): Promise<Listener> {
  const received: Received[] = []
  const listener: Listener = { origin: '', server: null as unknown as Server, received, redirectTo }
  listener.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
      if (listener.redirectTo) {
        res.writeHead(307, { location: listener.redirectTo })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => listener.server.listen(0, '127.0.0.1', resolve))
  const address = listener.server.address()
  if (!address || typeof address !== 'object') throw new Error('listener did not bind')
  listener.origin = `http://127.0.0.1:${address.port}`
  listeners.push(listener)
  return listener
}

after(async () => {
  await Promise.all(listeners.map((listener) => new Promise<void>((resolve) => listener.server.close(() => resolve()))))
})

const refusals: OutboundWriteHeldError[] = []
beforeEach(() => {
  refusals.length = 0
  resetOutboundRefusalRateLimit()
  setOutboundRefusalSink(async (error) => { refusals.push(error) })
})
after(() => setOutboundRefusalSink(null))

/** Env for one call: loopback http is allowed only under the e2e allowance, so every call carries it. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { E2E_TEST_MODE: '1', NODE_ENV: 'test', ...extra }
}

type Case = {
  name: string
  connectorName: 'WooCommerce' | 'Mintsoft' | 'Xero'
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  /** Env that grants exactly this case, built from the listener origin. */
  grant: (origin: string) => Record<string, string>
  mintsoftClientId?: string
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'

const WRITE_CASES: Case[] = [
  { name: 'WooCommerce PUT /orders/1', connectorName: 'WooCommerce', method: 'PUT', path: '/wp-json/wc/v3/orders/1', body: '{"status":"completed"}', grant: (o) => ({ WC_WRITEBACK_ALLOWED_ORIGIN: o }) },
  { name: 'WooCommerce POST /webhooks (registration)', connectorName: 'WooCommerce', method: 'POST', path: '/wp-json/wc/v3/webhooks', body: '{}', grant: (o) => ({ WC_WRITEBACK_ALLOWED_ORIGIN: o }) },
  { name: 'WooCommerce DELETE', connectorName: 'WooCommerce', method: 'DELETE', path: '/wp-json/wc/v3/products/1', grant: (o) => ({ WC_WRITEBACK_ALLOWED_ORIGIN: o }) },
  { name: 'Mintsoft PUT /api/Order', connectorName: 'Mintsoft', method: 'PUT', path: '/api/Order', body: '{"ClientId":89}', mintsoftClientId: '89', grant: (o) => ({ MINTSOFT_WRITE_ALLOWED: `${o}|89` }) },
  { name: 'Mintsoft GET /api/Order/5/Cancel', connectorName: 'Mintsoft', method: 'GET', path: '/api/Order/5/Cancel', mintsoftClientId: '89', grant: (o) => ({ MINTSOFT_WRITE_ALLOWED: `${o}|89` }) },
  { name: 'Mintsoft GET /api/Order/5/MarkAwaitingConfirmation', connectorName: 'Mintsoft', method: 'GET', path: '/api/Order/5/MarkAwaitingConfirmation', mintsoftClientId: '89', grant: (o) => ({ MINTSOFT_WRITE_ALLOWED: `${o}|89` }) },
  { name: 'Mintsoft POST /api/Order/5/Comments', connectorName: 'Mintsoft', method: 'POST', path: '/api/Order/5/Comments', body: '{}', mintsoftClientId: '89', grant: (o) => ({ MINTSOFT_WRITE_ALLOWED: `${o}|89` }) },
  { name: 'Mintsoft POST /api/Auth (key-minting login)', connectorName: 'Mintsoft', method: 'POST', path: '/api/Auth', body: '{}', grant: (o) => ({ MINTSOFT_WRITE_ALLOWED: `${o}|89` }) },
  { name: 'Xero POST journal', connectorName: 'Xero', method: 'POST', path: '/api.xro/2.0/ManualJournals', body: '{}', headers: { 'Xero-Tenant-Id': TENANT }, grant: () => ({ XERO_WRITE_ALLOWED_TENANT: TENANT }) },
  { name: 'Xero PUT contact', connectorName: 'Xero', method: 'PUT', path: '/api.xro/2.0/Contacts', body: '{}', headers: { 'Xero-Tenant-Id': TENANT }, grant: () => ({ XERO_WRITE_ALLOWED_TENANT: TENANT }) },
]

async function send(testCase: Case, origin: string, grant: Record<string, string> | null): Promise<unknown> {
  return connectorFetch(`${origin}${testCase.path}`, {
    method: testCase.method,
    headers: testCase.headers,
    body: testCase.body,
  }, {
    connectorName: testCase.connectorName,
    allowE2eLocalHttp: true,
    env: env(grant ?? {}),
    outboundWriteContext: { writeScopeId: testCase.mintsoftClientId ?? null },
  })
}

test('(a) GATE + acceptance 1 and 2: with no grant every write class is refused and NO byte reaches the listener; with the grant each reaches it', async () => {
  const held = await startListener()
  const granted = await startListener()
  console.log(`precondition (a): ${WRITE_CASES.length} write cases; no-grant listener ${held.origin}, granted listener ${granted.origin}`)
  assert.ok(WRITE_CASES.length >= 10)

  for (const testCase of WRITE_CASES) {
    await assert.rejects(send(testCase, held.origin, null), (error: unknown) => {
      assert.ok(isOutboundWriteHeldError(error), `${testCase.name}: expected OutboundWriteHeldError, got ${String(error)}`)
      assert.equal((error as OutboundWriteHeldError).code, 'no_grant', testCase.name)
      assert.equal((error as OutboundWriteHeldError).nothingSent, true, testCase.name)
      assert.match((error as Error).message, /^Outbound write HELD \(/, testCase.name)
      return true
    })
  }
  assert.equal(held.received.length, 0, `NO byte may reach the listener without a grant (saw ${JSON.stringify(held.received)})`)

  for (const testCase of WRITE_CASES) {
    const response = await send(testCase, granted.origin, testCase.grant(granted.origin)) as Response
    assert.equal(response.status, 200, testCase.name)
  }
  assert.equal(granted.received.length, WRITE_CASES.length, 'every granted write reached the listener exactly once')
  console.log(`(a) observed: ${held.received.length} bytes-bearing requests without a grant, ${granted.received.length}/${WRITE_CASES.length} with it`)
})

test('reads are never held: GET/HEAD to WooCommerce and an allow-listed Mintsoft read reach the listener with no grant at all', async () => {
  const listener = await startListener()
  const reads: Array<[string, 'WooCommerce' | 'Mintsoft', string, string]> = [
    ['WooCommerce GET', 'WooCommerce', 'GET', '/wp-json/wc/v3/orders'],
    ['WooCommerce HEAD', 'WooCommerce', 'HEAD', '/wp-json/wc/v3/orders'],
    ['Mintsoft GET /api/Warehouse', 'Mintsoft', 'GET', '/api/Warehouse'],
    ['Mintsoft GET /api/Order/Search', 'Mintsoft', 'GET', '/api/Order/Search?OrderNumber=1&ClientId=89'],
    ['Mintsoft GET /api/Order/5/Items', 'Mintsoft', 'GET', '/api/Order/5/Items?ClientId=89'],
  ]
  console.log(`precondition (reads): ${reads.length} read cases, no grant variable set`)
  for (const [name, connectorName, method, path] of reads) {
    const response = await connectorFetch(`${listener.origin}${path}`, { method }, {
      connectorName, allowE2eLocalHttp: true, env: env(),
    })
    assert.equal(response.status, 200, name)
  }
  assert.equal(listener.received.length, reads.length)
  assert.equal(refusals.length, 0, 'a read logs no refusal')
})

test('(b) MINTSOFT BY PATH, NOT METHOD: a GET to /Cancel is refused even though GET is the method of every read', async () => {
  const listener = await startListener()
  const target = `${listener.origin}/api/Order/12345/Cancel`
  console.log(`precondition (b): method=GET path=/api/Order/12345/Cancel, no grant; a GET to /api/Order/12345 on the same listener must pass`)

  const read = await connectorFetch(`${listener.origin}/api/Order/12345`, { method: 'GET' }, {
    connectorName: 'Mintsoft', allowE2eLocalHttp: true, env: env(),
  })
  assert.equal(read.status, 200, 'the control: a GET read of the same order is allowed')
  assert.equal(listener.received.length, 1)

  await assert.rejects(
    connectorFetch(target, { method: 'GET' }, { connectorName: 'Mintsoft', allowE2eLocalHttp: true, env: env(), outboundWriteContext: { writeScopeId: '89' } }),
    isOutboundWriteHeldError,
  )
  assert.equal(listener.received.length, 1, 'the GET /Cancel reached nothing: only the control read arrived')
})

test('(c) REDIRECT: a grant for origin A is NOT a grant for origin B reached by redirect, and the refusal says the first request WAS sent', async () => {
  const listenerB = await startListener()
  const listenerA = await startListener(`${listenerB.origin}/wp-json/wc/v3/orders/1`)
  console.log(`precondition (c): A=${listenerA.origin} (granted, answers 307 to B) B=${listenerB.origin} (not granted)`)

  const error = await connectorFetch(`${listenerA.origin}/wp-json/wc/v3/orders/1`, {
    method: 'PUT', body: '{"status":"completed"}', headers: { 'content-type': 'application/json' },
  }, {
    connectorName: 'WooCommerce', allowE2eLocalHttp: true, env: env({ WC_WRITEBACK_ALLOWED_ORIGIN: listenerA.origin }),
  }).then(() => null, (caught: unknown) => caught)

  assert.ok(isOutboundWriteHeldError(error), `expected a hold, got ${String(error)}`)
  const held = error as OutboundWriteHeldError
  assert.equal(held.code, 'destination_mismatch')
  assert.equal(held.hop, 1, 'refused on the redirect hop, not the first')
  assert.equal(held.nothingSent, false, 'the first request had already been sent, so nothing-sent is not claimed')
  assert.match(held.message, /HAD ALREADY been sent/)
  assert.doesNotMatch(held.message, /so nothing was sent/)
  assert.equal(listenerA.received.length, 1, 'A received the granted PUT')
  assert.equal(listenerB.received.length, 0, 'B received NOTHING')
})

test('(d) UNREADABLE GRANT = DENY: a list, a path, credentials, a bare host, a flag and a wildcard each refuse and no byte arrives', async () => {
  const listener = await startListener()
  const o = listener.origin
  const wcBad: string[] = [
    `${o},http://127.0.0.1:1`, `${o} http://127.0.0.1:1`, `${o}/wp-json`, `${o}?x=1`, `${o}#f`,
    `http://user:pw@127.0.0.1:${new URL(o).port}`, '127.0.0.1', 'true', '1', '*',
  ]
  const msBad: string[] = [
    o, `${o}|`, `|89`, `${o}|089`, `${o}|8.9`, `${o}|89|90`, `${o},${o}|89`, `${o}|89,${o}|90`, `true`,
  ]
  const xeroBad: string[] = [`${TENANT},${TENANT}`, `${TENANT} ${TENANT}`, 'true', '1', '*', 'all']
  console.log(`precondition (d): ${wcBad.length} WooCommerce, ${msBad.length} Mintsoft, ${xeroBad.length} Xero unreadable shapes`)

  let refused = 0
  for (const value of wcBad) {
    await assert.rejects(connectorFetch(`${o}/wp-json/wc/v3/orders/1`, { method: 'PUT', body: '{}' }, {
      connectorName: 'WooCommerce', allowE2eLocalHttp: true, env: env({ WC_WRITEBACK_ALLOWED_ORIGIN: value }),
    }), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'unreadable_grant', `WC ${value}`)
    refused += 1
  }
  for (const value of msBad) {
    await assert.rejects(connectorFetch(`${o}/api/Order`, { method: 'PUT', body: '{"ClientId":89}' }, {
      connectorName: 'Mintsoft', allowE2eLocalHttp: true, env: env({ MINTSOFT_WRITE_ALLOWED: value }),
      outboundWriteContext: { writeScopeId: '89' },
    }), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'unreadable_grant', `Mintsoft ${value}`)
    refused += 1
  }
  for (const value of xeroBad) {
    await assert.rejects(connectorFetch(`${o}/api.xro/2.0/Invoices`, { method: 'POST', body: '{}', headers: { 'Xero-Tenant-Id': TENANT } }, {
      connectorName: 'Xero', allowE2eLocalHttp: true, env: env({ XERO_WRITE_ALLOWED_TENANT: value }),
    }), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'unreadable_grant', `Xero ${value}`)
    refused += 1
  }
  assert.equal(refused, wcBad.length + msBad.length + xeroBad.length)
  assert.equal(listener.received.length, 0, 'not one byte arrived for any unreadable grant')
  console.log(`(d) observed: ${refused} refusals, ${listener.received.length} bytes at the listener`)
})

test('Mintsoft ClientId: a grant for ClientId 89 refuses a write configured for another ClientId, one whose body names another, and one with no ClientId at all', async () => {
  const listener = await startListener()
  const grant = { MINTSOFT_WRITE_ALLOWED: `${listener.origin}|89` }
  const attempt = (body: string, clientId: string | null) => connectorFetch(`${listener.origin}/api/Order`, { method: 'PUT', body }, {
    connectorName: 'Mintsoft', allowE2eLocalHttp: true, env: env(grant), outboundWriteContext: { writeScopeId: clientId },
  })
  console.log('precondition (clientid): grant names ClientId 89 on the listener base')
  await assert.rejects(attempt('{}', '101'), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'client_mismatch')
  await assert.rejects(attempt('{"ClientId":101}', '89'), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'client_mismatch')
  await assert.rejects(attempt('{}', null), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'client_unproven')
  assert.equal(listener.received.length, 0)
  const ok = await attempt('{"ClientId":89}', '89')
  assert.equal(ok.status, 200)
  assert.equal(listener.received.length, 1)
})

test('Xero: a write for a tenant other than the granted one is refused; a write with no tenant header is refused', async () => {
  const listener = await startListener()
  const grant = { XERO_WRITE_ALLOWED_TENANT: TENANT }
  const post = (headers: Record<string, string>) => connectorFetch(`${listener.origin}/api.xro/2.0/Invoices`, { method: 'POST', body: '{}', headers }, {
    connectorName: 'Xero', allowE2eLocalHttp: true, env: env(grant),
  })
  console.log('precondition (xero): grant names one tenant')
  await assert.rejects(post({ 'Xero-Tenant-Id': '99999999-9999-4999-8999-999999999999' }), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'destination_mismatch')
  await assert.rejects(post({}), (e: unknown) => isOutboundWriteHeldError(e) && e.code === 'tenant_unproven')
  assert.equal(listener.received.length, 0)
  const ok = await post({ 'Xero-Tenant-Id': TENANT.toUpperCase() })
  assert.equal(ok.status, 200, 'tenant ids compare case-insensitively')
})

test('refusals are rate-limited per connector and code, and the suppressed count rides on the next entry', async () => {
  const { recordOutboundWriteRefusal } = await import('../../lib/security/outbound-write-refusal-log.ts')
  const refusal = {
    connector: 'xero', code: 'no_grant', method: 'POST', target: 'https://api.xero.com/x', granted: null, attempted: null, basis: 'b',
  } as const
  const error = new OutboundWriteHeldError(refusal, 0)
  const other = new OutboundWriteHeldError({ ...refusal, connector: 'mintsoft' }, 0)
  const suppressed: number[] = []
  setOutboundRefusalSink(async (_e, count) => { suppressed.push(count) })
  resetOutboundRefusalRateLimit()
  const t0 = 1_000_000
  console.log('precondition (rate limit): one connector+code refused 5 times inside the window, a second connector once')
  const written = [
    await recordOutboundWriteRefusal(error, t0),
    await recordOutboundWriteRefusal(error, t0 + 1),
    await recordOutboundWriteRefusal(error, t0 + 2),
    await recordOutboundWriteRefusal(other, t0 + 3),
    await recordOutboundWriteRefusal(error, t0 + 4),
    await recordOutboundWriteRefusal(error, t0 + 60_001),
  ]
  assert.deepEqual(written, [true, false, false, true, false, true])
  assert.deepEqual(suppressed, [0, 0, 3], 'the entry after the window carries the 3 suppressed refusals')
})
