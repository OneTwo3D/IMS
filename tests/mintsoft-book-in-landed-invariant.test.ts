import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileBookedInQuantities, resolveManualReceiptPool } from '../lib/domain/wms/asn-reconciliation.ts'

/**
 * o3d-papk (6a follow-up, C1) — A-U1. THE INVARIANT OF A BOOK-IN, over a grid.
 *
 * A book-in changes the line's LANDED quantity (`qtyReceived + max(0, snapshot - receipt)`, the PO and transfer
 * definition, for the one ASN row a fixture has) by EXACTLY the stock it adds, and accounts for exactly the
 * delta the warehouse reported. The old arithmetic broke the first half whenever a manual receipt sat on the
 * line next to an unabsorbed snapshot credit (Codex H1): the manual term was applied before the snapshot cover,
 * so `qtyAccountedViaReceipt` rose by more than `qtyReceived` did and landed FELL.
 *
 * The grid ENUMERATES; it does not sample. Every case is checked, the count is printed, and the old arithmetic
 * (`trunkReconcile`, copied from 5f14d41c) is run over the same grid and MUST violate the invariant somewhere,
 * so a grid that could not see the defect cannot pass.
 */

const EXPECTED = 10

type Case = {
  current: number
  lastProcessed: number
  snapshot: number
  receipt: number
  pool: number
}

function landed(qtyReceived: number, snapshot: number, receipt: number): number {
  return qtyReceived + Math.max(0, snapshot - receipt)
}

function grid(): Case[] {
  const cases: Case[] = []
  for (const lastProcessed of [0, 3, 6]) {
    for (const current of [0, 3, 6, 10]) {
      if (current < lastProcessed) continue
      for (const snapshot of [0, 4, 6, 10]) {
        for (const receipt of [0, 2, 4, 6, 10]) {
          if (receipt > snapshot) continue
          for (const pool of [0, 2, 4, 10]) {
            cases.push({ current, lastProcessed, snapshot, receipt, pool })
          }
        }
      }
    }
  }
  return cases
}

/** The arithmetic as it stood at 5f14d41c: the manual term first, the snapshot cover second. */
function trunkReconcile(input: { current: number; lastProcessed: number; snapshot: number; receipt: number; localReceivedQty: number }) {
  const current = Math.min(EXPECTED, input.current)
  const local = Math.min(current, input.localReceivedQty)
  const alreadyAccountedViaAsn = Math.max(input.lastProcessed, local)
  const reconciledManualQty = Math.max(0, alreadyAccountedViaAsn - input.lastProcessed)
  const qtyReceived = Math.max(0, current - alreadyAccountedViaAsn)
  const covered = Math.min(qtyReceived, Math.max(0, input.snapshot - input.receipt))
  return { qtyReceived, reconciledManualQty, covered, stockQtyToAdd: Math.max(0, qtyReceived - covered), newlyProcessedQty: qtyReceived + reconciledManualQty }
}

test('A-U1: every book-in changes landed by exactly the stock it adds and accounts for exactly the delta', () => {
  let examined = 0
  let interaction = 0
  for (const c of grid()) {
    const qtyReceivedBefore = c.pool + c.lastProcessed
    const result = reconcileBookedInQuantities({
      expectedQty: EXPECTED,
      currentReceivedQty: c.current,
      manualReceiptPool: resolveManualReceiptPool({ lineQtyReceived: qtyReceivedBefore, lineReconciledAcrossAsns: c.lastProcessed, rowManualQtyBaseline: 0 }),
      lastProcessedReceivedQty: c.lastProcessed,
      qtyAccountedViaSnapshot: c.snapshot,
      qtyAccountedViaReceipt: c.receipt,
    })
    examined += 1
    const delta = Math.max(0, c.current - c.lastProcessed)
    const unabsorbed = Math.max(0, c.snapshot - c.receipt)
    if (c.pool > 0 && unabsorbed > 0 && delta > 0) interaction += 1

    const before = landed(qtyReceivedBefore, c.snapshot, c.receipt)
    const after = landed(qtyReceivedBefore + result.qtyReceived, c.snapshot, c.receipt + result.newlyProcessedQty)
    assert.equal(result.newlyProcessedQty, delta, `delta accounted for: ${JSON.stringify(c)}`)
    assert.ok(Math.abs((after - before) - result.stockQtyToAdd) < 1e-9, `landed moved by ${after - before} but stock added ${result.stockQtyToAdd}: ${JSON.stringify(c)}`)
    assert.ok(result.stockQtyToAdd >= 0 && result.coveredBySnapshotQty >= 0 && result.reconciledManualQty >= 0, JSON.stringify(c))
    assert.ok(Math.abs(result.stockQtyToAdd + result.coveredBySnapshotQty + result.reconciledManualQty - delta) < 1e-9, `the delta splits exactly into stock, cover and manual: ${JSON.stringify(c)}`)
    assert.ok(result.reconciledManualQty <= c.pool + 1e-9, `no more manual units than the pool holds: ${JSON.stringify(c)}`)
  }
  console.log(`# A-U1: examined ${examined} cases, ${interaction} with a manual pool AND an unabsorbed credit AND a delta`)
  assert.ok(examined > 400, `PRECONDITION: the grid is not small (${examined})`)
  assert.ok(interaction > 50, `PRECONDITION: the interaction the defect lives in is exercised (${interaction})`)
})

test('A-U1 non-vacuity: the OLD arithmetic violates the invariant on this very grid (the grid can see the defect)', () => {
  let violations = 0
  let examined = 0
  for (const c of grid()) {
    const qtyReceivedBefore = c.pool + c.lastProcessed
    const old = trunkReconcile({ ...c, localReceivedQty: qtyReceivedBefore })
    examined += 1
    const before = landed(qtyReceivedBefore, c.snapshot, c.receipt)
    const after = landed(qtyReceivedBefore + old.qtyReceived, c.snapshot, c.receipt + old.newlyProcessedQty)
    if (Math.abs((after - before) - old.stockQtyToAdd) > 1e-9) violations += 1
  }
  console.log(`# A-U1 non-vacuity: the old arithmetic broke the invariant in ${violations} of ${examined} cases`)
  assert.ok(violations > 0, 'the grid must be able to fail: the old arithmetic is known to break it')
})
