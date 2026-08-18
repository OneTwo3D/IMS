import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

// o3d-q1w: a variations-fetch failure must FAIL the parent product sync — it must NOT
// silently mark the parent SYNCED (which would leave variations un-synced with no retry
// and let the poll/webhook cursor advance past the change).

// wcFetch always errors: this simulates the variations endpoint failing on its first page.
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: null, totalPages: 0, error: 'HTTP 503 fetching variations' }),
    wcPut: async () => ({ data: null, error: null }),
  },
})

// logActivity is a no-op for this test (trade fields unchanged, so it is not exercised anyway).
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {} },
})

const syncLogs: Array<Record<string, unknown>> = []
// findFirst is the "existing product" lookup; a mutable holder lets each test choose
// create-path (null) vs update-path (an existing row).
let existingProduct: unknown = null

const dbMock: Record<string, unknown> = {}
mock.module('@/lib/db', {
  namedExports: {
    db: Object.assign(dbMock, {
      product: {
        findFirst: async () => existingProduct,
        create: async () => ({ id: 'ims-parent-1' }),
        update: async () => ({ id: 'ims-parent-1', sku: 'PARENT-SKU' }),
      },
      shoppingSyncLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          syncLogs.push(data)
          return data
        },
      },
      productOption: { upsert: async () => ({}) },
      setting: {
        upsert: async () => ({}),
        // The credential-rebind fence (o3d-mlc7) snapshots settings before any remote read.
        // No rows => credentials null and version '0', which findUnique agrees with, so the
        // fence is a no-op here and this suite keeps testing what it says it tests.
        findMany: async () => [],
        findUnique: async () => null,
      },
      // The fence's snapshot runs in its own transaction, BEFORE the variations fetch this
      // suite makes fail. Without it the sync dies on a TypeError instead — which still
      // looks like "the sync failed", so the suite would have kept passing while no longer
      // exercising the variations failure at all.
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbMock),
      $executeRaw: async () => 1,
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const skus = (values[0] ?? []) as string[]
        return [...new Set(skus)].map((sku, index) => ({ lock_id: index + 1, sku }))
      },
    }),
  },
})

type SyncModule = typeof import('../lib/connectors/woocommerce/sync/product-sync.ts')
async function loadSync(): Promise<SyncModule['syncWcProductToIms']> {
  return (await import('@/lib/connectors/woocommerce/sync/product-sync')).syncWcProductToIms
}

function variableProduct(): WcFullProduct {
  return {
    id: 42,
    sku: 'PARENT-SKU',
    name: 'Parent Widget',
    type: 'variable',
    status: 'publish',
    description: 'A widget',
    short_description: '',
    regular_price: '',
    sale_price: '',
    weight: '',
    dimensions: { length: '', width: '', height: '' },
    images: [],
    attributes: [],
    categories: [],
    meta_data: [],
    variations: [111, 112],
  } as unknown as WcFullProduct
}

test('create path: a variations-fetch failure fails the sync and records FAILED, not SYNCED (o3d-q1w)', async () => {
  const syncWcProductToIms = await loadSync()
  syncLogs.length = 0
  existingProduct = null

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false, 'the parent sync must report failure')
  assert.match(result.error ?? '', /variations/i, 'the error should mention the variations failure')

  const statuses = syncLogs.map((l) => l.status)
  assert.ok(statuses.includes('FAILED'), 'a FAILED shoppingSyncLog must be recorded')
  assert.ok(!statuses.includes('SYNCED'), 'the parent must NOT be marked SYNCED')
})

test('update path: a variations-fetch failure fails the sync and records FAILED, not SYNCED (o3d-q1w)', async () => {
  const syncWcProductToIms = await loadSync()
  syncLogs.length = 0
  existingProduct = {
    id: 'ims-parent-1',
    sku: 'PARENT-SKU',
    description: null,
    imageUrl: null,
    weight: null,
    depthCm: null,
    widthCm: null,
    heightCm: null,
    barcode: null,
    lifecycleStatus: 'ACTIVE',
    hsCode: null,
    countryOfOrigin: null,
    customsDescription: null,
  }

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false, 'the parent sync must report failure')
  const statuses = syncLogs.map((l) => l.status)
  assert.ok(statuses.includes('FAILED'), 'a FAILED shoppingSyncLog must be recorded')
  assert.ok(!statuses.includes('SYNCED'), 'the parent must NOT be marked SYNCED')
})
