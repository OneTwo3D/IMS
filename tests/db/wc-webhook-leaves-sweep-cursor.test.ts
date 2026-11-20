import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { Prisma } from '../../app/generated/prisma/client'

/**
 * A WEBHOOK DELIVERY NEVER MOVES THE SWEEP CURSOR, against a real database.
 *
 * Order A changes in WooCommerce and its webhook is missed. Order B changes later and its webhook is
 * delivered. Delivering B used to stamp `last_wc_order_sync_at` / `last_wc_product_sync_at` to NOW, which is
 * past A, so the next sweep asked for `modified_after` > A and never read it. The unit tier mocks
 * `$executeRaw` and the settings upsert (see #901), so this drives the REAL webhook write
 * (`recordWcWebhookProcessed`, the only thing a delivery writes now) and the REAL sweeps against Postgres,
 * and reads back what WooCommerce would have been asked.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in '
    + 'tests/db/wc-webhook-leaves-sweep-cursor.test.ts would have been skipped. Fix the invocation (npm run test:db).',
  )
}

const asked: Array<{ path: string; modifiedAfter: string | undefined }> = []
const hooks: { onOrdersFetch: null | (() => Promise<void>) } = { onOrdersFetch: null }

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      // The order sweep sends GMT without a zone suffix (dates_are_gmt=true): read it back as the ISO instant it denotes.
      asked.push({ path, modifiedAfter: path === '/orders' && params.modified_after ? new Date(`${params.modified_after}Z`).toISOString() : params.modified_after })
      if (path === '/orders') await hooks.onOrdersFetch?.()
      return { data: [], totalPages: 1, totalItems: 0 }
    },
    wcPut: async () => ({ data: null }),
    MAX_WC_PAGE_WALK_PAGES: 1000,
    describeUnendedWcPageWalk: (collection: string, pagesRead: number) =>
      `The WooCommerce ${collection} walk did not reach an empty page within ${pagesRead} page(s).`,
  },
})

const ORDER_CURSOR = 'last_wc_order_sync_at'
const PRODUCT_CURSOR = 'last_wc_product_sync_at'
const KEYS = [
  ORDER_CURSOR, `${ORDER_CURSOR}_statuses`, `${ORDER_CURSOR}_withdrawal_dropped`,
  'wc_order_admission_refused_since', PRODUCT_CURSOR, 'last_wc_order_reconcile_at', 'last_wc_order_reconcile_at_statuses', 'last_wc_order_reconcile_at_withdrawal_dropped', 'last_wc_product_reconcile_at',
  'wc_initial_import_completed', 'wc_sync_order_statuses', 'wc_order_sweep_last_success_at',
  'wc_order_webhook_last_processed_at', 'wc_product_webhook_last_processed_at',
]

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const db = (await import('../../lib/db')).db
  const [row] = await db.$queryRaw<Array<{ n: string }>>`SELECT current_database()::text AS n`
  if (/^(postgres|template|pg_)|onetwo3d|onetwoinventory|prod|live/i.test(row!.n) || !/scratch|_ci$|_test$/i.test(row!.n)) {
    throw new Error(`refusing to run against database "${row!.n}": it is not a scratch/CI database`)
  }
  return db
}

async function put(key: string, value: string) {
  const db = await getDb()
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function get(key: string): Promise<string | null> {
  return (await (await getDb()).setting.findUnique({ where: { key } }))?.value ?? null
}

/**
 * Snapshot the settings rows, run, restore; and remove the seeded order and product whatever happens.
 * The sweeps only honour a stored cursor when IMS already holds an order / a product (a fresh install
 * ignores a stale one), so both are seeded.
 */
async function scenario(fn: () => Promise<void>) {
  const db = await getDb()
  const saved = await db.setting.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true } })
  await db.setting.deleteMany({ where: { key: { in: KEYS } } })
  asked.length = 0
  hooks.onOrdersFetch = null
  const sku = `WHC-${randomUUID().slice(0, 8)}`
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `WHC-${randomUUID().slice(0, 8)}`, status: 'DRAFT', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('1'), totalForeign: new Prisma.Decimal('1'), subtotalBase: new Prisma.Decimal('1'), taxBase: new Prisma.Decimal('0'), totalBase: new Prisma.Decimal('1'),
    },
    select: { id: true },
  })
  await db.product.create({ data: { sku, name: 'webhook cursor probe' } })
  try {
    await fn()
  } finally {
    await db.setting.deleteMany({ where: { key: { in: KEYS } } })
    for (const row of saved) await db.setting.create({ data: row })
    await db.product.deleteMany({ where: { sku } })
    await db.salesOrder.deleteMany({ where: { id: order.id } })
  }
}

async function seedOrderSweep(cursor: string) {
  await put('wc_initial_import_completed', 'true')
  await put('wc_sync_order_statuses', JSON.stringify(['processing']))
  await put(`${ORDER_CURSOR}_statuses`, JSON.stringify(['pending-wdraw', 'processing', 'withdrawn']))
  await put(ORDER_CURSOR, cursor)
}

test('order A missed, order B delivered: the real webhook write leaves the sweep cursor, and the next sweep reads A', { skip }, async () => {
  const { recordWcOrderWebhookProcessed } = await import('../../lib/connectors/woocommerce/webhooks')
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    const cursor = '2026-11-14T09:00:00.000Z'
    const orderAModifiedAt = '2026-11-14T09:30:00.000Z' // after the cursor; its webhook was missed
    await seedOrderSweep(cursor)

    await recordWcOrderWebhookProcessed() // order B's delivery, at the real clock (well after A)

    assert.equal(await get(ORDER_CURSOR), cursor, 'the delivery did not move the sweep cursor')
    assert.ok(await get('wc_order_webhook_last_processed_at'), 'it recorded its own stamp instead')

    const result = await syncNewWcOrders({ mode: 'poll' })
    assert.deepEqual(result.errors, [])
    const read = asked.find((call) => call.path === '/orders')
    assert.ok(read?.modifiedAfter, 'the sweep read with a modified_after bound')
    assert.ok(Date.parse(read.modifiedAfter) < Date.parse(orderAModifiedAt), 'order A (missed) is inside the window the sweep asked for')
    assert.equal(read.modifiedAfter, cursor)
  })
})

test('product A missed, product B delivered: the real webhook write leaves the sweep cursor, and the next sweep reads A', { skip }, async () => {
  const { recordWcWebhookProcessed, WC_PRODUCT_WEBHOOK_LAST_PROCESSED_SETTING } = await import('../../lib/connectors/woocommerce/webhooks')
  const { syncAllWcProducts } = await import('../../lib/connectors/woocommerce/sync/product-sync')
  await scenario(async () => {
    const cursor = '2026-11-14T09:00:00.000Z'
    await put(PRODUCT_CURSOR, cursor)

    await recordWcWebhookProcessed(WC_PRODUCT_WEBHOOK_LAST_PROCESSED_SETTING) // product B's delivery

    assert.equal(await get(PRODUCT_CURSOR), cursor, 'the delivery did not move the sweep cursor')
    assert.ok(await get('wc_product_webhook_last_processed_at'))

    const result = await syncAllWcProducts({ mode: 'poll' })
    assert.deepEqual(result.errors, [])
    const read = asked.find((call) => call.path === '/products')
    assert.equal(read?.modifiedAfter, cursor, 'the sweep still asks from the sweep-owned cursor, so product A is in range')
  })
})

test('only the sweep advances the cursor: after a clean poll it is read-start less the overlap', { skip }, async () => {
  const { recordWcOrderWebhookProcessed } = await import('../../lib/connectors/woocommerce/webhooks')
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const { WC_PULL_CURSOR_OVERLAP_MS } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  await scenario(async () => {
    await seedOrderSweep('2026-11-14T09:00:00.000Z')
    await recordWcOrderWebhookProcessed()
    const before = Date.now()
    const result = await syncNewWcOrders({ mode: 'poll' })
    assert.deepEqual(result.errors, [])
    const committed = Date.parse((await get(ORDER_CURSOR))!)
    assert.ok(committed >= before - WC_PULL_CURSOR_OVERLAP_MS && committed <= Date.now() - WC_PULL_CURSOR_OVERLAP_MS)
  })
})

test('webhook-primary mode: a clean order reconcile carries its position to an old poll cursor', { skip }, async () => {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const { WC_PULL_CURSOR_OVERLAP_MS } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  await scenario(async () => {
    await put('wc_initial_import_completed', 'true')
    await put('wc_sync_order_statuses', JSON.stringify(['processing']))
    await put(ORDER_CURSOR, '2026-01-01T00:00:00.000Z') // a long webhook-primary spell: the poll cursor is far behind
    await put(`${ORDER_CURSOR}_statuses`, await resolvedPollFingerprint(['processing'])) // the poll last earned its cursor under this selection (equal list)
    const before = Date.now()
    const result = await syncNewWcOrders({ mode: 'reconcile' })
    assert.deepEqual(result.errors, [])
    const reconcile = Date.parse((await get('last_wc_order_reconcile_at'))!)
    const poll = Date.parse((await get(ORDER_CURSOR))!)
    assert.ok(reconcile >= before - WC_PULL_CURSOR_OVERLAP_MS)
    assert.equal(poll, reconcile, 'the poll cursor is at least reconcile read-start less the overlap')
  })
})

test('a clean poll does NOT touch the reconcile cursor, and the carry never moves a newer poll cursor backwards', { skip }, async () => {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    await put('wc_initial_import_completed', 'true')
    await put('wc_sync_order_statuses', JSON.stringify(['processing']))
    const newer = new Date(Date.now() + 3_600_000).toISOString()
    await put(ORDER_CURSOR, newer)
    await syncNewWcOrders({ mode: 'reconcile' })
    assert.equal(await get(ORDER_CURSOR), newer)
    await db_delete('last_wc_order_reconcile_at')
    await syncNewWcOrders({ mode: 'poll' })
    assert.equal(await get('last_wc_order_reconcile_at'), null)
  })
})

test('webhook-primary mode: a clean product reconcile carries its position to an old product poll cursor', { skip }, async () => {
  const { syncAllWcProducts } = await import('../../lib/connectors/woocommerce/sync/product-sync')
  await scenario(async () => {
    await put(PRODUCT_CURSOR, '2026-01-01T00:00:00.000Z')
    const result = await syncAllWcProducts({ mode: 'reconcile' })
    assert.deepEqual(result.errors, [])
    assert.equal(await get(PRODUCT_CURSOR), await get('last_wc_product_reconcile_at'))
    assert.ok(Date.parse((await get(PRODUCT_CURSOR))!) > Date.parse('2026-11-01T00:00:00.000Z'))
  })
})

async function db_delete(key: string) {
  await (await getDb()).setting.deleteMany({ where: { key } })
}

async function resolvedPollFingerprint(selection: string[]): Promise<string> {
  const { getWcPullStatuses } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await put('wc_sync_order_statuses', JSON.stringify(selection))
  return JSON.stringify([...(await getWcPullStatuses('poll'))].sort())
}

test('a carried reconcile also carries the poll fingerprint: narrow, carry, widen back, and the next poll rewinds', { skip }, async () => {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    await put('wc_initial_import_completed', 'true')
    const wide = await resolvedPollFingerprint(['processing', 'on-hold'])
    const narrow = await resolvedPollFingerprint(['processing'])
    assert.notEqual(wide, narrow)
    await put(ORDER_CURSOR, '2026-11-01T00:00:00.000Z')
    await put(`${ORDER_CURSOR}_statuses`, wide) // the poll last ran under the wider selection

    const reconciled = await syncNewWcOrders({ mode: 'reconcile' }) // selection is narrow now
    assert.deepEqual(reconciled.errors, [])
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), narrow, 'the poll fingerprint is what the reconcile actually covered')
    const carried = await get(ORDER_CURSOR)
    assert.ok(Date.parse(carried!) > Date.parse('2026-11-10T00:00:00.000Z'), 'and the cursor moved with it')

    // on-hold is selected again, with an order it once refused far behind the cursor
    await put('wc_sync_order_statuses', JSON.stringify(['processing', 'on-hold']))
    const refusedAt = '2026-11-05T00:00:00.000Z'
    await put('wc_order_admission_refused_since', refusedAt)
    asked.length = 0
    const poll = await syncNewWcOrders({ mode: 'poll' })
    assert.deepEqual(poll.errors, [])
    assert.equal(asked.find((call) => call.path === '/orders')?.modifiedAfter, refusedAt, 'the poll saw the widening and rewound')
  })
})

test('a poll commit that lands during the reconcile means the carry is skipped', { skip }, async () => {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    await put('wc_initial_import_completed', 'true')
    const wide = await resolvedPollFingerprint(['processing', 'on-hold'])
    const narrow = await resolvedPollFingerprint(['processing'])
    const oldCursor = '2026-11-01T00:00:00.000Z'
    await put(ORDER_CURSOR, oldCursor)
    await put(`${ORDER_CURSOR}_statuses`, wide)
    hooks.onOrdersFetch = async () => { await put(`${ORDER_CURSOR}_statuses`, narrow) } // a concurrent poll commit

    const reconciled = await syncNewWcOrders({ mode: 'reconcile' })
    assert.deepEqual(reconciled.errors, [])
    assert.equal(await get(ORDER_CURSOR), oldCursor, 'the carry did not move the poll cursor')
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), narrow, "and left the concurrent commit's fingerprint alone")
    assert.ok(await get('last_wc_order_reconcile_at'), 'the reconcile itself still committed')
  })
})

test('a carry never widens: on-hold newly selected, old missed on-hold order, no watermark: the carry is skipped and the poll handles it', { skip }, async () => {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    await put('wc_initial_import_completed', 'true')
    const narrow = await resolvedPollFingerprint(['processing'])
    const wide = await resolvedPollFingerprint(['processing', 'on-hold']) // selection is wide now
    const oldCursor = '2026-11-01T00:00:00.000Z'
    await put(ORDER_CURSOR, oldCursor)
    await put(`${ORDER_CURSOR}_statuses`, narrow) // the poll last earned its cursor without on-hold

    const reconciled = await syncNewWcOrders({ mode: 'reconcile' })
    assert.deepEqual(reconciled.errors, [])
    assert.equal(await get(ORDER_CURSOR), oldCursor, 'no cursor was carried')
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), narrow, 'and no fingerprint was written')

    asked.length = 0
    const poll = await syncNewWcOrders({ mode: 'poll' })
    assert.deepEqual(poll.errors, [])
    assert.equal(asked.find((call) => call.path === '/orders')?.modifiedAfter, oldCursor, 'the poll still reads from before the old on-hold order')
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), wide, 'and only now records the widened selection')
  })
})

test('legacy install, no stored poll fingerprint: a clean reconcile bootstrap-carries and records the fingerprint', { skip }, async () => {
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    await put('wc_initial_import_completed', 'true')
    const expected = await resolvedPollFingerprint(['processing'])
    await put(ORDER_CURSOR, '2026-11-01T00:00:00.000Z')
    const reconciled = await syncNewWcOrders({ mode: 'reconcile' })
    assert.deepEqual(reconciled.errors, [])
    assert.ok(Date.parse((await get(ORDER_CURSOR))!) > Date.parse('2026-11-10T00:00:00.000Z'))
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), expected)
  })
})

test('the initial import writes the poll fingerprint with the cursor', { skip }, async () => {
  const { runInitialImport } = await import('../../lib/connectors/woocommerce/sync/initial-import')
  await scenario(async () => {
    const expected = await resolvedPollFingerprint(['processing'])
    await (await getDb()).setting.deleteMany({ where: { key: 'wc_initial_import_completed' } })
    const run = await runInitialImport(freshProgress())
    assert.equal(run.stamped, true, JSON.stringify(run.progress.errors))
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), expected)
    assert.ok(await get(ORDER_CURSOR))
  })
})

test('fresh webhook-primary install: initial import, reconciles with no poll, then webhooks stop and the poll reads from a recent position', { skip }, async () => {
  const { runInitialImport } = await import('../../lib/connectors/woocommerce/sync/initial-import')
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  const { WC_PULL_CURSOR_OVERLAP_MS } = await import('../../lib/connectors/woocommerce/sync/read-cursor')
  await scenario(async () => {
    await resolvedPollFingerprint(['processing'])
    await (await getDb()).setting.deleteMany({ where: { key: 'wc_initial_import_completed' } })
    assert.equal((await runInitialImport(freshProgress())).stamped, true)
    const afterImport = (await get(ORDER_CURSOR))!
    // Time passes: simulate the import having happened long ago.
    await put(ORDER_CURSOR, '2026-11-01T00:00:00.000Z')
    for (let i = 0; i < 3; i += 1) assert.deepEqual((await syncNewWcOrders({ mode: 'reconcile' })).errors, [])
    const before = Date.now()
    asked.length = 0
    assert.deepEqual((await syncNewWcOrders({ mode: 'poll' })).errors, []) // webhooks stopped: the poll runs
    const modifiedAfter = Date.parse(asked.find((call) => call.path === '/orders')!.modifiedAfter!)
    assert.ok(modifiedAfter >= Date.parse(afterImport) - 1000 && modifiedAfter <= before, 'the poll reads from the carried (recent) position, not the stale cursor')
    assert.ok(modifiedAfter > Date.parse('2026-11-10T00:00:00.000Z'))
    assert.ok(WC_PULL_CURSOR_OVERLAP_MS > 0)
  })
})

test('a status added while the initial import runs is NOT claimed by the fingerprint: no carry, and the next poll sees a widening', { skip }, async () => {
  const { runInitialImport } = await import('../../lib/connectors/woocommerce/sync/initial-import')
  const { syncNewWcOrders } = await import('../../lib/connectors/woocommerce/sync/order-import')
  await scenario(async () => {
    const startList = await resolvedPollFingerprint(['processing'])
    const wideList = await resolvedPollFingerprint(['processing', 'on-hold'])
    await put('wc_sync_order_statuses', JSON.stringify(['processing']))
    await (await getDb()).setting.deleteMany({ where: { key: 'wc_initial_import_completed' } })
    // The operator ticks on-hold while the import is reading (the page-fetch seam).
    hooks.onOrdersFetch = async () => {
      hooks.onOrdersFetch = null
      await put('wc_sync_order_statuses', JSON.stringify(['processing', 'on-hold']))
    }
    assert.equal((await runInitialImport(freshProgress())).stamped, true)
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), startList, 'the fingerprint is the list the import started with')
    const importCursor = (await get(ORDER_CURSOR))!

    // No carry before the poll has handled the widening.
    assert.deepEqual((await syncNewWcOrders({ mode: 'reconcile' })).errors, [])
    assert.equal(await get(ORDER_CURSOR), importCursor, 'the reconcile did not carry over a pending widening')
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), startList)

    // An on-hold order the import never read was refused long before the import cursor.
    const refusedAt = new Date(Date.parse(importCursor) - 86_400_000).toISOString()
    await put('wc_order_admission_refused_since', refusedAt)
    asked.length = 0
    assert.deepEqual((await syncNewWcOrders({ mode: 'poll' })).errors, [])
    assert.equal(asked.find((call) => call.path === '/orders')?.modifiedAfter, refusedAt.replace(/\.\d{3}Z$/, '.000Z'), 'the poll treated it as a widening and rewound (the request carries second precision)')
    assert.equal(await get(`${ORDER_CURSOR}_statuses`), wideList)
  })
})

const freshProgress = () => ({ status: 'running' as const, message: '', activeOrdersImported: 0, activeOrdersSkipped: 0, totalOrders: 0, currentPage: 0, totalPages: 0, errors: [] as string[] })
