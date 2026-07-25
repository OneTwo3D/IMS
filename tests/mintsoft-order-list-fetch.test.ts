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
// The /api/Order/Statuses body, swappable per test so the o3d-bjc.2.2 fail-closed
// status-map cases (malformed / empty / unresolvable id) can be exercised.
const DEFAULT_STATUSES: unknown = [{ ID: 4, Name: 'DESPATCHED' }, { ID: 17, Name: 'PICKED' }]
let statusResponder: () => unknown = () => DEFAULT_STATUSES
// o3d-6j8: authoritative per-id records + the ids actually re-read.
let detailRows = new Map<string, unknown>()
let detailCalls: string[] = []
// Concurrency observability for the bounded re-read pool.
let detailInFlight = 0
let detailMaxInFlight = 0
let detailDelayMs = 0

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
        return { data: statusResponder(), status: 200 }
      }
      // o3d-6j8: an incomplete dispatched row is re-read by id before it is applied.
      const detail = path.split('?')[0].match(/^\/api\/Order\/(\d+)$/)
      if (detail) {
        const id = detail[1]
        detailCalls.push(id)
        detailInFlight += 1
        detailMaxInFlight = Math.max(detailMaxInFlight, detailInFlight)
        try {
          if (detailDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, detailDelayMs))
          return detailRows.has(id)
            ? { data: detailRows.get(id), status: 200 }
            : { data: null, status: 404 }
        } finally {
          detailInFlight -= 1
        }
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

/** Drop the memoised status map so a test can serve its own /Order/Statuses body. */
async function resetStatusCache(): Promise<void> {
  ;(await import('@/lib/connectors/mintsoft/api/orders')).resetMintsoftOrderStatusCacheForTests()
}

// Every delta is scoped to our ClientId, and every ROW must echo it (fail closed).
const CLIENT = 5
// Build a well-formed, in-scope row (carries our ClientId).
// A COMPLETE Order/List row: it carries the fulfilment block, with explicit nulls
// for an untracked shipment. o3d-6j8 keys on PRESENCE, so a row like this stays on
// the bulk hot path and is never re-read by id.
function row(id: number, over: Record<string, unknown> = {}) {
  return {
    ID: id,
    OrderNumber: `N${id}`,
    OrderStatusId: 4,
    ClientId: CLIENT,
    TrackingNumber: null,
    CourierServiceName: null,
    DespatchDate: null,
    NumberOfParts: 1,
    ...over,
  }
}

/** The same row with the fulfilment block OMITTED — the o3d-6j8 hazard shape. */
function incompleteRow(id: number, over: Record<string, unknown> = {}) {
  return { ID: id, OrderNumber: `N${id}`, OrderStatusId: 4, ClientId: CLIENT, ...over }
}

test('fetchMintsoftOrderList paginates until a short page and carries the delta params', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const fullPage = Array.from({ length: 100 }, (_, i) => row(i + 1))
  listResponder = (pageNo) => (pageNo === 1 ? fullPage : pageNo === 2 ? [row(201), row(202)] : [])

  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT, limit: 100 })
  assert.equal(out.length, 102)
  assert.equal(listCalls.length, 2) // stopped on the short 2nd page
  assert.equal(listCalls[0].SinceLastUpdated, '2026-07-15T12:00:00')
  assert.equal(listCalls[0].IncludeOrderItems, 'true')
  assert.equal(listCalls[0].SortOldestFirst, 'true')
  assert.equal(listCalls[0].Limit, '100')
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

// --- o3d-bjc.2.2: an UNRESOLVED dispatch status must never ride through clean --
// A lenient status map (empty/malformed) normalises every row to status '' →
// dispatched:false → a clean `pending`, so the sweep's watermark would advance
// past orders whose real dispatch state was never determined and a genuinely
// DESPATCHED order could be aged out of the delta window.

test('[o3d-bjc.2.2] a malformed /Order/Statuses body throws and is NOT cached as an empty map', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => [row(1)]

  await resetStatusCache()
  statusResponder = () => ({ Message: 'temporarily unavailable' })
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /Order\/Statuses: expected an array/,
  )

  // An empty list is equally unusable — every OrderStatusId would be unresolvable.
  statusResponder = () => []
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /returned no statuses/,
  )

  // An entry without a usable ID/Name is drift, not a status we can skip.
  statusResponder = () => [{ ID: 4, Name: 'DESPATCHED' }, { Name: 'PICKED' }]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /positive-integer ID or a non-empty string Name/,
  )

  // Nothing above was cached: a healthy body still resolves normally afterwards.
  statusResponder = () => DEFAULT_STATUSES
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'DESPATCHED')
})

test('[o3d-bjc.2.2] a delta row whose OrderStatusId is unresolvable throws (the watermark is retained)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  // OrderStatusId 999 is absent from the status map → dispatch state unknown.
  listResponder = () => [row(1), row(2, { OrderStatusId: 999 })]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /unresolved OrderStatusId \(999\) and no despatch date/,
  )

  // A row with NO OrderStatusId at all is the same unknown state.
  listResponder = () => [row(3, { OrderStatusId: null })]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /unresolved OrderStatusId \(missing\) and no despatch date/,
  )
})

test('[o3d-bjc.2.2] the status map rejects COERCIBLE junk (no "4junk" ids, no numeric names, no conflicting duplicates)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => [row(1)]

  // "4junk" would parseInt to 4 — a plausible id built from drift.
  await resetStatusCache()
  statusResponder = () => [{ ID: '4junk', Name: 'DESPATCHED' }]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /positive-integer ID or a non-empty string Name/,
  )

  // A numeric Name would stringify to a truthy but meaningless status.
  await resetStatusCache()
  statusResponder = () => [{ ID: 4, Name: 123 }]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /positive-integer ID or a non-empty string Name/,
  )

  // A non-integer id would truncate onto a real status id.
  await resetStatusCache()
  statusResponder = () => [{ ID: 4.7, Name: 'DESPATCHED' }]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /positive-integer ID or a non-empty string Name/,
  )

  // A duplicate id with a CONFLICTING name silently overwrote the first entry.
  await resetStatusCache()
  statusResponder = () => [{ ID: 4, Name: 'DESPATCHED' }, { ID: 4, Name: 'CANCELLED' }]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /ambiguous status map/,
  )

  // An identical duplicate is harmless and still resolves.
  await resetStatusCache()
  statusResponder = () => [{ ID: 4, Name: 'DESPATCHED' }, { ID: 4, Name: 'despatched' }]
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out[0].status, 'DESPATCHED')
})

test('[o3d-bjc.2.2] a malformed or sentinel DespatchDate is NOT proof of despatch', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  // Each of these previously satisfied the unknown-status escape hatch AND
  // isMintsoftDispatched purely by being non-empty.
  for (const despatchDate of ['not-a-date', '0001-01-01T00:00:00', 0, '0', '']) {
    listResponder = () => [row(1, { OrderStatusId: 999, DespatchDate: despatchDate })]
    await assert.rejects(
      () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
      /unresolved OrderStatusId \(999\) and no despatch date/,
      `DespatchDate ${JSON.stringify(despatchDate)} must not prove despatch`,
    )
  }

  // Trailing junk, calendar rollover, out-of-range time, and an out-of-range zone
  // offset are all rejected — Date.parse alone accepts every one of them.
  for (const despatchDate of [
    '2026-07-15junk', '2026-02-30T09:00:00', '2026-04-31', '2026-07-15T24:00:00',
    '2026-07-15T09:60:00', '2026-07-15T09:00:00+99:99', '2027-02-29',
    // Offset range is ±14:00 inclusive, and hour 14 admits only :00.
    '2026-07-15T09:00:00+14:01', '2026-07-15T09:00:00+14:59', '2026-07-15T09:00:00-14:01',
    '2026-07-15T09:00:00+15:00', '2026-07-15T09:00:00-15:00', '2026-07-15T09:00:00+',
  ]) {
    listResponder = () => [row(1, { OrderStatusId: 999, DespatchDate: despatchDate })]
    await assert.rejects(
      () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
      /unresolved OrderStatusId \(999\) and no despatch date/,
      `DespatchDate ${JSON.stringify(despatchDate)} must not prove despatch`,
    )
  }

  // …while every REAL Mintsoft form still counts (no shipping regression).
  for (const despatchDate of [
    '2026-07-15T09:00:00', '2026-07-15 09:00:00', '2026-07-15', '2026-07-15T09:00',
    '2026-07-15T09:00:00.1234567', '2026-07-15T09:00:00Z', '2026-07-15T09:00:00+01:00',
    '2026-07-15t09:00:00', '2028-02-29T09:00:00',
    // The offset boundary itself is valid in both directions, with and without a colon.
    '2026-07-15T09:00:00+14:00', '2026-07-15T09:00:00-14:00', '2026-07-15T09:00:00+0100',
  ]) {
    listResponder = () => [row(1, { OrderStatusId: 999, DespatchDate: despatchDate })]
    const proven = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
    assert.equal(proven[0].dispatched, true, `DespatchDate ${JSON.stringify(despatchDate)} must prove despatch`)
  }

  // …and a sentinel date on a KNOWN, non-despatched status must not mark it shipped.
  listResponder = () => [row(1, { OrderStatusId: 17, DespatchDate: '0001-01-01T00:00:00' })]
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out[0].status, 'PICKED')
  assert.equal(out[0].dispatched, false)
  assert.deepEqual(out[0].tracking, [])
})

test('[o3d-bjc.2.2] an unresolvable status is allowed when a DespatchDate proves the goods left', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  listResponder = () => [row(1, { OrderStatusId: 999, DespatchDate: '2026-07-15T09:00:00', TrackingNumber: 'TN9' })]
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out.length, 1)
  assert.equal(out[0].status, '') // status name still unknown…
  assert.equal(out[0].dispatched, true) // …but the despatch date is authoritative
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

// --- o3d-6j8: an INCOMPLETE dispatched row must never be applied ---------------
// readTracking() returns [] when TrackingNumber, CourierServiceName and DespatchDate
// are all ABSENT, so `dispatched` comes from the status name alone and the order is
// written SHIPPED with no tracking. SHIPPED then leaves the poll set
// (POST_DISPATCH_STATUSES), so the real tracking number can never land afterwards.
// An absent field read as a positive fact, on an irreversible path.

test('[o3d-6j8] a DISPATCHED row missing the fulfilment block is re-read by id and the authoritative record is used', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  listResponder = () => [incompleteRow(1)] // status 4 = DESPATCHED, no fulfilment keys
  detailRows = new Map([['1', {
    ID: 1, OrderNumber: 'N1', OrderStatusId: 4, ClientId: CLIENT,
    TrackingNumber: 'TN-REAL', CourierServiceName: 'DPD',
    DespatchDate: '2026-07-15T09:00:00', NumberOfParts: 1,
  }]])

  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.deepEqual(detailCalls, ['1'], 'the incomplete row was re-read by id')
  assert.equal(out.length, 1)
  assert.equal(out[0].dispatched, true)
  // The real tracking number is applied instead of a SHIPPED-with-nothing order.
  assert.deepEqual(out[0].tracking, [{ trackingNumber: 'TN-REAL', carrier: 'DPD', despatchedAt: '2026-07-15T09:00:00' }])
})

test('[o3d-6j8] a COMPLETE row carrying explicit nulls stays on the bulk hot path (no re-read)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  detailRows = new Map()
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  // A legitimate UNTRACKED despatch: the block is present, the values are null.
  listResponder = () => [row(1)]
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out.length, 1)
  assert.equal(out[0].dispatched, true)
  assert.deepEqual(detailCalls, [], 'presence, not truthiness — the optimisation is not undone')
})

test('[o3d-6j8] a NON-dispatched incomplete row is never re-read', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  detailRows = new Map()
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  listResponder = () => [incompleteRow(1, { OrderStatusId: 17 })] // PICKED
  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(out.length, 1)
  assert.equal(out[0].dispatched, false)
  assert.deepEqual(detailCalls, [])
})

test('[o3d-6j8] an incomplete row whose authoritative record cannot be read THROWS (holds the watermark)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  detailRows = new Map() // the detail read 404s
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  listResponder = () => [incompleteRow(1)]
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /refusing to apply an incomplete dispatch/,
  )
})

test('[o3d-6j8] an authoritative record that ALSO omits the block throws rather than shipping blind', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  listResponder = () => [incompleteRow(1)]
  detailRows = new Map([['1', { ID: 1, OrderNumber: 'N1', OrderStatusId: 4, ClientId: CLIENT }]])
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /\(authoritative re-read\) reads as dispatched .* but omits/,
  )
})

test('[o3d-6j8] a row dispatched only by DespatchDate but missing NumberOfParts is re-read (split decision unknowable)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  // Unknown status, but a valid despatch date makes it dispatched — and NumberOfParts
  // is absent, so `isSplit` would silently read false and skip part reconciliation.
  listResponder = () => [{
    ID: 1, OrderNumber: 'N1', OrderStatusId: 999, ClientId: CLIENT,
    TrackingNumber: 'TN1', CourierServiceName: 'DPD', DespatchDate: '2026-07-15T09:00:00',
  }]
  detailRows = new Map([['1', {
    ID: 1, OrderNumber: 'N1', OrderStatusId: 4, ClientId: CLIENT,
    TrackingNumber: 'TN1', CourierServiceName: 'DPD',
    DespatchDate: '2026-07-15T09:00:00', NumberOfParts: 3,
  }]])

  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.deepEqual(detailCalls, ['1'])
  assert.equal(out[0].isSplit, true, 'the split is no longer silently missed')
  assert.equal(out[0].partCount, 3)
})

test('[o3d-6j8] the re-read is scoped by ClientId', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  listResponder = () => [incompleteRow(1)]
  detailRows = new Map([['1', {
    ID: 1, OrderNumber: 'N1', OrderStatusId: 4, ClientId: 99, // FOREIGN
    TrackingNumber: 'TN', CourierServiceName: 'DPD', DespatchDate: '2026-07-15T09:00:00', NumberOfParts: 1,
  }]])
  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /does not match configured 5/,
  )
})

// --- Drift lock: the guard must keep covering what the dispatch path READS ------
// The IMS analogue of the Python inspect.getsource() test. If someone adds a new
// `order.X` read to readTracking / normalizeMintsoftOrderRow whose absence could be
// mistaken for a fact, this fails until the key is guarded or explicitly exempted.

test('[o3d-6j8] drift lock: every dispatch-relevant row field read by this module is guarded or exempted', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/connectors/mintsoft/api/orders.ts', import.meta.url), 'utf8')

  const { MINTSOFT_DISPATCH_ROW_KEYS } = await import('@/lib/connectors/mintsoft/api/orders')
  const guarded = new Set<string>(MINTSOFT_DISPATCH_ROW_KEYS)

  // Validated per row before dispatch resolution, so absence already fails closed.
  const exempt = new Set(['ID', 'Id', 'OrderNumber', 'OrderStatusId', 'ClientId', 'Name', 'Part'])

  // Every PascalCase field read off a raw order/row/detail/record object.
  const read = new Set<string>()
  for (const match of source.matchAll(/\b(?:order|row|detail|record)\.([A-Z][A-Za-z0-9]*)/g)) {
    read.add(match[1])
  }

  const unaccounted = [...read].filter((field) => !guarded.has(field) && !exempt.has(field))
  assert.deepEqual(
    unaccounted,
    [],
    `New raw-row field(s) read by orders.ts are neither guarded by MINTSOFT_DISPATCH_ROW_KEYS nor exempt: `
      + `${unaccounted.join(', ')}. If absence of the field could be read as a positive fact on the dispatch `
      + `path, add it to MINTSOFT_DISPATCH_ROW_KEYS; if it is validated elsewhere, add it to this test's exempt set.`,
  )
  // And the guard must not have silently shrunk.
  for (const key of ['TrackingNumber', 'CourierServiceName', 'DespatchDate', 'NumberOfParts']) {
    assert.ok(guarded.has(key), `${key} must stay guarded`)
  }
})

test('[o3d-6j8] the authoritative re-reads are CONCURRENCY-BOUNDED (drift cannot self-inflict a request storm)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  detailMaxInFlight = 0
  detailInFlight = 0
  detailDelayMs = 5 // hold each read open so overlap is observable
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  // 40 dispatched rows, ALL incomplete — the schema-drift shape. Unbounded, this
  // opened 40 simultaneous detail requests; at 10k rows it would be 10k.
  const ids = Array.from({ length: 40 }, (_, i) => i + 1)
  listResponder = () => ids.map((id) => incompleteRow(id))
  detailRows = new Map(ids.map((id) => [String(id), {
    ID: id, OrderNumber: `N${id}`, OrderStatusId: 4, ClientId: CLIENT,
    TrackingNumber: `TN-${id}`, CourierServiceName: 'DPD',
    DespatchDate: '2026-07-15T09:00:00', NumberOfParts: 1,
  }]))

  try {
    const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
    assert.equal(out.length, 40)
    assert.equal(detailCalls.length, 40)
    assert.ok(detailMaxInFlight <= 4, `at most 4 re-reads in flight (peaked at ${detailMaxInFlight})`)
    assert.equal(detailMaxInFlight, 4, 'and the pool is actually SATURATED, not serialised')
    // Input order is preserved despite the chunked pool.
    assert.deepEqual(out.map((o) => o.externalOrderId), ids.map(String))
    assert.deepEqual(out.map((o) => o.tracking[0]?.trackingNumber), ids.map((id) => `TN-${id}`))
  } finally {
    detailDelayMs = 0
  }
})

test('[o3d-6j8] SPARSE incomplete rows still overlap — the pool queues by row, not by chunk', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  detailCalls = []
  detailMaxInFlight = 0
  detailInFlight = 0
  detailDelayMs = 10
  await resetStatusCache()
  statusResponder = () => DEFAULT_STATUSES

  // 8 incomplete rows each separated by 9 COMPLETE ones. Chunking all rows in
  // fours put every incomplete row in a different chunk, so they never overlapped
  // and cost 8 sequential request latencies — worst exactly when little has drifted.
  const rows: unknown[] = []
  const incompleteIds: number[] = []
  for (let i = 1; i <= 80; i += 1) {
    if (i % 10 === 0) { rows.push(incompleteRow(i)); incompleteIds.push(i) }
    else rows.push(row(i))
  }
  listResponder = () => rows
  detailRows = new Map(incompleteIds.map((id) => [String(id), {
    ID: id, OrderNumber: `N${id}`, OrderStatusId: 4, ClientId: CLIENT,
    TrackingNumber: `TN-${id}`, CourierServiceName: 'DPD',
    DespatchDate: '2026-07-15T09:00:00', NumberOfParts: 1,
  }]))

  try {
    const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
    assert.equal(out.length, 80)
    // ONLY the incomplete rows cost a network read.
    assert.deepEqual(detailCalls.sort((a, b) => Number(a) - Number(b)), incompleteIds.map(String))
    assert.equal(detailMaxInFlight, 4, `sparse re-reads must still overlap (peaked at ${detailMaxInFlight})`)
    // Order preserved despite out-of-order completion.
    assert.deepEqual(out.map((o) => o.externalOrderId), Array.from({ length: 80 }, (_, i) => String(i + 1)))
    assert.equal(out[9].tracking[0]?.trackingNumber, 'TN-10')
  } finally {
    detailDelayMs = 0
  }
})

// --- o3d-9vv: the API 400s above Limit=100, so we must CLAMP, not just default ---
// Verified live by bisection (2026-07-25): Limit=100 -> 200 OK, Limit=101 -> HTTP 400.
// This shipped as 200, so EVERY delta fetch 400'd and the sweep fell back to the
// per-order reconcile on every tick — the optimisation never engaged once. It failed
// SAFE (correct sync, zero errors), which is exactly why nothing surfaced it.

test('[o3d-9vv] the default Limit is at the API maximum, never above it', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  const { MINTSOFT_ORDER_LIST_MAX_LIMIT } = await import('@/lib/connectors/mintsoft/api/orders')
  assert.equal(MINTSOFT_ORDER_LIST_MAX_LIMIT, 100)

  listCalls = []
  listError = null
  listResponder = () => []
  await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT })
  assert.equal(listCalls[0].Limit, '100')
})

test('[o3d-9vv] an over-cap configured Limit is CLAMPED, not passed through (it would 400 and kill the delta silently)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => []

  for (const requested of [101, 200, 500, 10_000]) {
    listCalls = []
    await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT, limit: requested })
    assert.equal(listCalls[0].Limit, '100', `Limit ${requested} must be clamped to 100`)
  }
})

test('[o3d-9vv] a below-cap Limit is still honoured', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => []
  await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT, limit: 25 })
  assert.equal(listCalls[0].Limit, '25')
})

test('[o3d-9vv] EVERY page of a multi-page delta stays within the cap', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const full = Array.from({ length: 100 }, (_, i) => row(i + 1))
  // Three full pages then a short one, so paging is genuinely exercised.
  listResponder = (pageNo) => (pageNo <= 3 ? full : [row(999)])

  await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT, limit: 250 })
  assert.equal(listCalls.length, 4)
  for (const [index, call] of listCalls.entries()) {
    assert.ok(Number(call.Limit) <= 100, `page ${index + 1} sent Limit ${call.Limit}, above the API maximum`)
  }
})

test('[o3d-9vv] the page budget keeps the overall delta capacity (100 x 100, not 100 x 50)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const full = Array.from({ length: 100 }, (_, i) => row(i + 1))
  listResponder = () => full // never a short page → runs to the budget, then throws

  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: CLIENT }),
    /exceeded 100 pages at limit=100/,
  )
  assert.equal(listCalls.length, 100, 'halving the page size doubled the page budget')
})
