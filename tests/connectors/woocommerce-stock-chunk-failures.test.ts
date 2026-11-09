import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * A chunked stock window is "handled" (its result carries `chunk`) only when EVERY candidate in it reached a completed outcome.
 * A partial failure at any of the three read/push stages (SKU lookup, preflight page, batch push), or an item the store dropped
 * from its response, must leave the window pending: no `chunk`, so the reconcile advances no cursor and writes no stamp.
 */

const ORIGIN = 'https://shop.example.com'
const settings = new Map<string, string>()
let candidates: Array<Record<string, unknown>> = []

type Fetch = (path: string, params: Record<string, string>) => { data: unknown; error?: string }
type Post = (path: string, body: unknown) => { data: unknown; error?: string }
let fetchImpl: Fetch = () => ({ data: [] })
let postImpl: Post = () => ({ data: { update: [] } })

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async (args?: { where?: { key?: string } }) => {
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (name === 'warehouse' && method === 'findMany') return [{ id: 'w1' }]
      if (name === 'stockLevel' && method === 'findMany') {
        return candidates.map((p) => ({ productId: p.id, warehouseId: 'w1', quantity: 5, reservedQty: 0 }))
      }
      if (name === 'product' && method === 'findMany') return candidates
      if (name === 'product' && method === 'updateMany') return { count: 1 }
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
    wcFetch: async (path: string, params: Record<string, string>) => fetchImpl(path, params),
    wcPost: async (path: string, body: unknown) => postImpl(path, body),
  },
})

const product = (id: string, sku: string, externalProductId: bigint | null) => ({
  id, sku, type: 'SIMPLE', lifecycleStatus: 'ACTIVE', externalProductId, parent: null, productComponents: [],
})

function reset(list: Array<Record<string, unknown>>) {
  settings.clear()
  for (const [key, value] of Object.entries({ wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_stock_sync_enabled: 'true' })) settings.set(key, value)
  candidates = list
  fetchImpl = () => ({ data: [] })
  postImpl = () => ({ data: { update: [] } })
}

async function run() {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const saved = process.env[OUTBOUND_GRANT_ENV.woocommerce]
  process.env[OUTBOUND_GRANT_ENV.woocommerce] = ORIGIN
  try {
    return await pushStockToWc({ forceAll: true, chunk: { afterId: null, limit: 10 } })
  } finally {
    if (saved === undefined) delete process.env[OUTBOUND_GRANT_ENV.woocommerce]
    else process.env[OUTBOUND_GRANT_ENV.woocommerce] = saved
  }
}

const okPreflight: Fetch = (path, params) => {
  if (params.include) return { data: params.include.split(',').map((id) => ({ id: Number(id), sku: `S${id}` })) }
  return { data: [] }
}
const okUpdate = (ids: number[]) => ({ data: { update: ids.map((id) => ({ id, stock_quantity: 5 })) } })

test('CONTROL: every candidate looked up, verified and pushed: the window is handled and says where the next one starts', async () => {
  reset([product('a', 'S1', 1n), product('b', 'S2', 2n)])
  fetchImpl = okPreflight
  postImpl = () => okUpdate([1, 2])
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.chunk, { nextCursor: null, totalCandidates: 2 })
})

test('SKU lookup: one lookup failing leaves the window unhandled', async () => {
  reset([product('a', 'S1', 1n), product('b', 'S2', null), product('c', 'S3', null)])
  fetchImpl = (path, params) => {
    if (params.include) return okPreflight(path, params)
    if (params.sku === 'S2') return { data: [{ id: 2, sku: 'S2' }] }
    return { data: null, error: 'WC API error: 500' }
  }
  postImpl = () => okUpdate([1, 2])
  const result = await run()
  assert.ok(result.errors.some((e) => e.includes('lookup failure for SKU S3')))
  assert.equal(result.chunk, undefined)
})

test('preflight: one failing page leaves the window unhandled', async () => {
  reset([product('a', 'S1', 1n), product('b', 'S2', 2n)])
  // 100 ids per page, so two pages need >100 candidates; the failing page here is the only page for variant-free products, which
  // is an outage and also unhandled. A partial page failure is covered by the unit flag set on any preflight error.
  fetchImpl = (_path, params) => (params.include ? { data: null, error: 'WC API error: 502' } : { data: [] })
  postImpl = () => okUpdate([1, 2])
  const result = await run()
  assert.equal(result.chunk, undefined)
})

test('preflight: a partial page failure (one of two pages) leaves the window unhandled', async () => {
  const many = Array.from({ length: 120 }, (_, i) => product(`p${String(i).padStart(3, '0')}`, `S${i + 1}`, BigInt(i + 1)))
  reset(many)
  fetchImpl = (path, params) => {
    if (params.include && params.include.split(',').includes('1')) return { data: null, error: 'WC API error: 502' }
    return okPreflight(path, params)
  }
  postImpl = (_p, body) => okUpdate(((body as { update: Array<{ id: number }> }).update).map((u) => u.id))
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const saved = process.env[OUTBOUND_GRANT_ENV.woocommerce]
  process.env[OUTBOUND_GRANT_ENV.woocommerce] = ORIGIN
  try {
    const result = await pushStockToWc({ forceAll: true, chunk: { afterId: null, limit: 200 } })
    assert.ok(result.errors.some((e) => e.includes('preflight warning')))
    assert.equal(result.chunk, undefined)
  } finally {
    if (saved === undefined) delete process.env[OUTBOUND_GRANT_ENV.woocommerce]
    else process.env[OUTBOUND_GRANT_ENV.woocommerce] = saved
  }
})

test('batch push: a failed batch leaves the window unhandled', async () => {
  reset([product('a', 'S1', 1n), product('b', 'S2', 2n)])
  fetchImpl = okPreflight
  postImpl = () => ({ data: null, error: 'WC API error: 500' })
  const result = await run()
  assert.ok(result.errors.some((e) => e.startsWith('batch push')))
  assert.equal(result.chunk, undefined)
})

test('batch push: an item the store dropped from its response leaves the window unhandled', async () => {
  reset([product('a', 'S1', 1n), product('b', 'S2', 2n)])
  fetchImpl = okPreflight
  postImpl = () => okUpdate([1])
  const result = await run()
  assert.ok(result.errors.some((e) => e.includes('missing from batch response')))
  assert.equal(result.chunk, undefined)
})
