import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE ORDER SWEEP'S CURSOR COMMIT AGAINST A REAL DATABASE.
 *
 * The unit tier mocks `$transaction`, `$queryRaw` and `$executeRaw`, which is exactly how the advisory-lock
 * statement written with `$queryRaw` slipped through (it must be `$executeRaw`: `pg_advisory_xact_lock`
 * returns void). This runs the real conditional commit - the advisory lock, the fingerprint compare, the
 * cursor upsert and the liveness stamp - and pins what it writes: the READ-START cursor less the overlap,
 * never behind a stored value.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/wc-order-sweep-cursor-commit.test.ts would have been skipped. Fix the invocation (npm run test:db).',
  )
}

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: [], totalPages: 1, totalItems: 0 }),
    wcPut: async () => ({ data: null }),
    MAX_WC_PAGE_WALK_PAGES: 1000,
    describeUnendedWcPageWalk: (collection: string, pagesRead: number) =>
      `The WooCommerce ${collection} walk did not reach an empty page within ${pagesRead} page(s).`,
  },
})

const CURSOR_KEY = 'last_wc_order_reconcile_at'
const KEYS = [
  CURSOR_KEY,
  `${CURSOR_KEY}_statuses`,
  `${CURSOR_KEY}_withdrawal_dropped`,
  'wc_initial_import_completed',
  'wc_sync_order_statuses',
  'wc_order_sweep_last_success_at',
]

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  return (await import('../../lib/db')).db
}

async function put(key: string, value: string) {
  const db = await getDb()
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function get(key: string): Promise<string | null> {
  const db = await getDb()
  return (await db.setting.findUnique({ where: { key } }))?.value ?? null
}

async function clean() {
  const db = await getDb()
  await db.setting.deleteMany({ where: { key: { in: KEYS } } })
}

async function sweep() {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode: 'reconcile' })
}

test('a clean sweep commits the read-start cursor less the overlap, through the real advisory-lock transaction', { skip }, async () => {
  const { WC_PULL_CURSOR_OVERLAP_MS } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  const db = await getDb()
  await clean()
  try {
    await put('wc_initial_import_completed', 'true')
    await put('wc_sync_order_statuses', JSON.stringify(['processing']))
    const before = Date.now()
    const result = await sweep()
    const after = Date.now()
    assert.deepEqual(result.errors, [], 'the sweep itself ran clean (the commit is only reached on a clean run)')

    const committed = await get(CURSOR_KEY)
    assert.ok(committed, 'the cursor was written')
    const committedMs = Date.parse(committed)
    assert.ok(committedMs >= before - WC_PULL_CURSOR_OVERLAP_MS && committedMs <= after - WC_PULL_CURSOR_OVERLAP_MS,
      `the cursor ${committed} is the start time less ${WC_PULL_CURSOR_OVERLAP_MS} ms`)
    assert.ok(await get(`${CURSOR_KEY}_statuses`), 'the fingerprint is written with it')
    const liveness = await get('wc_order_sweep_last_success_at')
    assert.ok(liveness && Date.parse(liveness) >= before, 'the liveness stamp is the real commit time, not the cursor')
  } finally {
    await clean()
    await db.$disconnect()
  }
})

test('a stored cursor newer than the candidate is kept (never regresses)', { skip }, async () => {
  const db = await getDb()
  await clean()
  try {
    const newer = new Date(Date.now() + 60_000).toISOString()
    await put('wc_initial_import_completed', 'true')
    await put('wc_sync_order_statuses', JSON.stringify(['processing']))
    await put(CURSOR_KEY, newer)
    const result = await sweep()
    assert.deepEqual(result.errors, [])
    assert.equal(await get(CURSOR_KEY), newer)
  } finally {
    await clean()
    await db.$disconnect()
  }
})
