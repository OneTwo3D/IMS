import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { afterEach } from 'node:test'

import { WOO_READ_COLLECTIONS } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readWooCredentials } from '../../lib/reconciliation-pack/woo-credentials.ts'
import { readWooOrders, readWooTaxRates } from '../../lib/reconciliation-pack/woo-source.ts'
import { createWooGetPort, projectToRequested, requestedFields, wooHopRefusal } from '../../lib/reconciliation-pack/woo-transport.ts'
import { encryptSettingValue } from '../../lib/security/encrypted-settings.ts'
import { noSleep, order } from './woo-fixtures.ts'

/**
 * THE VENDOR TRANSPORT over a LOOPBACK HTTP double (no real network: tests/no-outbound-network.cjs refuses anything else).
 * The double records every request; a method other than GET fails the test that sees it. Mutations are listed in the PR.
 */

const E2E = { E2E_TEST_MODE: '1', NODE_ENV: 'test' }
const KEY = 'ck_test_consumer_key_value'
const SECRET = 'cs_test_consumer_secret_value'

type Seen = { method: string; url: string; authorization: string | undefined }
type Rig = { seen: Seen[]; base: string; close: () => Promise<void> }
const rigs: Rig[] = []
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close() })

async function double(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void): Promise<Rig> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization })
    handler(req, res, seen)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const rig: Rig = { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
  rigs.push(rig)
  return rig
}

const json = (res: http.ServerResponse, body: unknown, headers: Record<string, string> = {}, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', ...headers })
  res.end(JSON.stringify(body))
}

/** A store of 3 orders in `processing` and 2 tax rates, answering the way WordPress does. */
function storeHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/wp-json/wc/v3/orders') {
    const rows = url.searchParams.get('status') === 'processing' ? [order(11), order(12), order(13)] : []
    return json(res, Number(url.searchParams.get('page')) === 1 ? rows : [], { 'X-WP-Total': String(rows.length), 'X-WP-TotalPages': String(rows.length ? 1 : 0) })
  }
  if (url.pathname === '/wp-json/wc/v3/taxes') return json(res, Number(url.searchParams.get('page')) === 1 ? [{ id: 1 }, { id: 2 }] : [], { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' })
  json(res, { code: 'rest_no_route', message: `no route with ${KEY} ${SECRET}` }, {}, 404)
}

const portFor = (rig: Rig, over: Partial<Parameters<typeof createWooGetPort>[0]> = {}) =>
  createWooGetPort({ readCredentials: async () => ({ baseUrl: rig.base, key: KEY, secret: SECRET }), env: E2E, ...over })

test('a full order and tax-rate walk over loopback is GET only, to the listed collections and parameters, with the credential only in Authorization', async () => {
  const rig = await double(storeHandler)
  const port = portFor(rig)
  const orders = await readWooOrders(port, ['processing', 'on-hold'], { sleep: noSleep })
  assert.ok(orders.ok && orders.value.orders.length === 3 && orders.value.totals.length === 2)
  const taxes = await readWooTaxRates(port, { sleep: noSleep })
  assert.ok(taxes.ok && taxes.value.rates.length === 2)
  assert.equal(rig.seen.length, 6, "processing, on-hold and taxes: one page each, read twice")
  // THE NO-NON-GET PROOF: the double saw nothing but GET.
  assert.deepEqual([...new Set(rig.seen.map((s) => s.method))], ['GET'])
  const expectedAuth = `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`
  for (const s of rig.seen) {
    const url = new URL(s.url, 'http://x')
    assert.ok((WOO_READ_COLLECTIONS as readonly string[]).includes(url.pathname.replace('/wp-json/wc/v3/', '')), s.url)
    for (const name of url.searchParams.keys()) assert.ok(['status', 'page', 'per_page', 'orderby', 'order', '_fields'].includes(name), name)
    assert.equal(s.authorization, expectedAuth)
    assert.ok(!s.url.includes(KEY) && !s.url.includes(SECRET), 'the credential is never in the URL')
  }
})

// [mutation: wooHopRefusal's method check removed]
test('the hop gate refuses everything but a GET to one of three collections on the store origin with the listed parameters', () => {
  const base = new URL('https://shop.example')
  const hop = (url: string, method = 'GET', redirectCount = 0) => wooHopRefusal(base, { method, url: new URL(url), redirectCount })
  const good = 'https://shop.example/wp-json/wc/v3/orders?status=processing&page=1&per_page=100&orderby=id&order=asc&_fields=id,status,currency,total,date_created_gmt'
  assert.equal(hop(good), null)
  assert.equal(hop('https://shop.example/wp-json/wc/v3/products?status=any&page=2'), null)
  assert.equal(hop('https://shop.example/wp-json/wc/v3/taxes'), null)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get', '']) assert.equal(hop(good, method), 'method', method)
  assert.equal(hop(good, 'GET', 1), 'redirect')
  for (const url of [
    'https://shop.example/wp-json/wc/v3/orders/12', 'https://shop.example/wp-json/wc/v3/orders/12/notes', 'https://shop.example/wp-json/wc/v3/orders/', 'https://shop.example/wp-json/wc/v3/coupons',
    'https://shop.example/wp-json/wc/v3/customers', 'https://shop.example/wp-json/wc/v3/system_status', 'https://shop.example/wp-json/wc/v3', 'https://shop.example/wp-json/wc/v2/orders', 'https://shop.example/wp-json/wp/v2/users',
    'https://shop.example/wp-json/wc/v3/orders/../customers', 'https://shop.example/wp-json/wc/v3/products/1/variations', 'https://shop.example/wp-json/wc/v3/Orders', 'https://shop.example/other', 'https://shop.example/',
  ]) assert.equal(hop(url), 'path', url)
  for (const url of [
    'https://shop.example/wp-json/wc/v3/orders?context=edit', 'https://shop.example/wp-json/wc/v3/orders?consumer_key=x', 'https://shop.example/wp-json/wc/v3/orders?_method=DELETE', 'https://shop.example/wp-json/wc/v3/orders?status=a&status=b',
    'https://shop.example/wp-json/wc/v3/orders?status=a%20b', 'https://shop.example/wp-json/wc/v3/orders?status=a;b', 'https://shop.example/wp-json/wc/v3/orders?status=', 'https://shop.example/wp-json/wc/v3/orders?search=x',
    `https://shop.example/wp-json/wc/v3/orders?status=${'a'.repeat(129)}`,
  ]) assert.equal(hop(url), 'parameter', url)
  for (const url of ['https://other.example/wp-json/wc/v3/orders', 'http://shop.example/wp-json/wc/v3/orders', 'https://shop.example:8443/wp-json/wc/v3/orders', 'https://u:p@shop.example/wp-json/wc/v3/orders', 'https://shop.example/wp-json/wc/v3/orders#x']) assert.equal(hop(url), 'origin', url)
  // A store in a sub-directory keeps its prefix.
  const sub = new URL('https://shop.example/store/')
  assert.equal(wooHopRefusal(sub, { method: 'GET', url: new URL('https://shop.example/store/wp-json/wc/v3/orders?page=1'), redirectCount: 0 }), null)
  assert.equal(wooHopRefusal(sub, { method: 'GET', url: new URL('https://shop.example/wp-json/wc/v3/orders?page=1'), redirectCount: 0 }), 'path')
})

// [mutation: the hopGate not handed to the seam / refuseRedirects removed]
test('the seam is handed the gate and refuses redirects: a POST hop is refused through the gate it was given', async () => {
  let seamOptions: Parameters<typeof import('../../lib/security/connector-fetch.ts').connectorFetch>[2] | undefined
  const port = createWooGetPort({
    readCredentials: async () => ({ baseUrl: 'https://shop.example', key: KEY, secret: SECRET }),
    fetchImpl: async (_input, init, options) => { seamOptions = options; assert.equal(init?.method, 'GET'); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'x-wp-total': '0', 'x-wp-totalpages': '0' } }) },
  })
  const page = await port.get('orders', { page: '1', _fields: 'id' })
  assert.ok(page.ok)
  assert.equal(seamOptions?.refuseRedirects, true)
  assert.equal(seamOptions?.connectorName, 'WooCommerce')
  const gate = seamOptions!.hopGate!
  assert.equal(gate({ method: 'GET', url: new URL('https://shop.example/wp-json/wc/v3/orders?page=1'), redirectCount: 0 }), null)
  assert.equal(gate({ method: 'POST', url: new URL('https://shop.example/wp-json/wc/v3/orders?page=1'), redirectCount: 0 }), 'method')
  assert.equal(gate({ method: 'GET', url: new URL('https://evil.example/wp-json/wc/v3/orders'), redirectCount: 1 }), 'redirect')
})

test('a collection or parameter the transport does not know is never sent: nothing reaches the double', async () => {
  const rig = await double(storeHandler)
  const port = portFor(rig)
  assert.deepEqual(await port.get('customers' as never, { page: '1' }), { ok: false })
  assert.deepEqual(await port.get('orders', { page: '1', context: 'edit', _fields: 'id' }), { ok: false })
  assert.deepEqual(await port.get('orders', { page: '1 2', _fields: 'id' }), { ok: false })
  assert.equal(rig.seen.length, 0)
})

test('a redirect is an error and its target is never requested', async () => {
  const rig = await double((req, res) => {
    if (req.url?.startsWith('/wp-json/wc/v3/orders')) { res.writeHead(302, { location: '/wp-json/wc/v3/customers' }); res.end(); return }
    json(res, [], { 'X-WP-Total': '0', 'X-WP-TotalPages': '0' })
  })
  const page = await portFor(rig).get('orders', { page: '1', _fields: 'id' })
  assert.deepEqual(page, { ok: false })
  assert.deepEqual(rig.seen.map((s) => s.url.split('?')[0]), ['/wp-json/wc/v3/orders'], 'the Location was not followed')
})

test('a non-2xx answer, a non-JSON answer and malformed JSON are failures that carry nothing of what the store said', async () => {
  for (const respond of [
    (res: http.ServerResponse) => json(res, { code: 'x', message: `denied for ${KEY} ${SECRET}` }, {}, 401),
    (res: http.ServerResponse) => json(res, [], {}, 500),
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${SECRET}</html>`) },
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{ not json ${SECRET}`) },
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('[]') },
    (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999999' }); res.end('[') },
  ]) {
    const rig = await double((_req, res) => respond(res))
    const page = await portFor(rig).get('orders', { page: '1', _fields: 'id' })
    assert.deepEqual(page, { ok: false })
    assert.ok(!JSON.stringify(page).includes(SECRET))
  }
})

test('the pagination headers reach the walk exactly as sent: a store with none is unreadable, not "one page"', async () => {
  const rig = await double((_req, res) => json(res, [order(1)]))
  const read = await readWooOrders(portFor(rig), ['processing'], { sleep: noSleep })
  assert.deepEqual(read, { ok: false, reason: 'SOURCE_UNREADABLE' })
})

test('credentials are read on the first request only, once, and never when no request is made; unavailable credentials make no request', async () => {
  const rig = await double(storeHandler)
  let reads = 0
  const port = createWooGetPort({ readCredentials: async () => { reads += 1; return { baseUrl: rig.base, key: KEY, secret: SECRET } }, env: E2E })
  assert.equal(reads, 0, 'building the port reads nothing')
  await port.get('taxes', { page: '1', _fields: 'id' }); await port.get('taxes', { page: '2', _fields: 'id' })
  assert.equal(reads, 1)
  for (const readCredentials of [async () => null, async () => { throw new Error(SECRET) }]) {
    const fresh = await double(storeHandler)
    assert.deepEqual(await createWooGetPort({ readCredentials, env: E2E }).get('orders', { page: '1', _fields: 'id' }), { ok: false })
    assert.equal(fresh.seen.length, 0)
  }
})

test('a store URL that is not https (outside the loopback allowance) is refused by the seam before any connection', async () => {
  const rig = await double(storeHandler)
  // No E2E environment: the loopback http URL is exactly what production would refuse.
  const page = await createWooGetPort({ readCredentials: async () => ({ baseUrl: rig.base, key: KEY, secret: SECRET }), env: { NODE_ENV: 'production' } }).get('orders', { page: '1', _fields: 'id' })
  assert.deepEqual(page, { ok: false })
  assert.equal(rig.seen.length, 0)
})

// ---- the credentials -------------------------------------------------------------------------

type Row = Record<string, unknown>
function dbDouble(rows: Row[] | Error, readOnly = 'on'): ImsQueryClient & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    async query(sql) {
      sent.push(sql)
      if (/transaction_read_only/.test(sql)) return { rows: [{ read_only: readOnly }] }
      if (/FROM settings/.test(sql)) { if (rows instanceof Error) throw rows; return { rows } }
      return { rows: [] }
    },
  }
}

test('the storefront credentials: three settings rows in a READ ONLY transaction, the key and secret decrypted, the URL validated, always rolled back', async () => {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY
  process.env.SETTINGS_ENCRYPTION_KEY = 'k'.repeat(32)
  try {
    const rows = [{ key: 'wc_url', value: 'https://shop.example' }, { key: 'wc_consumer_key', value: encryptSettingValue('wc_consumer_key', KEY) }, { key: 'wc_consumer_secret', value: encryptSettingValue('wc_consumer_secret', SECRET) }]
    const db = dbDouble(rows)
    assert.deepEqual(await readWooCredentials(db, {}), { baseUrl: 'https://shop.example', key: KEY, secret: SECRET })
    assert.equal(db.sent[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(db.sent.at(-1), 'ROLLBACK')
    for (const sql of db.sent) assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql), sql)
    // Plain (not yet encrypted) values are read as they are, as the settings store reads them.
    assert.ok(await readWooCredentials(dbDouble([{ key: 'wc_url', value: 'https://shop.example' }, { key: 'wc_consumer_key', value: KEY }, { key: 'wc_consumer_secret', value: SECRET }]), {}))
    const bad: Array<[string, Row[] | Error, string?]> = [
      ['a missing row', rows.slice(0, 2)], ['a repeated row', [...rows, rows[0]!]], ['a row for another key', [...rows, { key: 'xero_client_secret', value: 'x' }]], ['an empty value', [rows[0]!, rows[1]!, { key: 'wc_consumer_secret', value: '' }]],
      ['a value that is not text', [rows[0]!, rows[1]!, { key: 'wc_consumer_secret', value: 5 }]], ['an http store', [{ key: 'wc_url', value: 'http://shop.example' }, rows[1]!, rows[2]!]], ['a private address', [{ key: 'wc_url', value: 'https://10.0.0.5' }, rows[1]!, rows[2]!]],
      ['a url with credentials', [{ key: 'wc_url', value: 'https://u:p@shop.example' }, rows[1]!, rows[2]!]], ['ciphertext that does not decrypt', [rows[0]!, { key: 'wc_consumer_key', value: 'enc:setting:v1:AAAA' }, rows[2]!]],
      ['a database error', new Error(SECRET)], ['a transaction that is not read only', rows, 'off'],
    ]
    for (const [name, data, mode] of bad) assert.equal(await readWooCredentials(dbDouble(data, mode), {}), null, name)
    // Without the key the stored ciphertext cannot be read, and nothing is guessed.
    delete process.env.SETTINGS_ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    assert.equal(await readWooCredentials(dbDouble(rows), {}), null)
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previous
  }
})

// ---- THE CUSTOMER-DATA BOUNDARY: only requested fields cross the transport -----------------------------------------------------------

const WHOLE_ORDER = { id: 11, status: 'processing', currency: 'GBP', total: '12.50', date_created_gmt: '2026-10-10T09:30:00', billing: { first_name: 'A', email: 'a@example.test', phone: '0' }, shipping: { address_1: '1 Road' }, customer_note: 'note' }

// [mutation: the transport returns the parsed body unfiltered / the extra-key refusal removed]
test('a store that ignores _fields and returns whole orders is refused: nothing of the body is handed on', async () => {
  const rig = await double((req, res) => json(res, [WHOLE_ORDER], { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }))
  const port = portFor(rig)
  assert.deepEqual(await port.get('orders', { page: '1', _fields: 'id,status,currency,total,date_created_gmt' }), { ok: false })
  assert.deepEqual(await port.get('products', { page: '1', _fields: 'id,sku' }), { ok: false })
  assert.deepEqual(await port.get('taxes', { page: '1', _fields: 'id' }), { ok: false })
  assert.equal(rig.seen.length, 3, 'the requests were made (and refused on the way back)')
  const read = await readWooOrders(port, ['processing'], { sleep: noSleep })
  assert.deepEqual(read.ok ? null : read.reason, 'SOURCE_UNREADABLE')
})

// [mutation: only the first row of a page is judged / a nested object is waved through]
test('ONE row with an unrequested key among honest rows refuses the whole page, on any page of the walk', async () => {
  const honest = { id: 12, status: 'processing', currency: 'GBP', total: '1.00', date_created_gmt: '2026-10-10T09:30:00' }
  const rig = await double((req, res) => json(res, [honest, honest, { ...honest, id: 13, meta_data: [] }], { 'X-WP-Total': '3', 'X-WP-TotalPages': '1' }))
  assert.deepEqual(await portFor(rig).get('orders', { page: '1', _fields: 'id,status,currency,total,date_created_gmt' }), { ok: false })
})

// [mutation: a request with no _fields is sent / the allow-list is not per request]
test('a request that names no fields is not sent at all, and the allow-list is the request\'s own', async () => {
  const rig = await double((req, res) => json(res, [{ id: 1, status: 'x' }], { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }))
  const port = portFor(rig)
  assert.deepEqual(await port.get('orders', { page: '1' }), { ok: false })
  assert.deepEqual(await port.get('orders', { page: '1', _fields: '' }), { ok: false })
  assert.equal(rig.seen.length, 0)
  const ok = await port.get('orders', { page: '1', _fields: 'id,status' })
  assert.ok(ok.ok && JSON.stringify(ok.body) === '[{"id":1,"status":"x"}]')
  // another request asking for fewer fields does not inherit the wider list
  assert.deepEqual(await port.get('orders', { page: '1', _fields: 'id' }), { ok: false })
})

test('a store that omits requested fields is fine (a subset), and a dotted field is allowed by its top-level name', async () => {
  const rig = await double((req, res) => json(res, [{ id: 1, tax_lines: [] }], { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }))
  const page = await portFor(rig).get('orders', { page: '1', _fields: 'id,status,tax_lines.rate_code' })
  assert.ok(page.ok)
})

test('requestedFields and projectToRequested, directly', () => {
  assert.equal(requestedFields({}), null)
  assert.equal(requestedFields({ _fields: '' }), null)
  assert.equal(requestedFields({ _fields: ',' }), null)
  assert.deepEqual([...requestedFields({ _fields: 'id,tax_lines.rate_code,status' })!].sort(), ['id', 'status', 'tax_lines'])
  const want = new Set(['id', 'status'])
  assert.deepEqual(projectToRequested([{ id: 1 }, { id: 2, status: 'a' }], want), [{ id: 1 }, { id: 2, status: 'a' }])
  assert.deepEqual(projectToRequested({ id: 1 }, want), { id: 1 })
  assert.deepEqual(projectToRequested([], want), [])
  assert.equal(typeof projectToRequested([{ id: 1, billing: {} }], want), 'symbol')
  assert.equal(typeof projectToRequested({ id: 1, billing: {} }, want), 'symbol')
  // a non-object row is not this function's to judge (the parsers refuse it)
  assert.deepEqual(projectToRequested([1, 'x', null], want), [1, 'x', null])
})
