import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-jcx: the two remaining WooCommerce walks that ENDED ON A HEADER.
 *
 * `wcFetch` used to read `x-wp-totalpages` with `parseInt(header ?? '1')`, so an unreadable header
 * arrived as NaN. That value behaves differently depending on which way round a loop compares it,
 * and both ways were wrong:
 *
 *   - `fetchWcCategoryTree` broke on `res.totalPages <= page`. `NaN <= page` is false, so the walk
 *     NEVER ENDED — it asked a store with no more categories for empty page after empty page.
 *   - `importWcTaxRates` broke on `page >= r.totalPages`. `page >= NaN` is false, so it happened to
 *     keep going; the moment the header is reported as a negative sentinel instead, that comparison
 *     becomes true on page one and the rate list truncates to its first hundred.
 *
 * Both now follow the rule `fetchAllWcRefundsForOrder` established (o3d-okbd): only an empty page
 * ends a walk, a page ceiling stops a store that ignores `page`, and hitting that ceiling is
 * reported rather than passed off as the end of the collection.
 */

type Row = Record<string, unknown>

const store = {
  /** path -> page -> rows. A page with no entry serves []. */
  pages: {} as Record<string, Record<string, Row[]>>,
  /** What x-wp-totalpages parses to. Every test leaves it at a value that used to end the walk. */
  totalPages: 1,
  /** A store that ignores `page` and re-serves page one for ever. */
  ignoresPage: false,
  requests: [] as string[],
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    WC_PAGINATION_UNKNOWN: -1,
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      const page = params.page ?? '1'
      store.requests.push(`${path}?page=${page}`)
      const byPage = store.pages[path] ?? {}
      const rows = store.ignoresPage ? (byPage['1'] ?? []) : (byPage[page] ?? [])
      return { data: rows, totalPages: store.totalPages, totalItems: 0, error: undefined }
    },
  },
})

const db = {
  taxRates: [] as Row[],
  mappings: [] as Row[],
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      taxRate: {
        findFirst: async ({ where }: { where: { name: string } }) =>
          db.taxRates.find((row) => row.name === where.name) ?? null,
        create: async ({ data }: { data: Row }) => {
          const row = { id: `tr-${db.taxRates.length + 1}`, ...data }
          db.taxRates.push(row)
          return row
        },
      },
      shoppingTaxRateMapping: {
        upsert: async ({ create }: { create: Row }) => {
          db.mappings.push(create)
          return create
        },
      },
    },
  },
})

function reset() {
  store.pages = {}
  store.totalPages = 1
  store.ignoresPage = false
  store.requests = []
  db.taxRates = []
  db.mappings = []
}

function category(id: number): Row {
  return { id, name: `Cat ${id}`, slug: `cat-${id}`, parent: 0 }
}

function taxRate(id: number): Row {
  return { id, country: 'GB', state: '', postcode: '', city: '', rate: '20.0000', name: `Rate ${id}`, priority: 1, compound: false, shipping: true, order: 0, class: 'standard' }
}

test('o3d-jcx: the category walk does not end on a page count of ONE', async () => {
  reset()
  // A store that never sends x-wp-totalpages arrives here as the caller's default of 1 — exactly
  // like a store that genuinely has one page.
  store.totalPages = 1
  store.pages['/products/categories'] = { '1': [category(1), category(2)], '2': [category(3)] }

  const { fetchWcCategoryTree } = await import('@/lib/connectors/woocommerce/sync/category-mirror')
  const result = await fetchWcCategoryTree(null)

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok === true ? result.categories.map((c) => c.id) : [], [1, 2, 3])
})

test('o3d-jcx: the category walk does not end on an UNREADABLE page count either', async () => {
  reset()
  // -1 is what wcFetch now reports for a header it could not read. The old `res.totalPages <= page`
  // break was false for the NaN it used to be (so the walk never ended) and would be TRUE for -1
  // (so it would truncate). Neither may decide anything.
  store.totalPages = -1
  store.pages['/products/categories'] = { '1': [category(1)], '2': [category(2)] }

  const { fetchWcCategoryTree } = await import('@/lib/connectors/woocommerce/sync/category-mirror')
  const result = await fetchWcCategoryTree(null)

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok === true ? result.categories.map((c) => c.id) : [], [1, 2])
})

test('o3d-jcx: a store that ignores `page` terminates the category walk instead of looping for ever', async () => {
  reset()
  // This is the shape that used to hang: `while (true)` with the header as its only ending.
  store.totalPages = -1
  store.ignoresPage = true
  store.pages['/products/categories'] = { '1': [category(1)] }

  const { fetchWcCategoryTree } = await import('@/lib/connectors/woocommerce/sync/category-mirror')
  const result = await fetchWcCategoryTree(null)

  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /did not end within 50 pages/)
  assert.equal(store.requests.length, 50, 'bounded, and bounded by the page ceiling rather than by luck')
})

test('o3d-jcx: the tax-rate walk does not end on a page count of ONE', async () => {
  reset()
  store.totalPages = 1
  store.pages['/taxes'] = { '1': [taxRate(1)], '2': [taxRate(2)] }

  const { importWcTaxRates } = await import('@/lib/connectors/woocommerce/sync/taxes')
  const result = await importWcTaxRates()

  assert.deepEqual(result.errors, [])
  assert.equal(result.mappedRates, 2, 'both pages of rates must be mapped — a missing mapping mis-taxes imported orders')
})

test('o3d-jcx: a tax-rate list that never ends is REPORTED, not passed off as complete', async () => {
  reset()
  store.totalPages = 1
  store.ignoresPage = true
  store.pages['/taxes'] = { '1': [taxRate(1)] }

  const { importWcTaxRates } = await import('@/lib/connectors/woocommerce/sync/taxes')
  const result = await importWcTaxRates()

  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /did not end within 20 pages/)
})
