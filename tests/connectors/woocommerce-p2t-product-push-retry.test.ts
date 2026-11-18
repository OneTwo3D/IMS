import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.106: a failed IMS-to-WooCommerce product push is recorded as one open FAILED row per product, pushed again by the
 * reconcile sweep, and closed by a success. Nothing touches the network: wcFetch / wcPut are mocked.
 */

type Log = { id: number; entityId: string; status: string; errorMessage: string | null; recordKind: string | null; createdAt: Date }
let logs: Log[] = []
let nextId = 1
const settings = new Map<string, string>()
let wcError: string | null = 'WooCommerce 502'

const match = (row: Log, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'connector' || k === 'entityType') return true
    if (k === 'createdAt') return row.createdAt >= (v as { gte: Date }).gte
    if (k === 'entityId' && typeof v === 'object' && v !== null) return row.entityId != null
    return (row as unknown as Record<string, unknown>)[k] === v
  })

const fakeDb: object = new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    if (prop === 'shoppingSyncLog') {
      return {
        create: async (args: { data: Partial<Log> }) => {
          if (args.data.status === 'SYNCED' && args.data.recordKind == null) return null // the success log row
          logs.push({ id: nextId++, entityId: args.data.entityId as string, status: args.data.status as string, errorMessage: args.data.errorMessage ?? null, recordKind: args.data.recordKind ?? null, createdAt: new Date() })
          return null
        },
        updateMany: async (args: { where: Record<string, unknown>; data: Partial<Log> }) => {
          const hit = logs.filter((l) => match(l, args.where))
          for (const l of hit) Object.assign(l, args.data)
          return { count: hit.length }
        },
        findMany: async (args: { where: Record<string, unknown>; take?: number }) =>
          logs.filter((l) => match(l, args.where)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, args.take ?? 1000),
      }
    }
    if (prop === 'setting') {
      return {
        findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key) } : null),
        findMany: async () => [...settings].map(([key, value]) => ({ key, value })),
      }
    }
    if (prop === 'product') {
      return {
        findUnique: async () => ({ id: 'p1', sku: 'S1', name: 'N', salesPriceBase: 12, salePriceBase: null, barcode: null, mpn: null, type: 'SIMPLE', externalProductId: BigInt(7), lifecycleStatus: 'ACTIVE', parent: null }),
      }
    }
    return new Proxy({}, { get: () => async () => null })
  },
})
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => (wcError ? { data: null, error: wcError } : { data: { id: 7, sku: 'S1', meta_data: [] } }),
    wcPut: async () => ({ data: { id: 7 } }),
    wcPost: async () => ({ data: {} }),
    getWcCredentials: async () => ({ url: 'https://shop.example.com', consumerKey: 'ck', consumerSecret: 'cs' }),
  },
})

function setup() {
  logs = []
  nextId = 1
  settings.clear()
  for (const [k, v] of Object.entries({ wc_url: 'https://shop.example.com', wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_sync_product_enabled: 'true', wc_sync_product_direction: 'to_wc' })) settings.set(k, v)
  wcError = 'WooCommerce 502'
}

test('a failed push leaves one open FAILED row, a repeat failure does not add another, a success closes it (o3d-hqvrp.106)', async () => {
  setup()
  const { pushImsProductToWc, WC_PRODUCT_PUSH_RETRY_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const first = await pushImsProductToWc('p1')
  assert.equal(first.success, false)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].status, 'FAILED')
  assert.equal(logs[0].recordKind, WC_PRODUCT_PUSH_RETRY_KIND)
  assert.match(logs[0].errorMessage ?? '', /502/)

  wcError = 'timeout'
  await pushImsProductToWc('p1')
  assert.equal(logs.length, 1, 'one open row per product')
  assert.match(logs[0].errorMessage ?? '', /timeout/)

  wcError = null
  const ok = await pushImsProductToWc('p1')
  assert.equal(ok.success, true)
  assert.equal(logs[0].status, 'SYNCED', 'a later success closes the open row')
})

test('the retry sweep pushes each failed product again, once, and reports counts (o3d-hqvrp.106)', async () => {
  setup()
  const { retryFailedWcProductPushes, WC_PRODUCT_PUSH_RETRY_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const mk = (entityId: string, status = 'FAILED', age = 0): Log => ({ id: nextId++, entityId, status, errorMessage: 'x', recordKind: WC_PRODUCT_PUSH_RETRY_KIND, createdAt: new Date(Date.now() - age) })
  logs = [mk('a'), mk('b'), mk('c', 'SYNCED'), mk('old', 'FAILED', 8 * 86_400_000)]
  const seen: string[] = []
  const result = await retryFailedWcProductPushes(async (id) => { seen.push(id); return { success: id === 'a' } })
  assert.deepEqual(seen.sort(), ['a', 'b'], 'closed rows and rows past the retry window are not retried')
  assert.deepEqual(result, { retried: 2, resolved: 1, remaining: 1 })
})

test('a skipped push (settings forbid it) records nothing (o3d-hqvrp.106)', async () => {
  setup()
  settings.set('wc_sync_product_enabled', 'false')
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const r = await pushImsProductToWc('p1')
  assert.equal(r.skipped, true)
  assert.equal(logs.length, 0)
})
