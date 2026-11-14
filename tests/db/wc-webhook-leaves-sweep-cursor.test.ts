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

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      asked.push({ path, modifiedAfter: params.modified_after })
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
  PRODUCT_CURSOR, 'last_wc_order_reconcile_at', 'last_wc_order_reconcile_at_statuses', 'last_wc_order_reconcile_at_withdrawal_dropped', 'last_wc_product_reconcile_at',
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
