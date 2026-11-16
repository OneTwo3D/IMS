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
type Level = { productId: string; warehouseId: string; quantity: number; reservedQty: number }
let levels: Level[] = []
/** Rows of location_stock_buffers (independent of stock rows). */
let bufferRows: Array<{ productId: string; warehouseId: string; bufferQty: number }> = []
let bufferReads = 0
let candidates: Array<Record<string, unknown>> = []
let posts: Array<{ path: string; body: unknown }> = []

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async (args?: { where?: { key?: string }; select?: Record<string, boolean> }) => {
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (name === 'warehouse' && method === 'findMany') return [{ id: 'w1' }, { id: 'w2' }]
      if (name === 'locationStockBuffer' && method === 'findMany') {
        bufferReads += 1
        return bufferRows.filter((b) => b.bufferQty > 0)
      }
      if (name === 'stockLevel' && method === 'findMany') {
        return levels.map((l) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservedQty: l.reservedQty }))
      }
      if (name === 'product' && method === 'findMany') {
        // Like the real query: an unscoped run only selects products that have a stock row (or KITs).
        const ids = (args as { where?: { OR?: Array<{ id?: { in?: string[] } }> } } | undefined)?.where?.OR?.[0]?.id?.in
        return Array.isArray(ids) ? candidates.filter((c) => ids.includes(c.id as string)) : candidates
      }
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

function reset(list: Level[], buffers: Array<{ productId: string; warehouseId: string; bufferQty: number }> = []) {
  settings.clear()
  for (const [key, value] of Object.entries({ wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_stock_sync_enabled: 'true', last_wc_order_sync_at: '2026-11-15T00:00:00.000Z' })) settings.set(key, value)
  levels = list
  bufferRows = buffers
  bufferReads = 0
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

const L = (productId: string, warehouseId: string, quantity: number, reservedQty = 0): Level => ({ productId, warehouseId, quantity, reservedQty })
const B = (productId: string, warehouseId: string, bufferQty: number) => ({ productId, warehouseId, bufferQty })

test('a buffer reduces the pushed quantity; the floor is 0', async () => {
  reset([L('a', 'w1', 10, 2), L('b', 'w1', 4)], [B('a', 'w1', 3), B('b', 'w1', 9)]) // a: 8-3 = 5; b: buffer exceeds available -> 0
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.ok(bufferReads > 0, 'the sync reads the buffer table')
  assert.deepEqual(quantities(), { 1: 5, 2: 0 })
})

test('the buffer is per location: it comes off its own warehouse, then the locations are summed', async () => {
  reset(
    [L('a', 'w1', 10), L('a', 'w2', 5), L('b', 'w1', 1), L('b', 'w2', 7)],
    [B('a', 'w1', 4), B('b', 'w1', 5)], // a: 6 + 5; b: 0 (not -4 against the other warehouse) + 7
  )
  await run()
  assert.deepEqual(quantities(), { 1: 11, 2: 7 })
})

test('a buffer at a warehouse with NO stock row has no effect and does not make the product a candidate', async () => {
  // b has a buffer at w1 but no stock row anywhere: nothing to buffer, nothing pushed for it. a is unaffected by b's buffer.
  reset([L('a', 'w1', 10)], [B('b', 'w1', 5), B('a', 'w2', 7)])
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(quantities(), { 1: 10 }, 'only the stocked product is pushed; the buffer-only product is not a candidate and a buffer at a stockless warehouse changes nothing')
})

test('BYTE-IDENTITY: with no buffer rows, or only zero rows, the posted payloads are identical', async () => {
  const base: Level[] = [L('a', 'w1', 10, 2), L('a', 'w2', 3, 5), L('b', 'w1', 4)]
  reset(base.map((l) => ({ ...l })), [])
  await run()
  const before = JSON.stringify(posts)
  assert.ok(posts.length > 0 && before.includes('stock_quantity'))

  reset(base.map((l) => ({ ...l })), [B('a', 'w1', 0), B('b', 'w1', 0)])
  await run()
  assert.equal(JSON.stringify(posts), before)
})

test('the unreserved-order guard is untouched by the buffer when every buffer is 0, and the buffer comes off before it', async () => {
  const { buildStockMaps, bufferKey } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const held = new Map([['a', 3]])
  const rows = [{ productId: 'a', warehouseId: 'w1', quantity: 10, reservedQty: 0 }]
  const plain = buildStockMaps(rows, held)
  const zero = buildStockMaps(rows, held, new Map())
  assert.deepEqual([...zero.stockByProduct], [...plain.stockByProduct])
  assert.equal(plain.stockByProduct.get('a'), 7)
  const buffered = buildStockMaps(rows, held, new Map([[bufferKey('a', 'w1'), 2]]))
  assert.equal(buffered.stockByProduct.get('a'), 5) // 10 - 2 shown to the store, minus the 3 it already took
})
