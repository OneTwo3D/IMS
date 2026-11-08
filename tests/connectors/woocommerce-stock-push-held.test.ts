import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * A stock push that the outbound-write hold will refuse must stop BEFORE it reads WooCommerce.
 *
 * The hold refuses at the transport, which is after the push has read the store for every candidate product. On a held stage the
 * daily forceAll reconcile therefore spent about two minutes reading 911 products to send nothing, and the proxy in front of the cron
 * route gave up at 60 s. The push now asks the same decision up front: refused means no store read, no warehouse read, and the daily
 * reconcile stamp is left alone (nothing was reconciled).
 */

const ORIGIN = 'https://shop.example.com'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce]

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  try { return await fn() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const settings = new Map<string, string>()
const queries: string[] = []
const upserts: string[] = []
const transport: string[] = []

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async (args?: { where?: { key?: string }; create?: { key?: string } }) => {
      queries.push(`${name}.${method}`)
      if (name === 'setting' && method === 'upsert') upserts.push(args?.create?.key ?? '')
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (method === 'findMany') return []
      return null
    },
  })
}
const fakeDb: object = new Proxy({}, {
  get: (_target, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init?: { method?: string }) => {
      transport.push(`${init?.method ?? 'GET'} ${url}`)
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  },
})

function reset() {
  settings.clear()
  queries.length = 0
  upserts.length = 0
  transport.length = 0
  for (const [key, value] of Object.entries({
    wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_stock_sync_enabled: 'true',
  })) settings.set(key, value)
}

test('HELD (no grant): the push returns held and aborted, and reads neither the store nor the warehouses', async () => {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  reset()
  await withEnv({}, async () => {
    const result = await pushStockToWc({ forceAll: true, source: 'DAILY_RECONCILIATION' })
    assert.equal(result.held, true)
    assert.equal(result.aborted, true)
    assert.equal(result.pushed, false)
    assert.deepEqual(transport, [], 'no request of any kind reached the transport')
    assert.ok(!queries.includes('warehouse.findMany'), 'the read phase never started')
    assert.ok(!queries.includes('product.findMany'), 'the read phase never started')
  })
})

test('CONTROL (granted for this store): the push gets past the hold and starts its read phase', async () => {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  reset()
  await withEnv({ [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }, async () => {
    const result = await pushStockToWc({ forceAll: true, source: 'DAILY_RECONCILIATION' })
    assert.notEqual(result.held, true)
    assert.ok(queries.includes('warehouse.findMany'), 'the control reaches the warehouse read the held push never makes')
  })
})

test('HELD (grant names another store): refused the same way', async () => {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  reset()
  await withEnv({ [OUTBOUND_GRANT_ENV.woocommerce]: 'https://other.example.com' }, async () => {
    const result = await pushStockToWc({ forceAll: true })
    assert.equal(result.held, true)
    assert.deepEqual(transport, [])
  })
})

test('the daily reconcile does not stamp a push the hold refused', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset()
  settings.set('wc_sync_enabled', 'true')
  await withEnv({}, async () => {
    const results = await runWcReconcile()
    const stock = results.stock as { skipped?: boolean; reason?: string }
    assert.equal(stock.skipped, true)
    assert.equal(stock.reason, 'outbound_write_held')
    assert.ok(!upserts.includes('last_wc_stock_daily_reconcile_at'), 'nothing was reconciled, so the stamp is untouched')
  })
})
