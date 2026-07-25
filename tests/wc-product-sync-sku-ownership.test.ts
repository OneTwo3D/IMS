import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'
import { wcProductWriteLockKeys } from '../lib/connectors/woocommerce/sync-lock.ts'
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
  advisoryLocks: [] as string[],
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

const productDelegate = {
  findFirst: async ({ where }: { where: { sku?: unknown } }) => findProductBySku(where?.sku),
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
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.advisoryLocks.push(String(values[values.length - 1] ?? strings.join('')))
    return 1
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txClient,
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
  variationPages = {
    '1': [wcVariation(111, 'VAR-1', 'Red'), wcVariation(112, 'VAR-2', 'Blue')],
  }
}

// --- wcProductWriteLockKeys -------------------------------------------------

test('lock keys cover the parent and every variation SKU, deduped and sorted (o3d-fsi)', () => {
  assert.deepEqual(
    wcProductWriteLockKeys('PARENT', ['VAR-B', 'VAR-A', 'VAR-B']),
    ['PARENT', 'VAR-A', 'VAR-B'],
  )
})

test('lock key order is identical for two payloads sharing a SKU — the deadlock-freedom argument (o3d-fsi)', () => {
  // Two different parents that happen to share SHARED-SKU. Whatever else each one
  // touches, they must request SHARED-SKU at a consistent point in a single global
  // order, or each could hold a key the other is waiting on.
  const a = wcProductWriteLockKeys('P-A', ['SHARED-SKU', 'A-ONLY'])
  const b = wcProductWriteLockKeys('P-B', ['B-ONLY', 'SHARED-SKU'])

  const shared = a.filter((key) => b.includes(key))
  assert.deepEqual(shared, b.filter((key) => a.includes(key)), 'shared keys appear in the same relative order')
  assert.deepEqual(a, [...a].sort(), 'A is globally sorted')
  assert.deepEqual(b, [...b].sort(), 'B is globally sorted')
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
    ['PARENT-SKU', 'VAR-1', 'VAR-2'],
    'the parent SKU alone is not enough: a variant SKU must be locked too, and in sorted order',
  )
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
  assert.deepEqual(state.advisoryLocks, ['DUP', 'PARENT-SKU'], 'the repeated SKU is locked once')
})
