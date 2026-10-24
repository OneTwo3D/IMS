import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { afterEach } from 'node:test'

import { XERO_READ_PARAMS, XERO_READ_RESOURCES, XERO_TOKEN_MIN_REMAINING_MS } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readXeroAccess, readXeroBinding } from '../../lib/reconciliation-pack/xero-credentials.ts'
import { makeXeroWalker, readXeroBaseCurrency, readXeroInvoices, xeroInvoiceWhere } from '../../lib/reconciliation-pack/xero-source.ts'
import { XERO_WHERE_RE, createXeroGetPort, xeroHopRefusal } from '../../lib/reconciliation-pack/xero-transport.ts'
import { invoice, noSleep } from './vat-fixtures.ts'

/**
 * THE XERO TRANSPORT over a LOOPBACK HTTP double (no real network: tests/no-outbound-network.cjs refuses anything else), and the stored
 * connection reader over a recording client. Mutations are named per test.
 */

const TOKEN = 'xero_access_token_value_for_tests'
const TENANT = 'a1b2c3d4-0000-4000-8000-000000000001'
// The fetch seam's outbound-write hold classes a Xero request to anything but api.xero.com as a write (a loopback double is not Xero), so
// the DOUBLE is given the grant that lets it be reached. The real command never sets it: api.xero.com GET is a read to the hold.
const E2E = { E2E_TEST_MODE: '1', NODE_ENV: 'test', XERO_WRITE_ALLOWED_TENANT: TENANT }
const NOW = new Date('2026-10-20T10:00:00.000Z')

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders }
type Rig = { seen: Seen[]; base: string; close: () => Promise<void> }
const rigs: Rig[] = []
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close() })

async function double(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void): Promise<Rig> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => { seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers }); handler(req, res, seen) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const rig: Rig = { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api.xro/2.0`, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
  rigs.push(rig)
  return rig
}
const json = (res: http.ServerResponse, body: unknown, status = 200, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'content-type': type }); res.end(JSON.stringify(body)) }

function xeroHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/api.xro/2.0/Organisation') return json(res, { Organisations: [{ BaseCurrency: 'GBP', Name: `secret ${TOKEN}` }] })
  if (url.pathname === '/api.xro/2.0/Invoices') {
    const rows = Number(url.searchParams.get('page')) === 1 ? [invoice(1, '2026-09-10', [{ type: 'OUTPUT2', tax: 20 }]), invoice(2, '2026-09-11', [{ type: 'OUTPUT2', tax: 5 }])] : []
    return json(res, { Invoices: rows, pagination: { page: Number(url.searchParams.get('page')), pageSize: 100, pageCount: 1, itemCount: 2 } })
  }
  json(res, { Message: `no route, and the token ${TOKEN}` }, 404)
}
const portFor = (rig: Rig, over: Partial<Parameters<typeof createXeroGetPort>[0]> = {}) =>
  createXeroGetPort({ readAccess: async () => ({ accessToken: TOKEN, tenantId: TENANT, connectionGeneration: 'g' }), baseUrl: rig.base, env: E2E, ...over })

test('a full read over loopback is GET only, to the two resources with the listed parameters, the token only in Authorization, the tenant only in its header', async () => {
  const rig = await double(xeroHandler)
  const walker = makeXeroWalker(portFor(rig), { sleep: noSleep })
  const base = await readXeroBaseCurrency(walker)
  const invoices = await readXeroInvoices(walker, { from: '2026-07-31', toExclusive: '2026-10-02' })
  assert.deepEqual(base, { ok: true, value: 'GBP' })
  assert.ok(invoices.ok && invoices.value.total === 2)
  assert.equal(rig.seen.length, 3, 'the organisation, then one page, read twice')
  // THE NO-NON-GET PROOF: the double saw nothing but GET.
  assert.deepEqual([...new Set(rig.seen.map((s) => s.method))], ['GET'])
  for (const s of rig.seen) {
    const url = new URL(s.url, 'http://x')
    assert.ok((XERO_READ_RESOURCES as readonly string[]).includes(url.pathname.replace('/api.xro/2.0/', '')), s.url)
    for (const name of url.searchParams.keys()) assert.ok((XERO_READ_PARAMS as readonly string[]).includes(name), name)
    assert.equal(s.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(s.headers['xero-tenant-id'], TENANT)
    assert.ok(!s.url.includes(TOKEN) && !s.url.includes(TENANT), 'neither the token nor the tenant is in the URL')
  }
})

// [mutation: xeroHopRefusal's method / path / parameter checks removed]
test('the hop gate refuses everything but a GET to the organisation or the invoice list on the API origin with the fixed parameters', () => {
  const base = new URL('https://api.xero.com/api.xro/2.0')
  const hop = (url: string, method = 'GET', redirectCount = 0) => xeroHopRefusal(base, { method, url: new URL(url), redirectCount })
  const where = encodeURIComponent(xeroInvoiceWhere({ from: '2026-07-31', toExclusive: '2026-10-02' }))
  const good = `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID&page=2`
  assert.equal(hop(good), null)
  assert.equal(hop('https://api.xero.com/api.xro/2.0/Organisation'), null)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', '']) assert.equal(hop(good, method), 'method', method)
  assert.equal(hop(good, 'GET', 1), 'redirect')
  for (const url of [
    'https://api.xero.com/api.xro/2.0/Invoices/abc', 'https://api.xero.com/api.xro/2.0/Contacts', 'https://api.xero.com/api.xro/2.0/Payments', 'https://api.xero.com/api.xro/2.0/CreditNotes', 'https://api.xero.com/api.xro/2.0/Journals',
    'https://api.xero.com/api.xro/2.0/Reports/TrialBalance', 'https://api.xero.com/api.xro/2.0/Invoices/', 'https://api.xero.com/api.xro/2.0/invoices', 'https://api.xero.com/api.xro/2.0', 'https://api.xero.com/api.xro/1.0/Invoices',
    'https://api.xero.com/connections', 'https://api.xero.com/api.xro/2.0/Organisation/../Contacts', 'https://api.xero.com/',
  ]) assert.equal(hop(url), 'path', url)
  for (const url of [
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID`, // page missing
    `https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED,PAID&page=1`, // where missing
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&page=1`, // Statuses missing
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=DRAFT&page=1`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID,DRAFT&page=1`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCPAY" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)')}&Statuses=AUTHORISED,PAID&page=1`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCREC"')}&Statuses=AUTHORISED,PAID&page=1`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent('Type=="ACCREC" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2) OR Status=="DRAFT"')}&Statuses=AUTHORISED,PAID&page=1`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID&page=0`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID&page=1&page=2`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID&page=1&order=Date`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID&page=1&pageSize=1000`,
    `https://api.xero.com/api.xro/2.0/Invoices?where=${where}&Statuses=AUTHORISED,PAID&page=1&summaryOnly=true`,
    'https://api.xero.com/api.xro/2.0/Organisation?page=1',
    'https://api.xero.com/api.xro/2.0/Organisation?where=x',
  ]) assert.equal(hop(url), 'parameter', url)
  for (const url of ['https://other.example/api.xro/2.0/Organisation', 'http://api.xero.com/api.xro/2.0/Organisation', 'https://api.xero.com:8443/api.xro/2.0/Organisation', 'https://u:p@api.xero.com/api.xro/2.0/Organisation', 'https://api.xero.com/api.xro/2.0/Organisation#x']) assert.equal(hop(url), 'origin', url)
  // The where shape is one: dates as plain numbers, no other clause.
  assert.ok(XERO_WHERE_RE.test('Type=="ACCREC" AND Date>=DateTime(2026, 7, 31) AND Date<DateTime(2026, 10, 2)'))
  assert.ok(!XERO_WHERE_RE.test('Type=="ACCREC" AND Date>=DateTime(2026, 07, 31) AND Date<DateTime(2026, 10, 2)'))
})

// [mutation: the hopGate not handed to the seam / refuseRedirects removed / the method made a parameter]
test('the seam is handed the gate and refuses redirects: a POST hop and a redirected hop are refused through the gate it was given', async () => {
  let seamOptions: Parameters<typeof import('../../lib/security/connector-fetch.ts').connectorFetch>[2] | undefined
  let method: string | undefined
  const port = createXeroGetPort({
    readAccess: async () => ({ accessToken: TOKEN, tenantId: TENANT, connectionGeneration: 'g' }),
    fetchImpl: async (_input, init, options) => { seamOptions = options; method = init?.method; return new Response('{"Organisations":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) },
  })
  assert.ok((await port.get('Organisation', {})).ok)
  assert.equal(method, 'GET')
  assert.equal(seamOptions?.refuseRedirects, true)
  assert.equal(seamOptions?.connectorName, 'Xero')
  const gate = seamOptions!.hopGate!
  assert.equal(gate({ method: 'GET', url: new URL('https://api.xero.com/api.xro/2.0/Organisation'), redirectCount: 0 }), null)
  assert.equal(gate({ method: 'POST', url: new URL('https://api.xero.com/api.xro/2.0/Organisation'), redirectCount: 0 }), 'method')
  assert.equal(gate({ method: 'GET', url: new URL('https://evil.example/api.xro/2.0/Organisation'), redirectCount: 1 }), 'redirect')
  // A resource that is not on the list is never even built into a request.
  assert.deepEqual(await port.get('Contacts' as never, {}), { ok: false })
})

test('A REDIRECT IS AN ERROR AND ITS TARGET IS NEVER REQUESTED', async () => {
  const target = await double((_req, res) => json(res, { Organisations: [{ BaseCurrency: 'GBP' }] }))
  const origin = await double((_req, res) => { res.writeHead(302, { location: `${target.base}/Organisation` }); res.end() })
  const page = await portFor(origin).get('Organisation', {})
  assert.deepEqual(page, { ok: false })
  assert.equal(target.seen.length, 0)
})

test('NO USABLE ACCESS, NO REQUEST: a null grant, a throwing reader and an unlisted resource send nothing; the reader is consulted once for many requests', async () => {
  const rig = await double(xeroHandler)
  assert.deepEqual(await portFor(rig, { readAccess: async () => null }).get('Organisation', {}), { ok: false })
  assert.deepEqual(await portFor(rig, { readAccess: async () => { throw new Error('boom') } }).get('Organisation', {}), { ok: false })
  assert.equal(rig.seen.length, 0)
  let reads = 0
  const port = portFor(rig, { readAccess: async () => { reads += 1; return { accessToken: TOKEN, tenantId: TENANT, connectionGeneration: null } } })
  await port.get('Organisation', {}); await port.get('Organisation', {}); await port.get('Organisation', {})
  assert.equal(reads, 1)
})

test('any answer but a 2xx JSON body is not a page, and nothing of the answer (the token a server echoes included) is kept', async () => {
  for (const [status, type] of [[500, 'application/json'], [429, 'application/json'], [401, 'application/json'], [200, 'text/html'], [404, 'application/json']] as const) {
    const rig = await double((_req, res) => json(res, { Message: `echo ${TOKEN}` }, status, type))
    const page = await portFor(rig).get('Organisation', {})
    assert.deepEqual(page, { ok: false }, `${status} ${type}`)
    assert.ok(!JSON.stringify(page).includes(TOKEN))
  }
  const rig = await double((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not json') })
  assert.deepEqual(await portFor(rig).get('Organisation', {}), { ok: false })
})

// ---- the stored connection ----------------------------------------------------------------------------------

type Row = Record<string, unknown>
type ClientRig = { client: ImsQueryClient; statements: string[] }
function clientRig(over: { tokens?: Row[]; settings?: Row[]; readOnly?: string; failOn?: RegExp } = {}): ClientRig {
  const statements: string[] = []
  const token: Row = {
    token: TOKEN, expires: new Date(NOW.getTime() + XERO_TOKEN_MIN_REMAINING_MS + 1000).toISOString(), tenant: TENANT, tenant_name: 'Org', demo: null, generation: 'gen-1',
    released_at: null, released_generation: null, released_tenant: null,
  }
  const client: ImsQueryClient = {
    async query(sql) {
      statements.push(sql)
      if (over.failOn?.test(sql)) throw new Error('boom')
      if (/^BEGIN|^ROLLBACK/.test(sql)) return { rows: [] }
      if (/current_setting/.test(sql)) return { rows: [{ read_only: over.readOnly ?? 'on' }] }
      if (/FROM accounting_tokens/.test(sql)) return { rows: over.tokens ?? [token] }
      if (/FROM settings/.test(sql)) return { rows: over.settings ?? [{ key: 'xero_expected_tenant_id', value: TENANT }] }
      throw new Error(`unexpected statement ${sql}`)
    },
  }
  return { client, statements }
}
const ENV = { XERO_ALLOWED_TENANT_IDS: TENANT, NODE_ENV: 'production' }

// [mutation: a write statement allowed / the refresh token selected / the transaction not read only]
test('THE STORED CONNECTION is read in a read-only transaction by SELECTs alone, never selects the refresh token, and always rolls back', async () => {
  const rig = clientRig()
  const access = await readXeroAccess(rig.client, { now: NOW, env: ENV })
  assert.deepEqual(access, { accessToken: TOKEN, tenantId: TENANT, connectionGeneration: 'gen-1' })
  assert.equal(rig.statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(rig.statements.at(-1), 'ROLLBACK')
  for (const sql of rig.statements.slice(1, -1)) assert.match(sql, /^SELECT /)
  assert.ok(!rig.statements.some((sql) => /refreshToken|refresh_token|INSERT|UPDATE|DELETE/i.test(sql)))
  const binding = clientRig()
  assert.deepEqual(await readXeroBinding(binding.client), { tenantId: TENANT, connectionGeneration: 'gen-1' })
  assert.equal(binding.statements.at(-1), 'ROLLBACK')
})

// [mutation: the expiry check removed or turned into a refresh]
test('THE PACK NEVER REFRESHES A TOKEN: one with less than the minimum time to live is null (the read-sync has to renew it first)', async () => {
  const at = (ms: number) => clientRig({ tokens: [{ token: TOKEN, expires: new Date(NOW.getTime() + ms).toISOString(), tenant: TENANT, tenant_name: null, demo: null, generation: 'g', released_at: null, released_generation: null, released_tenant: null }] })
  assert.ok(await readXeroAccess(at(XERO_TOKEN_MIN_REMAINING_MS).client, { now: NOW, env: ENV }), 'exactly the minimum is current')
  assert.equal(await readXeroAccess(at(XERO_TOKEN_MIN_REMAINING_MS - 1).client, { now: NOW, env: ENV }), null)
  assert.equal(await readXeroAccess(at(-1000).client, { now: NOW, env: ENV }), null)
  assert.equal(await readXeroAccess(clientRig({ tokens: [{ token: TOKEN, expires: 'not a date', tenant: TENANT, tenant_name: null, demo: null, generation: 'g', released_at: null, released_generation: null, released_tenant: null }] }).client, { now: NOW, env: ENV }), null)
})

// [mutation: storedXeroConnectionRefusal not consulted]
test('THE CONNECTOR\'S OWN TENANT GUARD decides: an organisation outside the allow-list, blocked, unpinned, or not a demo organisation when one is required is null', async () => {
  assert.equal(await readXeroAccess(clientRig().client, { now: NOW, env: { ...ENV, XERO_ALLOWED_TENANT_IDS: 'a1b2c3d4-0000-4000-8000-0000000000ff' } }), null)
  assert.equal(await readXeroAccess(clientRig().client, { now: NOW, env: { ...ENV, XERO_BLOCKED_TENANT_IDS: TENANT } }), null)
  // A production instance with no allow-list is accepted by the connector (the pin binds it), so it is accepted here too.
  assert.ok(await readXeroAccess(clientRig().client, { now: NOW, env: { NODE_ENV: 'production' } }))
  // A non-production instance with no identity anchor is refused (unguarded), as the connector refuses it.
  assert.equal(await readXeroAccess(clientRig().client, { now: NOW, env: { NODE_ENV: 'development' } }), null)
  // A bound token (it has a generation) with no pin in settings.
  assert.equal(await readXeroAccess(clientRig({ settings: [] }).client, { now: NOW, env: ENV }), null)
  assert.equal(await readXeroAccess(clientRig({ settings: [{ key: 'xero_expected_tenant_id', value: 'a-different-tenant' }] }).client, { now: NOW, env: ENV }), null)
  assert.equal(await readXeroAccess(clientRig().client, { now: NOW, env: { ...ENV, XERO_REQUIRE_DEMO_ORG: '1' } }), null, 'demo not verified')
})

test('a token row that is missing, repeated or malformed, a transaction that is not read only, or any failing statement is null, and the transaction is rolled back', async () => {
  const token = (over: Row) => ({ token: TOKEN, expires: new Date(NOW.getTime() + 3_600_000).toISOString(), tenant: TENANT, tenant_name: null, demo: null, generation: 'gen-1', released_at: null, released_generation: null, released_tenant: null, ...over })
  for (const tokens of [[], [token({}), token({})], [token({ token: '' })], [token({ token: 5 })], [token({ tenant: 'has space' })], [token({ tenant: '' })], [token({ generation: 5 })], [token({ demo: 'yes' })], [token({ released_at: 'x' })]]) {
    const rig = clientRig({ tokens })
    assert.equal(await readXeroAccess(rig.client, { now: NOW, env: ENV }), null, JSON.stringify(tokens).slice(0, 80))
    assert.equal(rig.statements.at(-1), 'ROLLBACK')
  }
  const notReadOnly = clientRig({ readOnly: 'off' })
  assert.equal(await readXeroAccess(notReadOnly.client, { now: NOW, env: ENV }), null)
  assert.equal(notReadOnly.statements.some((sql) => /accounting_tokens/.test(sql)), false, 'nothing is read in a transaction that is not provably read only')
  for (const failOn of [/^BEGIN/, /current_setting/, /accounting_tokens/, /FROM settings/]) assert.equal(await readXeroAccess(clientRig({ failOn }).client, { now: NOW, env: ENV }), null, String(failOn))
  assert.equal(await readXeroAccess(clientRig({ settings: [{ key: 'xero_expected_tenant_id', value: TENANT }, { key: 'xero_expected_tenant_id', value: TENANT }] }).client, { now: NOW, env: ENV }), null)
  assert.equal(await readXeroBinding(clientRig({ tokens: [] }).client), null)
  assert.equal(await readXeroBinding(clientRig({ tokens: [token({}), token({})] }).client), null)
  assert.equal(await readXeroBinding(clientRig({ readOnly: 'off' }).client), null)
})
