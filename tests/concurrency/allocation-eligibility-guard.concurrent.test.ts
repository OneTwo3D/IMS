import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-6ab — allocateSalesOrder's under-lock ELIGIBILITY guard, proved against a real Postgres.
 *
 * The batch allocation callers (the replenishment backorder allocator, the periodic reallocation
 * sweep) select candidate orders by status OUTSIDE the sales-order row lock. The lock serializes the
 * WRITES but historically did not revalidate the REASON for writing, so an order that moved
 * PROCESSING→ON_HOLD (or was picked up by a manual/payment-poller allocation) in the window between
 * selection and lock acquisition was still released, deleted, recreated and re-reserved.
 *
 * These tests reproduce that window for real: a holder connection takes `SELECT ... FOR UPDATE` on the
 * order and mutates it inside an OPEN transaction, then allocateSalesOrder is started. Its pre-lock
 * read runs under MVCC and therefore still sees the OLD status (exactly the stale premise a batch
 * caller acts on), and it then blocks on the row lock. When the holder commits, allocation proceeds
 * and must decide off the UNDER-LOCK status.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (needs a real Postgres): `npm run test:concurrency`.
 */

const SKIP = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'
// How long the holder keeps the row lock while allocation is already blocked on it. Only needs to
// exceed the time for allocation's (non-blocking) pre-lock reads to complete.
/**
 * How long to wait for the allocator to be CONFIRMED blocked on our row lock (o3d-bz8q).
 *
 * This is a timeout, not a delay: the barrier below polls pg_locks and proceeds the moment the
 * wait is observed. It only elapses if the allocator never blocks at all, which is a genuine
 * failure and must fail the test rather than pass it quietly.
 */
const BARRIER_TIMEOUT_MS = Number.parseInt(process.env.O3D_6AB_BARRIER_TIMEOUT_MS ?? '15000', 10)
const BATCH_ELIGIBLE = ['PROCESSING', 'ALLOCATED'] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Fixture = {
  orderId: string
  lineId: string
  productId: string
  warehouseId: string
}

async function loadDeps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new Error('o3d-6ab concurrency test requires a Postgres DATABASE_URL')
  }

  const [{ PrismaClient }, { PrismaPg }, { default: pg }, allocationService] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
    import('@/lib/domain/sales/allocation-service'),
  ])

  // Two independent pools: Prisma must never be starved by the connection deliberately holding the
  // row lock, or the "concurrency" would degrade into a pool deadlock that passes for the wrong reason.
  //
  // PrismaPg is given a CONFIG, not a pg.Pool instance. Handing it a Pool relies on an
  // `instanceof pg.Pool` check inside @prisma/adapter-pg, and under the tsx/node --test loader the
  // adapter's `pg` is a different module instance than the test's, so the check fails, the Pool object
  // is used as a connection CONFIG and startup dies with "The 'string' argument must be of type
  // string ... Received an instance of Object". (The same trap fails the pre-existing
  // cost-layers/mintsoft-auth-lease concurrency tests — see o3d-6ab notes.)
  const holderPool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 5 }) })

  return { db, holderPool, allocateSalesOrder: allocationService.allocateSalesOrder }
}

type TestDeps = Awaited<ReturnType<typeof loadDeps>>
type TestDb = TestDeps['db']

/** Create an isolated warehouse/product/stock/order set. Qty 3 ordered, 5 on hand, nothing reserved. */
async function createFixture(db: TestDb): Promise<Fixture> {
  const suffix = randomUUID()
  const warehouse = await db.warehouse.create({
    data: {
      code: `O6AB-${suffix.slice(0, 8)}`,
      name: `o3d-6ab ${suffix}`,
      active: true,
      availableForSale: true,
      syncToStore: false,
      isDefault: false,
    },
    select: { id: true },
  })
  const product = await db.product.create({
    data: { sku: `O6AB-${suffix}`, name: `o3d-6ab ${suffix}`, type: 'SIMPLE', oversellAllowed: false },
    select: { id: true },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: warehouse.id, quantity: 5, reservedQty: 0 },
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `O6AB-${suffix.slice(0, 8)}`,
      status: 'PROCESSING',
      currency: 'GBP',
      subtotalForeign: 30,
      totalForeign: 30,
      subtotalBase: 30,
      totalBase: 30,
      shipFromWarehouseId: warehouse.id,
      lines: {
        create: [{
          productId: product.id,
          description: 'o3d-6ab line',
          sku: `O6AB-${suffix}`,
          qty: 3,
          unitPriceForeign: 10,
          unitPriceBase: 10,
          totalForeign: 30,
          totalBase: 30,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })

  return {
    orderId: order.id,
    lineId: order.lines[0].id,
    productId: product.id,
    warehouseId: warehouse.id,
  }
}

async function destroyFixture(db: TestDb, fixture: Fixture) {
  const errors: Error[] = []
  const run = async (label: string, op: () => Promise<unknown>) => {
    try {
      await op()
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      errors.push(normalized)
      console.warn(`o3d-6ab cleanup failed for ${label}: ${normalized.message}`)
    }
  }
  await run('allocations', () => db.orderAllocation.deleteMany({ where: { orderId: fixture.orderId } }))
  await run('order lines', () => db.salesOrderLine.deleteMany({ where: { orderId: fixture.orderId } }))
  await run('order', () => db.salesOrder.delete({ where: { id: fixture.orderId } }))
  await run('stock levels', () => db.stockLevel.deleteMany({ where: { productId: fixture.productId } }))
  await run('product', () => db.product.delete({ where: { id: fixture.productId } }))
  await run('warehouse', () => db.warehouse.delete({ where: { id: fixture.warehouseId } }))
  if (errors.length > 0) throw new AggregateError(errors, 'o3d-6ab concurrency cleanup failed')
}

/**
 * Take the sales-order row lock on a dedicated connection, apply `mutate`, keep the transaction OPEN
 * while `whileHeld` starts and blocks on the same row, then COMMIT and return whileHeld's result.
 */
/**
 * Block until ANOTHER backend is waiting on the `sales_orders` row lock this connection holds.
 *
 * `pg_locks.granted = false` on a tuple/transaction-id lock is Postgres telling us, from its own
 * bookkeeping, that a second transaction has reached `SELECT ... FOR UPDATE` and is queued behind
 * us. That is the exact ordering the test needs, and it cannot be faked by timing.
 *
 * Throws on timeout — an allocator that never blocks means the race did not happen, and the test
 * must fail loudly rather than proceed and "pass".
 */
async function waitForRowLockWaiter(
  holder: { query(sql: string, params?: unknown[]): Promise<unknown> },
  orderId: string,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < BARRIER_TIMEOUT_MS) {
    const result = await holder.query(
      `SELECT count(*)::int AS waiting
         FROM pg_locks blocked
         JOIN pg_locks blocker
           ON blocker.transactionid = blocked.transactionid
          AND blocker.granted
          AND blocker.pid <> blocked.pid
        WHERE NOT blocked.granted
          AND blocker.pid = pg_backend_pid()`,
    ) as { rows: Array<{ waiting: number }> }
    if ((result.rows[0]?.waiting ?? 0) > 0) return
    await sleep(25)
  }
  throw new Error(
    `o3d-bz8q barrier: no backend blocked on the sales_orders row for ${orderId} within `
    + `${BARRIER_TIMEOUT_MS}ms — the allocator never reached the lock, so the race under test `
    + 'did not occur and this run proves nothing',
  )
}

async function raceUnderRowLock<T>(
  holderPool: TestDeps['holderPool'],
  orderId: string,
  mutate: (client: { query(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<void>,
  whileHeld: () => Promise<T>,
): Promise<T> {
  const holder = await holderPool.connect()
  let committed = false
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM "sales_orders" WHERE id = $1 FOR UPDATE', [orderId])
    await mutate(holder)

    // Starts, reads the PRE-lock (stale) state under MVCC, then blocks on the row lock we hold.
    const pending = whileHeld()

    // o3d-bz8q: WAIT FOR THE BLOCK, do not sleep for it. A fixed 750ms sleep proved nothing —
    // on a slow or loaded database the allocator's initial read could happen AFTER this commit,
    // so it would observe ON_HOLD directly and the test would pass even if the implementation
    // only ever checked the PRE-lock status. That is a false positive for precisely the
    // regression this test exists to catch.
    //
    // Polling pg_locks until the allocator is confirmed WAITING on our row makes the ordering a
    // fact rather than a hope: the stale read has provably already happened, because the
    // allocator cannot reach the lock without it.
    await waitForRowLockWaiter(holder, orderId)

    await holder.query('COMMIT')
    committed = true
    return await pending
  } finally {
    if (!committed) {
      try { await holder.query('ROLLBACK') } catch { /* connection already broken */ }
    }
    holder.release()
  }
}

test(
  'o3d-6ab: PROCESSING→ON_HOLD winning the row lock makes the guarded allocation a total no-op',
  { skip: SKIP },
  async () => {
    const { db, holderPool, allocateSalesOrder } = await loadDeps()
    let fixture: Fixture | undefined
    try {
      fixture = await createFixture(db)
      const orderId = fixture.orderId

      // The batch caller's selection: PROCESSING, so it is a candidate.
      const selected = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      assert.equal(selected?.status, 'PROCESSING', 'selected while eligible — the stale premise')

      const result = await raceUnderRowLock(
        holderPool,
        orderId,
        async (holder) => {
          await holder.query(
            'UPDATE "sales_orders" SET status = $1::"SalesOrderStatus" WHERE id = $2',
            ['ON_HOLD', orderId],
          )
        },
        () => allocateSalesOrder(db, { orderId, requireStatusUnderLock: BATCH_ELIGIBLE }),
      )

      assert.equal(result.skipped, true, 'the stale premise was caught UNDER the lock')
      assert.equal(result.skippedStatus, 'ON_HOLD')
      assert.equal(result.error, undefined, 'a skip is not an error — batch callers must not log a failure')
      assert.equal(result.allocationCount, 0)

      const stock = await db.stockLevel.findFirst({
        where: { productId: fixture.productId, warehouseId: fixture.warehouseId },
        select: { reservedQty: true },
      })
      assert.equal(Number(stock?.reservedQty), 0, 'no stock reserved for the held order')
      assert.equal(await db.orderAllocation.count({ where: { orderId } }), 0, 'no allocation rows written')
      const after = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      assert.equal(after?.status, 'ON_HOLD', 'the hold stands — allocation did not resume the order')
    } finally {
      if (fixture) await destroyFixture(db, fixture)
      await db.$disconnect()
      await holderPool.end()
    }
  },
)

test(
  'o3d-6ab: WITHOUT the guard the same race still re-reserves a held order (the bug this guards)',
  { skip: SKIP },
  async () => {
    // Control. Proves the window is real at DB level and that the guard — not some incidental
    // serialization — is what closes it. This asserts the PRE-FIX behaviour on the unguarded path,
    // which is also the behaviour every existing (non-batch) caller must keep.
    const { db, holderPool, allocateSalesOrder } = await loadDeps()
    let fixture: Fixture | undefined
    try {
      fixture = await createFixture(db)
      const orderId = fixture.orderId

      await raceUnderRowLock(
        holderPool,
        orderId,
        async (holder) => {
          await holder.query(
            'UPDATE "sales_orders" SET status = $1::"SalesOrderStatus" WHERE id = $2',
            ['ON_HOLD', orderId],
          )
        },
        () => allocateSalesOrder(db, { orderId }),
      )

      const stock = await db.stockLevel.findFirst({
        where: { productId: fixture.productId, warehouseId: fixture.warehouseId },
        select: { reservedQty: true },
      })
      assert.equal(Number(stock?.reservedQty), 3, 'unguarded: the held order IS re-reserved')
      const after = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      assert.equal(after?.status, 'ON_HOLD', 'still not promoted — that part was already fixed by o3d-2s8')
    } finally {
      if (fixture) await destroyFixture(db, fixture)
      await db.$disconnect()
      await holderPool.end()
    }
  },
)

test(
  'o3d-6ab: a manual allocation winning the lock leaves the order eligible — the batch pass is idempotent, not doubled',
  { skip: SKIP },
  async () => {
    // The guard must not over-fire. A manual "Allocate" on the order detail page (or any actor that
    // leaves the order in an allocation-eligible status) wins the lock and reserves; the batch pass then
    // acquires the lock, finds ALLOCATED — still in the eligible set — and rebuilds idempotently.
    const { db, holderPool, allocateSalesOrder } = await loadDeps()
    let fixture: Fixture | undefined
    try {
      fixture = await createFixture(db)
      const orderId = fixture.orderId

      const result = await raceUnderRowLock(
        holderPool,
        orderId,
        async (holder) => {
          // Model the committed effect of the manual allocation: rows + reservation + ALLOCATED.
          await holder.query(
            `INSERT INTO "order_allocations" ("id", "orderId", "lineId", "productId", "warehouseId", "qty", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 3, NOW(), NOW())`,
            [`o6ab-${randomUUID()}`, orderId, fixture!.lineId, fixture!.productId, fixture!.warehouseId],
          )
          await holder.query(
            'UPDATE "stock_levels" SET "reservedQty" = "reservedQty" + 3, "updatedAt" = NOW() WHERE "productId" = $1 AND "warehouseId" = $2',
            [fixture!.productId, fixture!.warehouseId],
          )
          await holder.query(
            'UPDATE "sales_orders" SET status = $1::"SalesOrderStatus" WHERE id = $2',
            ['ALLOCATED', orderId],
          )
        },
        () => allocateSalesOrder(db, { orderId, requireStatusUnderLock: BATCH_ELIGIBLE }),
      )

      assert.equal(result.skipped, undefined, 'ALLOCATED is still eligible — not skipped')
      assert.equal(result.success, true)

      const stock = await db.stockLevel.findFirst({
        where: { productId: fixture.productId, warehouseId: fixture.warehouseId },
        select: { reservedQty: true },
      })
      assert.equal(Number(stock?.reservedQty), 3, 'released-then-reserved: reservation not doubled to 6')
      assert.equal(await db.orderAllocation.count({ where: { orderId } }), 1, 'exactly one allocation row')
    } finally {
      if (fixture) await destroyFixture(db, fixture)
      await db.$disconnect()
      await holderPool.end()
    }
  },
)

test(
  'o3d-6ab: a payment-poller allocation followed by a hold — the skip must NOT release what the poller reserved',
  { skip: SKIP },
  async () => {
    // The o3d-9lx sweep exists precisely because a payment poller can leave an order PROCESSING and
    // stranded. Here the poller wins the lock, allocates, and the order is then held in the same window.
    // The sweep's guarded pass must be a NO-OP — in particular it must not release-and-delete the
    // reservation the poller just made, which is what an "allocate anyway" or a naive refusal would do.
    const { db, holderPool, allocateSalesOrder } = await loadDeps()
    let fixture: Fixture | undefined
    try {
      fixture = await createFixture(db)
      const orderId = fixture.orderId

      const result = await raceUnderRowLock(
        holderPool,
        orderId,
        async (holder) => {
          await holder.query(
            `INSERT INTO "order_allocations" ("id", "orderId", "lineId", "productId", "warehouseId", "qty", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, 3, NOW(), NOW())`,
            [`o6ab-${randomUUID()}`, orderId, fixture!.lineId, fixture!.productId, fixture!.warehouseId],
          )
          await holder.query(
            'UPDATE "stock_levels" SET "reservedQty" = "reservedQty" + 3, "updatedAt" = NOW() WHERE "productId" = $1 AND "warehouseId" = $2',
            [fixture!.productId, fixture!.warehouseId],
          )
          await holder.query(
            'UPDATE "sales_orders" SET status = $1::"SalesOrderStatus", "paidAt" = NOW() WHERE id = $2',
            ['ON_HOLD', orderId],
          )
        },
        () => allocateSalesOrder(db, { orderId, requireStatusUnderLock: BATCH_ELIGIBLE }),
      )

      assert.equal(result.skipped, true)
      assert.equal(result.skippedStatus, 'ON_HOLD')

      const stock = await db.stockLevel.findFirst({
        where: { productId: fixture.productId, warehouseId: fixture.warehouseId },
        select: { reservedQty: true },
      })
      assert.equal(Number(stock?.reservedQty), 3, "the poller's reservation survives the skip")
      assert.equal(await db.orderAllocation.count({ where: { orderId } }), 1, 'its allocation row survives too')
    } finally {
      if (fixture) await destroyFixture(db, fixture)
      await db.$disconnect()
      await holderPool.end()
    }
  },
)
