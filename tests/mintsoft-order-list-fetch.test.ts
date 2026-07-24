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

// Every delta is scoped to our ClientId, and every ROW must echo it (fail closed).
const CLIENT = 5
// Build a well-formed, in-scope row (carries our ClientId).
function row(id: number, over: Record<string, unknown> = {}) {
  return { ID: id, OrderNumber: `N${id}`, OrderStatusId: 4, ClientId: CLIENT, ...over }
}

test('fetchMintsoftOrderList paginates until a short page and carries the delta params', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const fullPage = Array.from({ length: 200 }, (_, i) => row(i + 1))
  listResponder = (pageNo) => (pageNo === 1 ? fullPage : pageNo === 2 ? [row(201), row(202)] : [])

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

// --- Finding 1: ClientId scoping (fail closed, whole-response) --------------

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

test('[o3d-bjc] a row MISSING a ClientId rejects the WHOLE response (fails closed — cannot verify tenant)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  // Second row has no ClientId — unverifiable → the whole delta is rejected so
  // contract drift can never quietly advance the watermark past unverified rows.
  listResponder = () => [row(1), { ID: 2, OrderNumber: 'N2', OrderStatusId: 4 }]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /has no ClientId/,
  )
})

test('[o3d-bjc] a row with a FOREIGN ClientId rejects the WHOLE response (fails closed — never applied to a local link)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  // A foreign row sharing our order number would otherwise be a cross-tenant hazard.
  listResponder = () => [row(1), row(2, { ClientId: 99 })]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /does not match configured 5/,
  )
})

test('fetchMintsoftOrderList throws (not truncates) when the delta overflows the page budget', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const alwaysFull = Array.from({ length: 10 }, (_, i) => row(i + 1))
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
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1))
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
  listResponder = () => ({ Message: 'temporarily unavailable' }) as unknown as unknown[]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /expected an array/,
  )

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
  listResponder = () => [row(1), { OrderNumber: 'N2', OrderStatusId: 4, ClientId: CLIENT }] // 2nd row: no ID
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /missing a valid ID/,
  )
})

test('[o3d-bjc] a row missing an order number throws (fails closed)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => [{ ID: 7, OrderStatusId: 4, ClientId: CLIENT }] // no OrderNumber
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
