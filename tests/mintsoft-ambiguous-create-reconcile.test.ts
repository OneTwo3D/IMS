import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The READ that resolves a create whose outcome was never recorded (a timed-out PUT, a 5xx, a lost link write).
 *
 * MINTSOFT IS LIVE: the transport here is a mock. The pinned facts are that the read is the ONE scoped Order/Search the push dedupe
 * already uses, that it writes nothing, and that an order is adopted only when it is provably THIS order (exactly one row carrying
 * this order's own external reference). Anything else is left for a person.
 */

const CLIENT = 5

let clientIdSetting = String(CLIENT)
const defaultCourierId = ''
let searchRows: unknown = []
let details = new Map<string, unknown>()
let createResult: unknown = null
let createError: string | null = null
let searchError: string | null = null
let createSequence: Array<{ error: string } | { result: unknown }> | null = null
let itemRows: unknown[] = []
// Ids whose detail request answers 2xx with NO readable order body (the client
// renders a 204 that way) — an UNKNOWN state, not an authoritative "not found".
let emptyDetailIds = new Set<string>()
let calls: string[] = []
let writes: Array<{ path: string; method: string }> = []
let cancelResponse: unknown = { ID: 0, Success: true, Message: 'Order: 1 was successfully cancelled' }

mock.module('@/lib/connectors/mintsoft/settings/schema', {
  namedExports: {
    getMintsoftSettings: async () => ({
      mintsoft_client_id: clientIdSetting,
      mintsoft_courier_service_map: '',
      mintsoft_default_courier_service_id: defaultCourierId,
      mintsoft_admin_order_url_template: 'https://wms.example/Order/{id}',
    }),
    MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE: 'https://wms.example/Order/{id}',
    parseMintsoftPositiveId: (value: string | null | undefined): number | null => {
      const trimmed = (value ?? '').trim()
      if (!/^\d+$/.test(trimmed)) return null
      const parsed = Number.parseInt(trimmed, 10)
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null
    },
  },
})

mock.module('@/lib/connectors/mintsoft/api/client', {
  namedExports: {
    mintsoftRequest: async (path: string, init?: { method?: string }) => {
      calls.push(path)
      const method = init?.method ?? 'GET'
      const pathname = path.split('?')[0]
      if (pathname === '/api/Order' && method === 'PUT') {
        if (createSequence) {
          const next = createSequence.shift()
          if (next && 'error' in next) return { data: null, error: next.error, status: 500 }
          if (next) return { data: next.result, status: 200 }
        }
        if (createError) return { data: null, error: createError, status: 500 }
        return { data: createResult, status: 200 }
      }
      if (pathname === '/api/Order/Search') {
        if (searchError) return { data: null, error: searchError, status: 500 }
        return { data: searchRows, status: 200 }
      }
      if (method !== 'GET') {
        writes.push({ path, method })
        return { data: { Success: true }, status: 200 }
      }
      const detailMatch = pathname.match(/^\/api\/Order\/([^/]+)$/)
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1])
        if (emptyDetailIds.has(id)) return { data: null, status: 204 }
        return details.has(id) ? { data: details.get(id), status: 200 } : { data: null, status: 404 }
      }
      const itemsMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Items$/)
      if (itemsMatch) return { data: itemRows, status: 200 }
      const cancelMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Cancel$/)
      if (cancelMatch) {
        writes.push({ path, method: 'CANCEL' })
        return { data: cancelResponse, status: 200 }
      }
      throw new Error(`Unexpected Mintsoft path: ${path}`)
    },
  },
})


async function push() {
  return import('@/lib/connectors/mintsoft/api/order-push')
}

function reset() {
  clientIdSetting = String(CLIENT)
  searchRows = []
  details = new Map()
  createResult = null
  createError = null
  searchError = null
  createSequence = null
  itemRows = []
  emptyDetailIds = new Set()
  calls = []
  writes = []
  cancelResponse = { ID: 0, Success: true, Message: 'Order: 1 was successfully cancelled' }
}

const REF = { orderNumber: 'WC-1001', externalReference: 'REF-1001' }

test('reconcile: the order the timed-out create left behind is ADOPTED, by one scoped read and no write', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  assert.deepEqual(await reconcileMintsoftAmbiguousCreate(REF), { kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'WC-1001' })
  assert.equal(calls.length, 1)
  const query = new URLSearchParams(calls[0].split('?')[1])
  assert.equal(calls[0].split('?')[0], '/api/Order/Search')
  assert.equal(query.get('ClientId'), String(CLIENT))
  assert.equal(query.get('OrderNumber'), 'WC-1001')
  assert.deepEqual(writes, [])
})

test('reconcile: nothing under the number is NONE (the ordinary replay policy then decides)', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = []
  assert.deepEqual(await reconcileMintsoftAmbiguousCreate(REF), { kind: 'NONE' })
})

test('reconcile: a number-only match (another reference) is NOT adopted', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'SOMETHING-ELSE', ClientId: CLIENT }]
  const result = await reconcileMintsoftAmbiguousCreate(REF)
  assert.equal(result.kind, 'UNRESOLVED')
})

test('reconcile: two matches are NOT adopted, even when one carries the reference', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [
    { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT },
    { ID: 556, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-OTHER', ClientId: CLIENT },
  ]
  assert.equal((await reconcileMintsoftAmbiguousCreate(REF)).kind, 'UNRESOLVED')
})

test('reconcile: a merged survivor is never adopted (it holds other orders too)', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 777, OrderNumber: 'WC-1001+WC-1002', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  assert.deepEqual(await reconcileMintsoftAmbiguousCreate(REF), { kind: 'NONE' })
})

test('reconcile: Order/Search is a term search, so another client\'s row is DROPPED (not adopted, not fatal) and our own still adopts', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 1, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: 99 }]
  assert.deepEqual(await reconcileMintsoftAmbiguousCreate(REF), { kind: 'NONE' })
  searchRows = [
    { ID: 1, OrderNumber: 'X-1', ExternalOrderReference: 'REF-1001', ClientId: 99 },
    { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT },
  ]
  assert.deepEqual(await reconcileMintsoftAmbiguousCreate(REF), { kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'WC-1001' })
})

test('reconcile: a row with no ClientId means ownership cannot be shown - nothing is adopted', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001' }]
  assert.equal((await reconcileMintsoftAmbiguousCreate(REF)).kind, 'UNRESOLVED')
})

test('reconcile: a FULL page of 10 results may be truncated - held, even when one row is exact', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = Array.from({ length: 10 }, (_, i) => ({ ID: 600 + i, OrderNumber: i === 0 ? 'WC-1001' : `OTHER-${i}`, ExternalOrderReference: i === 0 ? 'REF-1001' : `R-${i}`, ClientId: CLIENT }))
  const result = await reconcileMintsoftAmbiguousCreate(REF)
  assert.equal(result.kind, 'UNRESOLVED')
  searchRows = (searchRows as unknown[]).slice(0, 9)
  assert.equal((await reconcileMintsoftAmbiguousCreate(REF)).kind, 'ADOPT', 'control: nine rows is a complete answer')
})

test('reconcile: the order is there but CANCELLED (status 3) - never adopted', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 }]
  const result = await reconcileMintsoftAmbiguousCreate(REF)
  assert.equal(result.kind, 'UNRESOLVED')
  assert.match((result as { reason: string }).reason, /CANCELLED/)
})

// ---- the live duplicate-create answer and the cancel answers (shapes taken from a live API test; no personal data) -----------------

const INPUT = {
  orderNumber: 'WC-1001', externalReference: 'REF-1001', externalWarehouseId: '3', currency: 'GBP', email: 'a@example.com', phone: null, vatNumber: null,
  comments: null, courierService: 'DPD', totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0,
  lines: [{ sku: 'SKU-1', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' }],
  shippingAddress: { firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '', town: 'T', county: '', postCode: 'PC1', country: 'GB' },
}
const LIVE_DUPLICATE = [{ ID: 0, Success: false, OrderId: 0, OrderStatusId: 0, Message: 'Order Number already exists!' }]

test('live duplicate answer: the existing LIVE order (backordered, status 9) is bound', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 9 }]
  assert.equal((await pushMintsoftOrder(INPUT as never)).externalOrderId, '900')
})

test('live duplicate answer: a CANCELLED order keeps its number - IMS refuses to bind to it and the push fails for an operator', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 }]
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /holding it is CANCELLED in Mintsoft/)
})

test('cancel: a BACKORDERED order (status 9) is cancellable, and the answer is a fresh cancellation', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ClientId: CLIENT, OrderStatusId: 9 })
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: true, status: 'CANCELLED' })
  assert.equal(writes.filter((w) => w.method === 'CANCEL').length, 1)
})

test('cancel: an already CANCELLED order (status 3) is ALREADY_CANCELLED - distinct from a fresh cancel, and /Cancel is not called', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ClientId: CLIENT, OrderStatusId: 3 })
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: false, status: 'ALREADY_CANCELLED' })
  assert.deepEqual(writes, [])
})

test('cancel: a cancel that races an earlier one (Success:true "was already cancelled") is not reported as a fresh cancellation', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ClientId: CLIENT, OrderStatusId: 1 })
  cancelResponse = { ID: 0, Success: true, Message: 'Order: 1 was already cancelled' }
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: false, status: 'ALREADY_CANCELLED' })
})

test('cancel: any other status is still NOT_CANCELLABLE and nothing is sent', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ClientId: CLIENT, OrderStatusId: 5 })
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: false, status: 'NOT_CANCELLABLE' })
  assert.deepEqual(writes, [])
})

test('reconcile: an unconfigured tenant fails closed before any request', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  clientIdSetting = ''
  await assert.rejects(() => reconcileMintsoftAmbiguousCreate(REF))
  assert.deepEqual(calls, [])
})

// ---- merged survivor lookup: shapes from a live manual merge (B merged into C; no personal data) -------------------------------------

const MERGED = { Name: 'MergedOrder', Value: 'True' }
const survivorRow = (over: Record<string, unknown> = {}) => ({
  ID: 2001, OrderNumber: 'ORD-C+ORD-B', ExternalOrderReference: 'REF-C', ClientId: CLIENT, OrderStatusId: 9, OrderNameValues: [MERGED], ...over,
})

test('merged survivor: found from the ABSORBED number (second part) and from the absorbing number (first part)', async () => {
  reset()
  const { findMintsoftMergedSurvivor } = await push()
  searchRows = [survivorRow()]
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { externalOrderId: '2001', externalOrderNumber: 'ORD-C+ORD-B' })
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-C'), { externalOrderId: '2001', externalOrderNumber: 'ORD-C+ORD-B' })
  assert.deepEqual(writes, [])
  assert.ok(calls.every((c) => c.startsWith('/api/Order/Search')), 'only the search read')
})

test('merged survivor: refused without the MergedOrder flag, for a partial part, a foreign client, two candidates or a full page', async () => {
  reset()
  const { findMintsoftMergedSurvivor } = await push()
  searchRows = [survivorRow({ OrderNameValues: [] })]
  assert.equal(await findMintsoftMergedSurvivor('ORD-B'), null, 'no flag')
  searchRows = [survivorRow({ OrderNameValues: [{ Name: 'MergedOrder', Value: 'False' }] })]
  assert.equal(await findMintsoftMergedSurvivor('ORD-B'), null, 'flag false')
  searchRows = [survivorRow()]
  assert.equal(await findMintsoftMergedSurvivor('ORD'), null, 'a prefix of a part is not a part')
  assert.equal(await findMintsoftMergedSurvivor('ORD-B+ORD'), null)
  searchRows = [survivorRow({ ClientId: 99 })]
  assert.equal(await findMintsoftMergedSurvivor('ORD-B'), null, 'foreign client')
  searchRows = [survivorRow(), survivorRow({ ID: 2002, OrderNumber: 'ORD-X+ORD-B' })]
  assert.equal(await findMintsoftMergedSurvivor('ORD-B'), null, 'two candidates')
  searchRows = Array.from({ length: 10 }, (_, i) => survivorRow({ ID: 3000 + i, OrderNumber: i === 0 ? 'ORD-C+ORD-B' : `Z-${i}`, OrderNameValues: i === 0 ? [MERGED] : [] }))
  assert.equal(await findMintsoftMergedSurvivor('ORD-B'), null, 'a full page may be truncated')
})

test('merged parts: the number is recognised in ANY position', async () => {
  const { mergedParts } = await import('@/lib/connectors/mintsoft/api/orders')
  assert.deepEqual(mergedParts('ORD-C+ORD-B'), ['ORD-C', 'ORD-B'])
  assert.ok(mergedParts('ORD-C+ORD-B').includes('ORD-B'))
  assert.ok(mergedParts('ORD-C+ORD-B+ORD-D').includes('ORD-B'))
})
