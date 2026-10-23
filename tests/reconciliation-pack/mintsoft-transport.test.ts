import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { afterEach } from 'node:test'

import {
  createMintsoftReadPort, MINTSOFT_PACK_SETTING_KEYS, mintsoftReadHopRefusal, readMintsoftPackCredentials,
  type MintsoftPackCredentialRead, type MintsoftQueryClient,
} from '../../lib/connectors/mintsoft/reconciliation-read.ts'
import { classifyMintsoftRequest } from '../../lib/connectors/mintsoft/api/read-allowlist.ts'
import { readWms } from '../../lib/reconciliation-pack/wms-source.ts'
import { encryptSettingValue } from '../../lib/security/encrypted-settings.ts'
import { noSleep, PROBE_PRODUCT_LIST_ROWS, PROBE_WH5, PROBE_WH6 } from './wms-fixtures.ts'

/**
 * THE MINTSOFT READER over a LOOPBACK HTTP double (no real network: tests/no-outbound-network.cjs refuses anything else).
 * The double records every request; a method other than GET, or any request to /api/Auth, fails the test that sees it.
 * Mutations are listed in the PR.
 */

const E2E = { E2E_TEST_MODE: '1', NODE_ENV: 'test' }
const KEY = 'ms_fixed_key_0123456789abcdef_test_only'
const CLIENT = '89'

type Seen = { method: string; url: string; apikey: string | undefined }
type Rig = { seen: Seen[]; base: string; close: () => Promise<void> }
const rigs: Rig[] = []
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close() })

async function double(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void): Promise<Rig> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const entry: Seen = { method: req.method ?? '', url: req.url ?? '', apikey: req.headers['ms-apikey'] as string | undefined }
    seen.push(entry)
    // THE NO-WRITE, NO-LOGIN RIG: a request that is not a GET, or that is for /api/Auth, is a failure of whatever sent it.
    if (entry.method !== 'GET' || /\/api\/Auth/i.test(entry.url)) { res.writeHead(500); res.end(); return }
    handler(req, res, seen)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const rig: Rig = { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
  rigs.push(rig)
  return rig
}

const json = (res: http.ServerResponse, body: unknown, status = 200, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'content-type': type }); res.end(JSON.stringify(body)) }
const noWriteNoLogin = (rig: Rig) => {
  assert.ok(rig.seen.length > 0, 'precondition: requests were made')
  assert.deepEqual([...new Set(rig.seen.map((s) => s.method))], ['GET'])
  assert.ok(rig.seen.every((s) => !/\/api\/Auth/i.test(s.url)), 'nothing asked for /api/Auth')
}

/** A tenant of 12 products as the live API answers it (warehouses 5 and 6), the product list in pages as asked. */
const PRODUCTS = [...PROBE_WH6].map((r) => ({ ID: r.ProductId, SKU: r.SKU, ClientId: r.ClientId, Bundle: r.Bundle, Name: 'a product' }))
function tenant(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/api/Product/StockLevels') return json(res, url.searchParams.get('WarehouseId') === '5' ? PROBE_WH5 : url.searchParams.get('WarehouseId') === '6' ? PROBE_WH6 : [])
  if (url.pathname === '/api/Product/List') {
    const limit = Number(url.searchParams.get('Limit')); const page = Number(url.searchParams.get('PageNo'))
    if (limit > 100) return json(res, { Message: 'Limit too large' }, 400)
    if (page < 1) return json(res, { Message: 'bad page' }, 500)
    return json(res, PRODUCTS.slice((page - 1) * limit, page * limit))
  }
  json(res, { Message: `nothing at ${KEY}` }, 404)
}

const creds = (rig: Rig): MintsoftPackCredentialRead => ({ ok: true, value: { baseUrl: rig.base, apiKey: KEY, clientId: CLIENT } })
const portFor = (rig: Rig, over: Partial<Parameters<typeof createMintsoftReadPort>[0]> = {}) => createMintsoftReadPort({ readCredentials: async () => creds(rig), env: E2E, ...over })

test('a full read over loopback is GET only, to the two listed paths, the key only in ms-apikey, never /api/Auth, and the source proves it', async () => {
  const rig = await double(tenant)
  const read = await readWms(portFor(rig), ['5', '6'], { sleep: noSleep })
  assert.ok(read.ok, read.ok ? '' : read.reason)
  noWriteNoLogin(rig)
  assert.equal(rig.seen.length, 4 + 4, '2 warehouses read twice; 12 products: one page and the end proof, twice')
  for (const s of rig.seen) {
    const url = new URL(s.url, 'http://x')
    assert.ok(['/api/Product/StockLevels', '/api/Product/List'].includes(url.pathname), s.url)
    assert.deepEqual([...url.searchParams.keys()].sort(), url.pathname.endsWith('StockLevels') ? ['WarehouseId'] : ['Limit', 'PageNo'])
    assert.equal(s.apikey, KEY)
    assert.ok(!s.url.includes(KEY), 'the key is never in the URL')
    assert.equal(classifyMintsoftRequest('GET', url.pathname).class, 'read')
  }
  if (read.ok) {
    assert.equal(read.value.stock.get('6')!.find((r) => r.sku === '129552751')!.onHand, 36)
    assert.equal(read.value.stock.get('6')!.filter((r) => r.bundle).length, 2)
    assert.equal(read.value.census.length, 12)
    assert.ok(!JSON.stringify(read).includes(KEY))
  }
})

// [mutation: the clamp removed from the port]
test('THE LIMIT IS CLAMPED AT THE WIRE: a page size of 101, 500 or more is sent as 100 (Mintsoft answers 400 above it)', async () => {
  const rig = await double(tenant)
  const port = portFor(rig)
  for (const asked of [101, 500, 100000, Number.NaN, Number.POSITIVE_INFINITY]) assert.ok((await port.productPage(1, asked)).ok, String(asked))
  assert.deepEqual(rig.seen.map((s) => new URL(s.url, 'http://x').searchParams.get('Limit')), ['100', '100', '100', '100', '100'])
  assert.ok((await port.productPage(1, 7)).ok)
  assert.equal(new URL(rig.seen.at(-1)!.url, 'http://x').searchParams.get('Limit'), '7')
})

// [mutation: the method check, the path check or the parameter check removed from the gate]
test('the hop gate refuses everything but a GET to exactly the stock list of one warehouse or one page of the product list, on the connection\'s own origin', () => {
  const base = new URL('https://api.example.test')
  const hop = (url: string, method = 'GET', redirectCount = 0) => mintsoftReadHopRefusal(base, { method, url: new URL(url), redirectCount })
  assert.equal(hop('https://api.example.test/api/Product/StockLevels?WarehouseId=6'), null)
  assert.equal(hop('https://api.example.test/api/Product/List?PageNo=3&Limit=100'), null)
  assert.equal(hop('https://api.example.test/api/Product/List?Limit=1&PageNo=1'), null)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', '']) assert.equal(hop('https://api.example.test/api/Product/StockLevels?WarehouseId=6', method), 'method', method)
  assert.equal(hop('https://api.example.test/api/Product/StockLevels?WarehouseId=6', 'GET', 1), 'redirect')
  for (const url of [
    'https://api.example.test/api/Auth', 'https://api.example.test/api/Auth?WarehouseId=6', 'https://api.example.test/api/Order/5/Cancel', 'https://api.example.test/api/Order/5/MarkAwaitingConfirmation',
    'https://api.example.test/api/Order/List', 'https://api.example.test/api/Warehouse', 'https://api.example.test/api/Product/7', 'https://api.example.test/api/Product/7/Bundle', 'https://api.example.test/api/Product',
    'https://api.example.test/api/Product/Bundle', 'https://api.example.test/api/Product/stocklevels', 'https://api.example.test/api/product/StockLevels', 'https://api.example.test/api/Product/StockLevels/',
    'https://api.example.test/api/Product/List/', 'https://api.example.test//api/Product/List', 'https://api.example.test/api/Product/List/../Auth', 'https://api.example.test/api/e2e/mintsoft/api/Product/List',
    'https://api.example.test/', 'https://api.example.test/api/ASN/List',
  ]) assert.equal(hop(url), 'path', url)
  for (const url of [
    'https://api.example.test/api/Product/StockLevels', 'https://api.example.test/api/Product/StockLevels?WarehouseId=', 'https://api.example.test/api/Product/StockLevels?WarehouseId=0', 'https://api.example.test/api/Product/StockLevels?WarehouseId=6&ClientId=89',
    'https://api.example.test/api/Product/StockLevels?WarehouseId=6&WarehouseId=5', 'https://api.example.test/api/Product/StockLevels?WarehouseId=a', 'https://api.example.test/api/Product/StockLevels?WarehouseId=-1', 'https://api.example.test/api/Product/StockLevels?WarehouseId=6%20',
    'https://api.example.test/api/Product/StockLevels?WarehouseId=1234567890', 'https://api.example.test/api/Product/List?PageNo=1', 'https://api.example.test/api/Product/List?Limit=100', 'https://api.example.test/api/Product/List?PageNo=1&Limit=101',
    'https://api.example.test/api/Product/List?PageNo=1&Limit=500', 'https://api.example.test/api/Product/List?PageNo=0&Limit=100', 'https://api.example.test/api/Product/List?PageNo=1&Limit=0', 'https://api.example.test/api/Product/List?PageNo=1&Limit=100&SinceLastUpdated=2026-01-01',
    'https://api.example.test/api/Product/List?PageNo=100001&Limit=100', 'https://api.example.test/api/Product/List?PageNo=1&PageNo=2&Limit=100',
  ]) assert.equal(hop(url), 'parameter', url)
  for (const url of ['https://other.example/api/Product/List?PageNo=1&Limit=100', 'http://api.example.test/api/Product/List?PageNo=1&Limit=100', 'https://api.example.test:8443/api/Product/List?PageNo=1&Limit=100', 'https://u:p@api.example.test/api/Product/List?PageNo=1&Limit=100', 'https://api.example.test/api/Product/List?PageNo=1&Limit=100#x']) assert.equal(hop(url), 'origin', url)
  // A tenant in a sub-directory keeps its prefix.
  const sub = new URL('https://api.example.test/mintsoft/')
  assert.equal(mintsoftReadHopRefusal(sub, { method: 'GET', url: new URL('https://api.example.test/mintsoft/api/Product/List?PageNo=1&Limit=100'), redirectCount: 0 }), null)
  assert.equal(mintsoftReadHopRefusal(sub, { method: 'GET', url: new URL('https://api.example.test/api/Product/List?PageNo=1&Limit=100'), redirectCount: 0 }), 'path')
})

// [mutation: the connector's read classification dropped from the gate]
test('the gate also asks the connector\'s own read classification: a path the allow-list does not list as a read is refused even when it is spelled like one of the two', () => {
  const base = new URL('https://api.example.test')
  const hop = { method: 'GET', url: new URL('https://api.example.test/api/Product/List?PageNo=1&Limit=100'), redirectCount: 0 }
  assert.equal(mintsoftReadHopRefusal(base, hop), null)
  assert.equal(mintsoftReadHopRefusal(base, hop, () => ({ class: 'write', label: 'x' })), 'path', 'the allow-list says write')
  assert.equal(mintsoftReadHopRefusal(base, { ...hop, url: new URL('https://api.example.test/api/Product/StockLevels?WarehouseId=6') }, (_method, path) => (path.endsWith('StockLevels') ? { class: 'write', label: 'x' } : { class: 'read', label: 'y' })), 'path')
})

// [mutation: the hopGate not handed to the seam / refuseRedirects removed]
test('the seam is handed the gate and refuses redirects: a POST or /api/Auth hop is refused through the gate it was given', async () => {
  let seamOptions: Parameters<typeof import('../../lib/security/connector-fetch.ts').connectorFetch>[2] | undefined
  let init: RequestInit | undefined
  const port = createMintsoftReadPort({
    readCredentials: async () => ({ ok: true, value: { baseUrl: 'https://api.example.test', apiKey: KEY, clientId: CLIENT } }),
    fetchImpl: async (_input, i, options) => { seamOptions = options; init = i; return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) },
  })
  assert.ok((await port.stockLevels('6')).ok)
  assert.equal(seamOptions?.refuseRedirects, true)
  assert.equal(seamOptions?.connectorName, 'Mintsoft')
  assert.equal(init?.method, 'GET')
  const gate = seamOptions!.hopGate!
  assert.equal(gate({ method: 'GET', url: new URL('https://api.example.test/api/Product/StockLevels?WarehouseId=6'), redirectCount: 0 }), null)
  assert.equal(gate({ method: 'POST', url: new URL('https://api.example.test/api/Auth'), redirectCount: 0 }), 'method')
  assert.equal(gate({ method: 'GET', url: new URL('https://api.example.test/api/Order/5/Cancel'), redirectCount: 1 }), 'redirect')
  assert.equal(gate({ method: 'GET', url: new URL('https://api.example.test/api/Auth'), redirectCount: 0 }), 'path')
})

test('a warehouse id or page number that is not plain digits is never sent: nothing reaches the double', async () => {
  const rig = await double(tenant)
  const port = portFor(rig)
  for (const id of ['', '0', '06', '6&ClientId=89', '6/../Auth', 'a', '-1', '1234567890']) assert.deepEqual(await port.stockLevels(id), { ok: false, reason: 'BAD_KEY' }, id)
  for (const page of [0, -1, 1.5, Number.NaN, 100_001]) assert.deepEqual(await port.productPage(page, 100), { ok: false, reason: 'BAD_KEY' }, String(page))
  assert.equal(rig.seen.length, 0)
})

test('a redirect (Mintsoft mutates through GET) is an error and its target is never requested', async () => {
  const rig = await double((req, res) => {
    if (req.url?.startsWith('/api/Product/StockLevels')) { res.writeHead(302, { location: '/api/Order/5/Cancel' }); res.end(); return }
    json(res, [])
  })
  assert.deepEqual(await portFor(rig).stockLevels('6'), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(rig.seen.map((s) => s.url.split('?')[0]), ['/api/Product/StockLevels'], 'the Location was not followed')
})

// [mutation: a 401 refreshed (a login attempted) instead of reported]
test('A 401 IS NEVER REFRESHED: one request, no /api/Auth, a closed reason that carries nothing of the answer', async () => {
  const rig = await double((_req, res) => json(res, { Message: `denied ${KEY}` }, 401))
  const result = await portFor(rig).stockLevels('6')
  assert.deepEqual(result, { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.equal(rig.seen.length, 1)
  noWriteNoLogin(rig)
  assert.ok(!JSON.stringify(result).includes(KEY))
})

test('every non-200 answer, a 204, an HTML answer and malformed JSON are failures that carry nothing of what Mintsoft said', async () => {
  for (const respond of [
    (res: http.ServerResponse) => json(res, { Message: `x ${KEY}` }, 400), (res: http.ServerResponse) => json(res, [], 500), (res: http.ServerResponse) => { res.writeHead(204); res.end() },
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${KEY}</html>`) },
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{ not json ${KEY}`) },
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('[]') },
  ]) {
    const rig = await double((_req, res) => respond(res))
    const result = await portFor(rig).stockLevels('6')
    assert.deepEqual(result, { ok: false, reason: 'SOURCE_UNREADABLE' })
    assert.ok(!JSON.stringify(result).includes(KEY))
  }
})

// [mutation: the strict normaliser replaced by a lenient one that drops or repairs rows]
test('STRICT STOCK ROWS (the connector\'s own reader): a malformed row makes the WHOLE response unreadable - it is never dropped, repaired or summed', async () => {
  const good = PROBE_WH6[0]!
  const bodies: Array<[string, unknown]> = [
    ['not an array', { Message: 'error' }], ['null', null], ['a row that is not an object', [good, 5]], ['no SKU', [{ ...good, SKU: '' }]], ['SKU not a string', [{ ...good, SKU: 12 }]],
    ['no TotalStockLevel', [{ ...good, TotalStockLevel: undefined }]], ['TotalStockLevel null', [{ ...good, TotalStockLevel: null }]], ['TotalStockLevel a string', [{ ...good, TotalStockLevel: '36' }]],
    ['TotalStockLevel fractional', [{ ...good, TotalStockLevel: 36.5 }]], ['TotalStockLevel negative', [{ ...good, TotalStockLevel: -1 }]], ['Level above on hand', [{ ...good, Level: 99 }]],
    ['the same SKU twice', [good, { ...PROBE_WH6[1]!, SKU: good.SKU }]], ['a row of another warehouse', [{ ...good, WarehouseId: 5 }]], ['a row of another client', [{ ...good, ClientId: 90 }]],
    ['no client', [{ ...good, ClientId: undefined }]], ['Bundle missing', [{ ...good, Bundle: undefined }]], ['Bundle a string', [{ ...good, Bundle: 'false' }]], ['no product id', [{ ...good, ProductId: undefined }]],
    ['product id zero', [{ ...good, ProductId: 0 }]], ['product id fractional', [{ ...good, ProductId: 1.5 }]], ['the same product id twice', [good, { ...PROBE_WH6[1]!, ProductId: good.ProductId }]],
  ]
  for (const [label, body] of bodies) {
    const rig = await double((_req, res) => json(res, body))
    assert.deepEqual(await portFor(rig).stockLevels('6'), { ok: false, reason: 'SOURCE_UNREADABLE' }, label)
  }
  const rig = await double((_req, res) => json(res, { Data: [good] }))
  assert.deepEqual(await portFor(rig).stockLevels('6'), { ok: true, value: [{ sku: good.SKU, productId: String(good.ProductId), onHand: good.TotalStockLevel, bundle: false }] }, 'a recognised wrapper of one array is read')
})

test('PRODUCT ROWS: exact fields, one id key, a SKU, and a row that names another client or nothing readable makes the whole page unreadable', async () => {
  const ok = async (body: unknown) => { const rig = await double((_req, res) => json(res, body)); return portFor(rig).productPage(1, 100) }
  assert.deepEqual(await ok([{ ID: 7, SKU: ' ABC ', Bundle: false }, { ID: '8', SKU: 'DEF', ClientId: 89, Bundle: true }, { Id: 9, SKU: 'GHI', ClientId: null, Bundle: false }]), { ok: true, value: [{ id: '7', sku: 'ABC', bundle: false }, { id: '8', sku: 'DEF', bundle: true }, { id: '9', sku: 'GHI', bundle: false }] })
  assert.deepEqual(await ok([]), { ok: true, value: [] })
  for (const [label, body] of [
    ['not an array', { Message: 'x' }], ['a row that is not an object', [5]], ['no id', [{ SKU: 'A', Bundle: false }]], ['two id keys', [{ ID: 1, Id: 1, SKU: 'A', Bundle: false }]], ['id zero', [{ ID: 0, SKU: 'A', Bundle: false }]], ['id fractional', [{ ID: 1.5, SKU: 'A', Bundle: false }]],
    ['id text with letters', [{ ID: '1a', SKU: 'A', Bundle: false }]], ['no SKU', [{ ID: 1, Bundle: false }]], ['blank SKU', [{ ID: 1, SKU: '  ', Bundle: false }]], ['SKU not a string', [{ ID: 1, SKU: 5, Bundle: false }]], ['another client', [{ ID: 1, SKU: 'A', ClientId: 90, Bundle: false }]],
    ['no Bundle flag', [{ ID: 1, SKU: 'A' }]], ['Bundle a string', [{ ID: 1, SKU: 'A', Bundle: 'false' }]],
  ] as Array<[string, unknown]>) assert.deepEqual(await ok(body), { ok: false, reason: 'SOURCE_UNREADABLE' }, label)
})

test('credentials are read on the first request only, once, never when no request is made; a refusal makes no request and is carried as its closed reason', async () => {
  const rig = await double(tenant)
  let reads = 0
  const port = createMintsoftReadPort({ readCredentials: async () => { reads += 1; return creds(rig) }, env: E2E })
  assert.equal(reads, 0, 'building the port reads nothing')
  await port.stockLevels('6'); await port.productPage(1, 100)
  assert.equal(reads, 1)
  for (const [readCredentials, reason] of [
    [async () => ({ ok: false, reason: 'VENDOR_AUTH_REFUSED' }) as MintsoftPackCredentialRead, 'VENDOR_AUTH_REFUSED'],
    [async () => ({ ok: false, reason: 'SOURCE_UNREADABLE' }) as MintsoftPackCredentialRead, 'SOURCE_UNREADABLE'],
    [async () => { throw new Error(KEY) }, 'SOURCE_UNREADABLE'],
  ] as const) {
    const fresh = await double(tenant)
    const p = createMintsoftReadPort({ readCredentials, env: E2E })
    assert.deepEqual(await p.stockLevels('6'), { ok: false, reason })
    assert.deepEqual(await p.productPage(1, 100), { ok: false, reason })
    assert.equal(fresh.seen.length, 0)
  }
})

test('an address that is not https (outside the loopback allowance) is refused by the seam before any connection', async () => {
  const rig = await double(tenant)
  const result = await createMintsoftReadPort({ readCredentials: async () => creds(rig), env: { NODE_ENV: 'production' } }).stockLevels('6')
  assert.deepEqual(result, { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.equal(rig.seen.length, 0)
})

// ---- the credentials -------------------------------------------------------------------------

type Row = Record<string, unknown>
function dbDouble(settings: Row[] | Error, connections: Row[] = [{ base_url: 'https://api.example.test' }], readOnly = 'on'): MintsoftQueryClient & { sent: string[]; params: unknown[][] } {
  const sent: string[] = []
  const params: unknown[][] = []
  return {
    sent, params,
    async query(sql, values) {
      sent.push(sql); params.push(values ?? [])
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: readOnly }] }
      if (/FROM settings/.test(sql)) { if (settings instanceof Error) throw settings; return { rows: settings } }
      if (/FROM wms_connections/.test(sql)) return { rows: connections }
      return { rows: [] }
    },
  }
}

test('the Mintsoft credentials: settings rows and the connection in a READ ONLY transaction, the fixed key decrypted, the URL validated, always rolled back', async () => {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY
  process.env.SETTINGS_ENCRYPTION_KEY = 'k'.repeat(32)
  try {
    const rows: Row[] = [{ key: 'mintsoft_auth_mode', value: 'api_key' }, { key: 'mintsoft_static_api_key', value: encryptSettingValue('mintsoft_static_api_key', KEY) }, { key: 'mintsoft_client_id', value: ` ${CLIENT} ` }]
    const db = dbDouble(rows)
    assert.deepEqual(await readMintsoftPackCredentials(db, {}), { ok: true, value: { baseUrl: 'https://api.example.test', apiKey: KEY, clientId: CLIENT } })
    assert.equal(db.sent[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(db.sent.at(-1), 'ROLLBACK')
    assert.deepEqual(db.params[2], [[...MINTSOFT_PACK_SETTING_KEYS]])
    for (const sql of db.sent) assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql), sql)
    // A plain (not yet encrypted) key is read as it is, as the settings store reads it; the mode is trimmed and case-insensitive like the connector's.
    assert.ok((await readMintsoftPackCredentials(dbDouble([{ key: 'mintsoft_auth_mode', value: ' API_KEY ' }, { key: 'mintsoft_static_api_key', value: KEY }, rows[2]!]), {})).ok)
    // THE AUTH MODE: anything but the fixed-key mode would (or might) log in, and a login replaces the tenant's key.
    for (const mode of [undefined, '', 'credentials', 'Credentials', 'api-key', 'apikey', 'api_key2', 'key', 'true', 'password']) {
      const set: Row[] = [...(mode === undefined ? [] : [{ key: 'mintsoft_auth_mode', value: mode }]), rows[1]!, rows[2]!]
      const spy = dbDouble(set)
      assert.deepEqual(await readMintsoftPackCredentials(spy, {}), { ok: false, reason: 'VENDOR_AUTH_REFUSED' }, String(mode))
      assert.equal(spy.sent.at(-1), 'ROLLBACK')
    }
    const bad: Array<[string, Row[] | Error, Row[] | undefined, string | undefined, string]> = [
      ['no key', [rows[0]!, rows[2]!], undefined, undefined, 'VENDOR_AUTH_REFUSED'], ['a blank key', [rows[0]!, { key: 'mintsoft_static_api_key', value: '   ' }, rows[2]!], undefined, undefined, 'VENDOR_AUTH_REFUSED'],
      ['no client id', [rows[0]!, rows[1]!], undefined, undefined, 'SOURCE_UNREADABLE'], ['a client id of zero', [rows[0]!, rows[1]!, { key: 'mintsoft_client_id', value: '0' }], undefined, undefined, 'SOURCE_UNREADABLE'],
      ['a client id with letters', [rows[0]!, rows[1]!, { key: 'mintsoft_client_id', value: '89a' }], undefined, undefined, 'SOURCE_UNREADABLE'], ['a repeated row', [...rows, rows[0]!], undefined, undefined, 'SOURCE_UNREADABLE'],
      ['a row for another key', [...rows, { key: 'mintsoft_password', value: 'x' }], undefined, undefined, 'SOURCE_UNREADABLE'], ['a value that is not text', [rows[0]!, { key: 'mintsoft_static_api_key', value: 5 }, rows[2]!], undefined, undefined, 'SOURCE_UNREADABLE'],
      ['ciphertext that does not decrypt', [rows[0]!, { key: 'mintsoft_static_api_key', value: 'enc:setting:v1:AAAA' }, rows[2]!], undefined, undefined, 'SOURCE_UNREADABLE'],
      ['no connection', rows, [], undefined, 'SOURCE_UNREADABLE'], ['two connections', rows, [{ base_url: 'https://api.example.test' }, { base_url: 'https://api2.example.test' }], undefined, 'SOURCE_UNREADABLE'],
      ['a connection with no address', rows, [{ base_url: null }], undefined, 'SOURCE_UNREADABLE'], ['an http address', rows, [{ base_url: 'http://api.example.test' }], undefined, 'SOURCE_UNREADABLE'],
      ['a private address', rows, [{ base_url: 'https://10.0.0.5' }], undefined, 'SOURCE_UNREADABLE'], ['an address with credentials', rows, [{ base_url: 'https://u:p@api.example.test' }], undefined, 'SOURCE_UNREADABLE'],
      ['a database error', new Error(KEY), undefined, undefined, 'SOURCE_UNREADABLE'], ['a transaction that is not read only', rows, undefined, 'off', 'SOURCE_UNREADABLE'],
    ]
    for (const [name, data, connections, mode, reason] of bad) assert.deepEqual(await readMintsoftPackCredentials(dbDouble(data, connections, mode), {}), { ok: false, reason }, name)
    // Without the key the stored ciphertext cannot be read, and nothing is guessed.
    delete process.env.SETTINGS_ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    assert.deepEqual(await readMintsoftPackCredentials(dbDouble(rows), {}), { ok: false, reason: 'SOURCE_UNREADABLE' })
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previous
  }
})

// [mutation: the auth-mode check removed from the credentials reader]
test('AN AUTH MODE THAT WOULD LOG IN IS REFUSED BEFORE ANY REQUEST: the whole chain from the stored rows to the port makes no request and the double sees nothing', async () => {
  const rig = await double(tenant)
  const read = () => readMintsoftPackCredentials(dbDouble([{ key: 'mintsoft_auth_mode', value: 'credentials' }, { key: 'mintsoft_static_api_key', value: KEY }, { key: 'mintsoft_client_id', value: CLIENT }], [{ base_url: rig.base }]), E2E)
  const port = createMintsoftReadPort({ readCredentials: read, env: E2E })
  const walked = await readWms(port, ['5', '6'], { sleep: noSleep })
  assert.deepEqual(walked, { ok: false, reason: 'VENDOR_AUTH_REFUSED' })
  assert.equal(rig.seen.length, 0, 'no request of any kind - not a read, and not /api/Auth')
})

test('the whole chain from stored rows to the port works end to end against loopback when the mode is the fixed key, and no output holds the key', async () => {
  const rig = await double(tenant)
  const port = createMintsoftReadPort({
    readCredentials: () => readMintsoftPackCredentials(dbDouble([{ key: 'mintsoft_auth_mode', value: 'api_key' }, { key: 'mintsoft_static_api_key', value: KEY }, { key: 'mintsoft_client_id', value: CLIENT }], [{ base_url: rig.base }]), E2E),
    env: E2E,
  })
  const walked = await readWms(port, ['5', '6'], { sleep: noSleep })
  assert.ok(walked.ok)
  noWriteNoLogin(rig)
  assert.ok(!JSON.stringify(walked).includes(KEY))
})

test('THE LIVE PRODUCT-LIST SHAPE (rows copied verbatim from the 2026-10-23 probe) parses: ID, SKU, Bundle and ClientId are read, DisCont and every other field are ignored', async () => {
  const rig = await double((_req, res) => json(res, PROBE_PRODUCT_LIST_ROWS))
  const page = await portFor(rig).productPage(1, 100)
  assert.deepEqual(page, { ok: true, value: [
    { id: '263881', sku: '22771122402-02', bundle: false }, ...PROBE_PRODUCT_LIST_ROWS.slice(1).map((r) => ({ id: String(r.ID), sku: String(r.SKU), bundle: r.Bundle as boolean })),
  ] })
  assert.equal(PROBE_PRODUCT_LIST_ROWS[0]!.DisCont, true, 'precondition: a discontinued product is in the fixture and is read like any other')
  assert.deepEqual(PROBE_PRODUCT_LIST_ROWS.map((r) => r.Bundle), [false, false, true, false])
})
