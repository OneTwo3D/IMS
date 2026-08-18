import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
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
  /**
   * DOUBLE AUDIT (o3d-y89x r6): this used to return the WHOLE table for every call, ignoring
   * `where` entirely. The only caller here is `applyVariations`' candidate lookup
   * (`where: { sku: { in: [...] } }`), and answering it with every product meant a variation
   * could be matched to a row whose SKU it does not share — the fence tests would still have
   * passed. It honours the predicate now, and refuses a shape it does not model.
   */
  findMany: async ({ where }: { where?: Row } = {}) => {
    const skuIn = (where?.sku as { in?: unknown[] } | undefined)?.in
    if (Array.isArray(skuIn)) {
      return state.products.filter((row) => skuIn.includes(row.sku)).map((row) => ({ ...row }))
    }
    if (where === undefined) return state.products.map((row) => ({ ...row }))
    throw new Error(`product.findMany double got an unmodelled where: ${JSON.stringify(where)}`)
  },
  /**
   * The child-existence statement (o3d-y89x r6): `WHERE parentId IN (...) GROUP BY parentId`,
   * grouped and scoped to the ids named. Refuses anything else, so an unscoped child question
   * cannot be answered here either.
   */
  groupBy: async ({ by, where }: { by?: unknown; where?: Row } = {}) => {
    const parentIn = (where?.parentId as { in?: unknown[] } | undefined)?.in
    const grouping = Array.isArray(by) ? by.map(String) : []
    if (!Array.isArray(parentIn) || grouping.length !== 1 || grouping[0] !== 'parentId') {
      throw new Error(`product.groupBy double got an unmodelled query: ${JSON.stringify({ by, where })}`)
    }
    const candidates = parentIn.map(String)
    return [...new Set(
      state.products
        .filter((row) => row.parentId != null && candidates.includes(String(row.parentId)))
        .map((row) => String(row.parentId)),
    )].map((parentId) => ({ parentId }))
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
  /**
   * DOUBLE AUDIT (o3d-y89x r6): this used to write `data` onto EVERY product and report a count
   * of the whole table, ignoring `where` completely. Production reaches it two ways — the
   * ownership-guarded row update (`{ id }` plus an OR over externalProductId, where a count of 0
   * is how it learns the row moved) and the graph-version bump (`{ id: { in: [...] } }` with an
   * `{ increment }` op) — and a double that answers both with "yes, all of them" cannot tell a
   * fenced import from an unfenced one. It honours the predicate now.
   */
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const idIn = (where?.id as { in?: string[] } | undefined)?.in
    const targets = Array.isArray(idIn)
      ? state.products.filter((row) => idIn.includes(row.id as string))
      : state.products.filter((row) => row.id === where?.id)
    const or = where?.OR as Array<Row> | undefined
    const matched = or
      ? targets.filter((row) => or.some((clause) => {
        if ('externalProductId' in clause && clause.externalProductId === null) {
          return row.externalProductId == null
        }
        const inClause = (clause.externalProductId as { in?: bigint[] } | undefined)?.in
        return Array.isArray(inClause) && row.externalProductId != null
          && inClause.some((id) => id === row.externalProductId)
      }))
      : targets
    for (const row of matched) {
      for (const [field, value] of Object.entries(data)) {
        const increment = (value as { increment?: number } | null)?.increment
        row[field] = typeof increment === 'number' ? Number(row[field] ?? 0) + increment : value
      }
    }
    return { count: matched.length }
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
  shoppingSyncLog: {
    // `connector` is @default("woocommerce"); production never sets it and the o3d-fjqk
    // structure-conflict delete filters on it, so the double applies the default too.
    create: async ({ data }: { data: Row }) => {
      const row = { connector: 'woocommerce', ...data }
      state.syncLogs.push(row)
      return row
    },
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

test('the category mirror cache does not serve the previous store\'s tree (o3d-mlc7)', async () => {
  // Same class of leak as the mapping writes, one layer up. The mirror is cached per
  // process on a 5-minute TTL keyed only on time, so after a rebind an import running under
  // store-B credentials would resolve store-A categories and link them onto store-B
  // products. Keying the cache on the settings version too is what stops that.
  const { ensureWcCategoryTreeMirrored } = await import('@/lib/connectors/woocommerce/sync/category-mirror')
  resetState()

  const storeA = { url: 'https://a.example.com', key: 'ck_a', secret: 'cs_a' }
  const storeB = { url: 'https://b.example.com', key: 'ck_b', secret: 'cs_b' }

  await ensureWcCategoryTreeMirrored(storeA, '1')
  const fetchesAfterFirst = state.fetchCreds.length

  // Same version: the cache is doing its job, no refetch.
  await ensureWcCategoryTreeMirrored(storeA, '1')
  assert.equal(state.fetchCreds.length, fetchesAfterFirst, 'an unchanged version must still be served from cache')

  // Version moved — a rebind happened, so the cached tree belongs to the old store.
  await ensureWcCategoryTreeMirrored(storeB, '2')
  assert.ok(
    state.fetchCreds.length > fetchesAfterFirst,
    'a bumped settings version must invalidate the cached tree rather than serving the old store\'s categories',
  )
})

test('a payload fetched BEFORE a rebind is refused, even though the snapshot looks stable (o3d-mlc7)', async () => {
  // Codex's scenario, and the one an inside-only snapshot cannot see: the parent payload
  // arrives already fetched. A bulk page pulled from store A, then a rebind, then this
  // import — every read it makes itself is consistently store-B, and the write-time check
  // compares store-B against store-B and passes. Only the version the payload was FETCHED
  // under exposes the mismatch.
  const syncWcProductToIms = await loadSync()
  resetState()
  settingsVersion = '2' // the rebind already happened; the payload predates it

  const result = await syncWcProductToIms(variableProduct(), '1')

  assert.equal(result.success, false, 'a payload from the previous store must not be imported')
  assert.equal(state.products.length, 0, 'no store-A parent data may be written under store-B settings')
  assert.notEqual(result.permanent, true, 'a stale payload is retryable — it will be re-fetched')
})

test('a payload fetched under the CURRENT version imports normally (o3d-mlc7)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const result = await syncWcProductToIms(variableProduct(), '1')

  assert.equal(result.success, true, `expected success, got ${result.error}`)
  assert.ok(state.products.some((row) => row.sku === 'PARENT-SKU'))
})

test('an omitted observedVersion keeps the old contract for callers that cannot supply one (o3d-mlc7)', async () => {
  const syncWcProductToIms = await loadSync()
  resetState()

  const result = await syncWcProductToIms(variableProduct())

  assert.equal(result.success, true, 'callers without a fetch-time version must still work')
})

/**
 * The tests above exercise the version comparison itself. These pin the PRODUCTION WIRING:
 * without them, deleting `pageVersion` from the bulk call site or `syncVersion` from the
 * category-mirror call would leave every assertion above still passing (Codex review).
 * Asserted against the source because the invariant is about the call sites, and has to
 * hold for ones added later too.
 */
const PRODUCT_SYNC_SOURCE = path.join(process.cwd(), 'lib/connectors/woocommerce/sync/product-sync.ts')

test('the bulk import passes the page version to every product (o3d-mlc7)', async () => {
  const source = await readFile(PRODUCT_SYNC_SOURCE, 'utf8')

  assert.match(
    source,
    /const \{ creds: pageCreds, syncVersion: pageVersion \} = await snapshotProductSyncContext\(\)/,
    'the bulk loop must snapshot before its page fetch',
  )
  assert.match(
    source,
    /wcFetch\('\/products', params, pageCreds\)/,
    'the page fetch must use the pinned credentials',
  )
  assert.match(
    source,
    /syncWcProductToIms\(product, pageVersion\)/,
    'every product must be imported under the version its page was fetched at, or a payload '
      + 'from the previous store is written with no check able to see it',
  )
})

test('the category mirror is asked for THIS run\'s version (o3d-mlc7)', async () => {
  const source = await readFile(PRODUCT_SYNC_SOURCE, 'utf8')
  assert.match(
    source,
    /ensureWcCategoryTreeMirrored\(pinnedCreds, syncVersion\)/,
    'the mirror must be keyed on the snapshotted version, or its cache serves the previous store',
  )
})

test('the settings lock is taken in SHARED mode on the import path (o3d-mlc7)', async () => {
  // Exclusive would be correct but would serialize every product import behind a write
  // transaction that can run for a minute. Shared still blocks the rebind writers, which
  // take the key exclusively — that is the guarantee the fence actually needs.
  //
  // Scoped to the two acquisitions this fence owns. The other holders in this file are on
  // the IMS -> WC PUSH path and predate it; their mode is deliberately not asserted here.
  const source = await readFile(PRODUCT_SYNC_SOURCE, 'utf8')

  const snapshotStart = source.indexOf('async function snapshotProductSyncContext')
  assert.notEqual(snapshotStart, -1, 'the settings snapshot helper must still exist')
  assert.match(
    // A fixed window, not up to the first '}' — that lands inside the return-type
    // annotation, which silently truncated this assertion to nothing.
    source.slice(snapshotStart, snapshotStart + 900),
    /pg_advisory_xact_lock_shared\(\$\{WC_SYNC_ADVISORY_LOCK_KEY\}\)/,
    'the settings snapshot only READS, so it must take the lock shared',
  )

  const fenceStep3 = source.indexOf('Fence step 3 (o3d-mlc7)')
  assert.notEqual(fenceStep3, -1, 'the write transaction must still take the settings lock')
  assert.match(
    source.slice(fenceStep3, fenceStep3 + 1200),
    /pg_advisory_xact_lock_shared\(\$\{WC_SYNC_ADVISORY_LOCK_KEY\}\)/,
    'the write transaction must take the lock SHARED: it can run for a minute, and an '
      + 'exclusive hold that long serializes every unrelated product import',
  )
})
