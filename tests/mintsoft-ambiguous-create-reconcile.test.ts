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
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  assert.deepEqual(await reconcileMintsoftAmbiguousCreate(REF), { kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'WC-1001' })
  assert.equal(calls.length, 2, 'the search, then the read-back of the matched order')
  assert.ok(calls[1].startsWith('/api/Order/555?'))
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
  // The read-back WOULD pass for the exact row, so it is the two-match rule that refuses.
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  assert.equal((await reconcileMintsoftAmbiguousCreate(REF)).kind, 'UNRESOLVED')
})

test('reconcile: a single row that is not EXACT (right reference, another number) is not adopted even if its detail looks right', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'OTHER-1', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
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
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
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
  details.set('600', { ID: 600, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  assert.equal((await reconcileMintsoftAmbiguousCreate(REF)).kind, 'UNRESOLVED', 'even when the read-back would pass, a full page is never adopted')
  searchRows = (searchRows as unknown[]).slice(0, 9)
  details.set('600', { ID: 600, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  assert.equal((await reconcileMintsoftAmbiguousCreate(REF)).kind, 'ADOPT', 'control: nine rows is a complete answer')
})

test('reconcile: the order is there but CANCELLED (status 3) - never adopted', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 }]
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 })
  const result = await reconcileMintsoftAmbiguousCreate(REF)
  assert.equal(result.kind, 'UNRESOLVED')
  assert.match((result as { reason: string }).reason, /CANCELLED/)
})

test('reconcile: a search row with NO status is not trusted - the read-back says CANCELLED, so it is not adopted', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: null }]
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 })
  const result = await reconcileMintsoftAmbiguousCreate(REF)
  assert.equal(result.kind, 'UNRESOLVED')
  assert.match((result as { reason: string }).reason, /CANCELLED/)
})

test('reconcile: if the read-back fails, has no status, or is not ours, nothing is adopted', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  // 404: nothing to read back
  assert.match(((await reconcileMintsoftAmbiguousCreate(REF)) as { reason: string }).reason, /could not be read back/)
  // no status on the detail either
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT })
  assert.match(((await reconcileMintsoftAmbiguousCreate(REF)) as { reason: string }).reason, /status could not be read/)
  // another client / another id
  details.set('555', { ID: 555, ClientId: 99, OrderStatusId: 1 })
  assert.match(((await reconcileMintsoftAmbiguousCreate(REF)) as { reason: string }).reason, /did not confirm it is ours/)
  details.set('555', { ID: 556, ClientId: CLIENT, OrderStatusId: 1 })
  assert.match(((await reconcileMintsoftAmbiguousCreate(REF)) as { reason: string }).reason, /did not confirm it is ours/)
})

test('verify: an order that is already CANCELLED is never proved ours (the link must not go SYNCED against a dead order)', async () => {
  reset()
  const { verifyMintsoftPushedOrder } = await push()
  const ref = { orderNumber: 'WC-1001', externalReference: 'REF-1001' }
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 })
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 }]
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'unknown')
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 9 })
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'ours', 'control: a live (backordered) order still verifies')
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
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 9 })
  assert.equal((await pushMintsoftOrder(INPUT as never)).externalOrderId, '900')
})

test('live duplicate answer: a CANCELLED order keeps its number - IMS refuses to bind to it and the push fails for an operator', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 }]
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /holding it is CANCELLED in Mintsoft/)
})

test('live duplicate answer: a search row with NO status is not trusted - the read-back says CANCELLED, so IMS does not bind', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: null }]
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /CANCELLED in Mintsoft/)
})

test('live duplicate answer: no read-back, or a read-back with no status, is not a live order - IMS does not bind', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /could not be confirmed live/)
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /could not be confirmed live/)
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  assert.equal((await pushMintsoftOrder(INPUT as never)).externalOrderId, '900', 'control: a live order binds')
})

test('cancel: a BACKORDERED order (status 9) is cancellable, and the answer is a fresh cancellation', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 9 })
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: true, status: 'CANCELLED' })
  assert.equal(writes.filter((w) => w.method === 'CANCEL').length, 1)
})

test('cancel: an already CANCELLED order (status 3) is ALREADY_CANCELLED - distinct from a fresh cancel, and /Cancel is not called', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 })
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: false, status: 'ALREADY_CANCELLED' })
  assert.deepEqual(writes, [])
})

test('cancel: a cancel that races an earlier one (Success:true "was already cancelled") is not reported as a fresh cancellation', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  cancelResponse = { ID: 0, Success: true, Message: 'Order: 1 was already cancelled' }
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: false, status: 'ALREADY_CANCELLED' })
})

test('cancel: any other status is still NOT_CANCELLABLE and nothing is sent', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 5 })
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
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { kind: 'FOUND', externalOrderId: '2001', externalOrderNumber: 'ORD-C+ORD-B' })
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-C'), { kind: 'FOUND', externalOrderId: '2001', externalOrderNumber: 'ORD-C+ORD-B' })
  assert.deepEqual(writes, [])
  assert.ok(calls.every((c) => c.startsWith('/api/Order/Search')), 'only the search read')
})

test('merged survivor: ABSENT only when the search conclusively holds no such order (no flag, a partial part, a foreign client)', async () => {
  reset()
  const { findMintsoftMergedSurvivor } = await push()
  searchRows = [survivorRow({ OrderNameValues: [] })]
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { kind: 'ABSENT' }, 'no flag')
  searchRows = [survivorRow({ OrderNameValues: [{ Name: 'MergedOrder', Value: 'False' }] })]
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { kind: 'ABSENT' }, 'flag false')
  searchRows = [survivorRow()]
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD'), { kind: 'ABSENT' }, 'a prefix of a part is not a part')
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B+ORD'), { kind: 'ABSENT' })
  searchRows = [survivorRow({ ClientId: 99 })]
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { kind: 'ABSENT' }, 'foreign client')
  searchRows = []
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { kind: 'ABSENT' }, 'nothing at all')
})

test('merged survivor: two candidates or a FULL page cannot be told apart from a survivor - INCONCLUSIVE, never ABSENT', async () => {
  reset()
  const { findMintsoftMergedSurvivor } = await push()
  searchRows = [survivorRow(), survivorRow({ ID: 2002, OrderNumber: 'ORD-X+ORD-B' })]
  const several = await findMintsoftMergedSurvivor('ORD-B')
  assert.equal(several.kind, 'INCONCLUSIVE')
  searchRows = Array.from({ length: 10 }, (_, i) => survivorRow({ ID: 3000 + i, OrderNumber: i === 0 ? 'ORD-C+ORD-B' : `Z-${i}`, OrderNameValues: i === 0 ? [MERGED] : [] }))
  const full = await findMintsoftMergedSurvivor('ORD-B')
  assert.equal(full.kind, 'INCONCLUSIVE')
  assert.match((full as { reason: string }).reason, /full page/)
})

test('merged parts: the number is recognised in ANY position', async () => {
  const { mergedParts } = await import('@/lib/connectors/mintsoft/api/orders')
  assert.deepEqual(mergedParts('ORD-C+ORD-B'), ['ORD-C', 'ORD-B'])
  assert.ok(mergedParts('ORD-C+ORD-B').includes('ORD-B'))
  assert.ok(mergedParts('ORD-C+ORD-B+ORD-D').includes('ORD-B'))
})

test('R8: a REUSED ExternalOrderReference under a DIFFERENT OrderNumber is somebody else\'s order - the duplicate path does not bind it', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = [{ ID: 900, OrderNumber: 'OTHER-77', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 }]
  details.set('900', { ID: 900, OrderNumber: 'OTHER-77', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /already exists/)
})

test('R8: a reused number under a different reference, a row missing either field, or a full page leaves the duplicate unresolved', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  for (const row of [
    { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-OTHER', ClientId: CLIENT, OrderStatusId: 1 },
    { ID: 900, OrderNumber: 'WC-1001', ClientId: CLIENT, OrderStatusId: 1 },
  ]) {
    searchRows = [row]
    details.set('900', row)
    await assert.rejects(() => pushMintsoftOrder(INPUT as never), /already exists|could not be confirmed|Mintsoft order push failed/)
  }
  searchRows = Array.from({ length: 10 }, (_, i) => ({ ID: 900 + i, OrderNumber: i === 0 ? 'WC-1001' : `Z-${i}`, ExternalOrderReference: i === 0 ? 'REF-1001' : `R-${i}`, ClientId: CLIENT, OrderStatusId: 1 }))
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /already exists|Mintsoft order push failed/, 'a full page may have cut the real order off')
})

test('R8: the read-back itself checks identity - a detail row with another number or reference (or none) is not adopted by the reconcile', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  for (const detail of [
    { ID: 555, OrderNumber: 'OTHER-1', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 },
    { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-OTHER', ClientId: CLIENT, OrderStatusId: 1 },
    { ID: 555, OrderNumber: 'WC-1001', ClientId: CLIENT, OrderStatusId: 1 },
  ]) {
    details.set('555', detail)
    const result = await reconcileMintsoftAmbiguousCreate(REF)
    assert.equal(result.kind, 'UNRESOLVED')
    assert.match((result as { reason: string }).reason, /own number and reference/)
  }
})

test('R9: a matching detail row with NO OrderStatusId is never proved ours (it must not reach SYNCED)', async () => {
  reset()
  const { verifyMintsoftPushedOrder } = await push()
  const ref = { orderNumber: 'WC-1001', externalReference: 'REF-1001' }
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT })
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'unknown', 'by id and by reference, a missing status proves nothing')
  details.set('555', { ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'ours', 'control: a present, live status verifies')
})

test('R10: a result whose number is a merge containing ours but which has no ClientId or no order name/values is INCONCLUSIVE, not ABSENT', async () => {
  reset()
  const { findMintsoftMergedSurvivor } = await push()
  const noClient = survivorRow()
  delete (noClient as Record<string, unknown>).ClientId
  searchRows = [noClient]
  assert.equal((await findMintsoftMergedSurvivor('ORD-B')).kind, 'INCONCLUSIVE')
  const noValues = survivorRow()
  delete (noValues as Record<string, unknown>).OrderNameValues
  searchRows = [noValues]
  assert.equal((await findMintsoftMergedSurvivor('ORD-B')).kind, 'INCONCLUSIVE')
  // Conclusive rule-outs stay ABSENT: another client's row, a flag that is present and false, a number that is not a merge containing ours.
  searchRows = [survivorRow({ ClientId: 99 }), survivorRow({ ID: 2, OrderNumber: 'Z-1+Z-2' }), survivorRow({ ID: 3, OrderNameValues: [{ Name: 'MergedOrder', Value: 'False' }] })]
  assert.deepEqual(await findMintsoftMergedSurvivor('ORD-B'), { kind: 'ABSENT' })
})

test('R10b: the duplicate path selects ONLY the row that carries both fields exactly, among look-alikes; two exact rows are ambiguous', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  const exact = { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 }
  searchRows = [
    { ID: 901, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-OTHER', ClientId: CLIENT, OrderStatusId: 1 },
    { ID: 902, OrderNumber: 'OTHER-1', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 },
    exact,
  ]
  details.set('900', exact)
  assert.equal((await pushMintsoftOrder(INPUT as never)).externalOrderId, '900', 'number-only and reference-only look-alikes are not candidates')
  searchRows = [exact, { ...exact, ID: 903 }]
  details.set('903', { ...exact, ID: 903 })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /already exists|Mintsoft order push failed/, 'two exact rows cannot be told apart')
})

test('R10b: a full page leaves the duplicate unresolved even when the read-back would pass', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = LIVE_DUPLICATE
  searchRows = Array.from({ length: 10 }, (_, i) => ({ ID: 900 + i, OrderNumber: i === 0 ? 'WC-1001' : `Z-${i}`, ExternalOrderReference: i === 0 ? 'REF-1001' : `R-${i}`, ClientId: CLIENT, OrderStatusId: 1 }))
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 })
  await assert.rejects(() => pushMintsoftOrder(INPUT as never), /already exists|Mintsoft order push failed/)
})

test('R10b: a flagged merged survivor with no readable id is INCONCLUSIVE, not ABSENT', async () => {
  reset()
  const { findMintsoftMergedSurvivor } = await push()
  const row = survivorRow()
  delete (row as Record<string, unknown>).ID
  searchRows = [row]
  assert.equal((await findMintsoftMergedSurvivor('ORD-B')).kind, 'INCONCLUSIVE')
})

test('R10b: verify by REFERENCE (the by-id read failed) never proves a cancelled or status-less order ours', async () => {
  reset()
  const { verifyMintsoftPushedOrder } = await push()
  const ref = { orderNumber: 'WC-1001', externalReference: 'REF-1001' }
  // no detail row: the by-id route yields nothing, so only the search can speak
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 3 }]
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'unknown')
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'unknown')
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT, OrderStatusId: 1 }]
  assert.equal(await verifyMintsoftPushedOrder('555', ref), 'ours', 'control')
})
