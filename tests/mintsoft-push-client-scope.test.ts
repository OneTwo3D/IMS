import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushInput } from '@/lib/connectors/wms/types'

/**
 * o3d-bjc.6 — the OUTBOUND push path must not cross the shared-tenant boundary.
 *
 * Mintsoft is a shared 3PL tenant, so an unscoped `/api/Order/Search` can return
 * ANOTHER client's order. The push dedupe ("already exists" → re-find the order)
 * used to accept a single match on order number alone, binding our link to a
 * foreign order — after which our own update/cancel/comment calls would mutate
 * or disclose on someone else's order.
 *
 * These tests pin: the query is scoped, every returned row is validated, the
 * mutation gate re-proves ownership, and an unconfigured tenant fails closed
 * WITHOUT breaking an ordinary create.
 */

const CLIENT = 5

let clientIdSetting = String(CLIENT)
let searchRows: unknown = []
let details = new Map<string, unknown>()
let createResult: unknown = null
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
      mintsoft_default_courier_service_id: '',
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
      if (pathname === '/api/Order' && method === 'PUT') return { data: createResult, status: 200 }
      if (pathname === '/api/Order/Search') return { data: searchRows, status: 200 }
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
  itemRows = []
  emptyDetailIds = new Set()
  calls = []
  writes = []
}

const INPUT: WmsOrderPushInput = {
  orderNumber: 'WC-1001',
  externalReference: 'REF-1001',
  externalWarehouseId: '3',
  currency: 'GBP',
  email: 'a@example.com',
  phone: null,
  vatNumber: null,
  comments: null,
  courierService: 'DPD',
  totalVat: 0,
  shippingExVat: 0,
  shippingVat: 0,
  discountExVat: 0,
  discountVat: 0,
  lines: [{ sku: 'SKU-1', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' }],
  shippingAddress: {
    firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '',
    town: 'T', county: '', postCode: 'PC1', country: 'GB',
  },
}

/** A create that reports the order already exists → the dedupe branch runs. */
const DUPLICATE = { Success: false, Message: 'Order already exists' }

test('[o3d-bjc.6] the push dedupe search is scoped by ClientId', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = [DUPLICATE]
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]

  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '900')
  const search = calls.find((path) => path.startsWith('/api/Order/Search'))
  assert.ok(search, 'the dedupe search ran')
  assert.equal(new URLSearchParams(search.split('?')[1]).get('ClientId'), String(CLIENT))
})

test('[o3d-bjc.6] a FOREIGN row on the dedupe search rejects the push — it is never bound', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = [DUPLICATE]
  // Same order number, another client on the shared tenant. Pre-fix this single
  // match was accepted and our link bound to order 999.
  searchRows = [{ ID: 999, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: 99 }]

  await assert.rejects(() => pushMintsoftOrder(INPUT), /does not match configured 5/)
})

test('[o3d-bjc.6] a row with NO ClientId is unverifiable and rejects the push', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = [DUPLICATE]
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001' }]

  await assert.rejects(() => pushMintsoftOrder(INPUT), /has no ClientId/)
})

test('[o3d-bjc.6] a malformed dedupe search body throws instead of reading as "no match"', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = [DUPLICATE]
  searchRows = { Message: 'temporarily unavailable' }

  await assert.rejects(() => pushMintsoftOrder(INPUT), /Order\/Search \(push dedupe\): expected an array/)
})

test('[o3d-bjc.6] a create succeeds and binds only after the new order reads back under OUR ClientId', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  createResult = [{ Success: true, OrderId: 700, OrderNumber: 'WC-1001' }]
  details.set('700', { ID: 700, OrderNumber: 'WC-1001', OrderStatusId: 1, ClientId: CLIENT })

  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '700')
  const readBack = calls.find((path) => path.startsWith('/api/Order/700?'))
  assert.ok(readBack, 'the created order is read back')
  assert.equal(new URLSearchParams(readBack.split('?')[1]).get('ClientId'), String(CLIENT))
})

test('[o3d-bjc.6] a create whose order is not yet readable by id resolves BY REFERENCE (no stranded order, no duplicate)', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  // The order was created but the detail read 404s (not queryable yet). Throwing
  // here would leave the link unbound and rely on Mintsoft rejecting the duplicate
  // next sweep; instead we resolve it through the ClientId-scoped reference lookup.
  createResult = [{ Success: true, OrderId: 700, OrderNumber: 'WC-1001' }]
  searchRows = [{ ID: 700, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]

  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '700')
  assert.ok(calls.some((path) => path.startsWith('/api/Order/Search')), 'fell back to the scoped reference lookup')
  assert.equal(calls.filter((path) => path === '/api/Order').length, 1, 'the order was created exactly once')
})

test('[o3d-bjc.6] a created order invisible to BOTH lookups is still bound — never re-created', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  // Mintsoft said Success and gave us the id, but neither the scoped detail read nor
  // the reference lookup can see it yet. Throwing here would make the sweep re-PUT on
  // the next tick and duplicate a real warehouse order (or dead-letter the link while
  // a live order stays unlinked and can never be cancelled).
  createResult = [{ Success: true, OrderId: 700, OrderNumber: 'WC-1001' }]
  searchRows = []

  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '700')
  assert.equal(calls.filter((path) => path === '/api/Order').length, 1, 'created exactly once')
})

test('[o3d-bjc.6] …but a FOREIGN read-back is still fatal, never bound', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  // The distinction that makes the above safe: a ClientId MISMATCH throws out of the
  // read-back, so only "not yet visible" (404) can reach the permissive bind.
  createResult = [{ Success: true, OrderId: 999, OrderNumber: 'WC-1001' }]
  details.set('999', { ID: 999, OrderNumber: 'WC-1001', OrderStatusId: 1, ClientId: 99 })

  await assert.rejects(() => pushMintsoftOrder(INPUT), /does not match configured 5/)
})

test('[o3d-bjc.6] a link bound without a read-back can never be MUTATED without proving ownership', async () => {
  reset()
  const { pushMintsoftOrder, cancelMintsoftOrder } = await push()
  createResult = [{ Success: true, OrderId: 700, OrderNumber: 'WC-1001' }]
  searchRows = []
  const pushed = await pushMintsoftOrder(INPUT)
  assert.equal(pushed.externalOrderId, '700')

  // Had that id somehow been another client's, the mutation gate refuses it — which
  // is why the permissive bind above does not weaken the tenant boundary.
  details.set('700', { ID: 700, OrderNumber: 'WC-1001', OrderStatusId: 1, ClientId: 99 })
  await assert.rejects(() => cancelMintsoftOrder('700'), /does not match configured 5/)
  assert.deepEqual(writes, [])
})

test('[o3d-bjc.6] a create whose order reads back FOREIGN is not bound', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  // A create routed into an unintended client context: it echoes an OrderId, but
  // the order is not ours. Pre-fix the echoed id alone was enough to bind.
  createResult = [{ Success: true, OrderId: 999, OrderNumber: 'WC-1001' }]
  details.set('999', { ID: 999, OrderNumber: 'WC-1001', OrderStatusId: 1, ClientId: 99 })

  await assert.rejects(() => pushMintsoftOrder(INPUT), /does not match configured 5/)
})

test('[o3d-bjc.6] a FAILED create that merely echoes an OrderId does not bind it — it falls through to the scoped dedupe', async () => {
  reset()
  const { pushMintsoftOrder } = await push()
  // Pre-fix `ok` was true whenever OrderId was present, so this bound order 999
  // outright, before the scoped dedupe branch could ever run.
  createResult = [{ Success: false, OrderId: 999, Message: 'Order already exists' }]
  searchRows = [{ ID: 900, OrderNumber: 'WC-1001', ExternalOrderReference: 'REF-1001', ClientId: CLIENT }]

  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '900', 'bound the ClientId-verified order, not the echoed id')
  assert.ok(calls.some((path) => path.startsWith('/api/Order/Search')), 'the scoped dedupe ran')
})

test('[o3d-bjc.6] the whole push fails closed when mintsoft_client_id is unset — no order is created', async () => {
  reset()
  clientIdSetting = ''
  const { pushMintsoftOrder } = await push()
  createResult = [{ Success: true, OrderId: 700, OrderNumber: 'WC-1001' }]

  // Creating without the scope would mark the order SYNCED and then be unable to
  // amend, hold or CANCEL it — the warehouse would ship a cancelled order. Never
  // start a lifecycle we cannot finish.
  await assert.rejects(() => pushMintsoftOrder(INPUT), /requires a ClientId/)
  assert.deepEqual(calls, [], 'no request at all was issued')
})

test('[o3d-bjc.6] cancel refuses a FOREIGN order id — the mutation gate re-proves ownership', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  // A link mis-bound before the dedupe fix: the id is persisted and points at
  // another client's NEW order. The gate must refuse rather than cancel it.
  details.set('999', { ID: 999, OrderStatusId: 1, ClientId: 99 })

  await assert.rejects(() => cancelMintsoftOrder('999'), /does not match configured 5/)
  assert.deepEqual(writes, [])
})

test('[o3d-bjc.6] cancel still works for our own NEW order, and scopes the gate request', async () => {
  reset()
  const { cancelMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderStatusId: 1, ClientId: CLIENT })

  const result = await cancelMintsoftOrder('900')
  assert.deepEqual(result, { cancelled: true, status: 'CANCELLED' })
  const gate = calls.find((path) => path.startsWith('/api/Order/900?'))
  assert.ok(gate, 'the ownership gate ran')
  assert.equal(new URLSearchParams(gate.split('?')[1]).get('ClientId'), String(CLIENT))
  assert.deepEqual(writes.map((write) => write.method), ['CANCEL'])
})

test('[o3d-bjc.6] update refuses a FOREIGN order id before amending any item', async () => {
  reset()
  const { updateMintsoftOrder } = await push()
  details.set('999', { ID: 999, OrderStatusId: 1, ClientId: 99 })

  await assert.rejects(() => updateMintsoftOrder('999', INPUT), /does not match configured 5/)
  assert.deepEqual(writes, [])
})

test('[o3d-bjc.6] a comment is not posted onto a FOREIGN order', async () => {
  reset()
  const { addMintsoftOrderComment } = await push()
  details.set('999', { ID: 999, OrderStatusId: 4, ClientId: 99 })

  await assert.rejects(() => addMintsoftOrderComment('999', 'IMS could not cancel this order'), /does not match configured 5/)
  assert.deepEqual(writes, [])
})

test('[o3d-bjc.6] a comment on our own order still posts', async () => {
  reset()
  const { addMintsoftOrderComment } = await push()
  details.set('900', { ID: 900, OrderStatusId: 4, ClientId: CLIENT })

  await addMintsoftOrderComment('900', 'IMS note')
  assert.deepEqual(writes.map((write) => write.path.split('?')[0]), ['/api/Order/900/Comments'])
})

test('[o3d-bjc.6] a 2xx detail with NO readable order is NOT reported as "not found"', async () => {
  reset()
  const { cancelMintsoftOrder, addMintsoftOrderComment, updateMintsoftOrder } = await push()
  // The Mintsoft client renders a 204 as `data: null`. Reporting that as NOT_FOUND
  // would tell the push sweep the remote cancel succeeded and move the local link to
  // CANCELLED/HELD while the warehouse carries on fulfilling the order.
  emptyDetailIds.add('900')

  await assert.rejects(() => cancelMintsoftOrder('900'), /refusing to treat an unverifiable response as "not found"/)
  await assert.rejects(() => updateMintsoftOrder('900', INPUT), /unverifiable response/)
  await assert.rejects(() => addMintsoftOrderComment('900', 'IMS note'), /unverifiable response/)
  assert.deepEqual(writes, [])
})

test('[o3d-bjc.6] a genuine 404 is still an authoritative NOT_FOUND for cancel/update', async () => {
  reset()
  const { cancelMintsoftOrder, updateMintsoftOrder } = await push()
  // `details` has no entry for 900 → the mock returns a real 404.
  assert.deepEqual(await cancelMintsoftOrder('900'), { cancelled: false, status: 'NOT_FOUND' })
  assert.deepEqual(await updateMintsoftOrder('900', INPUT), { updated: false, status: 'NOT_FOUND' })
  assert.deepEqual(writes, [])
})

test('[o3d-bjc.6] an owned NEW order amends its items and posts the update — the gate precedes every write', async () => {
  reset()
  const { updateMintsoftOrder } = await push()
  details.set('900', { ID: 900, OrderNumber: 'WC-1001', OrderStatusId: 1, ClientId: CLIENT })
  // One line to update and one stale line to delete, so the whole write set runs.
  itemRows = [
    { ID: 11, SKU: 'SKU-1', Quantity: 5 },
    { ID: 12, SKU: 'SKU-GONE', Quantity: 2 },
  ]

  const result = await updateMintsoftOrder('900', INPUT)
  assert.deepEqual(result, { updated: true, status: 'NEW' })
  // The ownership gate is the FIRST call, before any mutation.
  assert.ok(calls[0].startsWith('/api/Order/900?'), `gate ran first (was ${calls[0]})`)
  assert.ok(writes.length > 0, 'item + order writes happened')
  // The items read is scoped too (its DTO carries no ClientId of its own).
  const itemsRead = calls.find((path) => path.startsWith('/api/Order/900/Items?'))
  assert.ok(itemsRead, 'the items read ran')
  assert.equal(new URLSearchParams(itemsRead.split('?')[1]).get('ClientId'), String(CLIENT))
})
