import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

// o3d-uh2: parent + variation + option + SYNCED-log writes must be ATOMIC.
//
// Before the fix, syncWcProductToIms wrote the parent product first and then let
// syncVariations write each variations page as it arrived. A failure on variations
// page 1 left the parent created/updated with no variants; a failure on a LATER page
// left a mix of freshly-written and stale variants. Nothing rolled back.
//
// The invariant asserted here: when ANY variations page fails, the database is
// byte-for-byte what it was before the sync started (except the FAILED sync log,
// which is written outside the transaction on purpose so the failure is visible).

type Row = Record<string, unknown>

const state = {
  products: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  advisoryLocks: [] as string[],
}

function snapshot() {
  return {
    products: state.products.map((row) => ({ ...row })),
    options: state.options.map((row) => ({ ...row })),
    syncLogs: state.syncLogs.map((row) => ({ ...row })),
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  state.products.splice(0, state.products.length, ...snap.products)
  state.options.splice(0, state.options.length, ...snap.options)
  state.syncLogs.splice(0, state.syncLogs.length, ...snap.syncLogs)
}

// Which variations page should fail. 0 = none.
let failVariationsPage = 0
let nextId = 1

const VARIATION_PAGES: Record<string, Row[]> = {
  '1': [
    {
      id: 111,
      sku: 'VAR-1',
      status: 'publish',
      description: '',
      regular_price: '19.00',
      sale_price: '',
      weight: '',
      dimensions: { length: '', width: '', height: '' },
      images: [],
      attributes: [{ option: 'Red' }],
      global_unique_id: '',
    },
  ],
  '2': [
    {
      id: 112,
      sku: 'VAR-2',
      status: 'publish',
      description: '',
      regular_price: '29.00',
      sale_price: '',
      weight: '',
      dimensions: { length: '', width: '', height: '' },
      images: [],
      attributes: [{ option: 'Blue' }],
      global_unique_id: '',
    },
  ],
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (!path.includes('/variations')) return { data: [], totalPages: 1, totalItems: 0, error: null }
      const page = params.page ?? '1'
      if (failVariationsPage > 0 && page === String(failVariationsPage)) {
        return { data: null, totalPages: 0, totalItems: 0, error: `HTTP 503 fetching variations page ${page}` }
      }
      return { data: VARIATION_PAGES[page] ?? [], totalPages: 2, totalItems: 2, error: null }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/trade/hs-classification-trigger', {
  namedExports: { invalidateStaleHsProposal: async () => {} },
})

function findProductBySku(sku: unknown) {
  return state.products.find((row) => row.sku === sku) ?? null
}

const productDelegate = {
  findFirst: async ({ where }: { where: { sku?: unknown } }) => findProductBySku(where?.sku),
  findMany: async ({ where }: { where?: { sku?: { in?: unknown[] } } } = {}) => {
    const wanted = where?.sku?.in
    if (!Array.isArray(wanted)) return state.products.map((row) => ({ ...row }))
    return state.products.filter((row) => wanted.includes(row.sku)).map((row) => ({ ...row }))
  },
  create: async ({ data }: { data: Row }) => {
    const row = { id: `ims-${nextId++}`, ...data }
    state.products.push(row)
    return row
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    if (!row) throw new Error(`no product ${where.id}`)
    Object.assign(row, data)
    return row
  },
  upsert: async ({ where, create, update }: { where: { sku?: unknown }; create: Row; update: Row }) => {
    const row = findProductBySku(where?.sku)
    if (row) {
      Object.assign(row, update)
      return row
    }
    const created = { id: `ims-${nextId++}`, ...create }
    state.products.push(created)
    return created
  },
}

const productOptionDelegate = {
  upsert: async ({ where, create, update }: {
    where: { productId_name: { productId: string; name: string } }
    create: Row
    update: Row
  }) => {
    const key = where.productId_name
    const row = state.options.find((candidate) => candidate.productId === key.productId && candidate.name === key.name)
    if (row) {
      Object.assign(row, update)
      return row
    }
    const created = { ...create }
    state.options.push(created)
    return created
  },
}

const shoppingSyncLogDelegate = {
  create: async ({ data }: { data: Row }) => {
    state.syncLogs.push(data)
    return data
  },
}

const txClient = {
  product: productDelegate,
  productOption: productOptionDelegate,
  shoppingSyncLog: shoppingSyncLogDelegate,
  // The credential-rebind fence (o3d-mlc7) snapshots settings before any remote read and
  // re-reads the version inside the write transaction. Neither is what this suite is about,
  // so the version is held CONSTANT: findMany returns no rows (version defaults to '0') and
  // findUnique agrees, which is the "nothing was rebound" case. Without these the fence
  // throws a TypeError before the sync starts — and because tests 1 and 2 assert FAILURE,
  // they would have kept passing while testing nothing at all.
  setting: {
    upsert: async () => ({}),
    findMany: async () => [],
    findUnique: async () => null,
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.advisoryLocks.push(String(values[values.length - 1] ?? strings.join('')))
    return 1
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txClient,
      // Stands in for SELECT DISTINCT hashtext(sku) FROM unnest(...) — see
      // resolveWcProductWriteLockIds. Ordering is asserted in the o3d-fsi suite; here
      // it only has to resolve so the write transaction can take its locks.
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const skus = values[0] as string[]
        return [...new Set(skus)].map((sku, index) => ({ lock_id: index + 1, sku }))
      },
      $transaction: async <T>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> => {
        const snap = snapshot()
        try {
          return await fn(txClient)
        } catch (error) {
          restore(snap)
          throw error
        }
      },
    },
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
    attributes: [{ name: 'Colour', options: ['Red', 'Blue'], variation: true, position: 0 }],
    categories: [],
    meta_data: [],
    variations: [111, 112],
  } as unknown as WcFullProduct
}

function resetState() {
  state.products.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.advisoryLocks.length = 0
  nextId = 1
}

test('create path: a FIRST-page variations failure leaves NO parent product behind (o3d-uh2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 1

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false, 'the parent sync must report failure')
  assert.equal(
    findProductBySku('PARENT-SKU'),
    null,
    'the parent product must NOT be left behind when variations page 1 fails',
  )
  assert.equal(state.products.length, 0, 'no product rows at all may survive a failed sync')
  assert.equal(state.options.length, 0, 'no product options may survive a failed sync')

  const statuses = state.syncLogs.map((log) => log.status)
  assert.ok(statuses.includes('FAILED'), 'a FAILED shoppingSyncLog must survive (written outside the transaction)')
  assert.ok(!statuses.includes('SYNCED'), 'the parent must NOT be marked SYNCED')
})

test('update path: a LATER-page variations failure rolls back the parent AND the earlier pages (o3d-uh2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 2

  // Pre-existing catalogue state: a parent and one stale variant from an earlier sync.
  state.products.push({
    id: 'ims-parent-1',
    sku: 'PARENT-SKU',
    name: 'Stale Parent Name',
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
    type: 'VARIABLE',
  })
  state.products.push({
    id: 'ims-var-1',
    sku: 'VAR-1',
    name: 'Stale Variant Name',
    description: null,
    imageUrl: null,
    weight: null,
    depthCm: null,
    widthCm: null,
    heightCm: null,
    barcode: null,
    lifecycleStatus: 'ACTIVE',
    type: 'VARIANT',
    parentId: 'ims-parent-1',
    salesPriceBase: 5,
  })
  const before = snapshot()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false, 'the parent sync must report failure')

  assert.deepEqual(
    state.products.find((row) => row.id === 'ims-parent-1'),
    before.products.find((row) => row.id === 'ims-parent-1'),
    'the parent product must be rolled back to its pre-sync state',
  )
  assert.deepEqual(
    state.products.find((row) => row.id === 'ims-var-1'),
    before.products.find((row) => row.id === 'ims-var-1'),
    'a variant written from an EARLIER page must be rolled back too — no mixed old/new variants',
  )
  assert.equal(
    findProductBySku('VAR-2'),
    null,
    'the failed page must not have created anything',
  )
  assert.equal(state.products.length, 2, 'no extra product rows may survive a failed sync')
  assert.equal(state.options.length, 0, 'product options must roll back with the rest of the write')

  const statuses = state.syncLogs.map((log) => log.status)
  assert.ok(statuses.includes('FAILED'), 'a FAILED shoppingSyncLog must survive (written outside the transaction)')
  assert.ok(!statuses.includes('SYNCED'), 'the parent must NOT be marked SYNCED')
})

test('happy path: all pages fetched before any write, applied under a per-SKU advisory lock (o3d-uh2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 0

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `sync should succeed, got: ${result.error}`)
  assert.ok(findProductBySku('PARENT-SKU'), 'parent written')
  assert.ok(findProductBySku('VAR-1'), 'page-1 variant written')
  assert.ok(findProductBySku('VAR-2'), 'page-2 variant written')
  assert.equal(state.options.length, 1, 'the variation attribute becomes a product option')
  assert.ok(
    state.advisoryLocks.length > 0,
    'the write transaction must take a per-SKU advisory lock so two workers cannot both take the create branch',
  )
  const statuses = state.syncLogs.map((log) => log.status)
  assert.ok(statuses.includes('SYNCED'), 'a SYNCED log is written inside the same transaction')
})
