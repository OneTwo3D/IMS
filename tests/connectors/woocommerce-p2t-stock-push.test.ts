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
let failVariationPage: string | null = null
let failStockReadsAfterFirstPost = false
let etaDates = new Map<string, string>()

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async (args?: Record<string, unknown> & { where?: { key?: string } }) => {
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (name === 'warehouse' && method === 'findMany') return [{ id: 'w1' }]
      if (name === 'stockLevel' && method === 'findMany') {
        if (failStockReadsAfterFirstPost && posts.length >= 1) throw new Error('connection reset')
        return levels
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
mock.module('@/lib/domain/inventory/back-in-stock-date', {
  namedExports: { loadBackInStockDates: async (ids: string[]) => new Map(ids.filter((id) => etaDates.has(id)).map((id) => [id, etaDates.get(id) as string])) },
})
mock.module('@/lib/connectors/woocommerce/producer-seam', {
  namedExports: { wooProducerSeam: async () => ({ proceed: true }) },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string>) => {
      fetches.push({ path, params })
      if (path === '/orders') return { data: [], totalItems: 0, totalItemsPresent: true }
      const variations = /^\/products\/(\d+)\/variations$/.exec(path)
      if (variations && !params.include) {
        if (failVariationPage === (params.page ?? '1')) return { data: null, error: 'WC API error: 502' }
        return { data: variationPages[`${variations[1]}:${params.page ?? '1'}`] ?? [] }
      }
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
  failVariationPage = null
  failStockReadsAfterFirstPost = false
  etaDates = new Map()
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

const variant = (id: string, sku: string) => product(id, sku, null, { type: 'VARIANT', parent: { sku: 'PAR', externalProductId: BigInt(50) } })
const fullPage = (page: number) => Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, sku: `OTHER-${page}-${i}` }))
const listReads = () => fetches.filter((f) => f.path === '/products/50/variations' && !f.params.include)

test('a parent over the 2,000-variation cap is skipped and reported, not a window error (o3d-hqvrp.104)', async () => {
  reset()
  candidates = [variant('v1', 'V1'), product('s1', 'SIMPLE-1', BigInt(9))]
  levels = [
    { productId: 'v1', warehouseId: 'w1', quantity: 5, reservedQty: 0 },
    { productId: 's1', warehouseId: 'w1', quantity: 5, reservedQty: 0 },
  ]
  for (let page = 1; page <= 20; page++) variationPages[`50:${page}`] = fullPage(page)
  const result = await run()
  assert.deepEqual(result.errors, [], 'no error: the reconcile window must be able to advance')
  assert.equal(result.skippedParents?.length, 1)
  assert.match(result.skippedParents?.[0] ?? '', /PAR/)
  assert.equal(result.unmatched, 0, 'the skipped variant is not counted unmatched either')
  assert.ok(updates().some((u) => u.id === 9), 'other products still pushed')
  assert.equal(updates().some((u) => u.id === 2000), false)
})

test('a variation page that keeps failing skips the parent for the pass, without a window error (o3d-hqvrp.104)', async () => {
  reset()
  candidates = [variant('v1', 'V1'), product('s1', 'SIMPLE-1', BigInt(9))]
  levels = [
    { productId: 'v1', warehouseId: 'w1', quantity: 5, reservedQty: 0 },
    { productId: 's1', warehouseId: 'w1', quantity: 5, reservedQty: 0 },
  ]
  failVariationPage = '1'
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.equal(result.skippedParents?.length, 1)
  assert.ok(updates().some((u) => u.id === 9))
})

test('a parent\'s variation list is read once per parent, not once per 100-variant batch (o3d-hqvrp.104)', async () => {
  reset()
  const ids = Array.from({ length: 101 }, (_, i) => `v${String(i).padStart(3, '0')}`)
  candidates = ids.map((id, i) => variant(id, `V${i}`))
  levels = ids.map((id) => ({ productId: id, warehouseId: 'w1', quantity: 5, reservedQty: 0 }))
  variationPages = {
    '50:1': Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, sku: `V${i}` })),
    '50:2': [{ id: 2000, sku: 'V100' }],
  }
  await run()
  assert.equal(listReads().filter((f) => f.params.page === '1').length, 1, 'page 1 is read once for two batches')
  assert.equal(listReads().filter((f) => f.params.page === '2').length, 1)
  assert.equal(updates().filter((u) => u.id >= 1000).length, 101, 'all 101 variants resolved and pushed')
})

test('a database error while re-reading stock for a batch sends it unclamped and does not abort the run (o3d-hqvrp.100)', async () => {
  reset()
  const ids = Array.from({ length: 101 }, (_, i) => `p${String(i).padStart(3, '0')}`)
  candidates = ids.map((id, i) => product(id, `S${i + 1}`, BigInt(i + 1)))
  levels = ids.map((id) => ({ productId: id, warehouseId: 'w1', quantity: 10, reservedQty: 0 }))
  failStockReadsAfterFirstPost = true
  const result = await run()
  const last = updates().find((u) => u.id === 101)
  assert.ok(last, 'the second batch was still sent')
  assert.equal(last.stock_quantity, 10, 'unclamped: the figure computed before the batch loop')
  assert.equal(result.errors.some((e) => /connection reset/.test(e)), false)
})

test('a clamp to 0 recomputes the back-in-stock date meta like the normal path (o3d-hqvrp.100)', async () => {
  reset()
  settings.set('wc_back_in_stock_date_enabled', 'true')
  const ids = Array.from({ length: 101 }, (_, i) => `p${String(i).padStart(3, '0')}`)
  candidates = ids.map((id, i) => product(id, `S${i + 1}`, BigInt(i + 1)))
  levels = ids.map((id) => ({ productId: id, warehouseId: 'w1', quantity: 10, reservedQty: 0 }))
  etaDates = new Map([['p100', '2026-12-01']])
  // Batch 1 is on the wire when the last product sells out.
  onPost = (n) => {
    if (n === 1) levels = levels.map((l) => (l.productId === 'p100' ? { ...l, quantity: 0 } : l))
  }
  await run()
  const last = updates().find((u) => u.id === 101)
  assert.ok(last)
  assert.equal(last.stock_quantity, 0)
  assert.deepEqual(last.meta_data, [{ key: '_oti_eta_date', value: '2026-12-01' }], 'clamped to 0 now carries its committed supply date')
  const other = updates().find((u) => u.id === 1)
  assert.equal(other?.meta_data, undefined, 'a product that stays in stock carries no date')
})
