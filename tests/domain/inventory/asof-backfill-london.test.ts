import assert from 'node:assert/strict'
import test from 'node:test'

import { getOnHandAsOf, type OnHandAsOfClient } from '../../../lib/domain/inventory/get-on-hand-as-of.ts'
import { backfill, D, inbound, inRange, NOW, outbound, readerClient, type Move, type Store } from './london-day-fixtures.ts'
import { getNegativeStockReport, getStockOnHandReport, type StockPositionReportClient } from '../../../lib/domain/inventory/stock-position-reports.ts'

/**
 * o3d-cr517 #2 round-trip: the REAL backfill writer feeds an in-memory store, the REAL reader and the REAL negative-stock report read it back.
 * Snapshots are labelled by London day and a backfilled day's cutoffAt is the London end of that day (23:00Z in BST), so as-of reads and the
 * negative-stock opening/window line up with no hour counted twice or dropped.
 */


async function qtyAt(client: OnHandAsOfClient, asOf: string | Date): Promise<string> {
  const r = await getOnHandAsOf({ client, asOf, now: NOW })
  return r.rows[0]?.qty ?? '0'
}

test('writer stamps London cutoffs: 23:00Z in BST, 00:00Z in GMT, the 2026 clock-change days (23h and 25h)', async () => {
  const store = await backfill([], 10, '2026-07-01', '2026-07-01')
  assert.equal(store.runs.get('2026-07-01')!.toISOString(), '2026-07-01T23:00:00.000Z')
  const gmt = await backfill([], 10, '2026-01-10', '2026-01-10')
  assert.equal(gmt.runs.get('2026-01-10')!.toISOString(), '2026-01-11T00:00:00.000Z')
  const spring = await backfill([], 10, '2026-03-29', '2026-03-29')
  assert.equal(spring.runs.get('2026-03-29')!.toISOString(), '2026-03-29T23:00:00.000Z')
  const autumn = await backfill([], 10, '2026-10-25', '2026-10-25')
  assert.equal(autumn.runs.get('2026-10-25')!.toISOString(), '2026-10-26T00:00:00.000Z')
})

test('backfilled BST day: as-of that day excludes the 23:30Z movement, and the snapshot holds it only from the next London day', async () => {
  // Inbound of 5 at 07-01T23:30Z is London 2 July. Current stock 15 = 10 + 5.
  const moves = [inbound('late', 5, '2026-07-01T23:30:00.000Z')]
  const store = await backfill(moves, 15, '2026-07-01', '2026-07-02')
  const client = readerClient(store, moves, 15)
  // Same-day backfilled anchor (07-01 snapshot, cutoff 07-01T23:00Z): excludes the 5.
  assert.equal(await qtyAt(client, '2026-07-01'), '10.000000')
  assert.equal(await qtyAt(client, '2026-07-02'), '15.000000')
  // Precise instant inside [23:00Z, 00:00Z): London 2 July, 23:15Z is before the 23:30Z movement.
  assert.equal(await qtyAt(client, new Date('2026-07-01T23:15:00.000Z')), '10.000000')
  assert.equal(await qtyAt(client, new Date('2026-07-01T23:30:00.000Z')), '15.000000')
})

test('legacy stored UTC cutoff (D+1 00:00Z) is still read correctly: the extra hour is reversed out of a same-day as-of', async () => {
  const moves = [inbound('late', 5, '2026-07-01T23:30:00.000Z')]
  // A legacy backfill wrote content up to 07-02T00:00Z for label 07-01, so its snapshot already holds the 5 (qty 15).
  const store: Store = {
    snapshots: [{ snapshotDate: new Date('2026-07-01T00:00:00.000Z'), productId: 'p1', warehouseId: 'w1', qty: D(15), valueBase: D(15) }],
    runs: new Map([['2026-07-01', new Date('2026-07-02T00:00:00.000Z')]]),
  }
  const client = readerClient(store, moves, 15)
  assert.equal(await qtyAt(client, '2026-07-01'), '10.000000')
  assert.equal(await qtyAt(client, new Date('2026-07-01T23:15:00.000Z')), '10.000000')
  assert.equal(await qtyAt(client, new Date('2026-07-01T23:45:00.000Z')), '15.000000')
  assert.equal(await qtyAt(client, '2026-07-02'), '15.000000')
})

test('negative-stock report from the day after a backfilled BST day counts the 23:30Z movement exactly once', async () => {
  // Opening 3, sale of 5 at 07-01T23:30Z (London 2 July) -> trough -2. Current stock -2.
  const moves = [outbound('late-sale', 5, '2026-07-01T23:30:00.000Z')]
  const store = await backfill(moves, -2, '2026-07-01', '2026-07-02')
  const reader = readerClient(store, moves, -2)
  const client = {
    warehouse: { findMany: async () => [{ id: 'w1', code: 'W1', name: 'Main' }] },
    productCategory: { findMany: async () => [] },
    supplier: { findMany: async () => [] },
    product: { findMany: async () => [{ id: 'p1', sku: 'S1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs', category: null, supplierProducts: [] }] },
    stockLevel: { findMany: async () => [{ productId: 'p1', warehouseId: 'w1', quantity: D(-2) }] },
    inventoryReservationSnapshot: { findMany: async () => [] },
    inventoryReservationSnapshotRun: { findUnique: async () => null },
    stockMovement: {
      findMany: async (args: unknown) => {
        const w = (args as { where: { createdAt: { gte: Date; lt: Date } } }).where.createdAt
        return moves.filter((m) => inRange(m.createdAt, w))
      },
    },
  } as unknown as StockPositionReportClient
  const report = await getNegativeStockReport(
    { dateFrom: '2026-07-02', dateTo: '2026-07-02' },
    {
      paginate: false,
      now: () => new Date('2026-07-03T10:00:00.000Z'),
      deps: { client, getOnHandAsOf: (o) => getOnHandAsOf({ ...o, client: reader, now: () => new Date('2026-07-03T10:00:00.000Z') }) },
    },
  )
  const row = report.rows.find((r) => r.productId === 'p1')!
  assert.equal(row.minimumQty, '-2')
  assert.equal(row.firstNegativeAt, '2026-07-01T23:30:00.000Z')
})

test('stock-on-hand report as-of is the London end of day and still finds the reservation snapshot for that day', async () => {
  const moves: Move[] = []
  const store = await backfill(moves, 10, '2026-07-01', '2026-07-01')
  const reader = readerClient(store, moves, 10)
  let snapshotWhere: unknown
  const client = {
    warehouse: { findMany: async () => [{ id: 'w1', code: 'W1', name: 'Main' }] },
    productCategory: { findMany: async () => [] },
    supplier: { findMany: async () => [] },
    product: { findMany: async () => [{ id: 'p1', sku: 'S1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs', category: null, supplierProducts: [] }] },
    stockLevel: { findMany: async () => [] },
    inventoryReservationSnapshot: { findMany: async (a: unknown) => { snapshotWhere = a; return [] } },
    inventoryReservationSnapshotRun: { findUnique: async () => null },
    stockMovement: { findMany: async () => [] },
  } as unknown as StockPositionReportClient
  const report = await getStockOnHandReport(
    { includeCost: true, asOf: '2026-07-01' },
    { paginate: false, deps: { client, getOnHandAsOf: (o) => getOnHandAsOf({ ...o, client: reader, now: NOW }) } },
  )
  assert.equal(report.asOf, '2026-07-01T22:59:59.999Z')
  assert.ok(JSON.stringify(snapshotWhere).includes('2026-07-01T00:00:00.000Z'), 'reservation snapshot looked up by the London day label')
})

type Cut = { label: string; day: string; start: string; end: string; next: string; nextEnd: string }

const iso = (ms: number) => new Date(ms).toISOString()
const prevOf = (day: string) => iso(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).slice(0, 10)

function partitionMoves(c: Cut): Move[] {
  return [
    inbound('before', 1, iso(Date.parse(c.start) - 1)),
    inbound('first-in-day', 10, c.start),
    inbound('last-in-day', 100, iso(Date.parse(c.end) - 1)),
    inbound('next-day', 1000, c.end),
  ]
}

/** Every anchor choice must give the same 111 (1 + 10 + 100) as-of the clock-change day, and 1111 as-of the day after. */
async function assertPartition(c: Cut, store: Store, moves: Move[]) {
  const prev = prevOf(c.day)
  const only = (label: string): Store => ({ snapshots: store.snapshots.filter((s) => s.snapshotDate.toISOString().slice(0, 10) === label), runs: store.runs })
  const read = (s: Store, day: string) => qtyAt(readerClient(s, moves, 1111), day)
  assert.equal(await read(only(prev), c.day), '111.000000', 'forward from the day before')
  assert.equal(await read(only(c.day), c.day), '111.000000', 'same-day anchor')
  assert.equal(await read(only(c.next), c.day), '111.000000', 'reverse from the day after')
  assert.equal(await read(only(prev), c.next), '1111.000000', 'forward two days')
  assert.equal(await read(only(c.day), c.next), '1111.000000', 'forward one day')
  // Instants either side of the London midnight at the end of the day.
  assert.equal(await qtyAt(readerClient(only(prev), moves, 1111), new Date(Date.parse(c.end) - 1)), '111.000000')
  assert.equal(await qtyAt(readerClient(only(c.next), moves, 1111), new Date(Date.parse(c.end) - 1)), '111.000000')
  assert.equal(await qtyAt(readerClient(only(c.next), moves, 1111), new Date(c.end)), '1111.000000')
}

// The writer refuses future dates, so the writer-backed cases use the 2026 clock changes (spring 03-29 = 23h, autumn 10-25 = 25h).
for (const c of [
  { label: 'spring-forward 2026-03-29 (23h)', day: '2026-03-29', start: '2026-03-29T00:00:00.000Z', end: '2026-03-29T23:00:00.000Z', next: '2026-03-30', nextEnd: '2026-03-30T23:00:00.000Z' },
  { label: 'fall-back 2026-10-25 (25h)', day: '2026-10-25', start: '2026-10-24T23:00:00.000Z', end: '2026-10-26T00:00:00.000Z', next: '2026-10-26', nextEnd: '2026-10-27T00:00:00.000Z' },
] as Cut[]) {
  test(`writer-backed clock-change day ${c.label}: forward and reverse partition the day with no gap or overlap`, async () => {
    const moves = partitionMoves(c)
    const store = await backfill(moves, 1111, prevOf(c.day), c.next)
    assert.equal(store.runs.get(c.day)!.toISOString(), c.end)
    assert.equal(store.runs.get(c.next)!.toISOString(), c.nextEnd)
    await assertPartition(c, store, moves)
  })
}

for (const c of [
  { label: 'spring-forward 2027-03-28 (23h)', day: '2027-03-28', start: '2027-03-28T00:00:00.000Z', end: '2027-03-28T23:00:00.000Z', next: '2027-03-29', nextEnd: '2027-03-29T23:00:00.000Z' },
  { label: 'fall-back 2027-10-31 (25h)', day: '2027-10-31', start: '2027-10-30T23:00:00.000Z', end: '2027-11-01T00:00:00.000Z', next: '2027-11-01', nextEnd: '2027-11-02T00:00:00.000Z' },
] as Cut[]) {
  test(`stored-cutoff clock-change day ${c.label}: forward, reverse, same-day and legacy UTC-cutoff anchors agree`, async () => {
    const moves = partitionMoves(c)
    const prev = prevOf(c.day)
    const snap = (label: string, qty: number) => ({ snapshotDate: new Date(`${label}T00:00:00.000Z`), productId: 'p1', warehouseId: 'w1', qty: D(qty), valueBase: D(qty) })
    const store: Store = {
      snapshots: [snap(prev, 1), snap(c.day, 111), snap(c.next, 1111)],
      runs: new Map([[prev, new Date(c.start)], [c.day, new Date(c.end)], [c.next, new Date(c.nextEnd)]]),
    }
    await assertPartition(c, store, moves)
    // Legacy backfill: UTC cutoff (day+1 00:00Z). Spring: it also holds 'next-day' (23:00Z..24:00Z, qty 1111); autumn: the UTC cutoff equals the London end.
    const utcCut = new Date(`${c.next}T00:00:00.000Z`)
    const legacyQty = utcCut.getTime() > Date.parse(c.end) ? 1111 : 111
    const legacy: Store = { snapshots: [snap(c.day, legacyQty)], runs: new Map([[c.day, utcCut]]) }
    assert.equal(await qtyAt(readerClient(legacy, moves, 1111), c.day), '111.000000')
    assert.equal(await qtyAt(readerClient(legacy, moves, 1111), c.next), '1111.000000')
  })
}

test('backfill: a movement in the hour before UTC fromDate (London fromDate, BST) is in the fromDate row, and a null-value one there does not mark the run unreliable', async () => {
  // 2026-06-30T23:30Z is London 1 July: in 07-01's row, in no earlier one. The fetch lower bound is end(06-30) = 06-30T23:00Z, an hour below UTC fromDate.
  const moves = [inbound('hour', 5, '2026-06-30T23:30:00.000Z'), { ...inbound('hour-null', 2, '2026-06-30T23:45:00.000Z'), totalValueBase: null }]
  const store = await backfill(moves, 17, '2026-07-01', '2026-07-01')
  const row = store.snapshots.find((s) => s.snapshotDate.toISOString() === '2026-07-01T00:00:00.000Z')!
  assert.equal(row.qty.toString(), '17', 'both movements of London 1 July are in the 07-01 row')
  assert.equal(store.result!.missingValueMovementCount, 0, 'nothing is reversed past the last written row, so nothing is counted')
  assert.equal(store.result!.valueReplayReliable, true)
})

test('backfill: a null-value movement inside fromDate itself does not mark the result unreliable (the trailing reverse pass fed only discarded state)', async () => {
  const moves = [{ ...inbound('same-day-null', 3, '2026-07-01T10:00:00.000Z'), totalValueBase: null }]
  const store = await backfill(moves, 13, '2026-07-01', '2026-07-01')
  assert.equal(store.result!.missingValueMovementCount, 0)
  assert.equal(store.result!.valueReplayReliable, true)
})

test('backfill: a null-value movement that an EARLIER-day row depends on still marks the result unreliable', async () => {
  // fromDate 07-01, toDate 07-02: the null-value movement on 07-02 is reversed to reach 07-01's row, so 07-01 is baked with it and the run is flagged.
  const moves = [{ ...inbound('later-null', 3, '2026-07-02T10:00:00.000Z'), totalValueBase: null }]
  const store = await backfill(moves, 13, '2026-07-01', '2026-07-02')
  assert.equal(store.result!.missingValueMovementCount, 1)
  assert.equal(store.result!.valueReplayReliable, false)
})
