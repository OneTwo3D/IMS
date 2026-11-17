import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'
import { createProductContentDelegate } from './helpers/product-content-delegate.ts'

// CUSTOMS FIELDS ON THE PRODUCT IMPORT: parent policy (WC wins when present, absent never clears)
// and variations (own REST value, else the parent's, applied on create and update), on a local fake.
// Harness shape is the one tests/wc-product-sync-atomicity.test.ts uses.

type Row = Record<string, unknown>

const state = { products: [] as Row[], options: [] as Row[], syncLogs: [] as Row[] }
let nextId = 1
let variationRows: Row[] = []

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (!path.includes('/variations')) return { data: [], totalPages: 1, totalItems: 0, error: null }
      const page = params.page ?? '1'
      return { data: page === '1' ? variationRows : [], totalPages: 1, totalItems: variationRows.length, error: null }
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
  // Which candidates are themselves parents: GROUP BY parentId over the candidate ids.
  groupBy: async ({ where }: { where?: Row } = {}) => {
    const parentIn = (where?.parentId as { in?: unknown[] } | undefined)?.in
    if (!Array.isArray(parentIn)) throw new Error('product.groupBy double: unmodelled query')
    return [...new Set(state.products.filter((r) => r.parentId != null && parentIn.includes(r.parentId)).map((r) => String(r.parentId)))]
      .map((parentId) => ({ parentId }))
  },
  // The ownership-guarded update: match on id (the externalProductId OR-guard is not modelled here;
  // ownership is covered by tests/wc-product-sync-sku-ownership.test.ts).
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    if (!row) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  },
  findUnique: async ({ where }: { where: { id?: string } }) => state.products.find((r) => r.id === where.id) ?? null,
  // Two queries: candidate rows by SKU, and (o3d-h2cz) the children of those candidates by
  // parentId. An unrecognised `where` throws rather than returning everything, so a query
  // this double does not model can never quietly answer "yes" or "no".
  findMany: async ({ where }: { where?: Row } = {}) => {
    const skuIn = (where?.sku as { in?: unknown[] } | undefined)?.in
    if (Array.isArray(skuIn)) {
      return state.products.filter((row) => skuIn.includes(row.sku)).map((row) => ({ ...row }))
    }
    const parentIn = (where?.parentId as { in?: unknown[] } | undefined)?.in
    if (Array.isArray(parentIn)) {
      return state.products
        .filter((row) => row.parentId != null && parentIn.includes(row.parentId))
        .map((row) => ({ ...row }))
    }
    if (where === undefined) return state.products.map((row) => ({ ...row }))
    throw new Error(`product.findMany double got an unmodelled where: ${JSON.stringify(where)}`)
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
  // `connector` is @default("woocommerce"); production never sets it and the delete below
  // filters on it, so the double applies the default too.
  create: async ({ data }: { data: Row }) => {
    const row = { connector: 'woocommerce', ...data }
    state.syncLogs.push(row)
    return row
  },
  /** o3d-fjqk structure-conflict dedup/resolution delete. */
  deleteMany: async ({ where }: { where: Row }) => {
    const matches = (row: Row) => Object.entries(where).every(([key, value]) => {
      if (key !== 'OR') return row[key] === value
      return (value as Row[]).some((clause) => Object.entries(clause).every(([k, v]) => row[k] === v))
    })
    const kept = state.syncLogs.filter((row) => !matches(row))
    const removed = state.syncLogs.length - kept.length
    state.syncLogs.splice(0, state.syncLogs.length, ...kept)
    return { count: removed }
  },
}

const txClient = {
  product: productDelegate,
  productContent: createProductContentDelegate(),
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
    void values; void strings
    return 1
  },
}


mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txClient,
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const skus = values[0] as string[]
        return [...new Set(skus)].map((sku, index) => ({ lock_id: index + 1, sku }))
      },
      $transaction: async <T>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> => fn(txClient),
    },
  },
})

type SyncModule = typeof import('../lib/connectors/woocommerce/sync/product-sync.ts')
async function loadSync(): Promise<SyncModule['syncWcProductToIms']> {
  return (await import('@/lib/connectors/woocommerce/sync/product-sync')).syncWcProductToIms
}

function parent(extra: Row = {}): WcFullProduct {
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
    ...extra,
  } as unknown as WcFullProduct
}

function variation(id: number, sku: string, extra: Row = {}): Row {
  return {
    id, sku, status: 'publish', description: '', regular_price: '10', sale_price: '', weight: '',
    dimensions: { length: '', width: '', height: '' }, images: [], attributes: [{ option: sku }],
    global_unique_id: '', ...extra,
  }
}

function reset() {
  state.products.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  nextId = 1
  variationRows = []
}

const bySku = (sku: string) => state.products.find((row) => row.sku === sku) as Row

test('parent policy: a differing native value overwrites a populated IMS field', async () => {
  const sync = await loadSync()
  reset()
  state.products.push({
    id: 'p1', sku: 'PARENT-SKU', name: 'x', type: 'VARIABLE', lifecycleStatus: 'ACTIVE',
    hsCode: '11111111', countryOfOrigin: 'DE', customsDescription: 'old description',
  })
  const result = await sync(parent({
    customs_commodity_code: '85011099', customs_country_of_origin: 'CN', customs_description: 'stepper motor',
  }))
  assert.equal(result.success, true, JSON.stringify(result))
  const row = bySku('PARENT-SKU')
  assert.equal(row.hsCode, '85011099')
  assert.equal(row.countryOfOrigin, 'CN')
  assert.equal(row.customsDescription, 'stepper motor')
})

test('parent policy: nothing supplied (native and fallbacks absent) preserves a populated IMS field', async () => {
  const sync = await loadSync()
  reset()
  state.products.push({
    id: 'p1', sku: 'PARENT-SKU', name: 'x', type: 'VARIABLE', lifecycleStatus: 'ACTIVE',
    hsCode: '11111111', countryOfOrigin: 'DE', customsDescription: 'old description',
  })
  const result = await sync(parent())
  assert.equal(result.success, true)
  const row = bySku('PARENT-SKU')
  assert.equal(row.hsCode, '11111111')
  assert.equal(row.countryOfOrigin, 'DE')
  assert.equal(row.customsDescription, 'old description')
})

test('variations on create: inherited value, own value, parent legacy description, China default only when absent', async () => {
  const sync = await loadSync()
  reset()
  variationRows = [
    // WC view context: the parent's value arrives on the variation itself.
    variation(111, 'VAR-INHERIT', { customs_commodity_code: '85011099', customs_country_of_origin: 'CN', customs_description: 'stepper motor' }),
    // Variation-specific values.
    variation(112, 'VAR-OWN', { customs_commodity_code: '39269097', customs_country_of_origin: 'US', customs_description: 'plastic bracket' }),
    // Nothing on the variation: falls back to the parent's extraction, including its legacy meta.
    variation(113, 'VAR-FALLBACK'),
  ]
  const result = await sync(parent({
    customs_commodity_code: '84798997',
    customs_country_of_origin: 'GB',
    meta_data: [{ id: 1, key: '_customs_description_legacy', value: 'parent legacy text' }],
  }))
  assert.equal(result.success, true)
  const inherit = bySku('VAR-INHERIT')
  assert.deepEqual([inherit.hsCode, inherit.countryOfOrigin, inherit.customsDescription], ['85011099', 'CN', 'stepper motor'])
  const own = bySku('VAR-OWN')
  assert.deepEqual([own.hsCode, own.countryOfOrigin, own.customsDescription], ['39269097', 'US', 'plastic bracket'])
  const fallback = bySku('VAR-FALLBACK')
  assert.deepEqual([fallback.hsCode, fallback.countryOfOrigin, fallback.customsDescription], ['84798997', 'GB', 'parent legacy text'])
})

test('an attribute-only variation (singular `option`) imports its customs and reaches the Mintsoft payload', async () => {
  const sync = await loadSync()
  reset()
  variationRows = [variation(111, 'VAR-ATTR', {
    attributes: [
      { name: 'Colour', option: 'Red' },
      { name: 'pa_hs_code', option: 'ignored' },
      { name: 'hs_code', option: '39269097' },
      { name: 'country_of_origin', option: 'DE' },
      { name: 'customs_description', option: 'plastic bracket' },
    ],
  })]
  const result = await sync(parent())
  assert.equal(result.success, true)
  const row = bySku('VAR-ATTR')
  assert.deepEqual([row.hsCode, row.countryOfOrigin, row.customsDescription], ['39269097', 'DE', 'plastic bracket'])
  const { buildMintsoftProductDto } = await import('@/lib/connectors/mintsoft/sync/product-sync')
  const { buildMintsoftProductUpsertRequest } = await import('@/lib/connectors/mintsoft/api/client')
  const body = JSON.parse(buildMintsoftProductUpsertRequest(buildMintsoftProductDto(row as never)).body) as Record<string, unknown>
  assert.deepEqual(body.CommodityCode, { Code: '39269097' })
  assert.deepEqual(body.CountryOfManufacture, { Code: 'DE' })
  assert.equal(body.CustomsDescription, 'plastic bracket')
})

test('variation with no origin anywhere takes the China default on create (as the parent does)', async () => {
  const sync = await loadSync()
  reset()
  variationRows = [variation(111, 'VAR-NONE')]
  await sync(parent())
  assert.equal(bySku('VAR-NONE').countryOfOrigin, 'CN')
  assert.equal(bySku('VAR-NONE').hsCode, null)
})

test('variations on update: WC overwrites a differing value, absence never clears', async () => {
  const sync = await loadSync()
  reset()
  state.products.push(
    { id: 'p1', sku: 'PARENT-SKU', name: 'x', type: 'VARIABLE', lifecycleStatus: 'ACTIVE' },
    { id: 'v1', sku: 'VAR-A', name: 'a', type: 'VARIANT', parentId: 'p1', lifecycleStatus: 'ACTIVE', hsCode: '11111111', countryOfOrigin: 'DE', customsDescription: 'old' },
    { id: 'v2', sku: 'VAR-B', name: 'b', type: 'VARIANT', parentId: 'p1', lifecycleStatus: 'ACTIVE', hsCode: '22222222', countryOfOrigin: 'FR', customsDescription: 'keep me' },
  )
  variationRows = [
    variation(111, 'VAR-A', { customs_commodity_code: '85011099', customs_country_of_origin: 'CN', customs_description: 'stepper motor' }),
    variation(112, 'VAR-B'),
  ]
  const result = await sync(parent())
  assert.equal(result.success, true)
  const a = bySku('VAR-A')
  assert.deepEqual([a.hsCode, a.countryOfOrigin, a.customsDescription], ['85011099', 'CN', 'stepper motor'])
  const b = bySku('VAR-B')
  assert.deepEqual([b.hsCode, b.countryOfOrigin, b.customsDescription], ['22222222', 'FR', 'keep me'])
})

test('the Mintsoft product payload for an imported variation carries the customs fields', async () => {
  const sync = await loadSync()
  reset()
  variationRows = [variation(111, 'VAR-MS', { customs_commodity_code: '85011099', customs_country_of_origin: 'CN', customs_description: 'stepper motor' })]
  await sync(parent())
  const { buildMintsoftProductDto } = await import('@/lib/connectors/mintsoft/sync/product-sync')
  const { buildMintsoftProductUpsertRequest } = await import('@/lib/connectors/mintsoft/api/client')
  const dto = buildMintsoftProductDto(bySku('VAR-MS') as never)
  const body = JSON.parse(buildMintsoftProductUpsertRequest(dto).body) as Record<string, unknown>
  assert.deepEqual(body.CommodityCode, { Code: '85011099' })
  assert.deepEqual(body.CountryOfManufacture, { Code: 'CN' })
  assert.equal(body.CustomsDescription, 'stepper motor')
})
