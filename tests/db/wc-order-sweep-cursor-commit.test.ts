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
// The settings rows these tests touch. They are SNAPSHOTTED before each test and RESTORED after it, so a
// run against a database that holds real values leaves them as it found them.
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
  const db = (await import('../../lib/db')).db
  await assertDisposableDatabase(db)
  return db
}

/**
 * These tests write settings rows through the real sweep, which cannot run inside a rolled-back
 * transaction (it opens its own). So refuse anything that does not look like a scratch or CI database.
 */
async function assertDisposableDatabase(db: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }) {
  const [row] = await db.$queryRaw<Array<{ n: string }>>`SELECT current_database()::text AS n`
  const name = row!.n
  if (/^(postgres|template|pg_)|onetwo3d|onetwoinventory|prod|live/i.test(name) || !/scratch|_ci$|_test$/i.test(name)) {
    throw new Error(`refusing to run against database "${name}": it is not a scratch/CI database (name must contain "scratch" or end in _ci/_test)`)
  }
}

type Saved = Array<{ key: string; value: string }>

async function snapshot(): Promise<Saved> {
  const db = await getDb()
  return db.setting.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true } })
}

async function restore(saved: Saved) {
  const db = await getDb()
  await db.setting.deleteMany({ where: { key: { in: KEYS } } })
  for (const row of saved) await db.setting.create({ data: row })
}

async function put(key: string, value: string) {
  const db = await getDb()
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function get(key: string): Promise<string | null> {
  const db = await getDb()
  return (await db.setting.findUnique({ where: { key } }))?.value ?? null
}

async function sweep() {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode: 'reconcile' })
}

async function withSnapshot(fn: () => Promise<void>) {
  const db = await getDb()
  const saved = await snapshot()
  await db.setting.deleteMany({ where: { key: { in: KEYS } } })
  try {
    await fn()
  } finally {
    await restore(saved)
  }
}

test('a clean sweep commits the read-start cursor less the overlap, through the real advisory-lock transaction', { skip }, async () => {
  const { WC_PULL_CURSOR_OVERLAP_MS } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  await withSnapshot(async () => {
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
  })
})

test('a stored cursor newer than the candidate is kept by the sweep (never regresses)', { skip }, async () => {
  await withSnapshot(async () => {
    const newer = new Date(Date.now() + 60_000).toISOString()
    await put('wc_initial_import_completed', 'true')
    await put('wc_sync_order_statuses', JSON.stringify(['processing']))
    await put(CURSOR_KEY, newer)
    const result = await sweep()
    assert.deepEqual(result.errors, [])
    assert.equal(await get(CURSOR_KEY), newer)
  })
})

test('advancePullCursor is one atomic max: an OLDER candidate applied after a NEWER one leaves the newer', { skip }, async () => {
  const { advancePullCursor } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  const db = await getDb()
  await withSnapshot(async () => {
    const older = '2026-11-14T10:00:00.000Z'
    const newer = '2026-11-14T10:05:00.000Z'
    await advancePullCursor(db, CURSOR_KEY, newer)
    await advancePullCursor(db, CURSOR_KEY, older)
    assert.equal(await get(CURSOR_KEY), newer, 'the late, older writer did not move the cursor backwards')
    await advancePullCursor(db, CURSOR_KEY, '2026-11-14T10:10:00.000Z')
    assert.equal(await get(CURSOR_KEY), '2026-11-14T10:10:00.000Z', 'a newer candidate still advances it')
  })
})

test('advancePullCursor: concurrent writers in either order end on the maximum', { skip }, async () => {
  const { advancePullCursor } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  const db = await getDb()
  await withSnapshot(async () => {
    const times = Array.from({ length: 12 }, (_, i) => new Date(Date.parse('2026-11-14T10:00:00.000Z') + i * 60_000).toISOString())
    const shuffled = [...times].reverse().map((t, i) => (i % 2 ? t : times[i]))
    await Promise.all(shuffled.map((t) => db.$transaction((tx) => advancePullCursor(tx, CURSOR_KEY, t))))
    const expected = shuffled.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
    assert.equal(await get(CURSOR_KEY), expected)
  })
})

test('advancePullCursor replaces a stored value that is not a timestamp', { skip }, async () => {
  const { advancePullCursor } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  const db = await getDb()
  await withSnapshot(async () => {
    await put(CURSOR_KEY, 'not-a-date')
    await advancePullCursor(db, CURSOR_KEY, '2026-11-14T10:00:00.000Z')
    assert.equal(await get(CURSOR_KEY), '2026-11-14T10:00:00.000Z')
  })
})
