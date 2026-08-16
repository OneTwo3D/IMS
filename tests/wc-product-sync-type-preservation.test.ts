import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

// o3d-y89x: the WooCommerce product sync is the THIRD writer of Product.type (after the
// editor and the CSV import) and was the only unguarded one. It computed
//   productType = wcProduct.type === 'variable' ? 'VARIABLE' : 'SIMPLE'
// and wrote it unconditionally onto an existing IMS row, so a KIT or BOM whose SKU matched a
// WooCommerce `simple` product was silently flattened to SIMPLE — with its ProductComponent
// rows left in place, the exact state o3d-w998 stops the CSV import from creating.
//
// The rule under test: a connector may never downgrade an IMS product out of KIT or BOM.
// WooCommerce has no concept of composition, so `simple` there is an ABSENCE of information,
// not an assertion. Everything else in the payload must still be applied — a refused sync
// would be worse than a preserved type.

type Row = Record<string, unknown>

const state = {
  products: [] as Row[],
  /** ProductComponent rows. Nothing in the connector may add, change or remove these. */
  components: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  warnings: [] as unknown[][],
  /** Every `data` object handed to product.updateMany, in order — the write log. */
  updateData: [] as Row[],
  /** Set if the connector ever tried to delete component rows. */
  componentDeletes: 0,
}

function snapshot() {
  return {
    products: state.products.map((row) => ({ ...row })),
    components: state.components.map((row) => ({ ...row })),
    options: state.options.map((row) => ({ ...row })),
    syncLogs: state.syncLogs.map((row) => ({ ...row })),
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  state.products.splice(0, state.products.length, ...snap.products)
  state.components.splice(0, state.components.length, ...snap.components)
  state.options.splice(0, state.options.length, ...snap.options)
  state.syncLogs.splice(0, state.syncLogs.length, ...snap.syncLogs)
}

let nextId = 1
let variationPages: Record<string, Row[]> = {}

function wcVariation(id: number, sku: string, option: string): Row {
  return {
    id,
    sku,
    status: 'publish',
    description: '',
    regular_price: '19.00',
    sale_price: '',
    weight: '',
    dimensions: { length: '', width: '', height: '' },
    images: [],
    attributes: [{ option }],
    global_unique_id: '',
  }
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (!path.includes('/variations')) return { data: [], totalPages: 1, totalItems: 0, error: null }
      const page = params.page ?? '1'
      return { data: variationPages[page] ?? [], totalPages: 1, totalItems: 0, error: null }
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

/**
 * The conditional ownership update, faithfully: `id` plus the OR over externalProductId, then
 * Object.assign of EXACTLY the keys `data` carries.
 *
 * This is the double the whole suite rests on, so be explicit about why it can tell the two
 * outcomes apart. The production fix works by OMITTING `type` from `data` rather than by
 * writing `existing.type` back. A double that seeded a default `type`, or that rebuilt the row
 * from the WC payload, or that returned a canned row regardless of `where`, would report
 * "type preserved" whatever production did — it would prove nothing. Object.assign over the
 * live row means an omitted key is untouched and a present key overwrites, which is the exact
 * distinction under test. `assertDoubleWritesTypeWhenAsked` below pins that down.
 */
function updateManyMatching(where: Row, data: Row): { count: number } {
  const row = state.products.find((candidate) => candidate.id === where.id)
  if (!row) return { count: 0 }

  const or = where.OR as Array<Row> | undefined
  if (or) {
    const matches = or.some((clause) => {
      if ('externalProductId' in clause && clause.externalProductId === null) {
        return row.externalProductId == null
      }
      const inClause = (clause.externalProductId as { in?: bigint[] } | undefined)?.in
      return Array.isArray(inClause) && row.externalProductId != null
        && inClause.some((id) => id === row.externalProductId)
    })
    if (!matches) return { count: 0 }
  }

  state.updateData.push({ ...data })
  Object.assign(row, data)
  return { count: 1 }
}

const productDelegate = {
  findFirst: async ({ where }: { where: { sku?: unknown } }) => findProductBySku(where?.sku),
  findUnique: async ({ where }: { where: { id: string } }) =>
    state.products.find((row) => row.id === where.id) ?? null,
  updateMany: async ({ where, data }: { where: Row; data: Row }) => updateManyMatching(where, data),
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
  upsert: async () => ({}),
}

const txClient = {
  product: productDelegate,
  productComponent: {
    findMany: async ({ where }: { where?: { productId?: string } } = {}) =>
      state.components.filter((row) => !where?.productId || row.productId === where.productId),
    deleteMany: async ({ where }: { where?: { productId?: string } } = {}) => {
      state.componentDeletes++
      const before = state.components.length
      const kept = state.components.filter((row) => where?.productId && row.productId !== where.productId)
      state.components.splice(0, state.components.length, ...kept)
      return { count: before - state.components.length }
    },
  },
  productOption: {
    upsert: async ({ create }: { create: Row }) => {
      state.options.push({ ...create })
      return create
    },
  },
  shoppingSyncLog: {
    create: async ({ data }: { data: Row }) => {
      state.syncLogs.push(data)
      return data
    },
  },
  setting: {
    upsert: async () => ({}),
    // No rows => credentials null and version '0', which findUnique agrees with, so the
    // credential-rebind fence (o3d-mlc7) is a consistent no-op here.
    findMany: async () => [],
    findUnique: async () => null,
  },
  $executeRaw: async () => 1,
}

const dbMock = {
  ...txClient,
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const skus = values[0] as string[]
    return [...new Set(skus)].map((sku, index) => ({ lock_id: index + 1 + sku.length }))
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
}

mock.module('@/lib/db', { namedExports: { db: dbMock } })

async function loadSync() {
  return (await import('@/lib/connectors/woocommerce/sync/product-sync')).syncWcProductToIms
}

function simpleProduct(overrides: Partial<Row> = {}): WcFullProduct {
  return {
    id: 42,
    sku: 'KIT-SKU',
    name: 'Widget Bundle (from WooCommerce)',
    type: 'simple',
    status: 'publish',
    description: 'Fresh WooCommerce copy',
    short_description: '',
    regular_price: '49.00',
    sale_price: '39.00',
    weight: '1.5',
    dimensions: { length: '10', width: '20', height: '30' },
    images: [{ src: 'https://example.test/img.png' }],
    attributes: [],
    categories: [],
    meta_data: [],
    variations: [],
    ...overrides,
  } as unknown as WcFullProduct
}

function variableProduct(overrides: Partial<Row> = {}): WcFullProduct {
  return simpleProduct({
    id: 77,
    sku: 'PARENT-SKU',
    name: 'Parent Widget',
    type: 'variable',
    regular_price: '',
    sale_price: '',
    attributes: [{ name: 'Colour', options: ['Red', 'Blue'], variation: true, position: 0 }],
    variations: [111, 112],
    ...overrides,
  })
}

function imsRow(row: Row): Row {
  return {
    name: 'IMS name',
    description: null,
    imageUrl: null,
    weight: null,
    depthCm: null,
    widthCm: null,
    heightCm: null,
    barcode: null,
    salesPriceBase: null,
    salePriceBase: null,
    active: true,
    lifecycleStatus: 'ACTIVE',
    hsCode: null,
    countryOfOrigin: null,
    customsDescription: null,
    parentId: null,
    externalProductId: null,
    ...row,
  }
}

function resetState() {
  state.products.length = 0
  state.components.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.warnings.length = 0
  state.updateData.length = 0
  state.componentDeletes = 0
  nextId = 1
  variationPages = {
    '1': [wcVariation(111, 'VAR-1', 'Red'), wcVariation(112, 'VAR-2', 'Blue')],
  }
}

/** Capture console.warn for the duration of `fn`, restoring it whatever happens. */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn
  console.warn = (...args: unknown[]) => { state.warnings.push(args) }
  try {
    return await fn()
  } finally {
    console.warn = original
  }
}

function typePreservationWarnings(): Array<Record<string, unknown>> {
  return state.warnings
    .filter((args) => String(args[0]).includes('kept IMS product type'))
    .map((args) => args[1] as Record<string, unknown>)
}

/** A KIT with two components, unmapped to WooCommerce — the ordinary adoption case. */
function seedKit(type: 'KIT' | 'BOM' = 'KIT') {
  state.products.push(imsRow({ id: 'ims-kit', sku: 'KIT-SKU', name: 'Widget Bundle', type }))
  state.components.push(
    { id: 'pc-1', productId: 'ims-kit', componentId: 'ims-part-a', quantity: 2 },
    { id: 'pc-2', productId: 'ims-kit', componentId: 'ims-part-b', quantity: 1 },
  )
}

// --- double integrity ------------------------------------------------------

test('DOUBLE AUDIT: the fake updateMany really does write `type` when production sends it', async () => {
  // If this fails, every "type preserved" assertion below is vacuous: the double would report
  // the old type no matter what production wrote. Exercised through the same helper the
  // delegate uses, against a live row.
  resetState()
  state.products.push(imsRow({ id: 'ims-x', sku: 'X', type: 'KIT' }))

  const result = updateManyMatching({ id: 'ims-x' }, { type: 'SIMPLE', name: 'overwritten' })

  assert.equal(result.count, 1)
  assert.equal(state.products[0].type, 'SIMPLE', 'a `type` key in `data` MUST land on the row')
  assert.equal(state.products[0].name, 'overwritten')
})

test('DOUBLE AUDIT: an omitted key leaves the existing value untouched', async () => {
  resetState()
  state.products.push(imsRow({ id: 'ims-x', sku: 'X', type: 'KIT' }))

  updateManyMatching({ id: 'ims-x' }, { name: 'only the name' })

  assert.equal(state.products[0].type, 'KIT')
  assert.equal(state.products[0].name, 'only the name')
})

test('DOUBLE AUDIT: findFirst honours its where clause instead of returning a canned row', async () => {
  resetState()
  state.products.push(imsRow({ id: 'ims-x', sku: 'X', type: 'KIT' }))

  assert.equal(await productDelegate.findFirst({ where: { sku: 'X' } }) !== null, true)
  assert.equal(await productDelegate.findFirst({ where: { sku: 'NOT-X' } }), null)
})

// --- the rule --------------------------------------------------------------

test('a KIT whose WooCommerce twin is `simple` keeps its type (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('KIT')

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'KIT', 'the connector must not downgrade a KIT to SIMPLE')
  assert.ok(
    !('type' in (state.updateData[0] ?? {})),
    '`type` must be omitted from the UPDATE entirely, not written back',
  )
})

test('a BOM whose WooCommerce twin is `simple` keeps its type (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('BOM')

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'BOM', 'BOM is protected exactly as KIT is')
})

test('the preserved KIT keeps its ProductComponent rows, and the rest of the sync still applies (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('KIT')

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  const row = findProductBySku('KIT-SKU')

  // The bug's second half: type=SIMPLE with the components left behind. Preserving the type is
  // what keeps the pair coherent — a KIT that still has components.
  assert.equal(row?.type, 'KIT')
  assert.equal(state.components.length, 2, 'the component rows survive')
  assert.equal(state.componentDeletes, 0, 'and the connector never tries to delete them')

  // "Do not fail the sync" — everything WooCommerce genuinely owns still lands.
  assert.equal(row?.name, 'Widget Bundle (from WooCommerce)', 'name synced')
  assert.equal(row?.description, 'Fresh WooCommerce copy', 'description synced')
  assert.equal(Number(row?.salesPriceBase), 49, 'regular price synced')
  assert.equal(Number(row?.salePriceBase), 39, 'sale price synced')
  assert.equal(Number(row?.weight), 1.5, 'weight synced')
  assert.equal(Number(row?.depthCm), 10, 'dimensions synced')
  assert.equal(row?.imageUrl, 'https://example.test/img.png', 'image synced')
  assert.equal(row?.externalProductId, BigInt(42), 'the WooCommerce mapping is still taken')
  assert.ok(
    state.syncLogs.some((log) => log.status === 'SYNCED'),
    'the import is recorded as SYNCED, not refused',
  )
})

test('the suppressed type change is logged at WARNING with enough detail to find the pair (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  seedKit('KIT')

  await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  const warnings = typePreservationWarnings()
  assert.equal(warnings.length, 1, 'exactly one warning per product per sync — not zero, not per-field')
  const detail = warnings[0]
  assert.equal(detail.sku, 'KIT-SKU', 'names the SKU')
  assert.equal(detail.imsType, 'KIT', 'names the IMS type that was kept')
  assert.equal(detail.wcType, 'simple', 'names the incoming WooCommerce type')
  assert.equal(detail.suppressedType, 'SIMPLE', 'names the write that was refused')
  assert.equal(detail.imsProductId, 'ims-kit', 'names the IMS row')
  assert.equal(detail.wcProductId, '42', 'names the WooCommerce object')
})

test('a genuine SIMPLE -> VARIABLE change still syncs, silently (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // No composition to protect: SIMPLE is not IMS-owned structure, so WooCommerce still decides.
  state.products.push(imsRow({ id: 'ims-simple', sku: 'PARENT-SKU', name: 'Was simple', type: 'SIMPLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE', 'the guard must not freeze ordinary types')
  assert.deepEqual(typePreservationWarnings(), [], 'nothing was suppressed, so nothing is warned about')
  assert.equal(findProductBySku('VAR-1')?.type, 'VARIANT', 'variations are still applied')
})

test('a genuine VARIABLE -> SIMPLE change still syncs (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-var', sku: 'KIT-SKU', name: 'Was variable', type: 'VARIABLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'SIMPLE')
  assert.deepEqual(typePreservationWarnings(), [])
})

test('a NEW product still takes its type from WooCommerce — create is not guarded (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // A brand-new IMS row has no composition to protect, so the create branch is correct as it
  // stands: guarding it would be guarding nothing, and would leave new products typeless.
  const created = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))
  assert.equal(created.success, true, `sync must succeed, got: ${created.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'SIMPLE', 'a new simple product is created SIMPLE')

  resetState()
  const createdVariable = await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.equal(createdVariable.success, true, `sync must succeed, got: ${createdVariable.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'VARIABLE', 'a new variable product is created VARIABLE')
  assert.deepEqual(typePreservationWarnings(), [], 'a create never warns')
})

test('a KIT matched by a WooCommerce VARIATION is not flattened to VARIANT either (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // applyVariations was the fourth unconditional writer of Product.type. A KIT or BOM under a
  // VARIABLE parent is a first-class IMS shape ("bundle variant"), so parentId still applies —
  // only the type write is dropped.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-kit-var', sku: 'VAR-1', name: 'Bundle variant', type: 'KIT' }))
  state.components.push({ id: 'pc-9', productId: 'ims-kit-var', componentId: 'ims-part-a', quantity: 3 })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  const row = findProductBySku('VAR-1')
  assert.equal(row?.type, 'KIT', 'the variation must not overwrite a KIT with VARIANT')
  assert.equal(row?.parentId, 'ims-parent', 'it is still attached to the variable parent')
  assert.equal(row?.name, 'Parent Widget — Red', 'the rest of the variation still applies')
  assert.equal(row?.externalProductId, BigInt(111), 'and it still takes the WooCommerce mapping')
  assert.equal(state.components.length, 1, 'its components survive')
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT', 'ordinary sibling variations are unaffected')

  const warnings = typePreservationWarnings()
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].sku, 'VAR-1')
  assert.equal(warnings[0].suppressedType, 'VARIANT')
  assert.equal(warnings[0].wcProductId, '111', 'names the variation, not the parent')
})

test('a KIT matched by a WooCommerce VARIABLE parent keeps its type and adopts no children (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit, not a parent', type: 'KIT' }))
  state.components.push({ id: 'pc-1', productId: 'ims-kit', componentId: 'ims-part-a', quantity: 2 })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.type, 'KIT', 'VARIABLE is a loss of composition too')
  // Writing the children anyway would swap one corruption for another: VARIANT rows parented to
  // a product IMS says is a kit, which validateProductStructureChange refuses (a parent must be
  // VARIABLE). The warning is what tells an operator this pairing needs a human.
  assert.equal(findProductBySku('VAR-1'), null, 'no child rows are attached to a non-variable parent')
  assert.equal(findProductBySku('VAR-2'), null)
  assert.equal(typePreservationWarnings().length, 1, 'and the operator is told')
})
