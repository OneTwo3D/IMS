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
 *
 * ROUND 4 (Codex HIGH 2) adds the two incompleteness shapes re-reading cannot see, because they REPEAT:
 * a short page that is not the end of the list, and a full scan that omits the same ASN every time. The
 * stub therefore also serves the independent `SinceLastUpdated` read; that read does not advance the
 * `scanCounter` the per-scan fixtures are written against, so a fixture's `scan === 1` still means the
 * first FULL scan, and the window read is served whatever scan 1 would serve.
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
  // The recently-updated read is a scan of its own; live Mintsoft narrows it, and this stub does not (an
  // unparseable SinceLastUpdated is IGNORED live, and a window read that returns MORE can only make the
  // containment check stricter). It is served the first full scan's fixture and leaves scanCounter alone.
  const recentWindow = url.searchParams.has('SinceLastUpdated')
  if (pageNo === 1 && !recentWindow) scanCounter += 1
  const warehouse = url.searchParams.get('WarehouseId')
  const all = rowsForScan(recentWindow ? 1 : scanCounter).filter((row) => !warehouse || String(row.WarehouseId) === warehouse)
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

test('every page request is Limit=100 and PageNo >= 1, the full scans ask for items, and the short page is PROVEN to be the end', async () => {
  reset(() => tenant())
  const { fetchMintsoftAsns, MINTSOFT_ASN_LIST_RECENT_WINDOW_DAYS, mintsoftAsnListRecentWindowSince } = await client()
  await fetchMintsoftAsns()
  assert.ok(requests.length > 0)
  const urls = requests.map((request) => new URL(request, 'https://mintsoft.test'))
  for (const url of urls) {
    assert.equal(url.pathname, '/api/ASN/List')
    assert.equal(url.searchParams.get('Limit'), '100')
    assert.ok(Number(url.searchParams.get('PageNo')) >= 1)
  }
  // Three scans of four requests: the independent recently-updated read FIRST, then the two full scans that
  // must agree. 220 rows = pages of 100, 100, 20 — and then page 4, which must come back empty for page 3
  // to be the end of the list rather than a truncation (round 4, Codex HIGH 2).
  assert.deepEqual(urls.map((url) => url.searchParams.get('PageNo')), ['1', '2', '3', '4', '1', '2', '3', '4', '1', '2', '3', '4'])
  const window = urls.slice(0, 4)
  const fullScans = urls.slice(4)
  assert.ok(MINTSOFT_ASN_LIST_RECENT_WINDOW_DAYS >= 1)
  for (const url of window) {
    assert.equal(url.searchParams.get('SinceLastUpdated'), mintsoftAsnListRecentWindowSince(), 'the window read is dated')
    assert.equal(url.searchParams.has('IncludeASNItems'), false, 'and needs IDs only')
  }
  for (const url of fullScans) {
    assert.equal(url.searchParams.has('SinceLastUpdated'), false, 'the full scan is not narrowed')
    assert.equal(url.searchParams.get('IncludeASNItems'), 'true')
  }
})

test('duplicate recovery reads the WHOLE tenant and finds its ASN on page 2, by POReference and expected quantity', async () => {
  reset(() => tenant())
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  const asns = await fetchMintsoftAsnsForDuplicateRecovery()
  // Tenant-wide, not scoped to a warehouse (review M3): no request narrows by WarehouseId.
  assert.ok(requests.every((request) => !new URL(request, 'https://mintsoft.test').searchParams.has('WarehouseId')), requests.join(' '))
  assert.ok(requests.some((request) => new URL(request, 'https://mintsoft.test').searchParams.get('PageNo') === '2'), 'the scan reached page 2')
  const target = asns.find((asn) => asn.externalAsnId === '9999')
  assert.ok(target, 'the target on page 2 is found')
  assert.equal(target.raw?.POReference, 'PO-TARGET')
  assert.equal(target.lines.length, 1)
  assert.equal(target.lines[0]!.sourceLineId, 'line-9999')
  assert.equal(target.lines[0]!.quantity, 4, 'the EXPECTED quantity, not the received one')
  assert.equal(asns.length, tenant().length, 'every ASN in the tenant, both warehouses')
})

test('a list whose pages never end FAILS CLOSED after a bounded number of requests', async () => {
  reset(() => [])
  pageHook = (url) => {
    if (url.pathname !== '/api/ASN/List') return null
    const pageNo = Number(url.searchParams.get('PageNo'))
    return json(Array.from({ length: 100 }, (_, index) => ({ ID: pageNo * 1000 + index, POReference: 'x', WarehouseId: 6, Items: [] })))
  }
  const { fetchMintsoftAsnsForDuplicateRecovery, MINTSOFT_ASN_LIST_MAX_PAGES } = await client()
  await assert.rejects(fetchMintsoftAsnsForDuplicateRecovery(), (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnListIncompleteError' && /more than 50 pages/.test(error.message))
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
  await assert.rejects(fetchMintsoftAsnsForDuplicateRecovery(), (error: unknown) => error instanceof Error && /ASN 1 came back without its items/.test(error.message), 'and the error names the ASN')
})

test('a scan that LOSES the target is never accepted until two consecutive scans agree (review L1)', async () => {
  // Scan 1 sees the target; scan 2 does not (it moved across a page boundary mid-scan); scan 3 sees it
  // again. No two consecutive scans agree, so the read is refused: accepting scan 2 would report "no
  // existing ASN" while one exists, and the creator would push a duplicate.
  reset((scan) => (scan === 2 ? tenant().filter((row) => row.ID !== 9999) : tenant()))
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  await assert.rejects(fetchMintsoftAsnsForDuplicateRecovery(), (error: unknown) => error instanceof Error && /changed between 3 consecutive scans/.test(error.message))
  assert.equal(scanCounter, 3, 'three scans were made, none of them accepted')
})

test('a SHORT PAGE is not the end of the list until the next page comes back empty (round 4, Codex HIGH 2)', async () => {
  // THE SHAPE RE-READING CANNOT SEE. Page 1 is cut short at 23 rows — the same 23 rows on every scan, so two
  // consecutive scans agree, no ID repeats, and the old reader called that the complete tenant and let the
  // creator push an ASN that already exists. Asking for page 2 settles it: it still serves rows.
  reset(() => tenant())
  pageHook = (url) => {
    if (url.pathname !== '/api/ASN/List') return null
    if (url.searchParams.get('PageNo') !== '1') return null
    return json(tenant().slice(0, 23).map((row) => ({ ...row, Items: url.searchParams.get('IncludeASNItems') === 'true' ? row.Items : null })))
  }
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  await assert.rejects(
    fetchMintsoftAsnsForDuplicateRecovery(),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnListIncompleteError'
      && /page 1 returned 23 rows of 100/.test(error.message)
      && /still served 100 rows/.test(error.message)
      && /TRUNCATION/.test(error.message),
  )
  assert.deepEqual(
    requests.map((request) => new URL(request, 'https://mintsoft.test').searchParams.get('PageNo')),
    ['1', '2'],
    'it refused on the very first scan, at the page that disproved the claim',
  )
})

test('an ASN the full scan omits EVERY time is still found, by the independent recently-updated read (round 4, Codex HIGH 2)', async () => {
  // The other shape re-reading cannot see: a deterministic omission. The full scan never serves ASN 9999 —
  // its pages are internally consistent, no ID repeats, both scans agree, and page 4 is empty — so nothing
  // about the scan itself betrays it. The `SinceLastUpdated` read is a different request whose rows fit in
  // one page, so it has no boundary to lose the row at, and it puts 9999 on the record.
  reset(() => tenant().filter((row) => row.ID !== 9999))
  pageHook = (url) => {
    if (url.pathname !== '/api/ASN/List' || !url.searchParams.has('SinceLastUpdated')) return null
    if (url.searchParams.get('PageNo') !== '1') return json([])
    return json([{ ID: 9999, POReference: 'PO-TARGET', WarehouseId: 6, Items: [] }])
  }
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  await assert.rejects(
    fetchMintsoftAsnsForDuplicateRecovery(),
    (error: unknown) => error instanceof Error
      && error.name === 'MintsoftAsnListIncompleteError'
      && /recently-updated read served ASN 9999/.test(error.message)
      && /no ASN will be created/.test(error.message),
  )
  assert.equal(scanCounter, 2, 'precondition: two full scans ran and AGREED — the omission is invisible to them')
  assert.ok(
    requests.some((request) => {
      const url = new URL(request, 'https://mintsoft.test')
      return url.searchParams.has('SinceLastUpdated') && url.searchParams.get('PageNo') === '1'
    }),
    'and the window read really was made',
  )
})

test('the recently-updated read can only ever REFUSE: what it misses does not widen the accepted list', async () => {
  // It is evidence of presence, not of absence. An ASN outside the window (here: the window read serves
  // nothing at all) leaves the full scan's verdict exactly as it was — otherwise a tenant whose ASNs are all
  // older than the window could never create one.
  reset(() => tenant())
  pageHook = (url) => (url.pathname === '/api/ASN/List' && url.searchParams.has('SinceLastUpdated') ? json([]) : null)
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  const asns = await fetchMintsoftAsnsForDuplicateRecovery()
  assert.equal(asns.length, 220)
  assert.ok(asns.some((asn) => asn.externalAsnId === '9999'))
})

test('a rebind between a lost attempt and the retry still finds the earlier ASN, and refuses it by name (review M3)', async () => {
  // ASN 9999 was created at warehouse 5 by an attempt whose response was lost; the binding now points at
  // warehouse 6. A scan scoped to warehouse 6 would return no match and the retry would create a second
  // inbound ASN. The tenant-wide scan finds it, and the matcher refuses the warehouse mismatch.
  reset(() => tenant().map((row) => (row.ID === 9999 ? { ...row, WarehouseId: 5 } : row)))
  const { fetchMintsoftAsnsForDuplicateRecovery } = await client()
  const { findRecoverableMintsoftAsn } = await import('@/lib/connectors/mintsoft/api/asn-recovery')
  const asns = await fetchMintsoftAsnsForDuplicateRecovery()
  assert.throws(
    () => findRecoverableMintsoftAsn(asns, { reference: 'PO-TARGET', externalWarehouseId: '6', lines: [{ sourceLineId: 'line-9999', expectedQty: 4 }] }),
    (error: unknown) => error instanceof Error && error.name === 'MintsoftAsnRecoveryWarehouseMismatchError' && /ASN 9999/.test(error.message),
  )
})

test('both ASN creators decide recover-or-create through findRecoverableMintsoftAsn over the tenant-wide list (o3d-bhvu)', () => {
  // A structural pin that the creators USE the behaviour tested in tests/mintsoft-asn-recovery.test.ts —
  // stated as such: the creators are server actions inside database transactions with no unit harness.
  // Universal counts over the whole file, so a stale call site beside a new one fails.
  const source = readFileSync(path.join(process.cwd(), 'app/actions/mintsoft-sync.ts'), 'utf8')
  assert.equal((source.match(/\bfetchMintsoftAsns\(/g) ?? []).length, 0, 'no call to the booked-in rollback list')
  assert.equal((source.match(/async function findExistingRemoteAsn\(/g) ?? []).length, 2, 'both creators still recover first')
  assert.equal((source.match(/await fetchMintsoftAsnsForDuplicateRecovery\(\)/g) ?? []).length, 2, 'both read the tenant-wide list')
  assert.equal((source.match(/return findRecoverableMintsoftAsn\(remoteAsns, \{/g) ?? []).length, 2, 'both decide through the shared matcher')
  assert.equal((source.match(/POReference/g) ?? []).length, 0, 'no creator keeps its own reference matching')
})
