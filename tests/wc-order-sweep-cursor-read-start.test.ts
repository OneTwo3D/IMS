import assert from 'node:assert/strict'
import { cursorRaw } from './helpers/cursor-raw'
import test, { mock } from 'node:test'

/**
 * The order sweep's cursor is the time the run STARTED (less an overlap), never the time it committed.
 *
 * Before: the commit stamped `new Date()`. An order modified after the final empty-page read but
 * before that stamp was never read by the run, yet sat behind the next sweep's `modified_after`.
 */

const T0 = Date.parse('2026-11-14T10:00:00.000Z')
const state = {
  settings: new Map<string, string>(),
  /** Every `modified_after` the sweep asked WooCommerce for, with the stand-in clock's reading. */
  reads: [] as Array<{ modifiedAfter: string | undefined; at: number }>,
  /** A hook run on the FINAL (empty-page) read, i.e. between the last read and the commit. */
  onEmptyPage: null as null | (() => void),
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => state.settings.get(key) ?? null,
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, state.settings.get(key)])),
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (path === '/orders') {
        state.reads.push({ modifiedAfter: params.modified_after, at: Date.now() })
        state.onEmptyPage?.()
      }
      return { data: [], totalPages: 1, totalItems: 0 }
    },
    wcPut: async () => ({ data: null }),
    MAX_WC_PAGE_WALK_PAGES: 1000,
    describeUnendedWcPageWalk: (collection: string, pagesRead: number) =>
      `The WooCommerce ${collection} walk did not reach an empty page within ${pagesRead} page(s).`,
  },
})

const sweepDb: Record<string, unknown> = {}
mock.module('@/lib/db', {
  namedExports: {
    db: Object.assign(sweepDb, {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.flatMap((key) => (state.settings.has(key) ? [{ key, value: state.settings.get(key)! }] : [])),
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
          state.settings.set(where.key, create.value)
          return {}
        },
      },
      salesOrder: { findFirst: async () => ({ id: 'so-any' }) },
      $queryRaw: async () => [],
      $executeRaw: cursorRaw((key, value) => {
        // The real statement keeps the later value (pinned against Postgres in tests/db); the double mirrors that.
        const stored = state.settings.get(key)
        if (!stored || Date.parse(stored) < Date.parse(value)) state.settings.set(key, value)
      }),
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(sweepDb),
    }),
  },
})

const CURSOR_KEY = 'last_wc_order_sync_at'
const OLD_CURSOR = '2026-11-14T09:00:00.000Z'

function reset(cursor: string | null = OLD_CURSOR) {
  state.settings = new Map<string, string>([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
    ['last_wc_order_sync_at_statuses', JSON.stringify(['pending-wdraw', 'processing', 'withdrawn'])],
  ])
  if (cursor) state.settings.set(CURSOR_KEY, cursor)
  state.reads = []
  state.onEmptyPage = null
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: T0 })
}

async function poll() {
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode: 'poll' })
}

test('the committed cursor is the read-start time minus the overlap, not the commit time', async () => {
  const { WC_PULL_CURSOR_OVERLAP_MS } = await import('@/lib/connectors/woocommerce/sync/read-cursor')
  reset()
  state.onEmptyPage = () => mock.timers.tick(45_000)

  await poll()

  const committed = Date.parse(state.settings.get(CURSOR_KEY)!)
  assert.ok(committed <= T0 - WC_PULL_CURSOR_OVERLAP_MS, 'never later than read start less the overlap')
  assert.equal(committed, T0 - WC_PULL_CURSOR_OVERLAP_MS)
  mock.timers.reset()
})

test('an order modified between the empty-page read and the commit is fetched by the NEXT sweep', async () => {
  reset()
  const modifiedAt = T0 + 30_000
  state.onEmptyPage = () => mock.timers.tick(60_000) // the commit follows 60 s after the final read; the order changed 30 s in

  await poll()
  const commitTime = T0 + 60_000
  assert.ok(modifiedAt < commitTime, 'precondition: the order changed before the old commit stamp')

  mock.timers.tick(5 * 60_000)
  state.onEmptyPage = null
  state.reads = []
  await poll()

  const afterMs = Date.parse(state.reads[0].modifiedAfter!)
  assert.ok(modifiedAt > afterMs, 'WooCommerce returns orders modified after this bound, and the order is one of them')
  mock.timers.reset()
})

test('the cursor never regresses: a newer stored value (a concurrent sweep commit) is kept', async () => {
  const newerStored = new Date(T0 + 10_000).toISOString()
  reset(newerStored)

  await poll()

  assert.equal(state.settings.get(CURSOR_KEY), newerStored)
  mock.timers.reset()
})

test('a first run with no cursor commits the read-start candidate', async () => {
  reset(null)

  await poll()

  assert.equal(state.settings.get(CURSOR_KEY), new Date(T0 - 120_000).toISOString())
  mock.timers.reset()
})

test('laterCursor and wcPullCursorCandidate are pure', async () => {
  const { laterCursor, wcPullCursorCandidate } = await import('@/lib/connectors/woocommerce/sync/read-cursor')
  assert.equal(wcPullCursorCandidate(T0), new Date(T0 - 120_000).toISOString())
  assert.equal(laterCursor(null, 'b'), 'b')
  assert.equal(laterCursor('garbage', '2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z')
  assert.equal(laterCursor('2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), '2026-02-01T00:00:00.000Z')
  assert.equal(laterCursor('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'), '2026-02-01T00:00:00.000Z')
})
