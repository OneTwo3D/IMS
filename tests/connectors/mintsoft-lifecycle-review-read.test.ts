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
import { MAX_REQUESTS, MintsoftReviewFailed, MintsoftReviewRefused, readMintsoftReviewConfig, readMintsoftReviewListing, type MintsoftReviewConfig, type MintsoftReviewDeps } from '../../lib/connectors/mintsoft/lifecycle-review-read.ts'

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
const WAREHOUSES = [{ ID: 5, Name: 'Main' }, { ID: 6, Name: 'Overflow' }]
function tenant(products: Array<Record<string, unknown>> = PRODUCTS, stock = STOCK, warehouses: Array<Record<string, unknown>> = WAREHOUSES, secondScan?: Array<Record<string, unknown>>) {
  let scans = 0
  return (url: URL, res: http.ServerResponse) => {
    if (url.pathname === '/api/Warehouse') return json(res, warehouses)
    if (url.pathname === '/api/Product/List') {
      const limit = Number(url.searchParams.get('Limit'))
      const page = Number(url.searchParams.get('PageNo'))
      if (limit > 100) return json(res, { Message: 'Limit too large' }, 400)
      if (page === 1) scans++
      const list = scans > 1 && secondScan ? secondScan : products
      return json(res, list.slice((page - 1) * limit, page * limit))
    }
    if (url.pathname === '/api/Product/StockLevels') return json(res, stock[url.searchParams.get('WarehouseId') ?? ''] ?? [])
    json(res, { Message: `nothing here ${KEY}` }, 404)
  }
}
const config = (rig: Rig, warehouseIds = ['5', '6']): MintsoftReviewConfig => ({ baseUrl: rig.base, apiKey: KEY, clientId: String(CLIENT), warehouseIds })
const read = (rig: Rig, c = config(rig), extra: Partial<MintsoftReviewDeps> = {}) => readMintsoftReviewListing(c, { env: E2E, sleep: noSleep, ...extra })

test('the listing is read GET-only from the two allow-listed paths, the key only in ms-apikey, never /api/Auth; status from DisCont, stock summed per product', async () => {
  const rig = await double(tenant())
  const listing = await read(rig)
  assert.deepEqual([...new Set(rig.seen.map((s) => s.method))], ['GET'])
  assert.ok(rig.seen.every((s) => !/\/api\/Auth/i.test(s.url) && !s.url.includes(KEY) && s.apikey === KEY))
  const scan = ['/api/Product/List?PageNo=1&Limit=100', '/api/Product/List?PageNo=2&Limit=100', '/api/Product/List?PageNo=3&Limit=100']
  assert.deepEqual(rig.seen.map((s) => s.url), [
    ...scan, ...scan, '/api/Warehouse',
    '/api/Product/StockLevels?WarehouseId=5', '/api/Product/StockLevels?WarehouseId=6',
  ], 'pages until a short one, then the page after it (which must be empty), the whole list a second time, the warehouse list, then each warehouse once')
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
    ['no client (L7)', [[{ ...PRODUCTS[0], ClientId: undefined }], {}], /names no client/],
    ['no bundle flag (L7)', [[{ ...PRODUCTS[0], Bundle: undefined }], {}], /whether it is a bundle/],
    ['a stock row under another SKU than the list (L7)', [PRODUCTS.slice(0, 5), { '5': [{ ...STOCK['5'][0], SKU: 'SYN-0002' }] }], /under another SKU/],
    ['a stock row that disagrees on the bundle flag (L7)', [PRODUCTS.slice(0, 5), { '5': [{ ...STOCK['5'][0], Bundle: true }] }], /disagree on whether product 1001 is a bundle/],
    ['a stock row of another warehouse', [PRODUCTS.slice(0, 5), { '5': [{ ...STOCK['5'][0], WarehouseId: 6 }] }], /does not name that warehouse, our client/],
    ['a stock row of another client', [PRODUCTS.slice(0, 5), { '5': [{ ...STOCK['5'][0], ClientId: 7 }] }], /does not name that warehouse, our client/],
    ['a product twice in one warehouse', [PRODUCTS.slice(0, 5), { '5': [STOCK['5'][0], { ...STOCK['5'][0], SKU: 'SYN-0001x' }] }], /appears twice in the stock of warehouse 5/],
    ['a product id twice in the list', [[PRODUCTS[0], { ...PRODUCTS[1], ID: PRODUCTS[0].ID }], {}], /product 1000 appears twice/],
    ['a configured warehouse Mintsoft does not list (L9)', [PRODUCTS.slice(0, 5), {}, [{ ID: 5 }]], /names warehouse\(s\) 6, which Mintsoft does not list/],
    ['an unconfigured warehouse that holds stock (L9)', [PRODUCTS.slice(0, 5), { '9': [{ ...STOCK['5'][0], WarehouseId: 9 }] }, [...WAREHOUSES, { ID: 9 }]], /warehouse 9 holds stock of 1 product\(s\) but is not in FIRST_LOAD_MINTSOFT_WAREHOUSE_IDS/],
    ['a list that changes between the two scans (L7)', [PRODUCTS.slice(0, 5), {}, WAREHOUSES, [...PRODUCTS.slice(0, 4), { ...PRODUCTS[4], DisCont: true }]], /changed between two complete reads/],
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
    const rig = await double(tenant(...(args as Parameters<typeof tenant>)))
    await assert.rejects(read(rig), (e: unknown) => e instanceof MintsoftReviewFailed && why.test(e.message) && !e.message.includes(KEY) && !e.message.includes(rig.base), label)
  }
  const erroring = await double((_url, res) => json(res, { Message: `boom ${KEY}` }, 500))
  await assert.rejects(read(erroring), (e: unknown) => e instanceof MintsoftReviewFailed && /could not be read/.test(e.message) && !e.message.includes(KEY))
  assert.ok(MAX_REQUESTS >= 10)
})

test('L9: an unconfigured warehouse that holds nothing of ours is read and allowed; L13: a page above the limit, the request cap and a list that never ends are refused', async () => {
  const quiet = await double(tenant(PRODUCTS.slice(0, 5), { '9': [{ ...STOCK['5'][0], WarehouseId: 9, TotalStockLevel: 0, Level: 0 }] }, [...WAREHOUSES, { ID: 9, Name: 'Returns' }]))
  const listing = await read(quiet)
  assert.ok(quiet.seen.some((s) => s.url === '/api/Product/StockLevels?WarehouseId=9'), 'the unconfigured warehouse was read')
  assert.deepEqual(listing.warehouses, ['5', '6'], 'and is not added to the warehouses whose stock is shown')
  const fat = await double((url, res) => (url.pathname === '/api/Product/List' ? json(res, Array.from({ length: 101 }, (_, i) => ({ ...PRODUCTS[0], ID: 5000 + i, SKU: `F-${i}` }))) : json(res, [])))
  await assert.rejects(read(fat), (e: unknown) => e instanceof MintsoftReviewFailed && /holds more rows than the limit/.test(e.message))
  // A store that always answers a full page: the page cap ends it (did not end), and a lower request cap ends it first.
  const endless = await double((url, res) => {
    if (url.pathname !== '/api/Product/List') return json(res, [])
    const page = Number(url.searchParams.get('PageNo'))
    return json(res, Array.from({ length: 100 }, (_, i) => ({ ...PRODUCTS[0], ID: page * 1000 + i, SKU: `E-${page}-${i}` })))
  })
  await assert.rejects(read(endless, config(endless), { maxPages: 3 }), (e: unknown) => e instanceof MintsoftReviewFailed && /did not end within 3 pages/.test(e.message))
  assert.equal(endless.seen.length, 3, 'exactly the page cap was asked for')
  await assert.rejects(read(endless, config(endless), { maxRequests: 2, maxPages: 3 }), (e: unknown) => e instanceof MintsoftReviewFailed && /more than 2 requests/.test(e.message))
  assert.equal(endless.seen.length, 3 + 2, 'the request cap stopped it before the third request')
  // The seams can only lower the caps.
  await assert.rejects(read(endless, config(endless), { maxPages: 10_000, maxRequests: 10_000 }), (e: unknown) => e instanceof MintsoftReviewFailed && /did not end within 200 pages/.test(e.message))
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
    ['a link (opened with O_NOFOLLOW, L8)', link, /regular file, not a link/],
    ['a directory', scratch, /regular file/],
    ['a missing file', path.join(scratch, 'missing.env'), /cannot be read/],
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

test('L9: the hop gate admits GET /api/Warehouse (no parameter) only for the review reader; the reconciliation pack\'s gate still refuses it', async () => {
  const { mintsoftReadHopRefusal } = await import('../../lib/connectors/mintsoft/reconciliation-read.ts')
  const base = new URL('https://mintsoft.example/')
  const hop = (pathAndQuery: string, method = 'GET') => ({ method, url: new URL(pathAndQuery, base), redirectCount: 0 })
  assert.equal(mintsoftReadHopRefusal(base, hop('/api/Warehouse')), 'path', 'the pack never reads the warehouse list')
  assert.equal(mintsoftReadHopRefusal(base, hop('/api/Warehouse'), undefined, { warehouseList: true }), null)
  assert.equal(mintsoftReadHopRefusal(base, hop('/api/Warehouse?ClientId=1'), undefined, { warehouseList: true }), 'parameter')
  assert.equal(mintsoftReadHopRefusal(base, hop('/api/Warehouse', 'POST'), undefined, { warehouseList: true }), 'method')
  assert.equal(mintsoftReadHopRefusal(base, hop('/api/Warehouse/5'), undefined, { warehouseList: true }), 'path')
})
