import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// Unit coverage for the Order/List delta paginator (o3d-bjc). fetchMintsoftOrderList
// reaches Mintsoft via mintsoftRequest and resolves the deep-link template via
// getMintsoftSettings — both mocked here so the paginator is testable without HTTP/DB.
//
// This file must NOT statically import anything that pulls in the WMS registry
// (which eagerly constructs the Mintsoft connector → the real orders/client
// modules), or the mocks below would bind too late. Orders is lazily imported
// inside each test, after the mocks are registered.

let listCalls: Array<Record<string, string>> = []
let listResponder: (pageNo: number) => unknown[] = () => []
let listError: string | null = null
// Call counters prove the o3d-bjc "resolve once per list, not per row" fix: a
// multi-row page must not fan out one settings/statuses lookup per order.
let settingsCalls = 0
let statusCalls = 0

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => {
      settingsCalls += 1
      return { mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}' }
    },
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    MINTSOFT_SETTING_KEYS: [],
    // Real implementation (the paginator/connector share it) — keep it here so a
    // mocked schema module still exposes the parser.
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      if (value == null) return null
      const trimmed = String(value).trim()
      if (!/^\d+$/.test(trimmed)) return null
      const parsed = Number.parseInt(trimmed, 10)
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    },
  },
})
mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string) => {
      if (path.startsWith('/api/Order/Statuses')) {
        statusCalls += 1
        return { data: [{ ID: 4, Name: 'DESPATCHED' }, { ID: 17, Name: 'PICKED' }], status: 200 }
      }
      const qs = new URLSearchParams(path.split('?')[1] ?? '')
      listCalls.push(Object.fromEntries(qs.entries()))
      if (listError) return { data: null, error: listError, status: 500 }
      return { data: listResponder(Number(qs.get('PageNo') ?? '1')), status: 200 }
    },
  },
})

async function loadFetch(): Promise<(typeof import('@/lib/connectors/mintsoft/api/orders'))['fetchMintsoftOrderList']> {
  return (await import('@/lib/connectors/mintsoft/api/orders')).fetchMintsoftOrderList
}

// Every delta is scoped to our ClientId now (fail-closed) — a shared value the
// tests reuse.
const CLIENT = 5

test('fetchMintsoftOrderList paginates until a short page and carries the delta params', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const fullPage = Array.from({ length: 200 }, (_, i) => ({ ID: i + 1, OrderNumber: `N${i + 1}`, OrderStatusId: 4 }))
  listResponder = (pageNo) =>
    pageNo === 1
      ? fullPage
      : pageNo === 2
        ? [{ ID: 201, OrderNumber: 'N201', OrderStatusId: 4 }, { ID: 202, OrderNumber: 'N202', OrderStatusId: 4 }]
        : []

  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT, limit: 200 })
  assert.equal(out.length, 202)
  assert.equal(listCalls.length, 2) // stopped on the short 2nd page
  assert.equal(listCalls[0].SinceLastUpdated, '2026-07-15T12:00:00')
  assert.equal(listCalls[0].IncludeOrderItems, 'true')
  assert.equal(listCalls[0].SortOldestFirst, 'true')
  assert.equal(listCalls[0].Limit, '200')
  assert.equal(listCalls[0].ClientId, String(CLIENT)) // always scoped
  assert.equal(listCalls[1].PageNo, '2')
})

// --- Finding 1: ClientId scoping (fail closed + defence in depth) ----------

test('[o3d-bjc] fetchMintsoftOrderList FAILS CLOSED without a clientId (never runs an unscoped cross-client delta)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => []
  await assert.rejects(
    // @ts-expect-error — intentionally omitting the now-required clientId
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00' }),
    /unscoped cross-client delta/,
  )
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: null }),
    /requires a ClientId/,
  )
  assert.equal(listCalls.length, 0) // never even issued a request
})

test('[o3d-bjc] fetchMintsoftOrderList always sends ClientId and passes optional Channel/Warehouse filters', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => [] // short (empty) first page → returns immediately
  await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: 42, warehouseId: 7, channelId: 3, limit: 100 })
  assert.equal(listCalls[0].ClientId, '42')
  assert.equal(listCalls[0].WarehouseId, '7')
  assert.equal(listCalls[0].ChannelId, '3')
})

test('[o3d-bjc] a delta row whose ClientId is NOT ours is dropped (never matched to a local link)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => [
    { ID: 1, OrderNumber: 'SHARED-1001', OrderStatusId: 4, ClientId: CLIENT },   // ours → kept
    { ID: 2, OrderNumber: 'SHARED-1001', OrderStatusId: 4, ClientId: 99 },       // FOREIGN (same number!) → dropped
    { ID: 3, OrderNumber: 'N3', OrderStatusId: 4 },                              // no ClientId → trusted via query scope
  ]
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  const ids = out.map((o) => o.externalOrderId).sort()
  assert.deepEqual(ids, ['1', '3']) // the foreign ClientId-99 row is gone, so it can't hijack SHARED-1001
  assert.equal(listCalls[0].ClientId, String(CLIENT))
})

test('fetchMintsoftOrderList throws (not truncates) when the delta overflows the page budget', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const alwaysFull = Array.from({ length: 10 }, (_, i) => ({ ID: i + 1, OrderNumber: `N${i}`, OrderStatusId: 4 }))
  listResponder = () => alwaysFull // every page full → never short

  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT, limit: 10, maxPages: 3 }),
    /exceeded 3 pages/,
  )
  assert.equal(listCalls.length, 3) // stopped at the budget
})

test('[o3d-bjc] a multi-row page resolves settings + statuses ONCE, not once per row', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  settingsCalls = 0
  statusCalls = 0
  const rows = Array.from({ length: 30 }, (_, i) => ({ ID: i + 1, OrderNumber: `N${i + 1}`, OrderStatusId: 4 }))
  listResponder = (pageNo) => (pageNo === 1 ? rows : []) // 30 < default limit 200 → short first page

  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out.length, 30)
  assert.equal(settingsCalls, 1) // once for the whole list, NOT 30x (the pre-fix fan-out)
  assert.ok(statusCalls <= 1, `statuses fetched at most once (was ${statusCalls})`) // 0 if cache warm, else 1 — never 30
})

test('[o3d-bjc] a malformed 2xx Order/List body throws (fails closed), not treated as an empty page', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  // A 200 with an unexpected shape (proxy error object / schema drift): must throw
  // rather than end pagination as a "complete" empty page and advance the watermark.
  listResponder = () => ({ Message: 'temporarily unavailable' }) as unknown as unknown[]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /expected an array/,
  )

  // A 200 null body likewise fails closed.
  listResponder = () => null as unknown as unknown[]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /got null/,
  )
})

test('[o3d-bjc] a row missing a valid ID throws (fails closed), not silently dropped', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  // A well-formed page shape, but one row has no ID — a schema/API fault. It must
  // throw (Python parity) rather than normalise to null and be filtered away,
  // which would advance the watermark past that order.
  listResponder = () => [
    { ID: 1, OrderNumber: 'N1', OrderStatusId: 4 },
    { OrderNumber: 'N2', OrderStatusId: 4 }, // no ID
  ]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /missing a valid ID/,
  )
})

test('[o3d-bjc] a row missing an order number throws (fails closed)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  // The delta map is keyed by order number; a row without one can never be matched
  // to an active link, so dropping it would silently lose the change. Fail closed.
  listResponder = () => [{ ID: 7, OrderStatusId: 4 }] // no OrderNumber
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /missing an order number/,
  )
})

test('fetchMintsoftOrderList throws on an HTTP error (so the sweep fails safe to reconcile)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = 'Mintsoft request failed with status 500'
  try {
    await assert.rejects(
      () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
      /Mintsoft request failed/,
    )
  } finally {
    listError = null
  }
})
