import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * LOCATION BUFFER, END TO END THROUGH pushStockToWc (no network: wcFetch / wcPost are mocked).
 *   - a buffer reduces the quantity WooCommerce is sent, floored at 0
 *   - with every buffer 0 (or the column absent from the row, i.e. today's shape) the POSTED PAYLOAD IS BYTE-IDENTICAL to the
 *     payload without any buffer support
 *   - the unreserved-order guard still comes out of what the store was shown
 */

const ORIGIN = 'https://shop.example.com'
const settings = new Map<string, string>()
type Level = { productId: string; warehouseId: string; quantity: number; reservedQty: number; bufferQty?: number }
let levels: Level[] = []
let candidates: Array<Record<string, unknown>> = []
let posts: Array<{ path: string; body: unknown }> = []
/** When false the fake DB returns rows WITHOUT a bufferQty key: the exact shape the code read before this feature. */
let returnBufferColumn = true
let selectedBuffer = false

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async (args?: { where?: { key?: string }; select?: Record<string, boolean> }) => {
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (name === 'warehouse' && method === 'findMany') return [{ id: 'w1' }, { id: 'w2' }]
      if (name === 'stockLevel' && method === 'findMany') {
        if (args?.select?.bufferQty) selectedBuffer = true
        return levels.map((l) => {
          const row: Record<string, unknown> = { productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservedQty: l.reservedQty }
          if (returnBufferColumn && args?.select?.bufferQty) row.bufferQty = l.bufferQty ?? 0
          return row
        })
      }
      if (name === 'product' && method === 'findMany') return candidates
      if (name === 'product' && method === 'updateMany') return { count: 1 }
      if (name === 'product' && method === 'findUnique') {
        const found = candidates.find((p) => p.id === (args as { where?: { id?: string } } | undefined)?.where?.id)
        return found ? { externalProductId: found.externalProductId } : null
      }
      if (method === 'findMany') return []
      return null
    },
  })
}
const fakeDb: object = new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string>) => {
      if (path === '/orders') return { data: [], totalItems: 0, totalItemsPresent: true }
      if (params.include) return { data: params.include.split(',').map((id) => ({ id: Number(id), sku: `S${id}` })) }
      return { data: [] }
    },
    wcPost: async (path: string, body: unknown) => {
      posts.push({ path, body })
      const update = (body as { update?: Array<{ id: number; stock_quantity: number }> }).update ?? []
      return { data: { update: update.map((u) => ({ id: u.id, stock_quantity: u.stock_quantity })) } }
    },
  },
})

const product = (id: string, sku: string, externalProductId: bigint) => ({
  id, sku, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', externalProductId, parent: null, productComponents: [],
})

function reset(list: Level[], withBufferColumn = true) {
  settings.clear()
  for (const [key, value] of Object.entries({ wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_stock_sync_enabled: 'true', last_wc_order_sync_at: '2026-11-15T00:00:00.000Z' })) settings.set(key, value)
  levels = list
  returnBufferColumn = withBufferColumn
  selectedBuffer = false
  posts = []
  candidates = [product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))]
}

async function run() {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const saved = process.env[OUTBOUND_GRANT_ENV.woocommerce]
  process.env[OUTBOUND_GRANT_ENV.woocommerce] = ORIGIN
  try {
    return await pushStockToWc({ forceAll: true })
  } finally {
    if (saved === undefined) delete process.env[OUTBOUND_GRANT_ENV.woocommerce]
    else process.env[OUTBOUND_GRANT_ENV.woocommerce] = saved
  }
}

const quantities = () => {
  const out: Record<string, number> = {}
  for (const p of posts) for (const u of (p.body as { update?: Array<{ id: number; stock_quantity: number }> }).update ?? []) out[String(u.id)] = u.stock_quantity
  return out
}

test('a buffer reduces the pushed quantity; the floor is 0; IMS figures are not what is sent', async () => {
  reset([
    { productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 2, bufferQty: 3 }, // available 8, buffer 3 -> 5
    { productId: 'b', warehouseId: 'w1', quantity: 4, reservedQty: 0, bufferQty: 9 },  // buffer exceeds available -> 0
  ])
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.equal(selectedBuffer, true, 'the sync reads bufferQty')
  assert.deepEqual(quantities(), { 1: 5, 2: 0 })
})

test('the buffer is per location: it comes off its own warehouse, then the locations are summed', async () => {
  reset([
    { productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 0, bufferQty: 4 }, // 6
    { productId: 'a', warehouseId: 'w2', quantity: 5, reservedQty: 0, bufferQty: 0 },  // 5
    { productId: 'b', warehouseId: 'w1', quantity: 1, reservedQty: 0, bufferQty: 5 },  // 0 (not -4 against the other warehouse)
    { productId: 'b', warehouseId: 'w2', quantity: 7, reservedQty: 0, bufferQty: 0 },  // 7
  ])
  await run()
  assert.deepEqual(quantities(), { 1: 11, 2: 7 })
})

test('BYTE-IDENTITY: with every buffer 0 the posted payloads equal the payloads of rows that carry no buffer at all', async () => {
  const base: Level[] = [
    { productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 2 },
    { productId: 'a', warehouseId: 'w2', quantity: 3, reservedQty: 5 },
    { productId: 'b', warehouseId: 'w1', quantity: 4, reservedQty: 0 },
  ]
  reset(base.map((l) => ({ ...l })), false) // today's row shape: no bufferQty key at all
  await run()
  const before = JSON.stringify(posts)
  assert.ok(posts.length > 0 && before.includes('stock_quantity'))

  reset(base.map((l) => ({ ...l, bufferQty: 0 })), true)
  await run()
  assert.equal(JSON.stringify(posts), before)
})

test('the unreserved-order guard is untouched by the buffer when every buffer is 0, and the buffer never goes negative', async () => {
  const { buildStockMaps } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const held = new Map([['a', 3]])
  const plain = buildStockMaps([{ productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 0 }], held)
  const zero = buildStockMaps([{ productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 0, bufferQty: 0 }], held)
  assert.deepEqual([...zero.stockByProduct], [...plain.stockByProduct])
  assert.equal(plain.stockByProduct.get('a'), 7)
  const buffered = buildStockMaps([{ productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 0, bufferQty: 2 }], held)
  assert.equal(buffered.stockByProduct.get('a'), 5) // 10 - 2 shown to the store, minus the 3 it already took
})
