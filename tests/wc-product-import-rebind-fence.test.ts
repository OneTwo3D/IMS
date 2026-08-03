import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WcFullProduct } from '../lib/connectors/woocommerce/sync/types.ts'

/**
 * o3d-mlc7: the WC → IMS product IMPORT must participate in the credential-rebind fence.
 *
 * sync-lock.ts documents a two-part fence protecting mapping writes from a credential
 * rebind or product-id cache reset: WC_SYNC_ADVISORY_LOCK_KEY, plus a monotonic
 * `wc_settings_version` that every externalProductId write re-checks. Stock sync honours it;
 * `syncWcProductToIms` never joined it. It took only the per-SKU locks, so an import
 * carrying store-A data could resume AFTER a rebind, see the freshly-nulled mapping, and
 * repopulate store-A external ids against store-B credentials — defeating the wipe and
 * pointing later operations at unrelated remote objects.
 *
 * The o3d-fsi ownership guard cannot catch this: it treats a wiped (null) mapping as
 * adoptable, which is precisely what the wipe leaves behind.
 */

type Row = Record<string, unknown>

const WC_SYNC_ADVISORY_LOCK_KEY = 918_273_645

const state = {
  products: [] as Row[],
  options: [] as Row[],
  syncLogs: [] as Row[],
  /**
   * Advisory-lock arguments grouped BY TRANSACTION, in acquisition order. Grouping matters:
   * the snapshot takes WC_SYNC_ADVISORY_LOCK_KEY in its own transaction, so a flat list makes
   * `indexOf(settingsKey)` find the SNAPSHOT's lock and the ordering assertion passes no
   * matter where the write transaction takes its own — verified by mutation, it did.
   */
  lockRuns: [] as number[][],
  /** Credentials each remote read was made with, so pinning can be asserted. */
  fetchCreds: [] as unknown[],
}

/** Bumped by the simulated rebind. */
let settingsVersion = '1'
/** When set, the write transaction observes this instead — the rebind landed mid-import. */
let versionAtWriteTime: string | null = null
/** Version the NEXT remote read flips to, simulating a rebind between pages. */
let bumpVersionOnFetch: string | null = null

function snapshot() {
  return {
    products: state.products.map((row) => ({ ...row })),
    options: state.options.map((row) => ({ ...row })),
  }
}

function restore(snap: ReturnType<typeof snapshot>) {
  state.products.splice(0, state.products.length, ...snap.products)
  state.options.splice(0, state.options.length, ...snap.options)
}

const VARIATION_ROW = {
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
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, _params: Record<string, string> = {}, creds?: unknown) => {
      state.fetchCreds.push(creds)
      if (bumpVersionOnFetch) {
        versionAtWriteTime = bumpVersionOnFetch
        bumpVersionOnFetch = null
      }
      if (!path.includes('/variations')) return { data: [], totalPages: 1, totalItems: 0, error: null }
      return { data: [VARIATION_ROW], totalPages: 1, totalItems: 1, error: null }
    },
    wcPut: async () => ({ data: null, error: null }),
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/trade/hs-classification-trigger', {
  namedExports: { invalidateStaleHsProposal: async () => {} },
})
mock.module('@/lib/security/encrypted-settings', {
  namedExports: { decryptSettingValue: (_key: string, value: string) => value },
})

let nextId = 1

const productDelegate = {
  findFirst: async ({ where }: { where: { sku?: unknown } }) =>
    state.products.find((row) => row.sku === where?.sku) ?? null,
  findMany: async () => state.products.map((row) => ({ ...row })),
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
  updateMany: async ({ data }: { data: Row }) => {
    state.products.forEach((row) => Object.assign(row, data))
    return { count: state.products.length }
  },
  upsert: async ({ where, create, update }: { where: { sku?: unknown }; create: Row; update: Row }) => {
    const row = state.products.find((candidate) => candidate.sku === where?.sku)
    if (row) {
      Object.assign(row, update)
      return row
    }
    const created = { id: `ims-${nextId++}`, ...create }
    state.products.push(created)
    return created
  },
}

const CREDENTIAL_ROWS = [
  { key: 'wc_url', value: 'https://store.example.com' },
  { key: 'wc_consumer_key', value: 'ck_test' },
  { key: 'wc_consumer_secret', value: 'cs_test' },
]

const txClient = {
  product: productDelegate,
  productOption: {
    upsert: async ({ create }: { create: Row }) => {
      state.options.push({ ...create })
      return create
    },
  },
  shoppingSyncLog: { create: async ({ data }: { data: Row }) => { state.syncLogs.push(data); return data } },
  setting: {
    upsert: async () => ({}),
    // The snapshot read, taken before any remote call.
    findMany: async () => [...CREDENTIAL_ROWS, { key: 'wc_settings_version', value: settingsVersion }],
    // The re-check inside the write transaction. `versionAtWriteTime` is what a rebind
    // landing mid-import would leave here.
    findUnique: async () => ({ key: 'wc_settings_version', value: versionAtWriteTime ?? settingsVersion }),
  },
  $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const run = state.lockRuns[state.lockRuns.length - 1]
    run?.push(Number(values[0]))
    return 1
  },
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
        state.lockRuns.push([])
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
    attributes: [{ name: 'Colour', options: ['Red'], variation: true, position: 0 }],
    categories: [],
    meta_data: [],
    variations: [111],
  } as unknown as WcFullProduct
}

function resetState() {
  state.products.length = 0
  state.options.length = 0
  state.syncLogs.length = 0
  state.lockRuns.length = 0
  state.fetchCreds.length = 0
  nextId = 1
  settingsVersion = '1'
  versionAtWriteTime = null
  bumpVersionOnFetch = null
}

test('a rebind landing between the remote reads and the write writes NOTHING (o3d-mlc7)', async () => {
  // The scenario the fence exists for: the import has store-A data in hand, a rebind wipes
  // the mapping and bumps the version, and the import must NOT repopulate store-A ids.
  const syncWcProductToIms = await loadSync()
  resetState()
  bumpVersionOnFetch = '2'

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, false, 'an overtaken import must not report success')
  assert.equal(state.products.length, 0, 'no product row may survive a rebind mid-import')
  assert.equal(state.options.length, 0, 'no product option may survive a rebind mid-import')

  // Transient, not permanent: nothing is wrong with the product, the run was overtaken.
  // A PERMANENT_CONFLICT prefix would stop the reconcile ever re-importing it.
  const failed = state.syncLogs.find((log) => log.status === 'FAILED')
  assert.ok(failed, 'the abandoned import must be visible as FAILED')
  assert.notEqual(result.permanent, true, 'an overtaken import is retryable, not a permanent conflict')
  assert.ok(
    !String(failed?.errorMessage ?? '').startsWith('PERMANENT_CONFLICT'),
    'an overtaken import is retryable and must not be marked permanent',
  )
})

test('an undisturbed import still completes normally (o3d-mlc7)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, `expected success, got ${result.error}`)
  assert.ok(state.products.some((row) => row.sku === 'PARENT-SKU'), 'the parent must be written')
})

test('every remote read uses the PINNED credentials, not ambient ones (o3d-mlc7)', async () => {
  // The second half of the defect: fetchAllWcVariations resolved credentials per call, so a
  // rebind mid-import could pair a store-A parent payload with store-B variation data inside
  // one transaction. Passing `undefined` is what makes wcFetch resolve them ambiently.
  const syncWcProductToIms = await loadSync()
  resetState()

  await syncWcProductToIms(variableProduct())

  assert.ok(state.fetchCreds.length > 0, 'the variable product must have triggered a remote read')
  for (const creds of state.fetchCreds) {
    assert.notEqual(creds, undefined, 'a remote read resolved credentials ambiently instead of using the pinned set')
  }
  assert.deepEqual(
    state.fetchCreds[0],
    { url: 'https://store.example.com', key: 'ck_test', secret: 'cs_test' },
    'the pinned credentials must be the ones snapshotted under the advisory lock',
  )
})

test('the settings lock is taken BEFORE any per-SKU lock (o3d-mlc7)', async () => {
  // Both lock families are taken inside the WRITE transaction, so a fixed order between them
  // is the deadlock-freedom argument. Asserted against that transaction's own run: the
  // snapshot takes the same settings key in a separate transaction, and looking at a flat
  // list would just find that one and pass regardless.
  const syncWcProductToIms = await loadSync()
  resetState()

  await syncWcProductToIms(variableProduct())

  const writeRun = state.lockRuns[state.lockRuns.length - 1] ?? []
  const settingsLockIndex = writeRun.indexOf(WC_SYNC_ADVISORY_LOCK_KEY)
  assert.notEqual(settingsLockIndex, -1, 'the write transaction must take WC_SYNC_ADVISORY_LOCK_KEY itself')

  const perSkuIndices = writeRun
    .map((lock, index) => ({ lock, index }))
    .filter(({ lock }) => lock !== WC_SYNC_ADVISORY_LOCK_KEY)
    .map(({ index }) => index)
  assert.ok(perSkuIndices.length > 0, 'the per-SKU locks must still be taken')
  for (const index of perSkuIndices) {
    assert.ok(
      settingsLockIndex < index,
      'the settings lock must precede every per-SKU lock, or the two families can deadlock',
    )
  }
})
