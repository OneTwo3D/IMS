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
        return { data: { Success: true }, status: 200 }
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

test('reconcile: a FOREIGN client row rejects the read; an empty own reference adopts nothing', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: 99 }]
  await assert.rejects(() => reconcileMintsoftAmbiguousCreate(REF), /does not match configured 5/)
  searchRows = [{ ID: 555, OrderNumber: 'WC-1001', ExternalOrderReference: '', ClientId: CLIENT }]
  assert.equal((await reconcileMintsoftAmbiguousCreate({ orderNumber: 'WC-1001', externalReference: '' })).kind, 'UNRESOLVED')
})

test('reconcile: an unconfigured tenant fails closed before any request', async () => {
  reset()
  const { reconcileMintsoftAmbiguousCreate } = await push()
  clientIdSetting = ''
  await assert.rejects(() => reconcileMintsoftAmbiguousCreate(REF))
  assert.deepEqual(calls, [])
})
