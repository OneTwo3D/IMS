import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

// PRODUCT CONTENT FROM WOOCOMMERCE (descriptions, picture references) INTO THE IMS HUB COPY, ON A LOCAL FAKE.
// The harness is the one tests/wc-product-sync-atomicity.test.ts uses, with a productContent delegate added:
// the importer must store content beside the product it writes, only when a field changed, never clear a stored
// field from an empty source, and roll it back with the rest of a failed write. Named mutations (each shown red in
// the PR, restored from a copy, md5-verified):
//  m14 no-store-parent     the parent branch does not call storeWcProductContent
//  m15 no-store-variation  the variation branches do not call storeWcProductContent
//  m16 always-write        applyIncomingProductContent writes even when nothing changed
//  m17 empty-clears        planContentUpdate lets an empty incoming value replace a stored one (shared with m1)
//
// (Original harness note follows.) o3d-uh2: parent + variation + option + SYNCED-log writes must be ATOMIC.
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
  contents: [] as Row[],
  contentWrites: 0,
  products: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  advisoryLocks: [] as string[],
}

function snapshot() {
  return {
    contents: state.contents.map((row) => ({ ...row })),
    products: state.products.map((row) => ({ ...row })),
    options: state.options.map((row) => ({ ...row })),
    syncLogs: state.syncLogs.map((row) => ({ ...row })),
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  state.contents.splice(0, state.contents.length, ...snap.contents)
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
      return { data: VARIATION_PAGES[page] ?? [], totalPages: 1, totalItems: 1, error: null }
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
  // Child-existence question for the structural decision: this fake has no children for a simple product.
  groupBy: async () => [] as Row[],
  // The ownership-guarded UPDATE: matches the row by id (the ownership predicate is not what this suite is about).
  updateMany: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    if (!row) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  },
  findFirst: async ({ where }: { where: { sku?: unknown } }) => findProductBySku(where?.sku),
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

const productContentDelegate = {
  findUnique: async ({ where }: { where: { productId: string } }) =>
    state.contents.find((row) => row.productId === where.productId) ?? null,
  upsert: async ({ where, create, update }: { where: { productId: string }; create: Row; update: Row }) => {
    state.contentWrites += 1
    const row = state.contents.find((candidate) => candidate.productId === where.productId)
    if (row) {
      Object.assign(row, update)
      return row
    }
    const created = { id: `content-${state.contents.length + 1}`, ...create }
    state.contents.push(created)
    return created
  },
}

const txClient = {
  productContent: productContentDelegate,
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
  state.contents.length = 0
  state.contentWrites = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.advisoryLocks.length = 0
  nextId = 1
}


function contentFor(sku: string) {
  const product = findProductBySku(sku)
  assert.ok(product, `product ${sku} exists`)
  return state.contents.find((row) => row.productId === product.id) ?? null
}

function productWithContent(overrides: Partial<WcFullProduct> = {}): WcFullProduct {
  return {
    ...variableProduct(),
    type: 'simple',
    sku: 'SIMPLE-1',
    name: 'Simple Widget',
    short_description: '<p>Short copy</p>',
    description: '<p>Long copy &amp; more</p>',
    images: [{ id: 5, src: 'https://shop.example.test/a.jpg', name: 'a', alt: 'front' }],
    attributes: [],
    variations: [],
    date_modified_gmt: '2026-10-01T09:00:00',
    ...overrides,
  } as unknown as WcFullProduct
}

test('inbound: a simple product stores its short and long description and picture references beside the product', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 0
  const result = await syncWcProductToIms(productWithContent())
  const content = contentFor('SIMPLE-1')
  console.log(`precondition: 1 product synced, ok=${result.success}; contents rows=${state.contents.length} writes=${state.contentWrites}`)
  assert.equal(result.success, true, `sync should succeed, got: ${result.error}`)
  assert.ok(content, 'a content row exists for the product')
  assert.equal(content.shortDescription, 'Short copy')
  assert.equal(content.longDescription, 'Long copy & more')
  const images = content.images as Array<{ url: string; externalImageId: string; checksum: string }>
  assert.equal(images.length, 1)
  assert.equal(images[0]!.url, 'https://shop.example.test/a.jpg')
  assert.equal(images[0]!.externalImageId, '5')
  assert.match(images[0]!.checksum, /^[0-9a-f]{64}$/, 'a checksum of the REFERENCE is stored, not bytes')
  assert.equal((content.sourceModifiedAt as Date).toISOString(), '2026-10-01T09:00:00.000Z')
})

test('inbound: re-importing identical content writes nothing; one changed field moves only that field', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 0
  await syncWcProductToIms(productWithContent())
  const afterFirst = state.contentWrites
  await syncWcProductToIms(productWithContent())
  console.log(`precondition: content writes after first import=${afterFirst}, after identical re-import=${state.contentWrites}`)
  assert.equal(afterFirst, 1)
  assert.equal(state.contentWrites, afterFirst, 'identical content is not rewritten')

  const before = contentFor('SIMPLE-1')!
  const longBefore = before.longDescriptionChangedAt
  const revised = await syncWcProductToIms(productWithContent({ short_description: '<p>Short copy, revised</p>' }))
  assert.equal(revised.success, true, `revised import failed: ${revised.error}`)
  const after = contentFor('SIMPLE-1')!
  assert.equal(state.contentWrites, 2)
  assert.equal(after.shortDescription, 'Short copy, revised')
  assert.equal(after.longDescriptionChangedAt, longBefore, 'the long description was not touched, so its changed-at did not move')
  assert.notEqual(after.shortDescriptionChangedAt, undefined)
})

test('inbound: a field WooCommerce sends EMPTY is kept, not cleared', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 0
  const first = await syncWcProductToIms(productWithContent())
  const emptied = await syncWcProductToIms(productWithContent({ short_description: '', description: '', images: [] }))
  // The precondition that makes the arm mean something: the second import REACHED the update path and succeeded.
  assert.equal(first.success && emptied.success, true, `both imports must succeed: ${first.error ?? emptied.error}`)
  const content = contentFor('SIMPLE-1')!
  console.log(`precondition: second import had 3 empty fields; stored short=${JSON.stringify(content.shortDescription)} images=${(content.images as unknown[]).length}`)
  assert.equal(content.shortDescription, 'Short copy')
  assert.equal(content.longDescription, 'Long copy & more')
  assert.equal((content.images as unknown[]).length, 1)
  assert.equal(state.contentWrites, 1, 'and nothing was written for it')
})

test('inbound: variations store their own description and picture; the parent stores its own', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 0
  const page = VARIATION_PAGES['1']![0]!
  page.description = '<p>Red variant text</p>'
  page.images = [{ id: 31, src: 'https://shop.example.test/red.jpg', name: 'red', alt: '' }]
  const result = await syncWcProductToIms(variableProduct())
  const variant = contentFor('VAR-1')
  const parent = contentFor('PARENT-SKU')
  console.log(`precondition: variable parent + 1 variation synced ok=${result.success}; content rows=${state.contents.length}`)
  assert.equal(result.success, true, `sync should succeed, got: ${result.error}`)
  assert.equal(variant?.longDescription, 'Red variant text')
  assert.equal(variant?.shortDescription, null, 'WooCommerce variations have no short description')
  assert.equal((variant?.images as Array<{ url: string }>)[0]!.url, 'https://shop.example.test/red.jpg')
  assert.equal(parent?.longDescription, 'A widget')
  assert.equal(state.contents.length, 2)
  page.description = ''
  page.images = []
})

test('inbound: content rolls back with a failed write (no content row for a product that was not committed)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  failVariationsPage = 1
  const result = await syncWcProductToIms(variableProduct())
  console.log(`precondition: variations page fails; sync ok=${result.success}; products=${state.products.length} contents=${state.contents.length}`)
  assert.equal(result.success, false)
  assert.equal(state.products.length, 0)
  assert.equal(state.contents.length, 0, 'no content survives a rolled-back import')
  failVariationsPage = 0
})

test('loop safety: the IMS -> WooCommerce product push carries no content key, for any product', async () => {
  const { buildImsToWcProductPayload } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const payload = buildImsToWcProductPayload({
    name: 'Widget',
    lifecycleStatus: 'ACTIVE',
    salesPriceBase: 12.5,
    salePriceBase: null,
    barcode: '5012345678900',
    // A caller that still hands over the old shape must not be able to smuggle content through.
    ...({ description: 'Short copy', short_description: 'Short', images: [{ src: 'https://x.test/a.jpg' }] } as object),
  } as Parameters<typeof buildImsToWcProductPayload>[0])
  const keys = Object.keys(payload).sort()
  console.log(`precondition: payload keys=${keys.join(',')}`)
  assert.deepEqual(keys, ['global_unique_id', 'name', 'regular_price', 'sale_price', 'status'])
  for (const content of ['description', 'short_description', 'images']) {
    assert.equal(content in payload, false, `${content} must never be pushed to WooCommerce`)
  }
})
