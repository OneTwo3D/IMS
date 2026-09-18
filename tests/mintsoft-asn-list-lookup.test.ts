import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { mock } from 'node:test'

/**
 * o3d-bhvu: THE ASN LIST, AGAINST A STUB OF THE LIVE CONTRACT.
 *
 * The HTTP boundary (`connectorFetch`) is stubbed with a server that behaves as live Mintsoft did under
 * read-only GETs on 2026-09-18 (ClientId 89): `GET /api/ASN` is 405; `GET /api/ASN/List` pages by
 * PageNo/Limit, Limit above 100 is a 400, PageNo 0 is a 500, a page past the end is `[]`, and `Items` is
 * `null` unless IncludeASNItems=true. Auth is stubbed to a fixed key, so nothing here reads a database or
 * reaches a network.
 *
 * The first test is the defect as it stood: the old client GET `/api/ASN` and threw on every call.
 */

type Row = { ID: number; POReference: string; WarehouseId: number; Items: Array<Record<string, unknown>> }

const requests: string[] = []
let rowsForScan: (scan: number) => Row[] = () => []
let pageHook: ((url: URL) => Response | null) | null = null
let scanCounter = 0

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function liveLikeServer(url: URL): Response {
  const hooked = pageHook?.(url)
  if (hooked) return hooked
  if (url.pathname === '/api/ASN') return json({ Message: "The requested resource does not support http method 'GET'." }, 405)
  if (url.pathname !== '/api/ASN/List') return json({ Message: 'No HTTP resource was found' }, 404)
  const pageNo = Number.parseInt(url.searchParams.get('PageNo') ?? '1', 10)
  const limit = Number.parseInt(url.searchParams.get('Limit') ?? '100', 10)
  if (pageNo < 1) return json({ Message: 'An error has occurred.' }, 500)
  if (limit > 100) return json({ Message: 'The request is invalid.' }, 400)
  if (pageNo === 1) scanCounter += 1
  const warehouse = url.searchParams.get('WarehouseId')
  const all = rowsForScan(scanCounter).filter((row) => !warehouse || String(row.WarehouseId) === warehouse)
  const page = all.slice((pageNo - 1) * limit, pageNo * limit)
  const includeItems = url.searchParams.get('IncludeASNItems') === 'true'
  return json(page.map((row) => ({ ...row, Items: includeItems ? row.Items : null })))
}

mock.module('@/lib/connectors/mintsoft/api/auth', {
  namedExports: {
    getMintsoftApiConfiguration: async () => ({ baseUrl: 'https://mintsoft.test', authMode: 'api_key' }),
    getMintsoftAccessToken: async () => 'test-key',
    invalidateMintsoftAccessToken: async () => {},
  },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (input: string | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input)
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET', 'this suite only ever reads')
      requests.push(`${url.pathname}${url.search}`)
      return liveLikeServer(url)
    },
  },
})

/** 220 ASNs over two warehouses, like the live tenant; `target` (ID 9999) lands on page 2. */
function tenant(): Row[] {
  const rows: Row[] = []
  for (let index = 0; index < 220; index += 1) {
    const id = index === 151 ? 9999 : 3000 + index
    rows.push({
      ID: id,
      POReference: id === 9999 ? 'PO-TARGET' : `PO-${id}`,
      WarehouseId: index % 3 === 0 ? 5 : 6,
      Items: [{ ID: id * 10, SourceLineId: `line-${id}`, ProductId: 7, SKU: 'SKU-7', QuantityExpected: 4, QuantityReceieved: 1 }],
    })
  }
  return rows
}

function reset(rows: (scan: number) => Row[]) {
  requests.length = 0
  scanCounter = 0
  pageHook = null
  rowsForScan = rows
}

async function client() {
  return await import('@/lib/connectors/mintsoft/api/client')
}

test('the ASN list is read from GET /api/ASN/List, not the 405 create route (o3d-bhvu)', async () => {
  reset(() => tenant())
  const { fetchMintsoftAsns } = await client()
  const asns = await fetchMintsoftAsns()
  assert.equal(asns.length, 220, 'every ASN on every page')
  assert.ok(asns.some((asn) => asn.externalAsnId === '9999'), 'including the one on page 2')
  assert.ok(!requests.some((request) => request === '/api/ASN' || request.startsWith('/api/ASN?')), `never the create route: ${requests.join(' ')}`)
})

test('every page request is Limit=100, PageNo >= 1 and asks for items, and paging stops at the short page', async () => {
  reset(() => tenant())
  const { fetchMintsoftAsns } = await client()
  await fetchMintsoftAsns()
  assert.ok(requests.length > 0)
  for (const request of requests) {
    const url = new URL(request, 'https://mintsoft.test')
    assert.equal(url.pathname, '/api/ASN/List')
    assert.equal(url.searchParams.get('Limit'), '100')
    assert.ok(Number(url.searchParams.get('PageNo')) >= 1)
    assert.equal(url.searchParams.get('IncludeASNItems'), 'true')
  }
  // 220 rows = pages of 100, 100, 20, read twice (two consecutive scans must agree).
  assert.deepEqual(requests.map((request) => new URL(request, 'https://mintsoft.test').searchParams.get('PageNo')), ['1', '2', '3', '1', '2', '3'])
})

test('duplicate recovery finds its ASN on page 2 of its warehouse, by POReference and expected quantity', async () => {
  reset(() => tenant())
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  const asns = await fetchMintsoftAsnsForDuplicateRecovery('6')
  assert.ok(requests.every((request) => new URL(request, 'https://mintsoft.test').searchParams.get('WarehouseId') === '6'))
  assert.ok(requests.some((request) => new URL(request, 'https://mintsoft.test').searchParams.get('PageNo') === '2'), 'the scan reached page 2')
  const target = asns.find((asn) => asn.externalAsnId === '9999')
  assert.ok(target, 'the target on page 2 is found')
  assert.equal(target.raw?.POReference, 'PO-TARGET')
  assert.equal(target.lines.length, 1)
  assert.equal(target.lines[0]!.sourceLineId, 'line-9999')
  assert.equal(target.lines[0]!.quantity, 4, 'the EXPECTED quantity, not the received one')
  assert.equal(asns.length, tenant().filter((row) => row.WarehouseId === 6).length)
})

test('a list whose pages never end FAILS CLOSED after a bounded number of requests', async () => {
  reset(() => [])
  pageHook = (url) => {
    if (url.pathname !== '/api/ASN/List') return null
    const pageNo = Number(url.searchParams.get('PageNo'))
    return json(Array.from({ length: 100 }, (_, index) => ({ ID: pageNo * 1000 + index, POReference: 'x', WarehouseId: 6, Items: [] })))
  }
  const { fetchMintsoftAsnsForDuplicateRecovery, MINTSOFT_ASN_LIST_MAX_PAGES } = await client()
  await assert.rejects(fetchMintsoftAsnsForDuplicateRecovery('6'), (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnListIncompleteError' && /more than 50 pages/.test(error.message))
  assert.equal(requests.length, MINTSOFT_ASN_LIST_MAX_PAGES, 'it stopped at the cap instead of paging for ever')
})

test('an error page, a non-array page or an oversized page is refused, never read as the end of the list', async () => {
  const { fetchMintsoftAsns } = await client()
  for (const [label, response] of [
    ['a 500 on page 2', json({ Message: 'boom' }, 500)],
    ['an object on page 2', json({ Items: [] })],
    ['101 rows on page 2', json(Array.from({ length: 101 }, (_, index) => ({ ID: 90000 + index, POReference: 'x', WarehouseId: 6, Items: [] })))],
  ] as const) {
    reset(() => tenant())
    pageHook = (url) => (url.pathname === '/api/ASN/List' && url.searchParams.get('PageNo') === '2' ? response.clone() : null)
    await assert.rejects(fetchMintsoftAsns(), (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnListIncompleteError', label)
  }
})

test('a list that shifts under the scan is re-read, and one that never settles FAILS CLOSED', async () => {
  const { fetchMintsoftAsns } = await client()
  // Scan 1 misses a row (it moved across a page boundary); scans 2 and 3 agree: accepted, complete.
  reset((scan) => (scan === 1 ? tenant().filter((row) => row.ID !== 9999) : tenant()))
  const settled = await fetchMintsoftAsns()
  assert.ok(settled.some((asn) => asn.externalAsnId === '9999'), 'the settled scan is the complete one')
  // Every scan differs: no two consecutive scans agree, so it refuses.
  reset((scan) => [...tenant(), { ID: 50000 + scan, POReference: 'new', WarehouseId: 6, Items: [] }])
  await assert.rejects(fetchMintsoftAsns(), (error: unknown) => error instanceof Error && /changed between 3 consecutive scans/.test(error.message))
  // An ID served on two pages of one scan (the order moved mid-scan) is never accepted as complete.
  reset(() => {
    const rows = tenant()
    rows[120] = { ...rows[5]! }
    return rows
  })
  await assert.rejects(fetchMintsoftAsns(), (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnListIncompleteError')
})

test('a recovery row that came back without its items is refused, not skipped', async () => {
  reset(() => tenant())
  pageHook = (url) => {
    if (url.pathname !== '/api/ASN/List') return null
    const page = Number(url.searchParams.get('PageNo'))
    if (page !== 1) return json([])
    return json([{ ID: 1, POReference: 'PO-1', WarehouseId: 6, Items: null }])
  }
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  await assert.rejects(fetchMintsoftAsnsForDuplicateRecovery('6'), (error: unknown) => error instanceof Error && /without its items/.test(error.message))
})

test('both ASN creators recover through the complete list and match Mintsoft’s POReference (o3d-bhvu)', () => {
  // A structural pin, stated as such: the creators are server actions whose duplicate recovery runs
  // inside a database transaction, and no unit harness drives them. It asserts, over the whole file,
  // that NO call to the old list function remains and that EVERY reference match reads POReference —
  // universal counts, not an existence check a stale call site beside a new one would satisfy.
  const source = readFileSync(path.join(process.cwd(), 'app/actions/mintsoft-sync.ts'), 'utf8')
  assert.equal((source.match(/\bfetchMintsoftAsns\(/g) ?? []).length, 0, 'no call to the list the booked-in rollback path uses')
  const recoveries = source.match(/async function findExistingRemoteAsn\(/g) ?? []
  assert.equal(recoveries.length, 2, 'both creators still have their recovery step')
  assert.equal((source.match(/await fetchMintsoftAsnsForDuplicateRecovery\(reservation\.externalWarehouseId\)/g) ?? []).length, 2)
  const referenceReads = source.match(/getMintsoftAsnRawString\(asn\.raw, \[[^\]]*\]\) !== reservation\.reference/g) ?? []
  assert.equal(referenceReads.length, 2, `reference matches found: ${referenceReads.length}`)
  for (const read of referenceReads) assert.match(read, /'POReference'/, read)
})
