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

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({ mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}' }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    MINTSOFT_SETTING_KEYS: [],
  },
})
mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string) => {
      if (path.startsWith('/api/Order/Statuses')) {
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

  const out = await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', limit: 200 })
  assert.equal(out.length, 202)
  assert.equal(listCalls.length, 2) // stopped on the short 2nd page
  assert.equal(listCalls[0].SinceLastUpdated, '2026-07-15T12:00:00')
  assert.equal(listCalls[0].IncludeOrderItems, 'true')
  assert.equal(listCalls[0].SortOldestFirst, 'true')
  assert.equal(listCalls[0].Limit, '200')
  assert.equal(listCalls[1].PageNo, '2')
})

test('fetchMintsoftOrderList passes ClientId / WarehouseId / ChannelId when provided', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  listResponder = () => [] // short (empty) first page → returns immediately
  await fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', clientId: 42, warehouseId: 7, channelId: 3, limit: 100 })
  assert.equal(listCalls[0].ClientId, '42')
  assert.equal(listCalls[0].WarehouseId, '7')
  assert.equal(listCalls[0].ChannelId, '3')
})

test('fetchMintsoftOrderList throws (not truncates) when the delta overflows the page budget', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = null
  const alwaysFull = Array.from({ length: 10 }, (_, i) => ({ ID: i + 1, OrderNumber: `N${i}`, OrderStatusId: 4 }))
  listResponder = () => alwaysFull // every page full → never short

  await assert.rejects(
    () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00', limit: 10, maxPages: 3 }),
    /exceeded 3 pages/,
  )
  assert.equal(listCalls.length, 3) // stopped at the budget
})

test('fetchMintsoftOrderList throws on an HTTP error (so the sweep fails safe to reconcile)', async () => {
  const fetchMintsoftOrderList = await loadFetch()
  listCalls = []
  listError = 'Mintsoft request failed with status 500'
  try {
    await assert.rejects(
      () => fetchMintsoftOrderList({ sinceLastUpdated: '2026-07-15T12:00:00' }),
      /Mintsoft request failed/,
    )
  } finally {
    listError = null
  }
})
