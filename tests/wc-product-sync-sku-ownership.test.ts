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
  setting: { upsert: async () => ({}), findUnique: async () => null },
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

test('every SKU written is locked, in sorted order, before the first lookup (o3d-fsi)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `sync should succeed, got: ${result.error}`)
  assert.deepEqual(
    state.advisoryLocks,
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
  assert.deepEqual(state.advisoryLocks, [10, 20, 9000], 'ordered by lock id, not by SKU')
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
    state.advisoryLocks,
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
