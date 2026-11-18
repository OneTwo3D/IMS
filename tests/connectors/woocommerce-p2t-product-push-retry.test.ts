import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.106: a failed IMS-to-WooCommerce product push is recorded as one open FAILED row per product, pushed again by the
 * reconcile sweep, and closed by a success. Nothing touches the network: wcFetch / wcPut are mocked.
 */

type Log = { id: number; entityId: string; status: string; errorMessage: string | null; recordKind: string | null; createdAt: Date; payload?: { attempts?: number; nextDueAt?: string } | null }
let logs: Log[] = []
let nextId = 1
const settings = new Map<string, string>()
let wcError: string | null = 'WooCommerce 502'
let putResponse: unknown = { id: 7 }
let putError: string | null = null
let putCalls = 0
let lockCalls = 0
let productMpn: string | null = null
let txTail: Promise<unknown> = Promise.resolve()

const match = (row: Log, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'connector' || k === 'entityType') return true
    if (k === 'createdAt') return row.createdAt >= (v as { gte: Date }).gte
    if (k === 'entityId' && typeof v === 'object' && v !== null) return row.entityId != null
    if (k === 'recordKind' && typeof v === 'object' && v !== null) return (v as { in: string[] }).in.includes(row.recordKind ?? '')
    return (row as unknown as Record<string, unknown>)[k] === v
  })

const fakeDb: object = new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$executeRaw') return async () => { lockCalls++; return 1 }
    // The per-product advisory lock makes transactions for one product take turns; the fake models that by running them one at a time.
    if (prop === '$transaction') return (fn: (tx: object) => unknown) => { const run = txTail.then(() => fn(fakeDb)); txTail = run.catch(() => undefined); return run }
    if (prop === 'shoppingSyncLog') {
      return {
        create: async (args: { data: Partial<Log> }) => {
          if (args.data.status === 'SYNCED' && args.data.recordKind == null) return null // the success log row
          logs.push({ id: nextId++, entityId: args.data.entityId as string, status: args.data.status as string, errorMessage: args.data.errorMessage ?? null, recordKind: args.data.recordKind ?? null, createdAt: new Date(), payload: (args.data.payload as Log['payload']) ?? null })
          return null
        },
        findFirst: async (args: { where: Record<string, unknown> }) => logs.find((l) => match(l, args.where)) ?? null,
        update: async (args: { where: { id: number }; data: Partial<Log> }) => {
          const row = logs.find((l) => l.id === args.where.id)
          if (row) Object.assign(row, args.data)
          return row
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
        findUnique: async () => ({ id: 'p1', sku: 'S1', name: 'N', salesPriceBase: 12, salePriceBase: null, barcode: null, mpn: productMpn, type: 'SIMPLE', externalProductId: BigInt(7), lifecycleStatus: 'ACTIVE', parent: null }),
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
    wcPut: async () => { putCalls++; return putError ? { data: null, error: putError } : { data: putResponse } },
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
  putResponse = { id: 7 }
  putError = null
  putCalls = 0
  lockCalls = 0
  productMpn = null
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

const HOUR = 3_600_000

test('the retry sweep pushes due products in next-due order, skips those still backing off, and reports counts (o3d-hqvrp.106)', async () => {
  setup()
  const { retryFailedWcProductPushes, WC_PRODUCT_PUSH_RETRY_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const now = Date.now()
  const mk = (entityId: string, o: { status?: string; age?: number; dueIn?: number; attempts?: number } = {}): Log => ({
    id: nextId++, entityId, status: o.status ?? 'FAILED', errorMessage: 'x', recordKind: WC_PRODUCT_PUSH_RETRY_KIND,
    createdAt: new Date(now - (o.age ?? 0)),
    payload: o.dueIn === undefined ? null : { attempts: o.attempts ?? 1, nextDueAt: new Date(now + o.dueIn).toISOString() },
  })
  logs = [
    mk('oldest-but-waiting', { age: 6 * 86_400_000, dueIn: 5 * HOUR, attempts: 6 }),
    mk('due-late', { age: 3 * 86_400_000, dueIn: -1 * HOUR }),
    mk('due-first', { age: 1000, dueIn: -10 * HOUR }),
    mk('closed', { status: 'SYNCED' }),
    mk('past-window', { age: 8 * 86_400_000, dueIn: -1 * HOUR }),
  ]
  const seen: string[] = []
  const result = await retryFailedWcProductPushes(async (id) => { seen.push(id); return { success: id === 'due-first' } }, { now })
  assert.deepEqual(seen, ['due-first', 'due-late'], 'ordered by next-due time; backing-off, closed and out-of-window rows are not retried')
  assert.deepEqual(result, { retried: 2, resolved: 1, remaining: 1, deferred: 0 })
})

test('the retry sweep stops at its deadline and leaves the rest for the next pass (o3d-hqvrp.106)', async () => {
  setup()
  const { retryFailedWcProductPushes, WC_PRODUCT_PUSH_RETRY_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  logs = ['a', 'b', 'c'].map((id) => ({ id: nextId++, entityId: id, status: 'FAILED', errorMessage: 'x', recordKind: WC_PRODUCT_PUSH_RETRY_KIND, createdAt: new Date(), payload: null }))
  const seen: string[] = []
  const deadlineAt = Date.now() + 50
  const result = await retryFailedWcProductPushes(async (id) => {
    seen.push(id)
    await new Promise((r) => setTimeout(r, 80))
    return { success: true }
  }, { deadlineAt })
  assert.equal(seen.length, 1, 'no new push starts once the budget is spent')
  assert.deepEqual(result, { retried: 1, resolved: 1, remaining: 0, deferred: 2 })
})

test('repeat failures back off 1h, 2h, 4h ... capped at 7 days (o3d-hqvrp.106)', async () => {
  setup()
  const { pushImsProductToWc, nextProductPushRetryDelayMs } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  assert.equal(nextProductPushRetryDelayMs(1), HOUR)
  assert.equal(nextProductPushRetryDelayMs(2), 2 * HOUR)
  assert.equal(nextProductPushRetryDelayMs(3), 4 * HOUR)
  assert.equal(nextProductPushRetryDelayMs(30), 7 * 24 * HOUR)
  await pushImsProductToWc('p1')
  await pushImsProductToWc('p1')
  await pushImsProductToWc('p1')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].payload?.attempts, 3)
  const wait = Date.parse(logs[0].payload?.nextDueAt ?? '') - Date.now()
  assert.ok(wait > 3.9 * HOUR && wait <= 4 * HOUR, `third failure waits about 4h, waited ${wait}`)
})

test('a post-PUT verification failure is recorded as a permanent row and never retried (o3d-hqvrp.106)', async () => {
  setup()
  settings.set('product_identifier_split_enabled', 'true')
  wcError = null
  const { pushImsProductToWc, retryFailedWcProductPushes, WC_PRODUCT_PUSH_PERMANENT_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  productMpn = 'MPN-1' // the store answers 200 without storing it
  putResponse = { id: 7, meta_data: [] }
  const r = await pushImsProductToWc('p1')
  assert.equal(r.success, false)
  assert.match(r.error ?? '', /did not store the MPN/)
  assert.equal(r.permanent, true)
  assert.equal(logs[0].recordKind, WC_PRODUCT_PUSH_PERMANENT_KIND)
  const seen: string[] = []
  await retryFailedWcProductPushes(async (id) => { seen.push(id); return { success: true } })
  assert.deepEqual(seen, [], 'the sweep never picks up a permanent row')
  assert.equal(putCalls, 1, 'the PUT was sent once and never again')
})

test('a PUT that fails (5xx / timeout) is retryable, not permanent (o3d-hqvrp.106)', async () => {
  setup()
  wcError = null
  putError = 'WC API PUT error: 502 Bad Gateway'
  const { pushImsProductToWc, WC_PRODUCT_PUSH_RETRY_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const r = await pushImsProductToWc('p1')
  assert.equal(r.success, false)
  assert.notEqual(r.permanent, true)
  assert.equal(putCalls, 1)
  assert.equal(logs[0].recordKind, WC_PRODUCT_PUSH_RETRY_KIND)
})

test('concurrent failures for one product leave one open row, recorded under the per-product lock (o3d-hqvrp.106)', async () => {
  setup()
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  await Promise.all([pushImsProductToWc('p1'), pushImsProductToWc('p1'), pushImsProductToWc('p1')])
  assert.equal(logs.filter((l) => l.status === 'FAILED').length, 1)
  assert.ok(lockCalls >= 3, 'every recording takes the advisory lock first')
})

test('a skipped push (settings forbid it) records nothing (o3d-hqvrp.106)', async () => {
  setup()
  settings.set('wc_sync_product_enabled', 'false')
  const { pushImsProductToWc } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const r = await pushImsProductToWc('p1')
  assert.equal(r.skipped, true)
  assert.equal(logs.length, 0)
})

test('a 4xx PUT rejection is permanent (product_push_failed); 408, 429, 5xx and network errors stay retryable (o3d-hqvrp.106)', async () => {
  const { pushImsProductToWc, WC_PRODUCT_PUSH_RETRY_KIND, WC_PRODUCT_PUSH_PERMANENT_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const cases: Array<[string, string]> = [
    ['WC API PUT error: 400 Bad Request', WC_PRODUCT_PUSH_PERMANENT_KIND],
    ['WC API PUT error: 404 Not Found', WC_PRODUCT_PUSH_PERMANENT_KIND],
    ['WC API PUT error: 409 Conflict', WC_PRODUCT_PUSH_PERMANENT_KIND],
    ['WC API PUT error: 408 Request Timeout', WC_PRODUCT_PUSH_RETRY_KIND],
    ['WC API PUT error: 429 Too Many Requests', WC_PRODUCT_PUSH_RETRY_KIND],
    ['WC API PUT error: 503 Service Unavailable', WC_PRODUCT_PUSH_RETRY_KIND],
    ['TypeError: fetch failed', WC_PRODUCT_PUSH_RETRY_KIND],
  ]
  for (const [error, kind] of cases) {
    setup()
    wcError = null
    putError = error
    const r = await pushImsProductToWc('p1')
    assert.equal(r.success, false)
    assert.equal(logs[0].recordKind, kind, error)
  }
})

test('each retry runs under a time box taken from the remaining budget (o3d-hqvrp.106)', async () => {
  setup()
  const { retryFailedWcProductPushes, WC_PRODUCT_PUSH_RETRY_KIND } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const { currentWcAttemptSignal } = await import('@/lib/connectors/woocommerce/attempt-fence')
  logs = [{ id: nextId++, entityId: 'a', status: 'FAILED', errorMessage: 'x', recordKind: WC_PRODUCT_PUSH_RETRY_KIND, createdAt: new Date(), payload: null }]
  let signal: AbortSignal | undefined
  await retryFailedWcProductPushes(async () => { signal = currentWcAttemptSignal(); return { success: true } }, { deadlineAt: Date.now() + 10_000 })
  assert.ok(signal, 'the retry runs with an ambient abort signal')
  assert.equal(signal.aborted, false)
  let unbounded: AbortSignal | undefined = signal
  await retryFailedWcProductPushes(async () => { unbounded = currentWcAttemptSignal(); return { success: true } })
  assert.equal(unbounded, undefined, 'no deadline, no time box')
})
