/**
 * The first-load lifecycle review's GET-only Mintsoft reader (lib/connectors/mintsoft/lifecycle-review-read.ts), over a LOOPBACK HTTP double: no real
 * network (tests/no-outbound-network.cjs refuses anything but loopback). The double records every request; a method other than GET, or any request to
 * /api/Auth, is a failure. Synthetic data only.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, afterEach } from 'node:test'
import { MAX_REQUESTS, MintsoftReviewFailed, MintsoftReviewRefused, readMintsoftReviewConfig, readMintsoftReviewListing, type MintsoftReviewConfig } from '../../lib/connectors/mintsoft/lifecycle-review-read.ts'

const E2E = { E2E_TEST_MODE: '1', NODE_ENV: 'test' }
const KEY = 'ms_fixed_key_review_0123456789_test_only'
const CLIENT = 89
const noSleep = async () => {}
const scratch = mkdtempSync(path.join(tmpdir(), 'mintsoft-lifecycle-review-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

type Seen = { method: string; url: string; apikey: string | undefined }
type Rig = { seen: Seen[]; base: string; close: () => Promise<void> }
const rigs: Rig[] = []
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close() })

async function double(handler: (url: URL, res: http.ServerResponse) => void): Promise<Rig> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const entry: Seen = { method: req.method ?? '', url: req.url ?? '', apikey: req.headers['ms-apikey'] as string | undefined }
    seen.push(entry)
    if (entry.method !== 'GET' || /\/api\/Auth/i.test(entry.url)) { res.writeHead(500); res.end(); return }
    handler(new URL(req.url ?? '/', 'http://x'), res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const rig: Rig = { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
  rigs.push(rig)
  return rig
}
const json = (res: http.ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }

/** 150 products (two pages at the clamped limit of 100): every 10th discontinued, one with no flag, one SKU with a trailing space. */
const PRODUCTS = Array.from({ length: 150 }, (_, i) => ({
  ID: 1000 + i, SKU: i === 7 ? 'SYN-0007 ' : `SYN-${String(i).padStart(4, '0')}`, ClientId: CLIENT, Bundle: false, Name: 'synthetic',
  ...(i === 3 ? {} : { DisCont: i % 10 === 0 }),
}))
const STOCK: Record<string, Array<Record<string, unknown>>> = {
  '5': [{ SKU: 'SYN-0001', ProductId: 1001, WarehouseId: 5, ClientId: CLIENT, Bundle: false, TotalStockLevel: 4, Level: 3 }, { SKU: 'SYN-0007', ProductId: 1007, WarehouseId: 5, ClientId: CLIENT, Bundle: false, TotalStockLevel: 2, Level: 2 }],
  '6': [{ SKU: 'SYN-0001', ProductId: 1001, WarehouseId: 6, ClientId: CLIENT, Bundle: false, TotalStockLevel: 6, Level: 6 }],
}
function tenant(products = PRODUCTS, stock = STOCK) {
  return (url: URL, res: http.ServerResponse) => {
    if (url.pathname === '/api/Product/List') {
      const limit = Number(url.searchParams.get('Limit'))
      const page = Number(url.searchParams.get('PageNo'))
      if (limit > 100) return json(res, { Message: 'Limit too large' }, 400)
      return json(res, products.slice((page - 1) * limit, page * limit))
    }
    if (url.pathname === '/api/Product/StockLevels') return json(res, stock[url.searchParams.get('WarehouseId') ?? ''] ?? [])
    json(res, { Message: `nothing here ${KEY}` }, 404)
  }
}
const config = (rig: Rig, warehouseIds = ['5', '6']): MintsoftReviewConfig => ({ baseUrl: rig.base, apiKey: KEY, clientId: String(CLIENT), warehouseIds })
const read = (rig: Rig, c = config(rig)) => readMintsoftReviewListing(c, { env: E2E, sleep: noSleep })

test('the listing is read GET-only from the two allow-listed paths, the key only in ms-apikey, never /api/Auth; status from DisCont, stock summed per product', async () => {
  const rig = await double(tenant())
  const listing = await read(rig)
  assert.deepEqual([...new Set(rig.seen.map((s) => s.method))], ['GET'])
  assert.ok(rig.seen.every((s) => !/\/api\/Auth/i.test(s.url) && !s.url.includes(KEY) && s.apikey === KEY))
  assert.deepEqual(rig.seen.map((s) => s.url), [
    '/api/Product/List?PageNo=1&Limit=100', '/api/Product/List?PageNo=2&Limit=100', '/api/Product/List?PageNo=3&Limit=100',
    '/api/Product/StockLevels?WarehouseId=5', '/api/Product/StockLevels?WarehouseId=6',
  ], 'pages until a short one, then the page after it (which must be empty), then each warehouse once')
  assert.equal(listing.products.length, 150)
  assert.deepEqual(listing.products.slice(0, 4).map((p) => p.status), ['discontinued', 'active', 'active', 'not stated'])
  assert.equal(listing.products[7].sku, 'SYN-0007 ', 'the SKU exactly as Mintsoft holds it (the sheet flags the whitespace)')
  assert.deepEqual([...listing.physical.entries()], [['SYN-0001', 10], ['SYN-0007 ', 2]], 'joined to the product by id, summed over the warehouses')
  assert.deepEqual(listing.warehouses, ['5', '6'])
})

test('an unreadable listing fails closed with a message that carries no key, URL or body: a page after a short page, a repeated SKU, another client, a bad flag, a stock row for an unlisted product, an error status', async () => {
  const cases: Array<[string, Parameters<typeof tenant>, RegExp]> = [
    ['a repeated SKU', [[...PRODUCTS.slice(0, 10), { ...PRODUCTS[11], SKU: 'SYN-0001' }], STOCK], /SKU appears twice/],
    ['another client', [[{ ...PRODUCTS[0], ClientId: 7 }], {}], /another client/],
    ['a flag that is not true or false', [[{ ...PRODUCTS[0], DisCont: 'yes' as unknown as boolean }], {}], /not true or false/],
    ['a stock row for a product the list does not hold', [PRODUCTS.slice(0, 5), { '5': [{ ...STOCK['5'][0], ProductId: 9999 }] }], /does not hold/],
  ]
  // The first case needs a store that answers a page AFTER the end: built by hand.
  const pagingLiar = await double((url, res) => {
    if (url.pathname === '/api/Product/List') return json(res, url.searchParams.get('PageNo') === '1' ? PRODUCTS.slice(0, 50) : PRODUCTS.slice(50, 60))
    json(res, [])
  })
  await assert.rejects(read(pagingLiar), (e: unknown) => e instanceof MintsoftReviewFailed && /short page 1 followed by a non-empty page/.test(e.message))
  for (const [label, args, why] of cases) {
    const rig = await double(tenant(...args))
    await assert.rejects(read(rig), (e: unknown) => e instanceof MintsoftReviewFailed && why.test(e.message) && !e.message.includes(KEY) && !e.message.includes(rig.base), label)
  }
  const erroring = await double((_url, res) => json(res, { Message: `boom ${KEY}` }, 500))
  await assert.rejects(read(erroring), (e: unknown) => e instanceof MintsoftReviewFailed && /could not be read/.test(e.message) && !e.message.includes(KEY))
  assert.ok(MAX_REQUESTS >= 10)
})

test('the credentials file: mode 600 regular file only, known keys only, a usable address, whole-number client and warehouses; refused before any request, no line echoed', async () => {
  const rig = await double(tenant())
  const write = (name: string, text: string, mode = 0o600) => { const f = path.join(scratch, name); writeFileSync(f, text, { mode }); chmodSync(f, mode); return f }
  const good = `FIRST_LOAD_MINTSOFT_URL=${rig.base}\nFIRST_LOAD_MINTSOFT_API_KEY=${KEY}\nFIRST_LOAD_MINTSOFT_CLIENT_ID=89\nFIRST_LOAD_MINTSOFT_WAREHOUSE_IDS=5, 6\n`
  assert.deepEqual(readMintsoftReviewConfig(write('good.env', good), E2E), { baseUrl: rig.base, apiKey: KEY, clientId: '89', warehouseIds: ['5', '6'] })
  const link = path.join(scratch, 'link.env')
  symlinkSync(write('target.env', good), link)
  const cases: Array<[string, string, RegExp]> = [
    ['group-readable', write('wide.env', good, 0o640), /readable by group or others/],
    ['a link', link, /regular file/],
    ['an unknown key', write('typo.env', `${good}FIRST_LOAD_MINTSOFT_PASSWORD=${KEY}\n`), /sets FIRST_LOAD_MINTSOFT_PASSWORD/],
    ['no key', write('nokey.env', good.replace(/FIRST_LOAD_MINTSOFT_API_KEY=.*\n/, '')), /does not set FIRST_LOAD_MINTSOFT_API_KEY/],
    ['a bad client', write('client.env', good.replace('CLIENT_ID=89', 'CLIENT_ID=x')), /positive whole number/],
    ['a bad warehouse list', write('wh.env', good.replace('IDS=5, 6', 'IDS=5,5')), /distinct positive whole numbers/],
    ['an address that is not usable', write('url.env', good.replace(rig.base, 'ftp://mintsoft.example')), /not a usable Mintsoft address/],
    ['a line that is not KEY=VALUE', write('junk.env', `${good}${KEY}\n`), /line 5 of the credentials file is not KEY=VALUE/],
  ]
  for (const [label, file, why] of cases) {
    assert.throws(() => readMintsoftReviewConfig(file, E2E), (e: unknown) => e instanceof MintsoftReviewRefused && why.test(e.message) && !e.message.includes(KEY), label)
  }
  assert.equal(rig.seen.length, 0, 'reading the credentials file requests nothing')
})
