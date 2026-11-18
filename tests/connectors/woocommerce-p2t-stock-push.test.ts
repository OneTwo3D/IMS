import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * P2 batch T, stock side. No network: wcFetch / wcPost are mocked and every database read is a fixture.
 *   - o3d-hqvrp.100: a later batch re-reads current stock, so it cannot post an older, higher figure over a lower one pushed meanwhile
 *   - o3d-hqvrp.104: variation resolution pages through every variation of a parent
 */

const ORIGIN = 'https://shop.example.com'
const settings = new Map<string, string>()
type Level = { productId: string; warehouseId: string; quantity: number; reservedQty: number }
let levels: Level[] = []
let candidates: Array<Record<string, unknown>> = []
let posts: Array<{ path: string; body: unknown }> = []
let onPost: (n: number) => void = () => undefined
let fetches: Array<{ path: string; params: Record<string, string> }> = []
let variationPages: Record<string, unknown[]> = {}

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async (args?: Record<string, unknown> & { where?: { key?: string } }) => {
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (name === 'warehouse' && method === 'findMany') return [{ id: 'w1' }]
      if (name === 'stockLevel' && method === 'findMany') return levels
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
mock.module('@/lib/connectors/woocommerce/producer-seam', {
  namedExports: { wooProducerSeam: async () => ({ proceed: true }) },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string>) => {
      fetches.push({ path, params })
      if (path === '/orders') return { data: [], totalItems: 0, totalItemsPresent: true }
      const variations = /^\/products\/(\d+)\/variations$/.exec(path)
      if (variations && !params.include) return { data: variationPages[`${variations[1]}:${params.page ?? '1'}`] ?? [] }
      if (variations && params.include) {
        return { data: Object.values(variationPages).flat().filter((v) => params.include.split(',').includes(String((v as { id: number }).id))) }
      }
      if (params.sku) return { data: params.sku === 'PAR' ? [{ id: 50, sku: 'PAR' }] : [] }
      if (params.include) return { data: params.include.split(',').map((id) => ({ id: Number(id), sku: `S${id}` })) }
      return { data: [] }
    },
    wcPost: async (path: string, body: unknown) => {
      posts.push({ path, body })
      onPost(posts.length)
      const update = (body as { update?: Array<{ id: number; stock_quantity: number }> }).update ?? []
      return { data: { update: update.map((u) => ({ id: u.id, stock_quantity: u.stock_quantity })) } }
    },
  },
})

const product = (id: string, sku: string, externalProductId: bigint | null, extra: Record<string, unknown> = {}) => ({
  id, sku, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', externalProductId, parent: null, productComponents: [], ...extra,
})

function reset() {
  settings.clear()
  for (const [key, value] of Object.entries({ wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_stock_sync_enabled: 'true', last_wc_order_sync_at: '2026-11-15T00:00:00.000Z' })) settings.set(key, value)
  levels = []
  candidates = []
  posts = []
  fetches = []
  variationPages = {}
  onPost = () => undefined
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
const updates = () => posts.flatMap((p) => (p.body as { update?: Array<Record<string, unknown>> }).update ?? [])

test('a later batch posts the CURRENT stock, not the figure read before the earlier batches (o3d-hqvrp.100)', async () => {
  reset()
  // 101 products: batch 1 holds 100, batch 2 holds the last one (ids sort lexically: p000..p100).
  const ids = Array.from({ length: 101 }, (_, i) => `p${String(i).padStart(3, '0')}`)
  candidates = ids.map((id, i) => product(id, `S${i + 1}`, BigInt(i + 1)))
  levels = ids.map((id) => ({ productId: id, warehouseId: 'w1', quantity: 10, reservedQty: 0 }))
  // While batch 1 is on the wire, an order takes 7 of the last product (a per-product job pushes 3).
  onPost = (n) => {
    if (n === 1) levels = levels.map((l) => (l.productId === 'p100' ? { ...l, quantity: 3 } : l))
  }
  await run()
  const last = updates().find((u) => u.id === 101)
  assert.ok(last, 'the last product was pushed')
  assert.equal(last.stock_quantity, 3, 'the stale 10 must not be written over the lower current figure')
})

test('the stock-push lock runs critical sections one at a time, in arrival order (o3d-hqvrp.100)', async () => {
  const { withStockPushLock } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const order: string[] = []
  const slow = withStockPushLock(async () => {
    order.push('a:start')
    await new Promise((r) => setTimeout(r, 20))
    order.push('a:end')
  })
  const fast = withStockPushLock(async () => { order.push('b:start'); order.push('b:end') })
  const failing = withStockPushLock(async () => { order.push('c:throws'); throw new Error('boom') }).catch(() => undefined)
  const after = withStockPushLock(async () => { order.push('d') })
  await Promise.all([slow, fast, failing, after])
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:throws', 'd'])
})

test('variation resolution reads every page of a parent with more than 100 variations (o3d-hqvrp.104)', async () => {
  reset()
  candidates = [
    product('v1', 'V-LAST', null, { type: 'VARIANT', parent: { sku: 'PAR', externalProductId: BigInt(50) } }),
  ]
  levels = [{ productId: 'v1', warehouseId: 'w1', quantity: 5, reservedQty: 0 }]
  variationPages = {
    '50:1': Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, sku: `OTHER-${i}` })),
    '50:2': [{ id: 2000, sku: 'V-LAST' }],
  }
  await run()
  const pagesRead = fetches.filter((f) => f.path === '/products/50/variations' && !f.params.include).map((f) => f.params.page)
  assert.ok(pagesRead.includes('2'), `page 2 must be read, read pages: ${pagesRead.join(',')}`)
  const variationPush = posts.find((p) => p.path.startsWith('/products/50/variations'))
  assert.ok(variationPush, 'the variation beyond page 1 received its stock')
  assert.equal((variationPush.body as { update: Array<{ id: number }> }).update[0].id, 2000)
})
