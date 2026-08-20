import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  XERO_DAILY_BATCH_DEFAULT_LIMIT,
  XERO_DAILY_BATCH_MAX_LIMIT,
  buildDailyBatchReferenceId,
  planA2Reclassification,
  resolveXeroDailyBatchLimit,
  takeShipmentAccountedEntries,
  takeDailyBatchWindow,
} from '@/lib/connectors/xero/daily-sync'
import {
  parseCostLayerSnapshot,
  sumCostLayerSnapshotQty,
  unaccountedAllocationQty,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { toDecimal } from '@/lib/domain/math/decimal'

test('Xero daily batch limit defaults, floors, and clamps operator input', () => {
  assert.equal(resolveXeroDailyBatchLimit(''), XERO_DAILY_BATCH_DEFAULT_LIMIT)
  assert.equal(resolveXeroDailyBatchLimit('0'), XERO_DAILY_BATCH_DEFAULT_LIMIT)
  assert.equal(resolveXeroDailyBatchLimit('-1'), XERO_DAILY_BATCH_DEFAULT_LIMIT)
  assert.equal(resolveXeroDailyBatchLimit('10.9'), 10)
  assert.equal(resolveXeroDailyBatchLimit(String(XERO_DAILY_BATCH_MAX_LIMIT + 1)), XERO_DAILY_BATCH_MAX_LIMIT)
})

test('Xero daily batch window processes only the first limit rows and signals remaining work', () => {
  const firstRun = takeDailyBatchWindow(['a', 'b', 'c'], 2)

  assert.deepEqual(firstRun.rows, ['a', 'b'])
  assert.equal(firstRun.hasMore, true)

  const secondRun = takeDailyBatchWindow(['c'], 2)
  assert.deepEqual(secondRun.rows, ['c'])
  assert.equal(secondRun.hasMore, false)
})

test('Xero daily batch reference ids distinguish split batches for the same date', () => {
  assert.equal(
    buildDailyBatchReferenceId('A2', '2026-06-09', ['order-3', 'order-1', 'order-2']),
    buildDailyBatchReferenceId('A2', '2026-06-09', ['order-1', 'order-2', 'order-3']),
  )
  assert.notEqual(
    buildDailyBatchReferenceId('A1', '2026-06-09', ['order-1', 'order-2']),
    buildDailyBatchReferenceId('A1', '2026-06-09', ['order-3']),
  )
  assert.match(
    buildDailyBatchReferenceId('B', '2026-06-09', ['shipment-1']),
    /^B-2026-06-09-[a-f0-9]{8}$/,
  )
})

// ---------------------------------------------------------------------------
// o3d-0i5y r5 — RESIDUAL QUANTITY ALLOCATED AFTER THE A2 STAMP HAD NO ROUTE INTO THE LEDGER.
//
// r4 correctly refused to clear the A2 stamp on a part-journaled order: A2 values a shipped order
// from its SHIPMENT snapshots, so a re-stage would have re-posted a reclassification the ledger
// already held and written an empty snapshot over the evidence a journal was posted against. What it
// did not do is give the RESIDUAL — quantity allocated after that stamp, which is the entire point of
// the journal-safe permit — any route in at all. Group B still credits Allocated Inventory when that
// residual ships, so the account drifts short by its cost and Inventory stays overstated by it.
//
// A2 now decides per allocation ROW instead of per order.
// ---------------------------------------------------------------------------

const JOURNALED = new Date('2026-01-02T00:00:00.000Z')

function allocationRow(overrides: Partial<Parameters<typeof planA2Reclassification>[0]['allocations'][number]> = {}) {
  return {
    id: 'alloc-1',
    lineId: 'line-1',
    productId: 'product-1',
    warehouseId: 'warehouse-1',
    qty: 3,
    costLayerSnapshot: null,
    ...overrides,
  }
}

function shipmentRow(overrides: { shipmentJournalDate?: Date | null; qty?: number } = {}) {
  return {
    warehouseId: 'warehouse-1',
    shipmentJournalDate: overrides.shipmentJournalDate ?? null,
    lines: [{ lineId: 'line-1', productId: 'product-1', qty: overrides.qty ?? 2 }],
  }
}

test('o3d-0i5y r5: the residual on a part-journaled order is owed a reclassification, and the journaled part is not', () => {
  // THE DEFECT. 3 ordered, 2 allocated-shipped-and-journaled, the third unit allocated afterwards by
  // the journal-safe rebuild. Under r4 this order was never looked at again and the third unit was
  // never reclassified — yet Group B credits Allocated Inventory for it the moment it ships.
  const plan = planA2Reclassification({
    allocations: [allocationRow({
      qty: 3,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 4 }],
    })],
    shipments: [shipmentRow({ shipmentJournalDate: JOURNALED, qty: 2 })],
  })

  // Exactly the residual: 3 allocated less the 2 already accounted. Not 3 (re-posting the journaled
  // part) and not 0 (r4).
  assert.equal(plan.outstandingByAllocation.get('alloc-1')?.toString(), '1')
  // And the dispatched 2 contribute NO value: the row's own pin already accounts for both of them.
  // r5 read that off the shipment's JOURNAL DATE instead; r7 reads it off the row, which is the only
  // record that knows which units A2 posted (a journal date only says the ORDER was stamped once).
  assert.equal(plan.shipmentAccountedByAllocation.size, 0)
  // The pinned layers are evidence for a posted journal. A2 must not restamp the row to empty.
  assert.deepEqual(plan.stampEmptyAllocationIds, [])
})

test('o3d-0i5y r5: pinned layers and shipped quantity are the SAME accounted units, so they are maxed and never summed', () => {
  // The two records of "already reclassified" OVERLAP — a dispatch consumes the very allocation it
  // ships. Adding them makes 5 allocated units look 6-accounted and strands the residual exactly as
  // r4 did, from a different direction.
  const plan = planA2Reclassification({
    allocations: [allocationRow({
      qty: 5,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 3, unitCostBase: 4 }],
    })],
    shipments: [shipmentRow({ shipmentJournalDate: JOURNALED, qty: 3 })],
  })

  assert.equal(plan.outstandingByAllocation.get('alloc-1')?.toString(), '2')
})

test('o3d-0i5y r5: a row A2 already pinned and that owes nothing is left ALONE, not restamped', () => {
  // Neither list. The write loop only touches rows a plan names, so this row's snapshot — the basis
  // the refund reversal relieves through — survives a pass that came back for a sibling's residual.
  const plan = planA2Reclassification({
    allocations: [allocationRow({
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 4 }],
    })],
    shipments: [],
  })

  assert.equal(plan.outstandingByAllocation.size, 0)
  assert.deepEqual(plan.stampEmptyAllocationIds, [])
})

test('o3d-0i5y r6: a never-stamped row whose quantity has all shipped is RECORDED, not stamped empty', () => {
  // r5 stamped this row with an EMPTY snapshot, on the reasoning that its value came through the
  // shipment. That is true and it is exactly the ambiguity: an empty snapshot beside 2 dispatched
  // units cannot tell the next pass whether those units were accounted, so the moment the order comes
  // back the pass has to guess. It no longer guesses — the 2 units are recorded on the row.
  const plan = planA2Reclassification({
    allocations: [allocationRow({ qty: 2, costLayerSnapshot: null })],
    shipments: [shipmentRow({ qty: 2 })],
  })

  assert.equal(plan.outstandingByAllocation.size, 0, 'nothing is on the shelf, so nothing is pinned')
  assert.equal(
    plan.shipmentAccountedByAllocation.get('alloc-1')?.toString(),
    '2',
    'the 2 dispatched units are what this pass accounts — and, since r7, exactly what it values',
  )
  assert.deepEqual(plan.stampEmptyAllocationIds, [], 'and the empty stamp is no longer how it is recorded')
})

test('o3d-0i5y r5: a first pass on an unshipped order is unchanged — the whole row is outstanding', () => {
  const plan = planA2Reclassification({
    allocations: [allocationRow({ qty: 4, costLayerSnapshot: null })],
    shipments: [],
  })

  assert.equal(plan.outstandingByAllocation.get('alloc-1')?.toString(), '4')
  assert.deepEqual(plan.stampEmptyAllocationIds, [])
})

test('o3d-0i5y r5: an order that both ships and holds residual owes BOTH, rather than only the shipment', () => {
  // The same defect in first-pass form: 6 of 10 dispatched before A2 ever ran. The order-level branch
  // took the shipment value and stopped, so the 4 still on the shelf were never reclassified either.
  const plan = planA2Reclassification({
    allocations: [allocationRow({ qty: 10, costLayerSnapshot: null })],
    shipments: [shipmentRow({ qty: 6 })],
  })

  assert.equal(
    plan.shipmentAccountedByAllocation.get('alloc-1')?.toString(),
    '6',
    'the dispatched 6 are valued from the shipment snapshot',
  )
  assert.equal(plan.outstandingByAllocation.get('alloc-1')?.toString(), '4', 'and the 4 on the shelf are pinned')
})

test('o3d-0i5y r5: unaccountedAllocationQty never reports a negative outstanding', () => {
  // A refund or a shrunk row can leave more accounted than allocated. That is a floor violation the
  // allocation guard refuses; it must not come back here as a negative debit.
  const outstanding = unaccountedAllocationQty({
    allocatedQty: 1,
    snapshot: [{ costLayerId: 'layer-1', qty: 2, unitCostBase: 4 }],
    shippedQty: 2,
  })
  assert.equal(outstanding.toString(), '0')
})

test('o3d-0i5y r5: Group A2 writes a snapshot only where its plan named one', () => {
  // Structural, because the property is about the ABSENCE of a write and there is no harness that can
  // run the batch. `?? []` here would erase the pinned layers of every row a previous pass posted —
  // the exact evidence r4 kept the stamp to protect — on every residual pass.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/daily-sync.ts'), 'utf8')
  const start = src.indexOf('// --- Group A2: Inventory Reclassification ---')
  const block = src.slice(start, src.indexOf('// --- Group B:', start))
  assert.ok(start > 0 && block.length > 0, 'the Group A2 block must exist')
  assert.ok(
    block.includes('const next = allocationSnapshots.get(alloc.id)') && block.includes('if (!next) continue'),
    'A2 must skip allocation rows its plan did not name',
  )
  assert.equal(
    block.indexOf('allocationSnapshots.get(alloc.id) ?? []'),
    -1,
    'A2 must not default an unnamed row to an empty snapshot',
  )
})


// ---------------------------------------------------------------------------
// o3d-0i5y r6 — A RESIDUAL PINNED BESIDE A SHIPMENT THAT PREDATES A2 POSTED TWICE.
//
// r5 established that the two records of "already reclassified" OVERLAP — a dispatch consumes the
// allocation it ships — so accounted quantity is max(pinned, shipped) and never the sum. That holds
// while both records describe the same units. They do not when the shipment came FIRST: A2 cannot pin
// units whose layers dispatch has already consumed, so it takes their value from the shipment
// snapshots and pins only the remainder. The row is then left holding 4 pinned BESIDE 6 dispatched —
// disjoint units totalling 10 — and max answers 6. Every later pass found the same 4 "unaccounted",
// re-pinned them and posted them again.
//
// There is nothing on the row that tells the two cases apart, so A2 stops inferring: it RECORDS the
// units it accounted through a shipment, on the row, as shipment-source entries carrying the layers
// the dispatch actually consumed. The pin becomes the whole record of accounted quantity.
// ---------------------------------------------------------------------------

function shipmentLineWithSnapshot(overrides: { id?: string; qty?: number; layerId?: string } = {}) {
  const qty = overrides.qty ?? 6
  return {
    id: overrides.id ?? 'shipment-line-1',
    lineId: 'line-1',
    productId: 'product-1',
    qty,
    costLayerSnapshot: [{
      costLayerId: overrides.layerId ?? 'layer-dispatched',
      qty,
      unitCostBase: 3,
      shipmentLineId: overrides.id ?? 'shipment-line-1',
      source: 'shipment',
    }],
  }
}

function shipmentWithLines(
  lines: ReturnType<typeof shipmentLineWithSnapshot>[],
  shipmentJournalDate: Date | null = null,
) {
  return { warehouseId: 'warehouse-1', shipmentJournalDate, lines }
}

/**
 * The A2 write loop, applied to one row: the units this pass accounted through the shipment, then the
 * layers it freshly pinned, APPENDED to what the row already held. Deliberately mirrors
 * `runDailyBatchSync` rather than re-deriving anything, so the two-pass property below is about the
 * plan and the write together — which is where the double post lived.
 */
function applyA2Pass(
  row: ReturnType<typeof allocationRow>,
  plan: ReturnType<typeof planA2Reclassification>,
  shipmentLines: ReturnType<typeof shipmentLineWithSnapshot>[],
): ReturnType<typeof allocationRow> {
  const recordQty = plan.shipmentAccountedByAllocation.get(row.id)
  // o3d-0i5y r8: the row's own record is passed in, exactly as `runDailyBatchSync` passes it, so the
  // take can never re-offer an entry an earlier pass already valued.
  const alreadyRecorded = parseCostLayerSnapshot(row.costLayerSnapshot)
  const recorded = recordQty ? takeShipmentAccountedEntries(alreadyRecorded, shipmentLines, recordQty, row.id) : []
  const outstanding = plan.outstandingByAllocation.get(row.id)
  const pinned: CostLayerSnapshotEntry[] = outstanding
    ? [{ costLayerId: 'layer-on-the-shelf', qty: outstanding.toString(), unitCostBase: 5 }]
    : []
  return {
    ...row,
    costLayerSnapshot: [
      ...alreadyRecorded,
      ...recorded,
      ...pinned,
    ] as never,
  }
}

test('o3d-0i5y r6: a pass that values dispatched units from the shipment RECORDS them on the row', () => {
  // 10 allocated, 6 of them dispatched before A2 ever ran. The 4 on the shelf are pinned, as r5 does;
  // the 6 gone are what r5 left no record of at all.
  const line = shipmentLineWithSnapshot({ qty: 6 })
  const plan = planA2Reclassification({
    allocations: [allocationRow({ qty: 10, costLayerSnapshot: null })],
    shipments: [shipmentWithLines([line])],
  })

  assert.equal(plan.outstandingByAllocation.get('alloc-1')?.toString(), '4', 'the 4 on the shelf are pinned')
  assert.equal(
    plan.shipmentAccountedByAllocation.get('alloc-1')?.toString(),
    '6',
    'and the 6 dispatched are recorded — which is also, since r7, exactly the quantity valued from the shipment',
  )
  assert.deepEqual(plan.stampEmptyAllocationIds, [])
})

test('o3d-0i5y r6: the residual beside a pre-A2 shipment is pinned ONCE, not once per pass', () => {
  // THE DEFECT, end to end. Pass one accounts all 10 units. Pass two — the order comes back because a
  // sibling row changed, or the rebuild re-declared the same set — must find NOTHING owed. Under r5
  // it found the same 4 outstanding (max(pinned 4, shipped 6) = 6 of 10 accounted) and pinned and
  // posted them a second time, and again on every pass after that.
  const line = shipmentLineWithSnapshot({ qty: 6 })
  const journaledShipment = shipmentWithLines([line], JOURNALED)

  const firstPass = planA2Reclassification({
    allocations: [allocationRow({ qty: 10, costLayerSnapshot: null })],
    shipments: [shipmentWithLines([line])],
  })
  const afterFirstPass = applyA2Pass(allocationRow({ qty: 10, costLayerSnapshot: null }), firstPass, [line])

  const secondPass = planA2Reclassification({
    allocations: [afterFirstPass],
    shipments: [journaledShipment],
  })

  assert.equal(plansOwe(secondPass, 'alloc-1'), '0', 'nothing is owed, so the residual is not pinned and posted twice')
  assert.equal(
    secondPass.shipmentAccountedByAllocation.size,
    0,
    'and there is nothing left to record — which under r7 is the same statement as nothing left to value',
  )

  // WHY it is nothing: the row itself now says so.
  assert.equal(
    sumCostLayerSnapshotQty(parseCostLayerSnapshot(afterFirstPass.costLayerSnapshot)).toString(),
    '10',
    'the row records all 10 accounted units, not just the 4 it could pin',
  )
  assert.equal(
    parseCostLayerSnapshot(afterFirstPass.costLayerSnapshot)
      .filter((entry) => entry.source === 'shipment')
      .reduce((sum, entry) => sum + Number(entry.qty), 0),
    6,
    'the 6 dispatched units are recorded as accounted THROUGH the shipment, with the layers dispatch consumed',
  )
})

test('o3d-0i5y r6: a genuine residual added AFTER the record is still owed, and only the residual', () => {
  // The counter-guard: r5 exists to get residual quantity into the ledger, and r6 must not buy its
  // idempotence by stranding it again. 3 more units allocated after the pass -> exactly 3 owed.
  const line = shipmentLineWithSnapshot({ qty: 6 })
  const recorded = takeShipmentAccountedEntries([], [line], toDecimal(6), 'alloc-1')
  const plan = planA2Reclassification({
    allocations: [allocationRow({
      qty: 13,
      costLayerSnapshot: [
        ...recorded,
        { costLayerId: 'layer-on-the-shelf', qty: 4, unitCostBase: 5 },
      ] as never,
    })],
    shipments: [shipmentWithLines([line], JOURNALED)],
  })

  assert.equal(plan.outstandingByAllocation.get('alloc-1')?.toString(), '3')
  assert.equal(plan.shipmentAccountedByAllocation.size, 0)
})

test('o3d-0i5y r6: the record carries the layers the dispatch consumed, and never more than was dispatched', () => {
  const lines = [
    shipmentLineWithSnapshot({ id: 'shipment-line-1', qty: 4, layerId: 'layer-a' }),
    shipmentLineWithSnapshot({ id: 'shipment-line-2', qty: 3, layerId: 'layer-b' }),
  ]

  const taken = takeShipmentAccountedEntries([], lines, toDecimal(6), 'alloc-1')

  assert.equal(sumCostLayerSnapshotQty(taken).toString(), '6')
  assert.deepEqual(
    taken.map((entry) => [entry.costLayerId, entry.qty, entry.shipmentLineId, entry.source, entry.orderAllocationId]),
    [
      ['layer-a', '4.000000', 'shipment-line-1', 'shipment', 'alloc-1'],
      ['layer-b', '2.000000', 'shipment-line-2', 'shipment', 'alloc-1'],
    ],
    'FIFO across the dispatching lines, at the cost each line actually consumed',
  )

  // A legacy line with no snapshot cannot be recorded. Recording less is the safe direction: the row
  // keeps looking under-accounted rather than over-accounted, which is r5's behaviour, not worse.
  const partial = takeShipmentAccountedEntries(
    [],
    [...lines, { id: 'shipment-line-3', costLayerSnapshot: null }],
    toDecimal(9),
    'alloc-1',
  )
  assert.equal(sumCostLayerSnapshotQty(partial).toString(), '7')
})

test('o3d-0i5y r7: Group A2 posts exactly the entries it writes, and reads no shipment journal date', () => {
  // r6's assertion here is REVERSED rather than dropped. It read "the recorded shipment units are
  // never added to the journal" as the rule, because the WHOLE unjournaled shipment was valued a few
  // lines above and adding the record too would have posted those units twice. The whole-shipment
  // valuation is the defect: on a MIXED shipment it re-posts the part an earlier pass already pinned.
  // Value now follows the record — `recorded` is by construction the dispatched quantity the row does
  // NOT already account for — and what A2 posts for a mixed shipment is asserted on the live writer in
  // tests/accounting/daily-batch-a2-mixed-shipment.test.ts.
  //
  // What stays structural is the ABSENCE: A2 must not resurrect a journal-date exclusion, and no
  // fixture can show that, because a journal date it never reads cannot change an outcome.
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/daily-sync.ts'), 'utf8')
  const start = src.indexOf('// --- Group A2: Inventory Reclassification ---')
  const block = src.slice(start, src.indexOf('// --- Group B:', start))
  assert.ok(start > 0 && block.length > 0, 'the Group A2 block must exist')
  assert.ok(
    block.includes('addMoney(sumCostLayerSnapshot(recorded), sumCostLayerSnapshot(consumed))'),
    'A2 posts the units it records from the shipment AND the layers it freshly pins',
  )
  assert.equal(
    block.indexOf('requireShipmentSnapshotValue('),
    -1,
    'and never values a shipment as a whole, which is what re-posted the pinned part of a mixed one',
  )
  assert.ok(
    block.includes('...recorded,') && block.includes('takeShipmentAccountedEntries('),
    'while still writing those units onto the row',
  )
  assert.equal(
    block.indexOf('shipmentJournalDate: true'),
    -1,
    'A2 does not even select a shipment journal date: what it owes is decided by the allocation row',
  )
  assert.equal(
    readFileSync(join(process.cwd(), 'lib/connectors/xero/daily-sync.ts'), 'utf8')
      .slice(src.indexOf('export function planA2Reclassification'), src.indexOf('export function takeShipmentAccountedEntries'))
      .indexOf('shipmentJournalDate'),
    -1,
    'and neither does the plan it decides with',
  )
})

/** The outstanding quantity a plan owes a row, as a string, with "0" for "owes nothing". */
function plansOwe(plan: ReturnType<typeof planA2Reclassification>, allocationId: string): string {
  return (plan.outstandingByAllocation.get(allocationId) ?? toDecimal(0)).toString()
}
