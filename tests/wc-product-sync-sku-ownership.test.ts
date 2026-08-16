import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'
import {
  resolveWcProductWriteLockIds,
  wcProductWriteLockKeys,
} from '../lib/connectors/woocommerce/sync-lock.ts'
import {
  assertWcRowNotClaimedByAnotherWcObject,
  isWcSkuOwnershipConflict,
} from '../lib/connectors/woocommerce/sync/product-sync-errors.ts'

// o3d-fsi: the write transaction must lock EVERY SKU it touches, and must never
// reassign a row another WooCommerce object already owns.
//
// Before the fix the advisory lock was keyed on the PARENT sku only. Two different
// parents sharing one variation SKU therefore took DIFFERENT locks, both snapshotted
// that variation as absent, and raced on create. The loser's retry then found the
// winner's row and took the UPDATE branch — which overwrites type, parentId and
// externalProductId. The same input could succeed by STEALING and REPARENTING another
// product's row: silent corruption, not a benign retry.

type Row = Record<string, unknown>

const state = {
  products: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  /** Advisory-lock IDs handed to pg_advisory_xact_lock, in acquisition order. */
  advisoryLocks: [] as number[],
  /**
   * o3d-4kfh r7 (Codex finding 2): `ProductComponent` rows, so the connector's graph-version bump
   * can walk the KIT ancestors the way it does in production. Without them the bump would appear to
   * work on the edited product alone and a nested-kit regression would be invisible.
   */
  components: [] as Array<{ productId: string; componentId: string }>,
}

function snapshot() {
  return {
    products: state.products.map((row) => ({ ...row })),
    options: state.options.map((row) => ({ ...row })),
    syncLogs: state.syncLogs.map((row) => ({ ...row })),
    components: state.components.map((row) => ({ ...row })),
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  state.products.splice(0, state.products.length, ...snap.products)
  state.options.splice(0, state.options.length, ...snap.options)
  state.syncLogs.splice(0, state.syncLogs.length, ...snap.syncLogs)
  state.components.splice(0, state.components.length, ...snap.components)
}

let nextId = 1
// Variations returned for the parent under test. Keyed by page like the real endpoint.
let variationPages: Record<string, Row[]> = {}
let variationTotalPages = 1

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
      return {
        data: variationPages[page] ?? [],
        totalPages: variationTotalPages,
        totalItems: 0,
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

function findProductBySku(sku: unknown) {
  return state.products.find((row) => row.sku === sku) ?? null
}

/**
 * Emulates the conditional ownership update: `id` plus an OR over externalProductId.
 * Returning { count: 0 } when the predicate does not match is what the production code
 * reads as "someone reassigned this row underneath us".
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

  Object.assign(row, data)
  return { count: 1 }
}

const productDelegate = {
  // o3d-4kfh r7: DETACHED COPIES, as Prisma returns. These used to hand back the live state object,
  // so a later `Object.assign` in the update path mutated the caller's "pre-update snapshot" too —
  // `existing.type` read AFTER the write returned the NEW type, and a test could not distinguish
  // "the code captured the old value" from "the code read a value that had already moved".
  findFirst: async ({ where }: { where: { sku?: unknown } }) => {
    const row = findProductBySku(where?.sku)
    return row ? { ...row } : null
  },
  findUnique: async ({ where }: { where: { id: string } }) => {
    const row = state.products.find((candidate) => candidate.id === where.id)
    return row ? { ...row } : null
  },
  // TWO shapes, and they are different questions. `{ id: '...' }` (+ an OR over externalProductId)
  // is the conditional ownership update. `{ id: { in: [...] } }` with an `{ increment }` op is
  // `bumpFulfillmentGraphVersions` (o3d-4kfh r7) — which `updateManyMatching` silently matched
  // NOTHING for, because it compares `row.id === where.id` and `where.id` is an object there. A
  // double that answers a real call with a silent `{ count: 0 }` cannot tell a working bump from an
  // absent one.
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const idIn = (where.id as { in?: string[] } | undefined)?.in
    if (Array.isArray(idIn)) {
      const rows = state.products.filter((row) => idIn.includes(row.id as string))
      for (const row of rows) {
        for (const [field, value] of Object.entries(data)) {
          const increment = (value as { increment?: number } | null)?.increment
          row[field] = typeof increment === 'number'
            ? Number(row[field] ?? 0) + increment
            : value
        }
      }
      return { count: rows.length }
    }
    return updateManyMatching(where, data)
  },
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
  // o3d-4kfh r7: the ancestor walk `bumpFulfillmentGraphVersions` shares with the component-graph
  // guard. Honours the `componentId: { in }` predicate and the parent's TYPE filter, because a BOM
  // parent is a fulfilment leaf and must not be walked through.
  productComponent: {
    findMany: async ({ where }: { where: { componentId: { in: string[] } } }) => state.components
      .filter((row) => where.componentId.in.includes(row.componentId))
      .map((row) => ({
        productId: row.productId,
        product: { type: state.products.find((p) => p.id === row.productId)?.type ?? 'SIMPLE' },
      })),
  },
  // Only reached by `findComponentGraphEditBlockers`, which the connector path deliberately does
  // NOT call. Present and honest so that a change which starts calling it fails loudly on the
  // fixture rather than throwing an unrelated TypeError.
  salesOrderLine: {
    findMany: async () => [],
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
    // The credential-rebind fence (o3d-mlc7) snapshots settings before any remote read.
    // No rows => credentials null and version '0', which findUnique agrees with, so the
    // fence is a no-op here and these suites keep testing what they say they test.
    findMany: async () => [],
    findUnique: async () => null,
  },
  // Records the lock ID argument of each pg_advisory_xact_lock call, in order.
  $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    state.advisoryLocks.push(Number(values[values.length - 1]))
    return 1
  },
}

/**
 * Stand-in for Postgres `hashtext`. The real one is an internal 32-bit hash; all the
 * code under test relies on is that it is DETERMINISTIC and that distinct SKUs may
 * collide. `hashOverrides` lets a test force a collision or an order inversion.
 */
let hashOverrides: Record<string, number> = {}
function fakeHashtext(sku: string): number {
  if (sku in hashOverrides) return hashOverrides[sku]
  let hash = 0
  for (const char of sku) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return hash
}

const dbMock = {
  ...txClient,
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const skus = values[0] as string[]
    // Mirrors SELECT DISTINCT hashtext(sku) FROM unnest($1) — set semantics, unordered.
    // Returned deliberately SHUFFLED so a test can only pass if the caller sorts.
    const distinct = [...new Set(skus.map(fakeHashtext))].reverse()
    return distinct.map((lock_id) => ({ lock_id }))
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

function variableProduct(overrides: Partial<Row> = {}): WcFullProduct {
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
    ...overrides,
  } as unknown as WcFullProduct
}

function imsRow(row: Row): Row {
  return {
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
    externalProductId: null,
    ...row,
  }
}

function resetState() {
  state.products.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.advisoryLocks.length = 0
  state.components.length = 0
  nextId = 1
  variationTotalPages = 1
  hashOverrides = {}
  variationPages = {
    '1': [wcVariation(111, 'VAR-1', 'Red'), wcVariation(112, 'VAR-2', 'Blue')],
  }
}

// --- wcProductWriteLockKeys -------------------------------------------------

test('lock keys cover the parent and every variation SKU, deduped (o3d-fsi)', () => {
  assert.deepEqual(
    [...wcProductWriteLockKeys('PARENT', ['VAR-B', 'VAR-A', 'VAR-B'])].sort(),
    ['PARENT', 'VAR-A', 'VAR-B'],
  )
})

test('lock ids come back sorted ASCENDING BY ID, not by SKU (o3d-fsi)', async () => {
  // Sorting SKU strings would be the wrong invariant: the lock identity is hashtext(sku),
  // and string order and hash order are unrelated permutations. Force an inversion —
  // 'AAA' hashes ABOVE 'ZZZ' — and the ids must still come back ascending.
  hashOverrides = { AAA: 900, ZZZ: 100 }
  const ids = await resolveWcProductWriteLockIds(dbMock, ['AAA', 'ZZZ'])

  assert.deepEqual(ids, [100, 900], 'ascending by lock id, so SKU order is irrelevant')
})

test('two payloads sharing a SKU request their shared lock ids in the same order (o3d-fsi)', async () => {
  // The deadlock-freedom argument, stated against LOCK IDS. Payload A is lexically
  // sorted one way and payload B the other; both must still agree on id order.
  hashOverrides = { 'A-ONLY': 500, SHARED: 300, 'B-ONLY': 100 }

  const a = await resolveWcProductWriteLockIds(dbMock, wcProductWriteLockKeys('A-ONLY', ['SHARED']))
  const b = await resolveWcProductWriteLockIds(dbMock, wcProductWriteLockKeys('B-ONLY', ['SHARED']))

  assert.deepEqual(a, [300, 500])
  assert.deepEqual(b, [100, 300])
  const sharedInA = a.filter((id) => b.includes(id))
  const sharedInB = b.filter((id) => a.includes(id))
  assert.deepEqual(sharedInA, sharedInB, 'shared ids are requested in the same relative order')
})

test('two SKUs that collide on hashtext collapse to ONE lock id (o3d-fsi)', async () => {
  // A real collision must over-serialize, never produce two ids that could be taken in
  // opposite orders by two transactions.
  hashOverrides = { 'SKU-ONE': 42, 'SKU-TWO': 42 }
  const ids = await resolveWcProductWriteLockIds(dbMock, ['SKU-ONE', 'SKU-TWO'])

  assert.deepEqual(ids, [42], 'one lock covers both colliding SKUs')
})

test('an empty SKU list needs no round trip and no locks (o3d-fsi)', async () => {
  let called = false
  const client = { $queryRaw: async () => { called = true; return [] } }
  assert.deepEqual(await resolveWcProductWriteLockIds(client, []), [])
  assert.equal(called, false)
})

// --- assertWcRowNotClaimedByAnotherWcObject ---------------------------------

test('an unclaimed row is adoptable — the ordinary first-import path (o3d-fsi)', () => {
  assert.doesNotThrow(() =>
    assertWcRowNotClaimedByAnotherWcObject({ id: 'ims-1', sku: 'S', externalProductId: null }, 111),
  )
  assert.doesNotThrow(
    () => assertWcRowNotClaimedByAnotherWcObject({ id: 'ims-1', sku: 'S' }, 111),
    'a row shape without the column at all still reads as unclaimed, not as a TypeError',
  )
})

test('a row already claimed by the SAME WC object is writable (o3d-fsi)', () => {
  assert.doesNotThrow(() =>
    assertWcRowNotClaimedByAnotherWcObject({ id: 'ims-1', sku: 'S', externalProductId: BigInt(111) }, 111),
  )
})

test('a row claimed by a DIFFERENT WC object is refused, naming both claimants (o3d-fsi)', () => {
  let thrown: unknown
  try {
    assertWcRowNotClaimedByAnotherWcObject({ id: 'ims-1', sku: 'SHARED', externalProductId: BigInt(999) }, 111)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'must throw')
  assert.ok(isWcSkuOwnershipConflict(thrown), 'must be recognisable as an ownership conflict')
  const message = String(thrown)
  assert.ok(message.includes('999'), 'names the existing claimant')
  assert.ok(message.includes('111'), 'names the incoming object')
  assert.ok(message.includes('SHARED'), 'names the SKU')
})

// --- end-to-end through syncWcProductToIms ----------------------------------

/**
 * The per-SKU locks only. The credential-rebind fence (o3d-mlc7) also takes
 * WC_SYNC_ADVISORY_LOCK_KEY — once when it snapshots settings, once as the write
 * transaction's first statement — and that key is not part of the per-SKU protocol these
 * assertions are about. Its presence and its ordering relative to the per-SKU locks are
 * covered by tests/wc-product-import-rebind-fence.test.ts.
 */
const WC_SYNC_ADVISORY_LOCK_KEY = 918_273_645
function perSkuLocks(): number[] {
  return state.advisoryLocks.filter((lock) => lock !== WC_SYNC_ADVISORY_LOCK_KEY)
}

test('every SKU written is locked, in sorted order, before the first lookup (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `sync should succeed, got: ${result.error}`)
  assert.deepEqual(
    perSkuLocks(),
    [fakeHashtext('PARENT-SKU'), fakeHashtext('VAR-1'), fakeHashtext('VAR-2')].sort((a, b) => a - b),
    'the parent SKU alone is not enough: every variant SKU is locked too, ascending by lock id',
  )
})

test('lock ids are acquired ascending even when SKU order disagrees (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // PARENT-SKU is lexically first but hashes LAST. Acquisition must follow the hash.
  hashOverrides = { 'PARENT-SKU': 9000, 'VAR-1': 10, 'VAR-2': 20 }

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `sync should succeed, got: ${result.error}`)
  assert.deepEqual(perSkuLocks(), [10, 20, 9000], 'ordered by lock id, not by SKU')
})

test('a variant SKU owned by ANOTHER WC object is refused, not reparented (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // VAR-1 already belongs to a different parent's variation (WC id 999).
  state.products.push(
    imsRow({
      id: 'ims-other-var',
      sku: 'VAR-1',
      name: 'Other Parent — Red',
      type: 'VARIANT',
      parentId: 'ims-other-parent',
      externalProductId: BigInt(999),
    }),
  )
  const before = snapshot()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false, 'the import must fail rather than steal the row')
  assert.match(String(result.error), /already mapped to WooCommerce object 999/)

  assert.deepEqual(
    state.products.find((row) => row.id === 'ims-other-var'),
    before.products.find((row) => row.id === 'ims-other-var'),
    'the other product\'s variation row must be untouched — no type/parentId/externalProductId rewrite',
  )
  assert.equal(findProductBySku('PARENT-SKU'), null, 'the whole write rolls back, parent included')
  assert.equal(state.products.length, 1, 'no rows created')

  const statuses = state.syncLogs.map((log) => log.status)
  assert.ok(statuses.includes('FAILED'), 'the conflict is visible as a FAILED log')
  assert.ok(!statuses.includes('SYNCED'), 'nothing may be marked SYNCED')
})

test('a PARENT SKU owned by another WC product is refused (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  state.products.push(
    imsRow({
      id: 'ims-other-simple',
      sku: 'PARENT-SKU',
      name: 'A different WC product',
      type: 'SIMPLE',
      externalProductId: BigInt(777),
    }),
  )
  const before = snapshot()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false)
  assert.match(String(result.error), /already mapped to WooCommerce object 777/)
  assert.deepEqual(state.products, before.products, 'the other product must be untouched')
})

test('an UNCLAIMED existing row is still adopted — first import must keep working (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // An IMS-native catalogue: rows exist, none carry a WC mapping yet.
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Native Parent', type: 'VARIABLE' }))
  state.products.push(
    imsRow({ id: 'ims-var', sku: 'VAR-1', name: 'Native Variant', type: 'VARIANT', parentId: 'ims-parent' }),
  )

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `adoption must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.externalProductId, BigInt(42), 'the parent takes the WC mapping')
  assert.equal(findProductBySku('VAR-1')?.externalProductId, BigInt(111), 'the variant takes its WC mapping')
})

test('a row already mapped to this same WC object updates normally (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  state.products.push(
    imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Old Name', type: 'VARIABLE', externalProductId: BigInt(42) }),
  )
  state.products.push(
    imsRow({
      id: 'ims-var',
      sku: 'VAR-1',
      name: 'Old Variant Name',
      type: 'VARIANT',
      parentId: 'ims-parent',
      externalProductId: BigInt(111),
    }),
  )

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `re-sync must succeed, got: ${result.error}`)
  assert.equal(findProductBySku('PARENT-SKU')?.name, 'Parent Widget', 'the parent is updated in place')
  assert.equal(findProductBySku('VAR-1')?.id, 'ims-var', 'no new row was created')
})

test('one SKU repeated across variations of the SAME parent stays tolerated (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  // WC permits this; the sync has always resolved it last-one-wins. The ownership guard
  // must not turn a long-tolerated quirk into a hard import failure.
  variationPages = { '1': [wcVariation(111, 'DUP', 'Red'), wcVariation(112, 'DUP', 'Blue')] }

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `duplicate variation SKUs must not fail the import, got: ${result.error}`)
  assert.equal(state.products.filter((row) => row.sku === 'DUP').length, 1, 'one row, not two')
  assert.equal(findProductBySku('DUP')?.externalProductId, BigInt(112), 'last variation wins, as before')
  assert.deepEqual(
    perSkuLocks(),
    [fakeHashtext('DUP'), fakeHashtext('PARENT-SKU')].sort((a, b) => a - b),
    'the repeated SKU is locked once',
  )
})

test('a duplicate variation SKU survives a SECOND identical sync (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  variationPages = { '1': [wcVariation(111, 'DUP', 'Red'), wcVariation(112, 'DUP', 'Blue')] }

  // First import leaves the row mapped to the LAST duplicate (112). If the guard only
  // accepted the variation currently being applied, the re-sync below would reach
  // variation 111 first, find a row owned by 112, and refuse — turning a tolerated WC
  // quirk into a permanent import failure. Every id in the duplicate group is accepted.
  assert.equal((await syncWcProductToIms(variableProduct())).success, true, 'first sync')
  assert.equal(findProductBySku('DUP')?.externalProductId, BigInt(112))

  const second = await syncWcProductToIms(variableProduct())

  assert.equal(second.success, true, `the re-sync must also succeed, got: ${second.error}`)
  assert.equal(state.products.filter((row) => row.sku === 'DUP').length, 1, 'still one row')
  assert.equal(findProductBySku('DUP')?.externalProductId, BigInt(112), 'still last-one-wins')
})

test('an id absent from the duplicate group is still refused (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  variationPages = { '1': [wcVariation(111, 'DUP', 'Red'), wcVariation(112, 'DUP', 'Blue')] }

  // Accepting the whole duplicate group must not become "accept anything": a row owned
  // by an object this payload does not contain is still someone else's.
  state.products.push(imsRow({ id: 'ims-outsider', sku: 'DUP', name: 'Outsider', externalProductId: BigInt(555) }))
  const before = snapshot()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false)
  assert.match(String(result.error), /already mapped to WooCommerce object 555/)
  assert.deepEqual(state.products, before.products, 'the outsider row is untouched')
})

test('a mapping reassigned BETWEEN the read and the write is caught by the update itself (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // VAR-1 exists UNCLAIMED, so the snapshot check passes cleanly. A writer outside the SKU
  // advisory-lock protocol — persistMappingIfVersionMatches, the stock-sync mapping path —
  // then claims it for WC object 999 before this transaction reaches its update. The stale
  // check has already said yes; only a conditional update can still refuse.
  state.products.push(imsRow({ id: 'ims-var', sku: 'VAR-1', name: 'Unclaimed', type: 'VARIANT' }))

  const realFindMany = productDelegate.findMany
  productDelegate.findMany = async (args) => {
    const rows = await realFindMany(args)
    // The interleaving: after this read is served, the outsider commits its claim.
    const victim = state.products.find((row) => row.id === 'ims-var')
    if (victim && rows.some((row) => row.sku === 'VAR-1')) victim.externalProductId = BigInt(999)
    return rows
  }

  try {
    const result = await syncWcProductToIms(variableProduct())

    assert.equal(result.success, false, 'the reassignment must be caught, not overwritten')
    assert.match(String(result.error), /already mapped to WooCommerce object 999/)
    // The victim row is back to its pre-transaction state — this double rolls back by
    // snapshot, so the outsider's mid-transaction write is undone here too. What matters is
    // that this import did NOT reparent it: no VARIANT type, no parentId, no WC id of ours.
    const victim = state.products.find((row) => row.id === 'ims-var')
    assert.equal(victim?.name, 'Unclaimed', 'fields not overwritten')
    assert.equal(victim?.parentId, undefined, 'not reparented')
    assert.notEqual(victim?.externalProductId, BigInt(111), 'our variation id was not written onto it')
    assert.equal(findProductBySku('PARENT-SKU'), null, 'the whole transaction rolled back')
  } finally {
    productDelegate.findMany = realFindMany
  }
})

test('the PARENT update is guarded the same way (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-SKU', name: 'Unclaimed', type: 'VARIABLE' }))

  const realFindFirst = productDelegate.findFirst
  productDelegate.findFirst = async (args) => {
    const row = await realFindFirst(args)
    const victim = state.products.find((candidate) => candidate.id === 'ims-parent')
    if (victim && row) victim.externalProductId = BigInt(888)
    return row
  }

  try {
    const result = await syncWcProductToIms(variableProduct())

    assert.equal(result.success, false)
    assert.match(String(result.error), /already mapped to WooCommerce object 888/)
    assert.equal(state.products.find((row) => row.id === 'ims-parent')?.name, 'Unclaimed', 'not overwritten')
  } finally {
    productDelegate.findFirst = realFindFirst
  }
})

test('a row DELETED mid-import is a transient failure, not an ownership conflict (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  state.products.push(imsRow({ id: 'ims-var', sku: 'VAR-1', name: 'Doomed', type: 'VARIANT' }))

  const realFindMany = productDelegate.findMany
  productDelegate.findMany = async (args) => {
    const rows = await realFindMany(args)
    // Deleted after this read: the conditional update will match zero rows for a reason that has
    // nothing to do with ownership.
    if (rows.some((row) => row.sku === 'VAR-1')) {
      const index = state.products.findIndex((row) => row.id === 'ims-var')
      if (index >= 0) state.products.splice(index, 1)
    }
    return rows
  }

  try {
    const result = await syncWcProductToIms(variableProduct())

    assert.equal(result.success, false)
    // Must NOT be an ownership conflict: o3d-gtk classifies those PERMANENT, which would ack the
    // webhook and strand the product for good. Staying transient is what lets o3d-i0y (PR #551)
    // retry it once that lands.
    assert.doesNotMatch(String(result.error), /already mapped to WooCommerce object/)
    assert.match(String(result.error), /disappeared while importing it/)
  } finally {
    productDelegate.findMany = realFindMany
  }
})

test('a later duplicate sibling sees the FIRST sibling\'s applied fields, not stale ones (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  // Both variations share a SKU. Only the first carries a description; the second omits it, so it
  // falls back to `existing.description`. That fallback must read the value the first just wrote,
  // otherwise the second update reinstates the stale IMS text and the fresh data is lost.
  const first = wcVariation(111, 'DUP', 'Red')
  first.description = 'Fresh description from WooCommerce'
  const second = wcVariation(112, 'DUP', 'Blue')
  second.description = ''
  variationPages = { '1': [first, second] }

  state.products.push(imsRow({ id: 'ims-dup', sku: 'DUP', name: 'Old', description: 'STALE' }))

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `expected success, got: ${result.error}`)
  assert.equal(
    findProductBySku('DUP')?.description,
    'Fresh description from WooCommerce',
    'the second sibling must not write the pre-import description back',
  )
})

// ---------------------------------------------------------------------------
// o3d-4kfh r7 (Codex finding 2) — the connector is a component-graph writer, and must bump.
//
// `OrderAllocation.fulfillmentGraphVersion` is what tells commitment and dispatch that a row was
// expanded from a recipe that no longer exists. The editor and the CSV import bump it — for the
// edited product AND every KIT above it — in the same transaction as the type write. This path did
// not, so an IMS KIT adopted by SKU could be re-typed with every allocation stamp and every ancestor
// version left untouched: the rows were reinterpreted against a different graph while still
// MATCHING, which is precisely the state the stamp exists to make unreachable.
//
// These tests are about the BUMP, not about whether the connector should be allowed to make the
// change at all — that is #617 (branch o3d-y89x-wc-type-guard), which stops the downgrade. The two
// compose: with #617 in, a preserved type makes `nextType === existing.type` and the bump below is
// a no-op that reads nothing; what remains is the legitimate type change, which must still bump.
// ---------------------------------------------------------------------------

function simpleProduct(overrides: Partial<Row> = {}): WcFullProduct {
  return {
    id: 77,
    sku: 'KIT-SKU',
    name: 'Adopted Kit',
    type: 'simple',
    status: 'publish',
    description: '',
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
    ...overrides,
  } as unknown as WcFullProduct
}

function versionOf(sku: string): number {
  return Number(findProductBySku(sku)?.fulfillmentGraphVersion ?? 0)
}

test('o3d-4kfh r7: a connector type change that loses KIT-ness bumps the version, and every KIT ancestor\'s', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()
  variationPages = { '1': [] }

  // PARENT-KIT (a KIT) contains KIT-SKU (a KIT). WooCommerce claims KIT-SKU is a simple product.
  state.products.push(imsRow({ id: 'ims-kit', sku: 'KIT-SKU', name: 'Adopted Kit', type: 'KIT', fulfillmentGraphVersion: 3 }))
  state.products.push(imsRow({ id: 'ims-parent', sku: 'PARENT-KIT', name: 'Parent Kit', type: 'KIT', fulfillmentGraphVersion: 8 }))
  state.components.push({ productId: 'ims-parent', componentId: 'ims-kit' })

  const result = await syncWcProductToIms(simpleProduct())

  assert.equal(result.success, true, `expected success, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.type, 'SIMPLE', 'the connector really did re-type it')
  assert.equal(versionOf('KIT-SKU'), 4, 'the edited product\'s stamp moves')
  assert.equal(
    versionOf('PARENT-KIT'),
    9,
    'and so does the KIT above it — its expansion changed even though its own row did not',
  )
})

test('o3d-4kfh r7: an ordinary connector update that changes no KIT-ness bumps nothing', async () => {
  // The boundary. Bumping on every import would refuse commitments across the catalogue every time
  // the reconcile sweep ran, which is a worse failure than the one being fixed.
  const syncWcProductToIms = await loadSync()
  resetState()
  variationPages = { '1': [] }
  state.products.push(imsRow({ id: 'ims-simple', sku: 'KIT-SKU', name: 'Plain', type: 'SIMPLE', fulfillmentGraphVersion: 3 }))

  const result = await syncWcProductToIms(simpleProduct({ name: 'Renamed' }))

  assert.equal(result.success, true, `expected success, got: ${result.error}`)
  assert.equal(findProductBySku('KIT-SKU')?.name, 'Renamed', 'the import still applied')
  assert.equal(versionOf('KIT-SKU'), 3, 'and the version did not move')
})

test('o3d-4kfh r7: the VARIATION path bumps too when it overwrites a KIT', async () => {
  // The same corruption through the other door: an IMS KIT whose SKU is adopted as a WC variation
  // is rewritten to VARIANT by applyVariations, which is just as much a KIT-ness change.
  const syncWcProductToIms = await loadSync()
  resetState()
  variationPages = { '1': [wcVariation(111, 'VAR-1', 'Red')] }

  state.products.push(imsRow({ id: 'ims-parent-wc', sku: 'PARENT-SKU', name: 'Parent Widget', type: 'VARIABLE', fulfillmentGraphVersion: 0 }))
  state.products.push(imsRow({ id: 'ims-var-kit', sku: 'VAR-1', name: 'Adopted Kit', type: 'KIT', fulfillmentGraphVersion: 2 }))
  state.products.push(imsRow({ id: 'ims-ancestor', sku: 'ANCESTOR-KIT', name: 'Ancestor', type: 'KIT', fulfillmentGraphVersion: 5 }))
  state.components.push({ productId: 'ims-ancestor', componentId: 'ims-var-kit' })

  const result = await syncWcProductToIms(variableProduct({ variations: [111] }))

  assert.equal(result.success, true, `expected success, got: ${result.error}`)
  assert.equal(findProductBySku('VAR-1')?.type, 'VARIANT')
  assert.equal(versionOf('VAR-1'), 3)
  assert.equal(versionOf('ANCESTOR-KIT'), 6, 'the ancestor walk runs on this path as well')
})
