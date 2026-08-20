import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

// o3d-jcx: the variations prefetch was unbounded and trusted whatever WooCommerce said about
// pagination, and the write transaction then applied the result unbounded inside a 60-second
// budget. Two failure modes follow, and this suite pins both:
//
//   - REFUSE rather than exhaust. A product larger than the transaction can atomically apply is
//     refused before the first write, instead of rolling back after holding the parent lock and
//     every earlier variation row lock for most of a minute.
//   - REFUSE rather than truncate. An unreadable page count used to end the walk after page one
//     (`parseInt('')` is NaN, and `page <= NaN` is false) and that truncated set was applied as if
//     it were the whole product.

type Row = Record<string, unknown>

const state = {
  products: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  skuLookups: [] as string[][],
  /** Every product row write, by SKU — so "applied once" can be asserted, not assumed. */
  productWrites: [] as string[],
}

/** What the fake store serves for /variations. Rewritten per test. */
const server = {
  pages: {} as Record<string, Row[]>,
  totalPages: 1,
  totalItems: 0,
  requestedPages: [] as string[],
}

function variation(id: number, sku: string): Row {
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
    attributes: [{ option: `Opt-${id}` }],
    global_unique_id: '',
  }
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    // Mirrors the real module's value: product-sync compares against it, so a wrong one here would
    // make the refusal untestable.
    WC_PAGINATION_UNKNOWN: -1,
    WC_REQUEST_TIMEOUT_MS: 120_000,
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (!path.includes('/variations')) return { data: [], totalPages: 1, totalItems: 0, error: null }
      const page = params.page ?? '1'
      server.requestedPages.push(page)
      return {
        data: server.pages[page] ?? [],
        totalPages: server.totalPages,
        totalItems: server.totalItems,
        error: null,
      }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/trade/hs-classification-trigger', {
  namedExports: { invalidateStaleHsProposal: async () => {} },
})

let nextId = 1
const findProductBySku = (sku: unknown) => state.products.find((row) => row.sku === sku) ?? null

const productDelegate = {
  findFirst: async ({ where }: { where: { sku?: unknown } }) => findProductBySku(where?.sku),
  findMany: async ({ where }: { where?: Row } = {}) => {
    const skuIn = (where?.sku as { in?: unknown[] } | undefined)?.in
    if (Array.isArray(skuIn)) {
      // Recorded so the CHUNKING of the lookup can be asserted rather than assumed.
      state.skuLookups.push(skuIn as string[])
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
    state.productWrites.push(String((row as Row).sku))
    return row
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    if (!row) throw new Error(`no product ${where.id}`)
    Object.assign(row, data)
    state.productWrites.push(String(row.sku))
    return row
  },
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    if (!row) return { count: 0 }
    Object.assign(row, data)
    state.productWrites.push(String(row.sku))
    return { count: 1 }
  },
  findUnique: async ({ where }: { where: { id?: string; sku?: string } }) =>
    state.products.find((row) => (where.id ? row.id === where.id : row.sku === where.sku)) ?? null,
  upsert: async ({ where, create, update }: { where: { sku?: unknown }; create: Row; update: Row }) => {
    const row = findProductBySku(where?.sku)
    if (row) {
      Object.assign(row, update)
      return row
    }
    const created = { id: `ims-${nextId++}`, ...create }
    state.products.push(created)
    state.productWrites.push(String((created as Row).sku))
    return created
  },
}

const txClient = {
  product: productDelegate,
  productOption: {
    upsert: async ({ where, create, update }: {
      where: { productId_name: { productId: string; name: string } }
      create: Row
      update: Row
    }) => {
      const key = where.productId_name
      const row = state.options.find((c) => c.productId === key.productId && c.name === key.name)
      if (row) {
        Object.assign(row, update)
        return row
      }
      const created = { ...create }
      state.options.push(created)
      return created
    },
  },
  shoppingSyncLog: {
    create: async ({ data }: { data: Row }) => {
      const row = { connector: 'woocommerce', ...data }
      state.syncLogs.push(row)
      return row
    },
    deleteMany: async () => ({ count: 0 }),
  },
  setting: { upsert: async () => ({}), findMany: async () => [], findUnique: async () => null },
  $executeRaw: async () => 1,
  $queryRaw: async () => [],
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txClient,
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const skus = values[0] as string[]
        return [...new Set(skus)].map((sku, index) => ({ lock_id: index + 1, sku }))
      },
      $transaction: async <T>(fn: (tx: typeof txClient) => Promise<T>): Promise<T> => {
        const before = state.products.map((row) => ({ ...row }))
        try {
          return await fn(txClient)
        } catch (error) {
          state.products.splice(0, state.products.length, ...before)
          throw error
        }
      },
    },
  },
})

async function loadSync() {
  return (await import('@/lib/connectors/woocommerce/sync/product-sync')).syncWcProductToIms
}

function variableProduct(variationIds: number[]): WcFullProduct {
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
    variations: variationIds,
  } as unknown as WcFullProduct
}

function reset() {
  state.products.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.skuLookups.length = 0
  state.productWrites.length = 0
  server.pages = {}
  server.totalPages = 1
  server.totalItems = 0
  server.requestedPages.length = 0
  nextId = 1
}

test('o3d-jcx: an UNREADABLE page count is refused — page one is not the whole product', async () => {
  reset()
  const syncWcProductToIms = await loadSync()
  server.pages = { '1': [variation(111, 'VAR-1')] }
  // -1 is what wcFetch now reports for a header it could not read. It used to be NaN, and
  // `page <= NaN` is false — so the walk ended here and this ONE variation was applied as if it
  // were the complete set.
  server.totalPages = -1
  server.totalItems = 250

  const result = await syncWcProductToIms(variableProduct([111]))

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /did not report a readable page count/i)
  assert.equal(state.products.length, 0, 'a truncated variation set must not be written at all')
  // Transient: the header may be readable on the next attempt, so this must keep retrying.
  assert.notEqual(result.permanent, true)
})

test('o3d-jcx: a product reporting more pages than supported is refused on the FIRST request', async () => {
  reset()
  const syncWcProductToIms = await loadSync()
  server.pages = { '1': [variation(111, 'VAR-1')] }
  server.totalPages = 500
  server.totalItems = 50_000

  const result = await syncWcProductToIms(variableProduct([111]))

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /500 pages of variations, above the 10/i)
  assert.deepEqual(server.requestedPages, ['1'], 'the refusal must not spend the whole page budget first')
  assert.equal(state.products.length, 0)
  // PERMANENT: it is a property of the product, so 24 retries into the dead-letter queue would
  // tell the operator nothing the first attempt did not.
  assert.equal(result.permanent, true)
  assert.match(String(state.syncLogs[0]?.errorMessage), /^PERMANENT_CONFLICT: /)
})

test('o3d-jcx: more variations than supported is refused before any write', async () => {
  reset()
  const syncWcProductToIms = await loadSync()
  // One page that serves more than the supported count, so the ITEM ceiling is what fires.
  server.pages = { '1': Array.from({ length: 1_001 }, (_, i) => variation(1_000 + i, `V-${i}`)) }
  server.totalPages = 1
  server.totalItems = 1_001

  const result = await syncWcProductToIms(variableProduct([1_000]))

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /1001 variations of variations, above the 1000/i)
  assert.equal(result.permanent, true)
  assert.equal(state.products.length, 0, 'nothing may be written for a product that cannot be applied whole')
})

test('o3d-jcx: a variation served on two pages is deduplicated by id, not applied twice', async () => {
  reset()
  const syncWcProductToIms = await loadSync()
  // WooCommerce paginates a LIVE list: an insert between requests shifts the window and re-serves
  // a row. The old code appended both copies and left applyVariations to resolve them.
  server.pages = {
    '1': [variation(111, 'VAR-1'), variation(112, 'VAR-2')],
    '2': [variation(112, 'VAR-2'), variation(113, 'VAR-3')],
  }
  server.totalPages = 2
  server.totalItems = 3

  const result = await syncWcProductToIms(variableProduct([111, 112, 113]))

  assert.equal(result.success, true, result.error)
  const skus = state.products.map((row) => row.sku).sort()
  assert.deepEqual(skus, ['PARENT-SKU', 'VAR-1', 'VAR-2', 'VAR-3'])
  // The dedupe happens in the PREFETCH, so the write transaction never sees the repeat: the
  // re-served variation must be WRITTEN once, not once per page it appeared on. Asserting only on
  // the resulting rows would not show the difference — the second write is idempotent, it just
  // costs a round trip inside the transaction whose budget this issue is about.
  assert.equal(
    state.productWrites.filter((sku) => sku === 'VAR-2').length,
    1,
    `VAR-2 was written ${state.productWrites.filter((s) => s === 'VAR-2').length} times: ${state.productWrites.join(', ')}`,
  )
  const lookedUp = state.skuLookups.flat()
  assert.deepEqual([...lookedUp].sort(), ['VAR-1', 'VAR-2', 'VAR-3'])
})

test('o3d-jcx: an EMPTY page below the reported total ends the walk instead of spending the budget', async () => {
  reset()
  const syncWcProductToIms = await loadSync()
  server.pages = { '1': [variation(111, 'VAR-1')] }
  server.totalPages = 8
  server.totalItems = 8

  const result = await syncWcProductToIms(variableProduct([111]))

  assert.equal(result.success, true, result.error)
  assert.deepEqual(server.requestedPages, ['1', '2'], 'the walk stops at the first empty page')
})

test('o3d-jcx: the variant SKU lookup is CHUNKED, not one unbounded IN list', async () => {
  reset()
  const syncWcProductToIms = await loadSync()
  // 250 variations over three pages: above the 200-SKU chunk, well under the supported ceiling.
  server.pages = {
    '1': Array.from({ length: 100 }, (_, i) => variation(200 + i, `CH-${i}`)),
    '2': Array.from({ length: 100 }, (_, i) => variation(300 + i, `CH-${100 + i}`)),
    '3': Array.from({ length: 50 }, (_, i) => variation(400 + i, `CH-${200 + i}`)),
  }
  server.totalPages = 3
  server.totalItems = 250

  const result = await syncWcProductToIms(variableProduct([200]))

  assert.equal(result.success, true, result.error)
  assert.equal(state.skuLookups.length, 2, '250 SKUs must be asked for in two chunks, not one statement')
  for (const chunk of state.skuLookups) {
    assert.ok(chunk.length <= 200, `a chunk of ${chunk.length} SKUs exceeds the bound`)
  }
  assert.equal(state.skuLookups.flat().length, 250, 'chunking must not drop a SKU')
})
