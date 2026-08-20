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
  takeDailyBatchWindow,
} from '@/lib/connectors/xero/daily-sync'
import { unaccountedAllocationQty } from '@/lib/cost-layer-snapshots'

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
  // And the journaled shipment contributes NO value: Group B refuses to journal an unstamped order,
  // so a journal date is proof A2 already posted that cost once.
  assert.deepEqual(plan.unjournaledShipments, [])
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

test('o3d-0i5y r5: a never-stamped row whose quantity has all shipped still gets its empty stamp', () => {
  // The pre-existing shipped-order behaviour, unchanged: the value comes from the shipment snapshot
  // and the allocation row is stamped empty so it is not mistaken for unaccounted next time.
  const plan = planA2Reclassification({
    allocations: [allocationRow({ qty: 2, costLayerSnapshot: null })],
    shipments: [shipmentRow({ qty: 2 })],
  })

  assert.equal(plan.outstandingByAllocation.size, 0)
  assert.deepEqual(plan.stampEmptyAllocationIds, ['alloc-1'])
  assert.equal(plan.unjournaledShipments.length, 1, 'and the shipment is still valued — it has not been journaled')
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

  assert.equal(plan.unjournaledShipments.length, 1, 'the dispatched 6 are valued from the shipment snapshot')
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
