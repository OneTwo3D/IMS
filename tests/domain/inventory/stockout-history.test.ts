import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  buildStockoutDays,
  enumerateDates,
  getSnapshotCoverage,
  getStockoutDayCounts,
  getStockoutHistory,
  MAX_STOCKOUT_WINDOW_DAYS,
  type StockoutHistoryClient,
} from '@/lib/domain/inventory/stockout-history'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

const states = (history: ReturnType<typeof buildStockoutDays>) =>
  history.days.map((day) => (!day.covered ? 'unknown' : day.stockout ? 'stockout' : 'in_stock'))

test('enumerateDates is inclusive, crosses a year end, and rejects bad input', () => {
  assert.deepEqual(enumerateDates('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  assert.deepEqual(enumerateDates('2027-01-01', '2027-01-01'), ['2027-01-01'])
  assert.throws(() => enumerateDates('2027-01-02', '2027-01-01'), /on or after/)
  assert.throws(() => enumerateDates('2027-1-2', '2027-01-03'), /YYYY-MM-DD/)
})

test('stockout rule per day: covered+zero, covered+negative, covered+absent are stockouts; covered+positive is in stock', () => {
  const history = buildStockoutDays({
    dateFrom: '2027-01-01',
    dateTo: '2027-01-05',
    runDates: ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05'],
    rows: [
      { date: '2027-01-01', qty: '5' },
      { date: '2027-01-02', qty: '0' },
      { date: '2027-01-03', qty: '-2' },
      // 01-04: a run exists and the row is absent: a genuine zero (the run's contract)
      { date: '2027-01-05', qty: '0.000001' },
    ],
  })
  assert.deepEqual(states(history), ['in_stock', 'stockout', 'stockout', 'stockout', 'in_stock'])
  assert.equal(history.stockoutDayCount, 3)
  assert.equal(history.coveredDayCount, 5)
  assert.equal(history.uncoveredDayCount, 0)
  assert.equal(history.firstCoveredDate, '2027-01-01')
})

test('an uncovered day is UNKNOWN: not a stockout and not in stock, even with no rows at all', () => {
  const history = buildStockoutDays({
    dateFrom: '2027-01-01',
    dateTo: '2027-01-04',
    runDates: ['2027-01-03'],
    rows: [],
  })
  assert.deepEqual(states(history), ['unknown', 'unknown', 'stockout', 'unknown'])
  assert.deepEqual(history.days[0], { date: '2027-01-01', covered: false, stockout: false, qty: null })
  assert.equal(history.stockoutDayCount, 1)
  assert.equal(history.coveredDayCount, 1)
  assert.equal(history.uncoveredDayCount, 3)
  assert.equal(history.firstCoveredDate, '2027-01-03')
})

test('a window with no run at all reports no stockouts AND no coverage (never "all in stock")', () => {
  const history = buildStockoutDays({ dateFrom: '2027-01-01', dateTo: '2027-01-03', runDates: [], rows: [{ date: '2027-01-02', qty: '9' }] })
  assert.deepEqual(states(history), ['unknown', 'unknown', 'unknown'])
  assert.equal(history.firstCoveredDate, null)
  assert.equal(history.coveredDayCount, 0)
  assert.equal(history.stockoutDayCount, 0)
  // a stray row on an uncovered day does not make the day known
  assert.equal(history.days[1]!.qty, null)
})

test('mixed warehouses: summed across warehouses, stocked out only when zero everywhere', () => {
  const history = buildStockoutDays({
    dateFrom: '2027-01-01',
    dateTo: '2027-01-03',
    runDates: ['2027-01-01', '2027-01-02', '2027-01-03'],
    rows: [
      { date: '2027-01-01', warehouseId: 'a', qty: '0' },
      { date: '2027-01-01', warehouseId: 'b', qty: '4' }, // one warehouse empty, the other stocked: in stock
      { date: '2027-01-02', warehouseId: 'a', qty: '0' },
      { date: '2027-01-02', warehouseId: 'b', qty: '0' }, // empty everywhere
      { date: '2027-01-03', warehouseId: 'a', qty: '1.5' },
      { date: '2027-01-03', warehouseId: 'b', qty: '2.25' },
    ],
  })
  assert.deepEqual(states(history), ['in_stock', 'stockout', 'in_stock'])
  assert.deepEqual(history.days.map((day) => day.qty), [4, 0, 3.75])
})

test('getStockoutHistory: two indexed queries scoped to the product, warehouse and date range', async () => {
  type Where = { productId?: string; warehouseId?: string; snapshotDate: { gte: Date; lte: Date } }
  const calls: Array<{ model: string; args: { where: Where } }> = []
  const client: StockoutHistoryClient = {
    inventorySnapshotRun: {
      findMany: async (args) => { calls.push({ model: 'run', args: args as { where: Where } }); return [{ snapshotDate: new Date('2027-01-01T00:00:00.000Z') }, { snapshotDate: new Date('2027-01-02T00:00:00.000Z') }] },
      aggregate: async () => ({ _min: { snapshotDate: null } }),
    },
    inventorySnapshot: {
      findMany: async (args) => { calls.push({ model: 'snapshot', args: args as { where: Where } }); return [{ snapshotDate: new Date('2027-01-01T00:00:00.000Z'), warehouseId: 'w1', qty: new Prisma.Decimal('3') }] },
    },
  }
  const history = await getStockoutHistory({ productId: 'p1', warehouseId: 'w1', dateFrom: '2027-01-01', dateTo: '2027-01-03', client })
  assert.deepEqual(states(history), ['in_stock', 'stockout', 'unknown'])
  assert.equal(calls.length, 2)
  const snapshotWhere = calls.find((call) => call.model === 'snapshot')!.args.where
  assert.equal(snapshotWhere.productId, 'p1')
  assert.equal(snapshotWhere.warehouseId, 'w1')
  assert.equal(snapshotWhere.snapshotDate.gte.toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(snapshotWhere.snapshotDate.lte.toISOString(), '2027-01-03T00:00:00.000Z')
})

test('getStockoutHistory omits the warehouse clause when none is chosen', async () => {
  let where: Record<string, unknown> = {}
  const client: StockoutHistoryClient = {
    inventorySnapshotRun: { findMany: async () => [], aggregate: async () => ({ _min: { snapshotDate: null } }) },
    inventorySnapshot: { findMany: async (args: unknown) => { where = (args as { where: Record<string, unknown> }).where; return [] } },
  }
  await getStockoutHistory({ productId: 'p1', dateFrom: '2027-01-01', dateTo: '2027-01-02', client })
  assert.equal('warehouseId' in where, false)
})

test('getStockoutDayCounts: one raw query, stockout = covered - positive days, zeros for products the SQL did not return', async () => {
  const queries: Prisma.Sql[] = []
  const client = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query)
      return [{ coveredDays: 10, productId: 'p1', positiveDays: 6 }]
    },
  }
  const counts = await getStockoutDayCounts({ productIds: ['p1', 'p2', 'p1'], dateFrom: '2027-01-01', dateTo: '2027-01-10', client: client as never })
  assert.equal(queries.length, 1)
  assert.deepEqual(counts.get('p1'), { stockoutDays: 4, coveredDays: 10 })
  assert.deepEqual(counts.get('p2'), { stockoutDays: 10, coveredDays: 10 }) // never positive on a covered day: all stockout
  assert.equal(counts.size, 2)
  assert.match(queries[0]!.sql, /inventory_snapshot_runs/)
  assert.doesNotMatch(queries[0]!.sql, /generate_series|CROSS JOIN|"warehouseId" = \?/)
  assert.ok(queries[0]!.values.includes('2027-01-01'))
})

test('getStockoutDayCounts with no covered day in the range is { 0, 0 } for everyone', async () => {
  const client = { $queryRaw: async () => [{ coveredDays: 0, productId: null, positiveDays: null }] }
  const counts = await getStockoutDayCounts({ productIds: ['p1'], dateFrom: '2027-01-01', dateTo: '2027-01-10', client: client as never })
  assert.deepEqual(counts.get('p1'), { stockoutDays: 0, coveredDays: 0 })
})

test('getStockoutDayCounts adds the warehouse clause only when a warehouse is chosen, and skips the query for no products', async () => {
  const queries: Prisma.Sql[] = []
  const client = { $queryRaw: async (query: Prisma.Sql) => { queries.push(query); return [] } }
  await getStockoutDayCounts({ productIds: ['p1'], warehouseId: 'w1', dateFrom: '2027-01-01', dateTo: '2027-01-10', client: client as never })
  assert.match(queries[0]!.sql, /"warehouseId" = \?/)
  assert.ok(queries[0]!.values.includes('w1'))
  assert.equal((await getStockoutDayCounts({ productIds: [], dateFrom: '2027-01-01', dateTo: '2027-01-10', client: client as never })).size, 0)
  assert.equal(queries.length, 1)
})

test('getStockoutDayCounts refuses a range longer than the window cap, and accepts exactly the cap', async () => {
  const client = { $queryRaw: async () => [] }
  const ok = enumerateDates('2026-01-01', '2026-12-31') // 365 days
  assert.equal(ok.length, MAX_STOCKOUT_WINDOW_DAYS)
  await getStockoutDayCounts({ productIds: ['p1'], dateFrom: '2026-01-01', dateTo: '2026-12-31', client: client as never })
  await assert.rejects(getStockoutDayCounts({ productIds: ['p1'], dateFrom: '2026-01-01', dateTo: '2027-01-01', client: client as never }), /at most 365/)
})

test('property: covered - positiveDays equals the per-day buildStockoutDays count on random fixtures', () => {
  let seed = 12345
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let round = 0; round < 200; round += 1) {
    const dates = enumerateDates('2027-01-01', '2027-02-15')
    const runs = dates.filter(() => rand() < 0.7)
    const rows: Array<{ date: string; warehouseId: string; qty: number }> = []
    for (const date of dates) for (const wh of ['a', 'b']) if (rand() < 0.6) rows.push({ date, warehouseId: wh, qty: rand() < 0.4 ? 0 : Math.floor(rand() * 5) })
    const reference = buildStockoutDays({ dateFrom: '2027-01-01', dateTo: '2027-02-15', runDates: runs, rows })
    // the SQL formula, evaluated in JS: positive days = covered days whose summed on-hand > 0
    const runSet = new Set(runs)
    const sums = new Map<string, number>()
    for (const row of rows) sums.set(row.date, (sums.get(row.date) ?? 0) + row.qty)
    const positive = [...sums].filter(([date, qty]) => runSet.has(date) && qty > 0).length
    assert.equal(runs.length - positive, reference.stockoutDayCount, `round ${round}`)
    assert.equal(runs.length, reference.coveredDayCount)
  }
})

test('getStockoutDayCounts guards the product-id array with the source-row limit', async () => {
  const ids = Array.from({ length: 50001 }, (_, index) => `p${index}`)
  await assert.rejects(
    getStockoutDayCounts({ productIds: ids, dateFrom: '2027-01-01', dateTo: '2027-01-10', client: { $queryRaw: async () => [] } as never }),
    (error: unknown) => error instanceof SourceScanTooLargeError,
  )
})

test('getSnapshotCoverage reports covered days in the window and the earliest run on record', async () => {
  const coverage = await getSnapshotCoverage({
    dateFrom: '2027-01-01',
    dateTo: '2027-01-10',
    client: {
      inventorySnapshotRun: {
        findMany: async () => [{ snapshotDate: new Date('2027-01-08T00:00:00.000Z') }, { snapshotDate: new Date('2027-01-09T00:00:00.000Z') }],
        aggregate: async () => ({ _min: { snapshotDate: new Date('2027-01-08T00:00:00.000Z') } }),
      },
    },
  })
  assert.deepEqual(coverage, { firstCoveredDate: '2027-01-08', coveredDays: 2, windowDays: 10 })
})
