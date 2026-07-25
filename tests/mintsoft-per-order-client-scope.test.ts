import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const CLIENT = 5

let searchRows: unknown[] = []
let details = new Map<string, unknown>()
let itemRows: unknown[] = []
let calls: string[] = []

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
    }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
  },
})

mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string) => {
      calls.push(path)
      // Match on the pathname; per-order detail/items requests now also carry a
      // ?ClientId= query (finding 1 request-side scoping) — the full path stays
      // in `calls` so tests can still assert the ClientId param.
      const pathname = path.split('?')[0]
      if (pathname === '/api/Order/Statuses') {
        return { data: [{ ID: 4, Name: 'DESPATCHED' }], status: 200 }
      }
      if (pathname === '/api/Order/Search') {
        return { data: searchRows, status: 200 }
      }
      const itemsMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Items$/)
      if (itemsMatch) return { data: itemRows, status: 200 }
      const detailMatch = pathname.match(/^\/api\/Order\/([^/]+)$/)
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1])
        return details.has(id)
          ? { data: details.get(id), status: 200 }
          : { data: null, status: 404 }
      }
      throw new Error(`Unexpected Mintsoft path: ${path}`)
    },
  },
})

async function orders() {
  return import('@/lib/connectors/mintsoft/api/orders')
}

// A COMPLETE Mintsoft order record: it carries the fulfilment block, with explicit
// nulls for an untracked despatch. o3d-6j8 keys on PRESENCE, and refuses to apply a
// dispatched record that OMITS these — so the fixture has to look like a real DTO.
function ownOrder(id: string | number, over: Record<string, unknown> = {}) {
  return {
    ID: id,
    OrderNumber: 'WC-1001',
    OrderStatusId: 4,
    ClientId: CLIENT,
    TrackingNumber: null,
    CourierServiceName: null,
    DespatchDate: null,
    NumberOfParts: 1,
    ...over,
  }
}

function reset() {
  searchRows = []
  details = new Map()
  itemRows = []
  calls = []
}

test('[o3d-bjc.2 finding 1] per-order lookups fail closed before I/O without a configured ClientId', async () => {
  reset()
  const { fetchMintsoftOrderStatus, probeMintsoftOrderPresence, fetchMintsoftOrderParts, fetchMintsoftPartItems } = await orders()

  await assert.rejects(() => fetchMintsoftOrderStatus('WC-1001', null), /requires a ClientId/)
  await assert.rejects(() => probeMintsoftOrderPresence('WC-1001', null), /requires a ClientId/)
  await assert.rejects(() => fetchMintsoftOrderParts('WC-1001', null), /requires a ClientId/)
  await assert.rejects(() => fetchMintsoftPartItems('M-1', null), /requires a ClientId/)
  assert.deepEqual(calls, [])
})

test('[o3d-bjc.2 finding 1] Order/Search sends ClientId and an in-scope detail is consumed', async () => {
  reset()
  searchRows = [ownOrder('M-1')]
  details.set('M-1', ownOrder('M-1', { TrackingNumber: 'TN-1' }))
  const { fetchMintsoftOrderStatus } = await orders()

  const result = await fetchMintsoftOrderStatus('WC-1001', CLIENT)
  const searchCall = calls.find((path) => path.startsWith('/api/Order/Search?'))
  assert.ok(searchCall)
  const query = new URLSearchParams(searchCall.split('?')[1])
  assert.equal(query.get('OrderNumber'), 'WC-1001')
  assert.equal(query.get('ClientId'), String(CLIENT))
  assert.equal(result?.externalOrderId, 'M-1')
  assert.equal(result?.tracking[0]?.trackingNumber, 'TN-1')
})

test('[o3d-bjc.2 finding 1] a foreign or ClientId-less Search row rejects the lookup and is never picked', async () => {
  reset()
  const { fetchMintsoftOrderStatus } = await orders()

  searchRows = [ownOrder('M-1'), ownOrder('FOREIGN', { ClientId: 99 })]
  await assert.rejects(
    () => fetchMintsoftOrderStatus('WC-1001', CLIENT),
    /ClientId 99 does not match configured 5/,
  )
  assert.equal(calls.some((path) => path === '/api/Order/M-1'), false)

  reset()
  searchRows = [{ ID: 'M-1', OrderNumber: 'WC-1001', OrderStatusId: 4 }]
  await assert.rejects(() => fetchMintsoftOrderStatus('WC-1001', CLIENT), /has no ClientId/)
})

test('[o3d-bjc.2 finding 1] a foreign detail row is rejected instead of falling back to the scoped Search row', async () => {
  reset()
  searchRows = [ownOrder('M-1')]
  details.set('M-1', ownOrder('M-1', { ClientId: 99, TrackingNumber: 'FOREIGN' }))
  const { fetchMintsoftOrderStatus } = await orders()

  await assert.rejects(
    () => fetchMintsoftOrderStatus('WC-1001', CLIENT),
    /ClientId 99 does not match configured 5/,
  )
})

test('[o3d-bjc.2 finding 1] split-part enumeration validates every Search and detail row', async () => {
  reset()
  searchRows = [
    ownOrder('M-1', { Part: 1, NumberOfParts: 2 }),
    ownOrder('M-2', { Part: 2, NumberOfParts: 2 }),
  ]
  details.set('M-1', ownOrder('M-1', { Part: 1, NumberOfParts: 2 }))
  details.set('M-2', ownOrder('M-2', { Part: 2, NumberOfParts: 2, ClientId: 99 }))
  const { fetchMintsoftOrderParts } = await orders()

  await assert.rejects(
    () => fetchMintsoftOrderParts('WC-1001', CLIENT),
    /ClientId 99 does not match configured 5/,
  )
})

test('[o3d-bjc.2 finding 1] part-item lookup validates the parent part ClientId before consuming items', async () => {
  reset()
  details.set('M-2', ownOrder('M-2', { ClientId: 99 }))
  itemRows = [{ SKU: 'FOREIGN-SKU', Quantity: 1 }]
  const { fetchMintsoftPartItems } = await orders()

  await assert.rejects(
    () => fetchMintsoftPartItems('M-2', CLIENT),
    /ClientId 99 does not match configured 5/,
  )
  assert.equal(calls.some((path) => path.endsWith('/Items')), false)

  reset()
  details.set('M-2', ownOrder('M-2'))
  itemRows = [{ SKU: 'OWN-SKU', Quantity: 2 }]
  assert.deepEqual(await fetchMintsoftPartItems('M-2', CLIENT), [{ sku: 'OWN-SKU', qty: 2 }])
})

// --- o3d-6j8: the sweep's FALLBACK must not undo the delta's refusal ----------
// When the delta throws on an incomplete dispatched row, the dispatch sweep falls
// back to per-order reconciliation through fetchMintsoftOrderStatus. Without the
// same completeness rule here, the very row the delta just refused would be applied:
// dispatched=true with tracking=[] marks the IMS order SHIPPED, and SHIPPED leaves
// the poll set, so the real tracking number can never land afterwards.

test('[o3d-6j8] the per-order fallback REFUSES an incomplete dispatched record (never reports it dispatched)', async () => {
  reset()
  const { fetchMintsoftOrderStatus } = await orders()
  // The Search row and the detail record both omit the fulfilment block.
  searchRows = [{ ID: 'M-1', OrderNumber: 'WC-1001', OrderStatusId: 4, ClientId: CLIENT }]
  details.set('M-1', { ID: 'M-1', OrderNumber: 'WC-1001', OrderStatusId: 4, ClientId: CLIENT })

  await assert.rejects(
    () => fetchMintsoftOrderStatus('WC-1001', CLIENT),
    /refusing to apply an incomplete dispatch/,
  )
})

test('[o3d-6j8] the per-order fallback also refuses when the detail 404s and only an incomplete SEARCH row is left', async () => {
  reset()
  const { fetchMintsoftOrderStatus } = await orders()
  // No detail entry → the historical fallback consumes the Search row, which is the
  // shape most likely to omit fulfilment fields.
  searchRows = [{ ID: 'M-1', OrderNumber: 'WC-1001', OrderStatusId: 4, ClientId: CLIENT }]

  await assert.rejects(
    () => fetchMintsoftOrderStatus('WC-1001', CLIENT),
    /refusing to apply an incomplete dispatch/,
  )
})

test('[o3d-6j8] a COMPLETE dispatched record still resolves normally on the per-order path', async () => {
  reset()
  const { fetchMintsoftOrderStatus } = await orders()
  searchRows = [ownOrder('M-1')]
  details.set('M-1', ownOrder('M-1', {
    TrackingNumber: 'TN-1', CourierServiceName: 'DPD', DespatchDate: '2026-07-15T09:00:00',
  }))

  const out = await fetchMintsoftOrderStatus('WC-1001', CLIENT)
  assert.equal(out?.dispatched, true)
  assert.equal(out?.tracking[0]?.trackingNumber, 'TN-1')
})

test('[o3d-6j8] a NON-dispatched incomplete record is not refused (only the irreversible path is guarded)', async () => {
  reset()
  const { fetchMintsoftOrderStatus } = await orders()
  // PICKED (17) with no fulfilment block: nothing irreversible follows, so this must
  // keep working or ordinary pre-despatch polling would break.
  searchRows = [{ ID: 'M-1', OrderNumber: 'WC-1001', OrderStatusId: 17, ClientId: CLIENT }]
  details.set('M-1', { ID: 'M-1', OrderNumber: 'WC-1001', OrderStatusId: 17, ClientId: CLIENT })

  const out = await fetchMintsoftOrderStatus('WC-1001', CLIENT)
  assert.equal(out?.dispatched, false)
})
