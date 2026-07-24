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
        return details.has(id) ? { data: details.get(id), status: 200 } : { data: null, status: 404 }
      }
      const itemsMatch = pathname.match(/^\/api\/Order\/([^/]+)\/Items$/)
      if (itemsMatch) return { data: [], status: 200 }
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

test('[o3d-bjc.6] an ordinary create still works on a tenant with no mintsoft_client_id (only the dedupe needs scope)', async () => {
  reset()
  clientIdSetting = ''
  const { pushMintsoftOrder } = await push()
  createResult = [{ Success: true, OrderId: 700, OrderNumber: 'WC-1001' }]

  const result = await pushMintsoftOrder(INPUT)
  assert.equal(result.externalOrderId, '700')
  assert.equal(calls.filter((path) => path.startsWith('/api/Order/Search')).length, 0)
})

test('[o3d-bjc.6] the dedupe fails closed (no search issued) when mintsoft_client_id is unset', async () => {
  reset()
  clientIdSetting = ''
  const { pushMintsoftOrder } = await push()
  createResult = [DUPLICATE]

  await assert.rejects(() => pushMintsoftOrder(INPUT), /requires a ClientId/)
  assert.equal(calls.filter((path) => path.startsWith('/api/Order/Search')).length, 0)
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
