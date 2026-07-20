import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Product.accountingItemId exists to stop us asking Xero "does an item with this code exist?" once
 * per distinct SKU, per invoice, forever. On a 3-line invoice that was 3 GETs to 1 POST — ~75% of
 * the cost of posting an invoice, against a cap of 1,000 calls per org per rolling 24h (o3d-3nc).
 *
 * The saving is invisible: nothing breaks if the short-circuit silently stops working, the bill just
 * comes back. So these pin the CALL COUNT, not the return value.
 */

type ProductRow = { accountingItemId: string | null; accountingItemProvenance?: string | null } | null

let storedProduct: ProductRow = null
// The connection the guard compares against. 'xero:tenant-A' is the default "matching" connection.
let activeTenantId: string | null = 'tenant-A'
const updateManyCalls: Array<{ where: unknown; data: unknown }> = []
const getPaths: string[] = []
const postPaths: string[] = []
/** Queued GET responses; the last one repeats once the queue drains. */
let getResponses: unknown[] = []
let postResponse: unknown = { ok: true, status: 200, data: { Items: [{ ItemID: 'created-id', Code: 'SKU-1', Name: 'n' }] } }

const noItems = { ok: true, status: 200, data: { Items: [] } }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingToken: {
        findUnique: async () => (activeTenantId === null ? null : { tenantId: activeTenantId }),
      },
      product: {
        findUnique: async () => storedProduct,
        updateMany: async (args: { where: unknown; data: unknown }) => {
          updateManyCalls.push(args)
          return { count: 1 }
        },
      },
    },
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      getPaths.push(path)
      return getResponses.length > 1 ? getResponses.shift() : (getResponses[0] ?? noItems)
    },
    xeroPost: async (path: string) => { postPaths.push(path); return postResponse },
  },
})

// Lazily imported: tsx transpiles this to CJS, where a top-level await will not compile. The mocks
// above are registered before any test body runs, so the first call still gets them.
type FindOrCreateItem = (
  code: string,
  name: string,
  salesAccountCode?: string,
  purchaseAccountCode?: string,
) => Promise<{ success: boolean; itemId?: string; error?: string }>

let impl: FindOrCreateItem | null = null
const findOrCreateItem: FindOrCreateItem = async (...args) => {
  if (!impl) {
    const m = await import('@/lib/connectors/xero/items')
    impl = m.findOrCreateItem as FindOrCreateItem
  }
  return impl(...args)
}

function reset() {
  storedProduct = null
  activeTenantId = 'tenant-A'
  updateManyCalls.length = 0
  getPaths.length = 0
  postPaths.length = 0
  getResponses = [noItems]
  postResponse = { ok: true, status: 200, data: { Items: [{ ItemID: 'created-id', Code: 'SKU-1', Name: 'n' }] } }
}

test('a stored item id costs ZERO Xero calls', async () => {
  reset()
  storedProduct = { accountingItemId: 'xero-item-123', accountingItemProvenance: 'xero:tenant-A' }

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.deepEqual(res, { success: true, itemId: 'xero-item-123' })
  assert.equal(getPaths.length, 0, 'a known item must not be looked up again')
  assert.equal(postPaths.length, 0, 'a known item must not be re-created')
})

test('a stored id from a DIFFERENT org is ignored and re-resolved (o3d-6nd)', async () => {
  // Re-authorising to a different Xero org (or a connector switch that bypassed disconnect) leaves the
  // old org's id cached. Serving it would post against an item that org never issued. The guard must
  // treat it as uncached and look it up fresh against the CURRENT org.
  reset()
  storedProduct = { accountingItemId: 'stale-other-org', accountingItemProvenance: 'xero:tenant-OLD' }
  getResponses = [{ ok: true, status: 200, data: { Items: [{ ItemID: 'fresh-id', Code: 'SKU-1', Name: 'Widget' }] } }]

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.deepEqual(res, { success: true, itemId: 'fresh-id' })
  assert.equal(getPaths.length, 1, 'a foreign-org id must be re-resolved, not trusted')
  assert.deepEqual(updateManyCalls, [{ where: { sku: 'SKU-1' }, data: { accountingItemId: 'fresh-id', accountingItemProvenance: 'xero:tenant-A' } }])
})

test('a legacy id with NULL provenance is re-resolved once, then stamped (o3d-6nd)', async () => {
  // Ids cached before this column existed carry NULL provenance. They cannot be trusted (that is the
  // whole bug), so they re-resolve once and backfill their own provenance.
  reset()
  storedProduct = { accountingItemId: 'legacy-id', accountingItemProvenance: null }
  getResponses = [{ ok: true, status: 200, data: { Items: [{ ItemID: 'reverified-id', Code: 'SKU-1', Name: 'Widget' }] } }]

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.deepEqual(res, { success: true, itemId: 'reverified-id' })
  assert.equal(getPaths.length, 1)
  assert.deepEqual(updateManyCalls, [{ where: { sku: 'SKU-1' }, data: { accountingItemId: 'reverified-id', accountingItemProvenance: 'xero:tenant-A' } }])
})

test('an unknown SKU is looked up once, and the answer is remembered', async () => {
  reset()
  storedProduct = { accountingItemId: null }
  getResponses = [{ ok: true, status: 200, data: { Items: [{ ItemID: 'found-id', Code: 'SKU-1', Name: 'Widget' }] } }]

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.deepEqual(res, { success: true, itemId: 'found-id' })
  assert.equal(getPaths.length, 1)
  assert.equal(postPaths.length, 0, 'an item that already exists must not be re-created')
  assert.deepEqual(updateManyCalls, [{ where: { sku: 'SKU-1' }, data: { accountingItemId: 'found-id', accountingItemProvenance: 'xero:tenant-A' } }])
})

test('a newly created item is remembered too', async () => {
  reset()
  storedProduct = { accountingItemId: null }

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.deepEqual(res, { success: true, itemId: 'created-id' })
  assert.equal(postPaths.length, 1)
  assert.deepEqual(updateManyCalls, [{ where: { sku: 'SKU-1' }, data: { accountingItemId: 'created-id', accountingItemProvenance: 'xero:tenant-A' } }])
})

test('the id recovered from a create race is remembered', async () => {
  // Two invoices for a new SKU at once: the loser gets "code already exists" and re-reads. That id
  // is just as good, and forgetting it would leave the SKU permanently uncached.
  reset()
  storedProduct = { accountingItemId: null }
  postResponse = { ok: false, status: 400, error: 'Item code already exists' }
  getResponses = [
    noItems, // first lookup: not there yet
    { ok: true, status: 200, data: { Items: [{ ItemID: 'raced-id', Code: 'SKU-1', Name: 'n' }] } }, // re-read after the collision
  ]

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.deepEqual(res, { success: true, itemId: 'raced-id' })
  assert.deepEqual(updateManyCalls, [{ where: { sku: 'SKU-1' }, data: { accountingItemId: 'raced-id', accountingItemProvenance: 'xero:tenant-A' } }])
})

test('a failed create stores nothing — a cached id must mean the item exists', async () => {
  reset()
  storedProduct = { accountingItemId: null }
  postResponse = { ok: false, status: 400, error: 'Account code is required' }

  const res = await findOrCreateItem('SKU-1', 'Widget', '200')

  assert.equal(res.success, false)
  assert.equal(updateManyCalls.length, 0, 'nothing was created, so there is nothing to remember')
})

test('an empty code is rejected before touching the database or Xero', async () => {
  reset()

  const res = await findOrCreateItem('', 'Widget', '200')

  assert.equal(res.success, false)
  assert.equal(getPaths.length, 0)
  assert.equal(updateManyCalls.length, 0)
})

test('the write is an updateMany, so a code that is not a product cannot throw', async () => {
  // Not every item code is a catalogue SKU. update() would throw RecordNotFound and fail the
  // invoice; updateMany matches zero rows and moves on.
  reset()
  storedProduct = { accountingItemId: null }

  await findOrCreateItem('Shipping', 'Shipping & Delivery', '200')

  assert.equal(updateManyCalls.length, 1)
  assert.deepEqual(updateManyCalls[0].where, { sku: 'Shipping' })
})
