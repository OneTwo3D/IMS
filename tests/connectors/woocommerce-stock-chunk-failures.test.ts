import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_SETTINGS_VERSION_KEY } from '@/lib/connectors/woocommerce/sync-lock'
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

async function run(options: { forceAll?: boolean; chunk?: { afterId: string | null; limit: number }; productIds?: string[] } = { forceAll: true, chunk: { afterId: null, limit: 10 } }) {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const saved = process.env[OUTBOUND_GRANT_ENV.woocommerce]
  process.env[OUTBOUND_GRANT_ENV.woocommerce] = ORIGIN
  try {
    return await pushStockToWc(options)
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
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))])
  fetchImpl = okPreflight
  postImpl = () => okUpdate([1, 2])
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.chunk, { nextCursor: null, totalCandidates: 2 })
})

test('SKU lookup: one lookup failing leaves the window unhandled', async () => {
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', null), product('c', 'S3', null)])
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
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))])
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
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))])
  fetchImpl = okPreflight
  postImpl = () => ({ data: null, error: 'WC API error: 500' })
  const result = await run()
  assert.ok(result.errors.some((e) => e.startsWith('batch push')))
  assert.equal(result.chunk, undefined)
})

test('batch push: an item the store dropped from its response leaves the window unhandled', async () => {
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))])
  fetchImpl = okPreflight
  postImpl = () => okUpdate([1])
  const result = await run()
  assert.ok(result.errors.some((e) => e.includes('missing from batch response')))
  assert.equal(result.chunk, undefined)
})

const variant = (id: string, sku: string, externalId: bigint) => ({
  ...product(id, sku, externalId), type: 'VARIANT', parent: { sku: 'PARENT', externalProductId: BigInt(100) },
})

test('stale mapping: a cached id the store no longer has is cleared, so the window is unhandled', async () => {
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))])
  fetchImpl = (_p, params) => ({ data: params.include ? [{ id: 1, sku: 'S1' }] : [] }) // id 2 absent from a page that succeeded
  postImpl = () => okUpdate([1])
  const result = await run()
  assert.ok(result.errors.some((e) => e.includes('Stale WC mapping')))
  assert.equal(result.chunk, undefined)
})

test('stale mapping: a cached id that now carries another SKU is cleared, so the window is unhandled', async () => {
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))])
  fetchImpl = (_p, params) => ({ data: params.include ? [{ id: 1, sku: 'S1' }, { id: 2, sku: 'OTHER' }] : [] })
  postImpl = () => okUpdate([1])
  const result = await run()
  assert.ok(result.errors.some((e) => e.includes('Stale WC mapping')))
  assert.equal(result.chunk, undefined)
})

test('lookup failures with nothing left to push: the empty result is still an unhandled window', async () => {
  reset([product('a', 'S1', null), product('b', 'S2', null)])
  fetchImpl = (_p, params) => (params.sku === 'S1' ? { data: [] } : { data: null, error: 'WC API error: 500' })
  const result = await run()
  assert.match(result.message, /^0 synced/)
  assert.equal(result.chunk, undefined)
})

test('variation push: a failed variation batch, or an item missing from its response, leaves the window unhandled', async () => {
  const fetchOk: Fetch = (path, params) => (path.includes('/variations') ? { data: [{ id: 11, sku: 'V1' }] } : okPreflight(path, params))
  reset([variant('v', 'V1', BigInt(11))])
  fetchImpl = fetchOk
  postImpl = () => okUpdate([11])
  const control = await run()
  assert.deepEqual(control.errors, [])
  assert.deepEqual(control.chunk, { nextCursor: null, totalCandidates: 1 })

  reset([variant('v', 'V1', BigInt(11))])
  fetchImpl = fetchOk
  postImpl = () => ({ data: null, error: 'WC API error: 500' })
  const failed = await run()
  assert.ok(failed.errors.some((e) => e.startsWith('variation batch push')))
  assert.equal(failed.chunk, undefined)

  reset([variant('v', 'V1', BigInt(11))])
  fetchImpl = fetchOk
  postImpl = () => okUpdate([])
  const dropped = await run()
  assert.ok(dropped.errors.some((e) => e.includes('missing from batch response')))
  assert.equal(dropped.chunk, undefined)
})

test('credentials rebound while the window was pushing: the window is unhandled', async () => {
  reset([product('a', 'S1', BigInt(1))])
  fetchImpl = okPreflight
  postImpl = () => { settings.set(WC_SETTINGS_VERSION_KEY, 'rebound'); return okUpdate([1]) }
  const result = await run()
  assert.ok(result.errors.some((e) => e.includes('rebound')))
  assert.equal(result.chunk, undefined)
})

test('a window past the end of the catalogue is handled and empty, and ends the pass', async () => {
  reset([product('a', 'S1', BigInt(1))])
  const result = await run({ forceAll: true, chunk: { afterId: 'a', limit: 10 } })
  assert.deepEqual(result.chunk, { nextCursor: null, totalCandidates: 1 })
})

test('chunking applies only to an unscoped forceAll push', async () => {
  reset([product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2)), product('c', 'S3', BigInt(3))])
  fetchImpl = okPreflight
  postImpl = () => okUpdate([1, 2, 3])
  const notForced = await run({ chunk: { afterId: null, limit: 1 } })
  assert.equal(notForced.candidates, 3, 'no forceAll: every candidate')
  assert.equal(notForced.chunk, undefined)
  const scoped = await run({ forceAll: true, productIds: ['a', 'b', 'c'], chunk: { afterId: null, limit: 1 } })
  assert.equal(scoped.candidates, 3, 'scoped: every candidate')
  assert.equal(scoped.chunk, undefined)
  const chunked = await run({ forceAll: true, chunk: { afterId: null, limit: 1 } })
  assert.equal(chunked.candidates, 1)
  assert.deepEqual(chunked.chunk, { nextCursor: 'a', totalCandidates: 3 })
})

test('a kit in this window sees a nested kit (and its components) that sit in other windows', async () => {
  const component = (componentId: string, type: string) => [{ componentId, qty: 1, component: { type, lifecycleStatus: 'ACTIVE' } }]
  const inner = { ...product('b', 'KIT-IN', BigInt(2)), type: 'KIT', productComponents: component('a', 'SIMPLE') }
  const outer = { ...product('c', 'KIT-OUT', BigInt(3)), type: 'KIT', productComponents: component('b', 'KIT') }
  reset([product('a', 'S1', BigInt(1)), inner, outer])
  const skuById: Record<string, string> = { 1: 'S1', 2: 'KIT-IN', 3: 'KIT-OUT' }
  fetchImpl = (_path, params) => (params.include ? { data: params.include.split(',').map((id) => ({ id: Number(id), sku: skuById[id] })) } : { data: [] })
  let sent: Array<{ id: number; stock_quantity?: number }> = []
  postImpl = (_p, body) => { sent = (body as { update: typeof sent }).update; return okUpdate(sent.map((u) => u.id)) }
  const result = await run({ forceAll: true, chunk: { afterId: 'b', limit: 1 } })
  assert.deepEqual(result.errors, [])
  assert.equal(sent.find((u) => u.id === 3)?.stock_quantity, 5, 'the outer kit is as available as the component two windows back')
})
