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
  /** Every `Setting` key written by an upsert — the bulk sync's cursor is one of these. */
  settingUpserts: [] as string[],
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
/** Pages served for GET /products — only the bulk-cursor test needs a non-empty one. */
let productPages: Record<string, Row[]> = {}

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
      const page = params.page ?? '1'
      if (path.includes('/variations')) {
        return { data: variationPages[page] ?? [], totalPages: 1, totalItems: 0, error: null }
      }
      if (path === '/products') {
        const rows = productPages[page] ?? []
        return { data: rows, totalPages: Object.keys(productPages).length || 1, totalItems: rows.length, error: null }
      }
      return { data: [], totalPages: 1, totalItems: 0, error: null }
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

/**
 * `findMany` for the TWO queries production makes: candidate rows by SKU, and the children
 * of those candidates by parentId.
 *
 * The old version returned EVERY row whenever `where.sku.in` was absent, which for the
 * parentId query would have reported every seeded row as a child of something — and, since
 * the resulting Set is keyed on `parentId` values that mostly do not name a candidate, would
 * have looked like it worked. Answering an unrecognised `where` with a throw instead is what
 * keeps "no children" a fact this double established rather than a coincidence.
 */
function findManyMatching(where?: Row): Row[] {
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
}

const productDelegate = {
  // The bulk sync calls findFirst with no `where` at all, to ask "is the catalogue empty?".
  // Answering that with null while rows exist would be a lie the suite might later lean on.
  findFirst: async ({ where }: { where?: { sku?: unknown } } = {}) =>
    where === undefined ? state.products[0] ?? null : findProductBySku(where?.sku),
  findUnique: async ({ where }: { where: { id: string } }) =>
    state.products.find((row) => row.id === where.id) ?? null,
  updateMany: async ({ where, data }: { where: Row; data: Row }) => updateManyMatching(where, data),
  findMany: async ({ where }: { where?: Row } = {}) => findManyMatching(where),
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
    // `connector` is @default("woocommerce") in the schema and production never sets it, so
    // the double has to apply the default too — otherwise the dedup delete below (which
    // filters on connector) would silently match nothing and the "one open row" and
    // "resolved conflicts disappear" assertions would both pass vacuously.
    create: async ({ data }: { data: Row }) => {
      const row = { connector: 'woocommerce', ...data }
      state.syncLogs.push(row)
      return row
    },
    /**
     * The conflict-row dedup/resolution delete. Modelled properly — every scalar key in
     * `where` must match, and the `OR` is a real disjunction — because a double that deleted
     * everything (or nothing) would make both halves of the claim untestable: "exactly one
     * open row per pairing" and "a clean sync clears it" are both statements about WHICH
     * rows this removes.
     */
    deleteMany: async ({ where }: { where: Row }) => {
      const matches = (row: Row) => {
        for (const [key, value] of Object.entries(where)) {
          if (key === 'OR') {
            const clauses = value as Row[]
            if (!clauses.some((clause) => Object.entries(clause).every(([k, v]) => row[k] === v))) return false
            continue
          }
          if (row[key] !== value) return false
        }
        return true
      }
      const kept = state.syncLogs.filter((row) => !matches(row))
      const removed = state.syncLogs.length - kept.length
      state.syncLogs.splice(0, state.syncLogs.length, ...kept)
      return { count: removed }
    },
  },
  setting: {
    upsert: async ({ where }: { where: { key: string } }) => {
      state.settingUpserts.push(where.key)
      return {}
    },
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
  state.settingUpserts.length = 0
  nextId = 1
  productPages = {}
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

/**
 * The durable exception-inbox rows: FROM_CONNECTOR / Product / QUARANTINED is exactly the
 * predicate `/sync/exceptions` selects on (PRODUCT_STRUCTURE_CONFLICT_WHERE in
 * app/actions/sync-exceptions.ts). Reading them back through the same filter is what makes
 * these assertions about what an operator SEES rather than about a row shape.
 */
function quarantinedConflicts(): Row[] {
  return state.syncLogs.filter((log) =>
    log.connector === 'woocommerce'
    && log.direction === 'FROM_CONNECTOR'
    && log.entityType === 'Product'
    && log.status === 'QUARANTINED')
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

test('DOUBLE AUDIT: findMany answers the parentId query by parentId, not by returning everything', async () => {
  // The "does this row have children?" check is the only thing standing between a WooCommerce
  // variation and an IMS parent row. A findMany that ignored `parentId` and returned every
  // seeded row would make both the positive and the negative case pass for the wrong reason.
  resetState()
  state.products.push(imsRow({ id: 'p-1', sku: 'P1', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'p-2', sku: 'P2', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'c-1', sku: 'C1', type: 'VARIANT', parentId: 'p-1' }))

  assert.deepEqual(
    (await productDelegate.findMany({ where: { parentId: { in: ['p-1', 'p-2'] } } })).map((row) => row.id),
    ['c-1'],
    'only the row whose parentId is in the list',
  )
  assert.deepEqual(await productDelegate.findMany({ where: { parentId: { in: ['p-2'] } } }), [])
  assert.deepEqual(
    (await productDelegate.findMany({ where: { sku: { in: ['P2'] } } })).map((row) => row.id),
    ['p-2'],
    'and the SKU query still works',
  )
})

test('DOUBLE AUDIT: shoppingSyncLog.deleteMany removes the matching rows and only those', async () => {
  // "One open conflict per pairing" and "a clean sync clears it" are both claims about WHICH
  // rows this delete removes. A double that deleted everything, or nothing, would prove
  // neither — and would make both of those tests pass regardless of production.
  resetState()
  const log = txClient.shoppingSyncLog
  await log.create({ data: { entityType: 'Product', status: 'QUARANTINED', entityId: 'a', externalId: '1' } })
  await log.create({ data: { entityType: 'Product', status: 'QUARANTINED', entityId: 'b', externalId: '2' } })
  await log.create({ data: { entityType: 'Product', status: 'SYNCED', entityId: 'a', externalId: '1' } })
  await log.create({ data: { entityType: 'SalesOrder', status: 'QUARANTINED', entityId: 'a', externalId: '1' } })

  const { count } = await log.deleteMany({
    where: {
      connector: 'woocommerce',
      entityType: 'Product',
      status: 'QUARANTINED',
      OR: [{ entityId: 'a' }, { externalId: '9' }],
    },
  })

  assert.equal(count, 1, 'exactly the one row that matches every clause')
  assert.deepEqual(
    state.syncLogs.map((row) => `${row.entityType}/${row.status}/${row.entityId}`),
    ['Product/QUARANTINED/b', 'Product/SYNCED/a', 'SalesOrder/QUARANTINED/a'],
    'a different entity, a different status and a different entityType all survive',
  )

  // The OR is a real disjunction: matching on the OTHER side of the pairing works too.
  const byExternal = await log.deleteMany({
    where: {
      connector: 'woocommerce',
      entityType: 'Product',
      status: 'QUARANTINED',
      OR: [{ entityId: 'zzz' }, { externalId: '2' }],
    },
  })
  assert.equal(byExternal.count, 1)
})

test('DOUBLE AUDIT: shoppingSyncLog.create applies the schema default for `connector`', async () => {
  // Production never sets `connector` (it is @default("woocommerce")). If the double stored
  // the row without it, every delete above — and the exception-inbox filter these tests read
  // back through — would match nothing, silently.
  resetState()
  await txClient.shoppingSyncLog.create({ data: { entityType: 'Product', status: 'SYNCED' } })
  assert.equal(state.syncLogs[0].connector, 'woocommerce')
})

// --- the policy, directly ---------------------------------------------------
//
// The sync-level tests below prove the policy is WIRED IN. These prove the policy itself,
// per type, so a decision can never be changed by accident without a test naming the type
// that changed. Imported after the `@/lib/db` mock above because the policy module reaches
// type-transforms, which imports the client.

function loadPolicy() {
  return import('@/lib/connectors/woocommerce/sync/product-structure-policy')
}

test('POLICY: SIMPLE is the only existing type a connector may transform out of', async () => {
  const policy = await loadPolicy()
  const protectedTypes = ['VARIABLE', 'VARIANT', 'KIT', 'BOM', 'NON_INVENTORY'] as const
  for (const type of protectedTypes) {
    assert.equal(policy.isConnectorProtectedProductType(type), true, `${type} must be protected`)
  }
  assert.equal(policy.isConnectorProtectedProductType('SIMPLE'), false, 'SIMPLE owns no structure')
})

test('POLICY: a suppressed write means a CHANGED write, so a steady-state re-sync is silent', async () => {
  const policy = await loadPolicy()
  assert.equal(policy.isConnectorTypeWriteSuppressed('KIT', 'SIMPLE'), true)
  assert.equal(policy.isConnectorTypeWriteSuppressed('VARIABLE', 'VARIABLE'), false, 'same type, nothing suppressed')
  assert.equal(policy.isConnectorTypeWriteSuppressed('VARIANT', 'VARIANT'), false)
  assert.equal(policy.isConnectorTypeWriteSuppressed('SIMPLE', 'VARIABLE'), false, 'SIMPLE is writable')
})

test('POLICY: the effective type is what the row ends up with, not what WooCommerce asked for', async () => {
  const policy = await loadPolicy()
  assert.equal(policy.effectiveImsProductType('KIT', 'VARIABLE'), 'KIT')
  assert.equal(policy.effectiveImsProductType('VARIANT', 'SIMPLE'), 'VARIANT')
  assert.equal(policy.effectiveImsProductType('NON_INVENTORY', 'SIMPLE'), 'NON_INVENTORY')
  assert.equal(policy.effectiveImsProductType('SIMPLE', 'VARIABLE'), 'VARIABLE')
  assert.equal(policy.effectiveImsProductType('SIMPLE', 'VARIANT'), 'VARIANT')
  // A protected type asked for the type it already has is not a suppression, so the
  // effective type is the same either way — this is the case the warning must stay quiet for.
  assert.equal(policy.effectiveImsProductType('VARIABLE', 'VARIABLE'), 'VARIABLE')
})

test('POLICY: refuseVariationAdoption, per type and per relationship', async () => {
  const policy = await loadPolicy()
  const adopt = (row: Record<string, unknown>, rowHasChildren = false) =>
    policy.refuseVariationAdoption({
      row: { id: 'r', sku: 'S', type: 'SIMPLE', parentId: null, ...row } as never,
      imsParentId: 'ims-parent',
      rowHasChildren,
    })

  // Adoptable: nothing IMS owns is lost.
  assert.equal(adopt({ type: 'SIMPLE' }), null, 'an unparented SIMPLE row — the initial-import path')
  assert.equal(adopt({ type: 'VARIANT', parentId: 'ims-parent' }), null, 'the ordinary re-sync')
  assert.equal(adopt({ type: 'KIT' }), null, 'a bundle variant is a first-class IMS shape')
  assert.equal(adopt({ type: 'BOM', parentId: 'ims-parent' }), null)

  // Refused, one reason each.
  assert.equal(adopt({ type: 'VARIANT', parentId: 'ims-other' })?.reason, 'different_ims_parent')
  assert.equal(adopt({ type: 'KIT', parentId: 'ims-other' })?.reason, 'different_ims_parent',
    'protection from a type write is not permission to reparent')
  assert.equal(adopt({ type: 'SIMPLE' }, true)?.reason, 'row_is_a_parent',
    'a row with children is a parent whatever its type says')
  assert.equal(adopt({ type: 'VARIABLE' })?.reason, 'type_cannot_be_a_variation')
  assert.equal(adopt({ type: 'NON_INVENTORY' })?.reason, 'type_cannot_be_a_variation')

  // Precedence: the parent check answers first, because it is the more specific fact.
  assert.equal(adopt({ type: 'VARIABLE', parentId: 'ims-other' })?.reason, 'different_ims_parent')
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

test('a VARIABLE parent is NOT flattened to SIMPLE by a WooCommerce simple product (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // This test previously asserted the OPPOSITE, and that was the bug: VARIABLE->SIMPLE left
  // the row's children pointing at a parent that is no longer variable, and its ProductOption
  // rows behind. validateProductStructureChange refuses this transformation outright in the
  // editor ("Variable parents cannot be converted through the standard editor"); a connector
  // that has been told strictly less than the editor may not do more.
  state.products.push(imsRow({ id: 'ims-var', sku: 'KIT-SKU', name: 'Was variable', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-child', sku: 'CHILD-1', name: 'Its child', type: 'VARIANT', parentId: 'ims-var' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `the rest of the payload must still apply, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'VARIABLE', 'the connector must not flatten a parent')
  assert.ok(
    !('type' in (state.updateData[0] ?? {})),
    '`type` must be omitted from the UPDATE entirely, not written back',
  )
  assert.equal(findProductBySku('CHILD-1')?.parentId, 'ims-var', 'its child still points at a VARIABLE parent')
  assert.equal(findProductBySku('KIT-SKU')?.name, 'Widget Bundle (from WooCommerce)', 'leaf fields still sync')

  const warnings = typePreservationWarnings()
  assert.equal(warnings.length, 1, 'the operator is told')
  assert.equal(warnings[0].imsType, 'VARIABLE')
  assert.equal(warnings[0].suppressedType, 'SIMPLE')

  // Nothing from WooCommerce went unapplied — a `simple` product carries no variations — so
  // this is a warning, not an exception-inbox conflict.
  assert.deepEqual(quarantinedConflicts(), [], 'no conflict row: nothing was left unimported')
  assert.ok(state.syncLogs.some((log) => log.status === 'SYNCED'))
})

test('a VARIANT is NOT flattened to SIMPLE, so it can never end up SIMPLE-with-a-parentId (o3d-8s89)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The parent branch writes `type` but never writes or clears `parentId`. Writing SIMPLE
  // over a VARIANT therefore minted a SIMPLE row that still carried a parentId — a shape
  // validateProductStructureChange refuses to save, so the connector could produce a row the
  // product editor will not let an operator fix. Preserving the type keeps the two columns
  // consistent without the connector deciding a detach it was never told about.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'OTHER-PARENT', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-variant', sku: 'KIT-SKU', name: 'A variant', type: 'VARIANT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  const row = findProductBySku('KIT-SKU')
  assert.equal(row?.type, 'VARIANT', 'the connector must not detach a variant it knows nothing about')
  assert.equal(row?.parentId, 'ims-parent', 'and the parentId it never writes stays coherent with the type')
  assert.equal(row?.name, 'Widget Bundle (from WooCommerce)', 'leaf fields still sync')
  assert.equal(typePreservationWarnings().length, 1)
})

test('a NON_INVENTORY product does not silently acquire inventory semantics (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // NON_INVENTORY means "not stock-tracked" — a service, a fee, a shipping line. WooCommerce's
  // `simple` says nothing at all about whether IMS tracks stock for it, and the editor refuses
  // this conversion outright.
  state.products.push(imsRow({ id: 'ims-service', sku: 'KIT-SKU', name: 'Assembly service', type: 'NON_INVENTORY' }))

  const result = await capturingWarnings(() => syncWcProductToIms(simpleProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'NON_INVENTORY')
  assert.equal(typePreservationWarnings().length, 1)
})

test('re-syncing a protected row whose type ALREADY matches warns about nothing (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // Every steady-state re-sync of every variable parent and every variant hits this path. If
  // "protected" alone triggered the warning, the operator-facing signal would fire on every
  // product on every run and the real conflicts would be invisible inside it.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-v1', sku: 'VAR-1', name: 'Red', type: 'VARIANT', parentId: 'ims-parent' }))
  state.products.push(imsRow({ id: 'ims-v2', sku: 'VAR-2', name: 'Blue', type: 'VARIANT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.deepEqual(typePreservationWarnings(), [], 'nothing changed, so nothing is suppressed')
  assert.equal(findProductBySku('VAR-1')?.name, 'Parent Widget — Red', 'and the variations still sync')
  assert.deepEqual(quarantinedConflicts(), [])
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

// --- unresolved conflicts: surfaced, not reported as success -----------------

test('a KIT matched by a WooCommerce VARIABLE parent keeps its type and adopts no children (o3d-y89x)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit, not a parent', type: 'KIT' }))
  state.components.push({ id: 'pc-1', productId: 'ims-kit', componentId: 'ims-part-a', quantity: 2 })

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('PARENT-SKU')?.type, 'KIT', 'VARIABLE is a loss of composition too')
  // Writing the children anyway would swap one corruption for another: VARIANT rows parented to
  // a product IMS says is a kit, which validateProductStructureChange refuses (a parent must be
  // VARIABLE).
  assert.equal(findProductBySku('VAR-1'), null, 'no child rows are attached to a non-variable parent')
  assert.equal(findProductBySku('VAR-2'), null)
  assert.equal(typePreservationWarnings().length, 1)

  // ...but leaving them out is not free, and this is what the first version of the fix got
  // wrong: it returned success and let the caller advance its cursor, so two WooCommerce
  // variations existed nowhere in IMS and nothing but a console line ever said so.
  assert.equal(result.success, false, 'an unresolved conflict is not a successful sync')
  assert.equal(result.permanent, true, 're-delivering the same payload reaches the same refusal')
  assert.match(String(result.error), /None of its variations were imported/)

  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1, 'exactly one exception-inbox row')
  assert.equal(conflicts[0].entityId, 'ims-kit', 'pointing at the IMS product')
  assert.equal(conflicts[0].externalId, '77', 'and at the WooCommerce product')
  assert.match(String(conflicts[0].errorMessage), /is KIT, which cannot be a variable parent/)
  assert.equal(
    (conflicts[0].payload as { conflicts: Array<{ kind: string }> }).conflicts[0].kind,
    'variations_not_imported',
  )
  assert.ok(
    !state.syncLogs.some((log) => log.status === 'SYNCED'),
    'a product whose children were never written must not be recorded as SYNCED',
  )
  // The parent row's own fields still committed: a kit paired with a WooCommerce product must
  // keep receiving price and status updates, or the fix costs more than the bug.
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'leaf fields still applied')
  assert.equal(state.components.length, 1, 'and its composition is untouched')
})

test('a repeated sync leaves exactly ONE open conflict row, not one per run (o3d-fjqk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))

  // The cursor deliberately does not advance past a conflicted product, so the reconcile
  // re-imports it every run. Without the dedup that is one new actionable row per run.
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(quarantinedConflicts().length, 1, 'three runs, one open exception')
})

test('resolving the conflict clears the exception with no acknowledge step (o3d-fjqk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))

  const conflicted = await capturingWarnings(() => syncWcProductToIms(variableProduct()))
  assert.equal(conflicted.success, false)
  assert.equal(quarantinedConflicts().length, 1)

  // The operator does what the row asks: the IMS product becomes the variable parent it is
  // paired with. Nothing else changes — no button is pressed.
  const row = state.products.find((candidate) => candidate.id === 'ims-kit')!
  row.type = 'VARIABLE'

  const resolved = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(resolved.success, true, `the re-sync must now succeed, got: ${resolved.error}`)
  assert.deepEqual(quarantinedConflicts(), [], 'the exception clears itself when the sync works')
  assert.equal(findProductBySku('VAR-1')?.type, 'VARIANT', 'and the variations finally land')
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT')
})

// --- variation row matching (o3d-h2cz) --------------------------------------

test('a variation SKU may not reparent an IMS row that belongs to a DIFFERENT parent (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // applyVariations resolves rows by BARE SKU, and the ownership guard deliberately waves
  // through a row with no WooCommerce mapping (that is the initial-import takeover path). So
  // an IMS-native variant of another parent was silently moved across, keeping its stock, its
  // reservations and its open order lines — a structural move the editor blocks outright.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-other-parent', sku: 'OTHER-PARENT', name: 'Other parent', type: 'VARIABLE' }))
  state.products.push(imsRow({
    id: 'ims-foreign-variant',
    sku: 'VAR-1',
    name: 'Belongs to the other parent',
    type: 'VARIANT',
    parentId: 'ims-other-parent',
  }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  const foreign = findProductBySku('VAR-1')
  assert.equal(foreign?.parentId, 'ims-other-parent', 'the row is NOT reparented')
  assert.equal(foreign?.name, 'Belongs to the other parent', 'and not renamed')
  assert.equal(foreign?.externalProductId, null, 'and not remapped onto our WooCommerce variation')

  assert.equal(result.success, false, 'the refusal is reported, not swallowed')
  const conflicts = quarantinedConflicts()
  assert.equal(conflicts.length, 1)
  assert.match(String(conflicts[0].errorMessage), /already a child of IMS product ims-other-parent/)

  // One refused row must not cost its healthy siblings their update.
  assert.equal(findProductBySku('VAR-2')?.type, 'VARIANT', 'the sibling variation still synced')
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'and the parent still synced')
})

test('a variation SKU may not turn an IMS row that HAS children into a variation (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The corrupt shape this guards is one whose `type` does not admit it: a row with children
  // that is not typed VARIABLE. Adopting it would leave ITS children pointing at a row that is
  // now itself a child — a two-level chain IMS has no concept of.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-sneaky-parent', sku: 'VAR-1', name: 'Has children', type: 'SIMPLE' }))
  state.products.push(imsRow({ id: 'ims-grandchild', sku: 'GRANDCHILD', name: 'Child of VAR-1', type: 'VARIANT', parentId: 'ims-sneaky-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(findProductBySku('VAR-1')?.type, 'SIMPLE', 'not rewritten to VARIANT')
  assert.equal(findProductBySku('VAR-1')?.parentId, null, 'not given a parent')
  assert.equal(findProductBySku('GRANDCHILD')?.parentId, 'ims-sneaky-parent', 'its own child is undisturbed')
  assert.equal(result.success, false)
  assert.match(String(quarantinedConflicts()[0]?.errorMessage), /is itself the parent of other IMS products/)
})

test('a variation SKU may not turn a NON_INVENTORY row into a variation (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // Protected type + not child-capable: preserving the type would leave NON_INVENTORY carrying
  // a parentId, which validateProductStructureChange refuses. There is no write that leaves
  // this row valid, so it is refused rather than adopted.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-service', sku: 'VAR-1', name: 'Delivery surcharge', type: 'NON_INVENTORY' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  const service = findProductBySku('VAR-1')
  assert.equal(service?.type, 'NON_INVENTORY')
  assert.equal(service?.parentId, null, 'a NON_INVENTORY row never acquires a parent')
  assert.equal(service?.name, 'Delivery surcharge')
  assert.equal(result.success, false)
  assert.match(String(quarantinedConflicts()[0]?.errorMessage), /which cannot sit under a variable parent/)
})

test('an unmapped SIMPLE row IS still adopted as a variation — first import must keep working (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The counterweight to the three refusals above. A SIMPLE, unparented, childless row owns no
  // structure, and the connector completes the transformation it is asking for (type AND
  // parentId in the same transaction). Refusing this would break the first sync of every
  // variable product against an IMS-native catalogue.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-native', sku: 'VAR-1', name: 'IMS-native product', type: 'SIMPLE' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `adoption must succeed, got: ${result.error}`)
  const adopted = findProductBySku('VAR-1')
  assert.equal(adopted?.id, 'ims-native', 'the existing row was reused, not duplicated')
  assert.equal(adopted?.type, 'VARIANT')
  assert.equal(adopted?.parentId, 'ims-parent')
  assert.equal(adopted?.externalProductId, BigInt(111))
  assert.deepEqual(quarantinedConflicts(), [])
})

test('a KIT already under THIS parent is still adopted, type intact (o3d-h2cz)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The parent check is "a DIFFERENT parent", not "any parent" — otherwise every re-sync of
  // every existing variation would refuse itself from the second run onwards.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Parent', type: 'VARIABLE' }))
  state.products.push(imsRow({ id: 'ims-bundle-var', sku: 'VAR-1', name: 'Bundle variant', type: 'KIT', parentId: 'ims-parent' }))

  const result = await capturingWarnings(() => syncWcProductToIms(variableProduct()))

  assert.equal(result.success, true, `sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('VAR-1')?.type, 'KIT')
  assert.equal(findProductBySku('VAR-1')?.name, 'Parent Widget — Red', 'and it still receives its update')
  assert.deepEqual(quarantinedConflicts(), [])
})

// --- the bulk cursor --------------------------------------------------------

test('the bulk sync does not advance its cursor past a conflicted product (o3d-y89x)', async () => {
  const { syncAllWcProducts } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  resetState()
  state.products.push(imsRow({ id: 'ims-kit', sku: 'PARENT-SKU', name: 'A kit', type: 'KIT' }))
  productPages = { '1': [variableProduct() as unknown as Row] }

  const result = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(result.synced, 0, 'a conflicted product is not counted as synced')
  assert.equal(result.errors.length, 1, 'it is reported as an error')
  assert.deepEqual(
    state.settingUpserts.filter((key) => key.includes('reconcile')),
    [],
    'the reconcile cursor must NOT move — the next run has to re-attempt this product',
  )

  // And once it is resolved the cursor does move again, so a conflict pins the cursor only
  // for as long as it is unresolved.
  state.products.find((row) => row.id === 'ims-kit')!.type = 'VARIABLE'
  state.settingUpserts.length = 0
  const after = await capturingWarnings(() => syncAllWcProducts({ mode: 'reconcile' }))

  assert.equal(after.errors.length, 0)
  assert.ok(
    state.settingUpserts.includes('last_wc_product_reconcile_at'),
    'a clean run advances the cursor as before',
  )
})
