import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import {
  getSnapshotCoverage,
  getStockoutDayCounts,
  getStockoutHistory,
  type StockoutCountsClient,
  type StockoutHistoryClient,
} from '../../lib/domain/inventory/stockout-history'

/**
 * THE STOCKOUT SNAPSHOT QUERIES AGAINST A REAL DATABASE: the batch aggregate (one raw SQL, one row per
 * product) and the single-product history agree with each other and with the three-state rule, an
 * uncovered day is never a stockout, and an absent row on a covered day is a genuine zero.
 * Every test runs inside a transaction that is ROLLED BACK, ALWAYS. Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 * Dates are in 2099 so no real snapshot run can collide with the seeded ones.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/stockout-history.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

const D = (value: string) => new Prisma.Decimal(value)
const day = (value: string) => new Date(`${value}T00:00:00.000Z`)

// Runs on 03-01 .. 03-05 and 03-07. 03-06 has NO run: unknown.
const RUN_DATES = ['2099-03-01', '2099-03-02', '2099-03-03', '2099-03-04', '2099-03-05', '2099-03-07']
const FROM = '2099-03-01'
const TO = '2099-03-07'

async function seed(tx: Tx) {
  const suffix = randomUUID().slice(0, 8)
  const product = async (name: string) => (await tx.product.create({ data: { sku: `ST-${name}-${suffix}`, name, type: 'SIMPLE' }, select: { id: true } })).id as string
  const warehouse = async (name: string) => (await tx.warehouse.create({ data: { code: `${name}${suffix}`, name: `${name} ${suffix}` }, select: { id: true } })).id as string
  const [p1, p2, p3] = [await product('one'), await product('two'), await product('three')]
  const [wa, wb] = [await warehouse('A'), await warehouse('B')]
  for (const date of RUN_DATES) {
    await tx.inventorySnapshotRun.create({ data: { snapshotDate: day(date), stockLevelCount: 0, snapshotCount: 0 } })
  }
  const row = (productId: string, warehouseId: string, date: string, qty: string) =>
    tx.inventorySnapshot.create({ data: { snapshotDate: day(date), productId, warehouseId, qty: D(qty), valueBase: D('0'), unitCostBase: D(qty).gt(0) ? D('1') : null } })
  // p1 @ A: in stock 03-01/02, zero 03-03, NO ROW 03-04 (covered: genuine zero), in stock 03-05 and 03-07,
  // and a stray row on the uncovered 03-06 that must not make that day known.
  await row(p1, wa, '2099-03-01', '5'); await row(p1, wa, '2099-03-02', '5'); await row(p1, wa, '2099-03-03', '0')
  await row(p1, wa, '2099-03-05', '7'); await row(p1, wa, '2099-03-06', '0'); await row(p1, wa, '2099-03-07', '7')
  // p2: A is always empty, B always has stock.
  for (const date of RUN_DATES) { await row(p2, wa, date, '0'); await row(p2, wb, date, '4') }
  // p3: never stocked anywhere: no rows at all.
  return { p1, p2, p3, wa, wb }
}

test('batch counts: three-state rule, sparse rows, uncovered day, warehouse scoping', { skip }, async () => {
  await withRollback(async (tx) => {
    const { p1, p2, p3, wa, wb } = await seed(tx)
    const client = tx as StockoutCountsClient
    const all = await getStockoutDayCounts({ productIds: [p1, p2, p3], dateFrom: FROM, dateTo: TO, client })
    assert.equal(all.size, 3)
    // 6 covered days; the uncovered 03-06 is in NEITHER count
    assert.deepEqual(all.get(p1), { stockoutDays: 2, coveredDays: 6 }) // 03-03 zero, 03-04 absent row
    assert.deepEqual(all.get(p2), { stockoutDays: 0, coveredDays: 6 }) // empty in A, stocked in B: summed
    assert.deepEqual(all.get(p3), { stockoutDays: 6, coveredDays: 6 }) // never stocked: absent rows on covered days
    const inA = await getStockoutDayCounts({ productIds: [p2], warehouseId: wa, dateFrom: FROM, dateTo: TO, client })
    assert.deepEqual(inA.get(p2), { stockoutDays: 6, coveredDays: 6 })
    const inB = await getStockoutDayCounts({ productIds: [p2], warehouseId: wb, dateFrom: FROM, dateTo: TO, client })
    assert.deepEqual(inB.get(p2), { stockoutDays: 0, coveredDays: 6 })
  })
})

test('a window with no snapshot run has zero covered days for every product, never "no stockouts" by coverage', { skip }, async () => {
  await withRollback(async (tx) => {
    const { p1, p3 } = await seed(tx)
    const counts = await getStockoutDayCounts({ productIds: [p1, p3], dateFrom: '2099-02-01', dateTo: '2099-02-10', client: tx as StockoutCountsClient })
    assert.deepEqual(counts.get(p1), { stockoutDays: 0, coveredDays: 0 })
    assert.deepEqual(counts.get(p3), { stockoutDays: 0, coveredDays: 0 })
    const coverage = await getSnapshotCoverage({ dateFrom: '2099-02-01', dateTo: '2099-02-10', client: tx as StockoutHistoryClient })
    assert.equal(coverage.coveredDays, 0)
    assert.equal(coverage.windowDays, 10)
  })
})

test('single-product history agrees with the batch aggregate and keeps the unknown day unknown', { skip }, async () => {
  await withRollback(async (tx) => {
    const { p1, p2, p3 } = await seed(tx)
    const history = await getStockoutHistory({ productId: p1, dateFrom: FROM, dateTo: TO, client: tx as StockoutHistoryClient })
    assert.deepEqual(
      history.days.map((d) => (!d.covered ? 'unknown' : d.stockout ? 'stockout' : 'in_stock')),
      ['in_stock', 'in_stock', 'stockout', 'stockout', 'in_stock', 'unknown', 'in_stock'],
    )
    assert.equal(history.days[5]!.qty, null) // the stray 03-06 row did not make the day known
    assert.equal(history.firstCoveredDate, '2099-03-01')
    const batch = await getStockoutDayCounts({ productIds: [p1, p2, p3], dateFrom: FROM, dateTo: TO, client: tx as StockoutCountsClient })
    for (const productId of [p1, p2, p3]) {
      const single = await getStockoutHistory({ productId, dateFrom: FROM, dateTo: TO, client: tx as StockoutHistoryClient })
      assert.deepEqual(batch.get(productId), { stockoutDays: single.stockoutDayCount, coveredDays: single.coveredDayCount }, productId)
    }
  })
})

test('snapshot coverage: covered days inside the window and the earliest run on record', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx)
    const coverage = await getSnapshotCoverage({ dateFrom: FROM, dateTo: TO, client: tx as StockoutHistoryClient })
    assert.equal(coverage.coveredDays, 6)
    assert.equal(coverage.windowDays, 7)
    assert.ok(coverage.firstCoveredDate != null && coverage.firstCoveredDate <= '2099-03-01')
  })
})

test('the batch query plan (EXPLAIN of the real statement) has no product x day expansion', { skip }, async () => {
  await withRollback(async (tx) => {
    const { p1, p2, wa } = await seed(tx)
    const plans: string[] = []
    const explaining = {
      $queryRaw: async (query: Prisma.Sql) => {
        const plan = await tx.$queryRawUnsafe(`EXPLAIN (COSTS OFF) ${query.text}`, ...query.values) as Array<Record<string, string>>
        plans.push(plan.map((row) => Object.values(row)[0]).join('\n'))
        return []
      },
    }
    for (const warehouseId of [undefined, wa]) {
      await getStockoutDayCounts({ productIds: [p1, p2], warehouseId, dateFrom: FROM, dateTo: TO, client: explaining as never })
    }
    assert.equal(plans.length, 2)
    for (const text of plans) {
      assert.match(text, /inventory_snapshots/)
      assert.doesNotMatch(text, /generate_series|unnest|Function Scan/i)
    }
  })
})
