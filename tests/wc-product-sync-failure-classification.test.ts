import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

// o3d-gtk: a product-sync failure must be classified PERMANENT (acknowledge + report) or
// TRANSIENT (retry). The dangerous mistake is calling a concurrent-create race permanent, which
// discards a legitimate update. These tests pin both halves of that line.
//
// The db double below enforces the three unique constraints on Product (sku, barcode,
// externalProductId) and raises the EXACT Prisma 7 + @prisma/adapter-pg P2002 shape observed
// against the live database — no `meta.target`, the column list under
// `meta.driverAdapterError.cause.constraint.fields`, camelCase columns arriving quoted.

type Row = Record<string, unknown>

const state = {
  products: [] as Row[],
  syncLogs: [] as Row[],
  createCalls: 0,
  updateCalls: 0,
  /** Advisory-lock keys handed to $executeRaw, in acquisition order. */
  lockOrder: [] as string[],
}

let nextId = 1
/** Emulate pg_advisory_xact_lock: transactions holding the same key run one at a time. */
let serializeOnAdvisoryLock = true

const UNIQUE_COLUMNS: Array<{ field: string; constraint: string; quoted: boolean }> = [
  { field: 'sku', constraint: 'products_sku_key', quoted: false },
  { field: 'barcode', constraint: 'products_barcode_key', quoted: false },
  { field: 'externalProductId', constraint: 'products_externalProductId_key', quoted: true },
]

/** The observed live error object, reproduced field for field. */
function uniqueViolation(column: { field: string; constraint: string; quoted: boolean }) {
  return Object.assign(
    new Error(`Unique constraint failed on the fields: (\`${column.field}\`)`),
    {
      code: 'P2002',
      name: 'PrismaClientKnownRequestError',
      meta: {
        modelName: 'Product',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: `duplicate key value violates unique constraint "${column.constraint}"`,
            kind: 'UniqueConstraintViolation',
            constraint: { fields: [column.quoted ? `"${column.field}"` : column.field] },
          },
        },
      },
    },
  )
}

function assertUnique(data: Row, ignoreId?: unknown) {
  for (const column of UNIQUE_COLUMNS) {
    const value = data[column.field]
    if (value === undefined || value === null) continue
    const clash = state.products.some(
      (row) => row.id !== ignoreId && row[column.field] != null && String(row[column.field]) === String(value),
    )
    if (clash) throw uniqueViolation(column)
  }
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: [], totalPages: 1, totalItems: 0, error: null }),
    wcPut: async () => ({ data: null, error: null }),
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/trade/hs-classification-trigger', {
  namedExports: { invalidateStaleHsProposal: async () => {} },
})

const txClient = {
  product: {
    findFirst: async ({ where }: { where: { sku?: unknown } }) =>
      state.products.find((row) => row.sku === where?.sku) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) =>
      state.products.find((row) => row.id === where.id) ?? null,
    // The ownership-guarded update (o3d-fsi): `id` plus an OR over externalProductId. A zero
    // count is how production learns the row was reassigned underneath it.
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const row = state.products.find((candidate) => candidate.id === where.id)
      if (!row) return { count: 0 }
      const or = where.OR as Array<Row> | undefined
      if (or) {
        const matches = or.some((clause) => {
          if ('externalProductId' in clause && clause.externalProductId === null) {
            return row.externalProductId == null
          }
          const inClause = (clause.externalProductId as { in?: bigint[] } | undefined)?.in
          return Array.isArray(inClause)
            && row.externalProductId != null
            && inClause.some((id) => id === row.externalProductId)
        })
        if (!matches) return { count: 0 }
      }
      assertUnique(data, String(where.id))
      state.updateCalls++
      Object.assign(row, data)
      return { count: 1 }
    },
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
      assertUnique(data)
      state.createCalls++
      const row = { id: `ims-${nextId++}`, ...data }
      state.products.push(row)
      return row
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = state.products.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error(`no product ${where.id}`)
      assertUnique(data, where.id)
      state.updateCalls++
      Object.assign(row, data)
      return row
    },
  },
  productOption: { upsert: async () => ({}) },
  shoppingSyncLog: {
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
  },
  setting: {
    upsert: async () => ({}),
    // The credential-rebind fence (o3d-mlc7) snapshots settings before any remote read.
    // No rows => credentials null and version '0', which findUnique agrees with, so the
    // fence is a no-op here and these suites keep testing what they say they test.
    findMany: async () => [],
    findUnique: async () => null,
  },
  $executeRaw: async () => 1,
}

/** One waiter chain per advisory-lock key, released when the holding transaction settles. */
const lockChains = new Map<string, Promise<unknown>>()

async function runTransaction<T>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> {
  const releases: Array<() => void> = []
  const tx = {
    ...txClient,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const lockKey = String(values[values.length - 1] ?? strings.join(''))
      state.lockOrder.push(lockKey)
      if (!serializeOnAdvisoryLock) return 1
      const previous = lockChains.get(lockKey) ?? Promise.resolve()
      let release!: () => void
      lockChains.set(lockKey, new Promise<void>((resolve) => { release = resolve }))
      releases.push(release)
      await previous
      return 1
    },
  }
  const snapshot = state.products.map((row) => ({ ...row }))
  try {
    return await fn(tx as unknown as typeof txClient)
  } catch (error) {
    // Roll back, like the real transaction does.
    state.products.splice(0, state.products.length, ...snapshot)
    throw error
  } finally {
    for (const release of releases) release()
  }
}

/**
 * Stands in for SELECT DISTINCT hashtext(sku) FROM unnest(...). Deterministic per SKU, so
 * two transactions importing the same SKU still contend on the SAME lock id — which is
 * what the serialization tests below assert. Ordering itself is covered in the o3d-fsi suite.
 */
async function queryLockIds(_strings: TemplateStringsArray, ...values: unknown[]) {
  const skus = values[0] as string[]
  const ids = new Map<string, number>()
  for (const sku of skus) {
    let hash = 0
    for (const char of sku) hash = (hash * 31 + char.charCodeAt(0)) | 0
    ids.set(sku, hash)
  }
  return [...new Set(ids.values())].map((lock_id) => ({ lock_id }))
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txClient,
      $queryRaw: queryLockIds,
      $transaction: runTransaction,
    },
  },
})

type SyncModule = typeof import('../lib/connectors/woocommerce/sync/product-sync.ts')
async function loadSync(): Promise<SyncModule['syncWcProductToIms']> {
  return (await import('@/lib/connectors/woocommerce/sync/product-sync')).syncWcProductToIms
}

function simpleProduct(overrides: Partial<WcFullProduct> = {}): WcFullProduct {
  return {
    id: 42,
    sku: 'WIDGET-1',
    name: 'Widget',
    type: 'simple',
    status: 'publish',
    description: 'A widget',
    short_description: '',
    regular_price: '10.00',
    sale_price: '',
    weight: '',
    dimensions: { length: '', width: '', height: '' },
    images: [],
    attributes: [],
    categories: [],
    meta_data: [],
    variations: [],
    global_unique_id: '',
    ...overrides,
  } as unknown as WcFullProduct
}

function resetState() {
  state.products.length = 0
  state.syncLogs.length = 0
  state.lockOrder.length = 0
  state.createCalls = 0
  state.updateCalls = 0
  lockChains.clear()
  nextId = 1
  serializeOnAdvisoryLock = true
}

// ---------------------------------------------------------------------------
// The classifier itself
// ---------------------------------------------------------------------------

test('classifier: only a single-column barcode/externalProductId P2002 on Product is permanent (o3d-gtk)', async () => {
  const { isPermanentProductSyncConflict } = await import(
    '@/lib/connectors/woocommerce/sync/product-sync-errors'
  )

  assert.equal(
    isPermanentProductSyncConflict(uniqueViolation(UNIQUE_COLUMNS[1])),
    true,
    'a duplicate GTIN targets a different IMS product — deterministic',
  )
  assert.equal(
    isPermanentProductSyncConflict(uniqueViolation(UNIQUE_COLUMNS[2])),
    true,
    'a duplicate WooCommerce id must be recognised through the adapter quoting the camelCase column',
  )
  assert.equal(
    isPermanentProductSyncConflict(uniqueViolation(UNIQUE_COLUMNS[0])),
    false,
    'a SKU collision is the concurrent-create race a retry resolves — it must stay TRANSIENT',
  )

  // Legacy query-engine shape, kept working so the classifier survives dropping the pg adapter.
  assert.equal(
    isPermanentProductSyncConflict({ code: 'P2002', meta: { target: ['barcode'] } }),
    true,
  )
  assert.equal(isPermanentProductSyncConflict({ code: 'P2002', meta: { target: 'products_barcode_key' } }), true)
  assert.equal(isPermanentProductSyncConflict({ code: 'P2002', meta: { target: ['sku'] } }), false)

  // A composite constraint can never be Product's — e.g. ShoppingProductLink/WmsProductLink both
  // carry @@unique([connector, externalProductId]). Matching it would misclassify another model.
  assert.equal(
    isPermanentProductSyncConflict({
      code: 'P2002',
      meta: { modelName: 'ShoppingProductLink', target: ['connector', 'externalProductId'] },
    }),
    false,
  )
  assert.equal(
    isPermanentProductSyncConflict({ code: 'P2002', meta: { modelName: 'ProductCategory', target: ['nameNormalized'] } }),
    false,
    'a category-mirror race must stay retryable',
  )

  // Everything unrecognised stays transient — the safe direction.
  assert.equal(isPermanentProductSyncConflict(new Error('ECONNRESET')), false)
  assert.equal(isPermanentProductSyncConflict({ code: 'P2034' }), false, 'a write conflict / deadlock retries')
  assert.equal(isPermanentProductSyncConflict({ code: 'P2002' }), false, 'no constraint named = not provably permanent')
  assert.equal(isPermanentProductSyncConflict(null), false)
})

// ---------------------------------------------------------------------------
// The create race (must NOT be classified permanent, must NOT lose the update)
// ---------------------------------------------------------------------------

test('create race: two workers importing the same SKU serialize on the advisory lock — one create, one update, nothing lost (o3d-gtk/o3d-uh2)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const [first, second] = await Promise.all([
    syncWcProductToIms(simpleProduct({ name: 'Widget (worker A)' })),
    syncWcProductToIms(simpleProduct({ name: 'Widget (worker B)' })),
  ])

  assert.equal(first.success, true, `worker A should succeed, got: ${first.error}`)
  assert.equal(second.success, true, `worker B should succeed, got: ${second.error}`)
  assert.equal(state.products.length, 1, 'exactly one product row for one SKU')
  assert.equal(state.createCalls, 1, 'the second worker must take the UPDATE branch, not a second create')
  assert.equal(state.updateCalls, 1, 'and its payload must actually be applied')
  // The credential-rebind fence (o3d-mlc7) also takes WC_SYNC_ADVISORY_LOCK_KEY — once to
  // snapshot settings, once inside the write transaction — so filter to the per-SKU keys
  // this assertion is actually about. That the settings lock is taken, and taken first, is
  // covered by tests/wc-product-import-rebind-fence.test.ts.
  const perSkuLockOrder = state.lockOrder.filter((key) => key !== String(918_273_645))
  assert.equal(perSkuLockOrder.length, 2, 'both write transactions take the per-SKU advisory lock')
  assert.equal(perSkuLockOrder[0], perSkuLockOrder[1], 'and they contend on the SAME key')
})

test('create race: a SKU P2002 that slips past the lock is TRANSIENT, and the retry UPDATES rather than discarding (o3d-gtk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // The lock is keyed on the PARENT sku, so a variant SKU colliding across two DIFFERENT parents
  // is not serialized and can still race into a P2002. Model that by dropping the serialization.
  serializeOnAdvisoryLock = false

  // The other worker's row lands first (Postgres only raises 23505 against a COMMITTED row).
  state.products.push({
    id: 'ims-rival',
    sku: 'WIDGET-1',
    name: 'Committed by the other worker',
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
    type: 'SIMPLE',
  })
  // ...but this worker already read "no such SKU" before that commit. Force the create branch
  // once so the P2002 actually fires, exactly as it would in the real race.
  const realFindFirst = txClient.product.findFirst
  let firstLookup = true
  txClient.product.findFirst = async (args: { where: { sku?: unknown } }) => {
    if (firstLookup) {
      firstLookup = false
      return null
    }
    return realFindFirst(args)
  }

  try {
    const raced = await syncWcProductToIms(simpleProduct({ name: 'Widget (raced)' }))

    assert.equal(raced.success, false, 'the racing worker fails on the unique constraint')
    assert.notEqual(
      raced.permanent,
      true,
      'a SKU collision MUST stay transient — calling it permanent discards a real update (data loss)',
    )
    assert.ok(
      String(state.syncLogs.at(-1)?.errorMessage).startsWith('PERMANENT_CONFLICT:') === false,
      'and the sync log must not mark it permanent either',
    )

    // The retry — the whole justification for keeping it transient.
    const retried = await syncWcProductToIms(simpleProduct({ name: 'Widget (raced)' }))
    assert.equal(retried.success, true, `the retry must succeed, got: ${retried.error}`)
    assert.equal(state.products.length, 1, 'still one row')
    assert.equal(
      state.products[0].name,
      'Widget (raced)',
      'the retry APPLIED the payload — the update was not discarded',
    )
  } finally {
    txClient.product.findFirst = realFindFirst
  }
})

// ---------------------------------------------------------------------------
// Genuine deterministic mapping conflicts (permanent)
// ---------------------------------------------------------------------------

test('mapping conflict: a GTIN already held by a DIFFERENT product is PERMANENT, and stays permanent on retry (o3d-gtk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  state.products.push({
    id: 'ims-other',
    sku: 'SOME-OTHER-SKU',
    name: 'Different product, same barcode',
    barcode: '5901234123457',
    externalProductId: '999',
    type: 'SIMPLE',
    lifecycleStatus: 'ACTIVE',
  })

  const incoming = simpleProduct({ sku: 'WIDGET-1', global_unique_id: '5901234123457' })
  const result = await syncWcProductToIms(incoming)

  assert.equal(result.success, false)
  assert.equal(result.permanent, true, 'the GTIN belongs to another product — retrying can never fix it')
  assert.equal(state.products.length, 1, 'the failed import rolled back')
  assert.ok(
    String(state.syncLogs.at(-1)?.errorMessage).startsWith('PERMANENT_CONFLICT:'),
    'the sync log flags it so operators can see it will never self-heal',
  )

  // Determinism is the entire licence to acknowledge: prove the retry re-hits the same wall.
  const retried = await syncWcProductToIms(incoming)
  assert.equal(retried.success, false, 'the retry fails identically')
  assert.equal(retried.permanent, true)
  assert.equal(state.createCalls, 0, 'no row was ever created')
})

test('mapping conflict: a WooCommerce id already mapped to a DIFFERENT product is PERMANENT (o3d-gtk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // The classic case: the SKU was renamed in WooCommerce, so the old IMS row still owns WC id 42.
  state.products.push({
    id: 'ims-old',
    sku: 'WIDGET-1-OLD-NAME',
    name: 'Imported before the SKU was renamed',
    barcode: null,
    externalProductId: BigInt(42),
    type: 'SIMPLE',
    lifecycleStatus: 'ACTIVE',
  })

  const result = await syncWcProductToIms(simpleProduct({ id: 42, sku: 'WIDGET-1' }))

  assert.equal(result.success, false)
  assert.equal(result.permanent, true, 'the WC id is claimed by another IMS product — deterministic')
  assert.equal(state.products.length, 1, 'the failed import rolled back')
})

test('transient failure: a non-constraint error is never permanent (o3d-gtk)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const realCreate = txClient.product.create
  txClient.product.create = async () => {
    throw Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' })
  }
  try {
    const result = await syncWcProductToIms(simpleProduct())
    assert.equal(result.success, false)
    assert.notEqual(result.permanent, true, 'pool/network/timeout failures must keep retrying')
  } finally {
    txClient.product.create = realCreate
  }
})

test('a SKU-ownership conflict is permanent — retrying it re-reads the same two claimants (o3d-fsi)', async () => {
  const { isPermanentProductSyncConflict, WcSkuOwnershipConflictError, isWcSkuOwnershipConflict } = await import(
    '@/lib/connectors/woocommerce/sync/product-sync-errors'
  )

  const conflict = new WcSkuOwnershipConflictError({
    sku: 'SHARED-SKU',
    claimedByWcId: '999',
    incomingWcId: '111',
    imsProductId: 'ims-1',
  })

  assert.equal(isWcSkuOwnershipConflict(conflict), true)
  assert.equal(
    isPermanentProductSyncConflict(conflict),
    true,
    'both claimants come from committed state, so a retry reaches the identical conclusion',
  )
  // A copy that lost its prototype (re-thrown across a boundary, structured-cloned) must
  // still classify, or the conflict silently reverts to 24 pointless retries.
  assert.equal(
    isPermanentProductSyncConflict({ name: 'WcSkuOwnershipConflictError', message: String(conflict) }),
    true,
    'duck-typed copies classify too',
  )
})

test('end to end: an import refused for SKU ownership reports permanent (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // WIDGET-1 already belongs to WooCommerce product 999.
  state.products.push({
    id: 'ims-other',
    sku: 'WIDGET-1',
    name: 'Someone else',
    barcode: null,
    externalProductId: BigInt(999),
    type: 'SIMPLE',
    lifecycleStatus: 'ACTIVE',
  })

  const result = await syncWcProductToIms(simpleProduct({ id: 42, sku: 'WIDGET-1' }))

  assert.equal(result.success, false)
  assert.equal(result.permanent, true, 'a stolen-row refusal must not retry 24 times')
  assert.match(String(result.error), /already mapped to WooCommerce object 999/)
  assert.equal(state.products.length, 1, 'the other product was neither rewritten nor duplicated')
  assert.equal(state.products[0].name, 'Someone else', 'no reparent, no field overwrite')
})
