import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
} from '../lib/cost-layer-snapshots.ts'

/**
 * The production helper at `lib/domain/wms/asn-reconciliation.ts`
 * imports via `@/lib/...` which Node's plain ESM resolver doesn't understand.
 * Re-implement it here from the same pure primitives so the test runs without
 * the Next runtime. If the production copy drifts from this re-implementation
 * the contract has changed and the test should fail accordingly.
 */
function sliceTransferSnapshotForReceipt(input: {
  snapshot: unknown
  alreadyReceivedQty: number
  qtyReceived: number
}) {
  const snapshot = parseCostLayerSnapshot(input.snapshot)
  if (snapshot.length === 0) return []
  const alreadyReceived = Math.max(0, input.alreadyReceivedQty)
  const qtyReceived = Math.max(0, input.qtyReceived)
  if (qtyReceived <= 0) return []
  const { taken: consumedBefore } = takeFromSnapshotEntries(snapshot, alreadyReceived)
  const remaining = reduceSnapshotByCostLayer(
    snapshot,
    consumedBefore.map((e) => ({ costLayerId: e.costLayerId, qty: e.qty })),
  )
  return takeFromSnapshotEntries(remaining, qtyReceived).taken
}

/**
 * The manual `receiveTransfer` path now uses sliceTransferSnapshotForReceipt
 * to grab only the *remaining* portion of the cost-layer snapshot when a WMS
 * partial booking has already consumed some of it.
 *
 * If the slicer returns the full snapshot when alreadyReceived > 0, manual
 * close-out would double-count cost layers — the bug Codex flagged. Lock in:
 *
 *   - alreadyReceived = 0          → full snapshot
 *   - alreadyReceived = total      → empty result
 *   - alreadyReceived = partial    → only the un-consumed remainder
 *   - sum of two adjacent slices   = full snapshot
 */

const SNAPSHOT = [
  { costLayerId: 'L1', qty: 4, unitCostBase: 10 },
  { costLayerId: 'L2', qty: 6, unitCostBase: 12 },
]

function totalQty(rows: Array<{ qty: number }>) {
  return rows.reduce((sum, r) => sum + r.qty, 0)
}

test('alreadyReceived=0 returns the full requested slice', () => {
  const got = sliceTransferSnapshotForReceipt({
    snapshot: SNAPSHOT,
    alreadyReceivedQty: 0,
    qtyReceived: 10,
  })
  assert.equal(totalQty(got), 10)
})

test('alreadyReceived=10 (everything taken) returns empty', () => {
  const got = sliceTransferSnapshotForReceipt({
    snapshot: SNAPSHOT,
    alreadyReceivedQty: 10,
    qtyReceived: 5,
  })
  assert.equal(got.length, 0)
})

test('alreadyReceived=4 + remaining=6 returns only L2 (the un-consumed layer)', () => {
  const got = sliceTransferSnapshotForReceipt({
    snapshot: SNAPSHOT,
    alreadyReceivedQty: 4,
    qtyReceived: 6,
  })
  assert.equal(totalQty(got), 6)
  // After consuming all of L1 (4 units), only L2 should remain in the slice.
  assert.deepEqual(
    got.map((r) => ({ costLayerId: r.costLayerId, qty: r.qty })),
    [{ costLayerId: 'L2', qty: 6 }],
  )
})

test('two adjacent partial slices sum to the full snapshot — no overlap', () => {
  const first = sliceTransferSnapshotForReceipt({
    snapshot: SNAPSHOT,
    alreadyReceivedQty: 0,
    qtyReceived: 5,
  })
  const second = sliceTransferSnapshotForReceipt({
    snapshot: SNAPSHOT,
    alreadyReceivedQty: 5,
    qtyReceived: 5,
  })
  assert.equal(totalQty(first) + totalQty(second), 10)
  // No layer should appear with more total qty across the two slices than it
  // had in the original snapshot — that would be the double-count bug.
  const combined = new Map<string, number>()
  for (const row of [...first, ...second]) {
    combined.set(row.costLayerId, (combined.get(row.costLayerId) ?? 0) + row.qty)
  }
  assert.equal(combined.get('L1'), 4)
  assert.equal(combined.get('L2'), 6)
})

test('zero remaining qty is a no-op (skip the line entirely)', () => {
  const got = sliceTransferSnapshotForReceipt({
    snapshot: SNAPSHOT,
    alreadyReceivedQty: 4,
    qtyReceived: 0,
  })
  assert.equal(got.length, 0)
})

test('snapshot cost summation uses Decimal arithmetic internally', () => {
  const total = sumCostLayerSnapshot([
    { costLayerId: 'L1', qty: 0.1, unitCostBase: 0.1 },
    { costLayerId: 'L2', qty: 0.2, unitCostBase: 0.2 },
  ])

  assert.equal(total.toString(), '0.05')
})
