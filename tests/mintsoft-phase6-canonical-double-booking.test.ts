import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileBookedInQuantities } from '../lib/domain/wms/asn-reconciliation.ts'

/**
 * Canonical partial-ASN double-booking prevention (0jls5 mt6fm / Mintsoft Phase 6).
 *
 * The danger: under ALIGN_TO_WMS, the stock-sync alignment books some quantity
 * into stock from a snapshot and stamps `qtyAccountedViaSnapshot` on the per-ASN
 * line ledger. When Mintsoft's booked-in callback later reports that same
 * quantity received, the callback must NOT add it to stock again. This test
 * drives the exact ledger sequence the real code applies and asserts the
 * invariant: across the snapshot + every callback, total stock added equals the
 * expected quantity exactly — never more.
 *
 * The model mirrors the real implementations:
 *  - Alignment (lib/connectors/mintsoft/sync/stock-sync*.ts): only the POSITIVE
 *    delta between the WMS-reported total and IMS on-hand is aligned, capped to
 *    each line's available capacity `expected − max(qtyAccountedViaSnapshot,
 *    lastProcessedReceivedQty)` (stock-sync-helpers.ts:192-199). The aligned qty
 *    is added to stock and to qtyAccountedViaSnapshot; lastProcessedReceivedQty
 *    and the local line's qtyReceived are NOT touched by alignment.
 *  - Booked-in callback (lib/domain/wms/booked-in-service.ts): stock +=
 *    reconciled.stockQtyToAdd; qtyAccountedViaReceipt and lastProcessedReceivedQty
 *    += newlyProcessedQty; the local line's qtyReceived += reconciled.qtyReceived.
 */

type Ledger = {
  expectedQty: number
  stock: number
  localReceivedQty: number
  lastProcessedReceivedQty: number
  qtyAccountedViaSnapshot: number
  qtyAccountedViaReceipt: number
}

function newLedger(expectedQty: number): Ledger {
  return {
    expectedQty,
    stock: 0,
    localReceivedQty: 0,
    lastProcessedReceivedQty: 0,
    qtyAccountedViaSnapshot: 0,
    qtyAccountedViaReceipt: 0,
  }
}

/**
 * ALIGN_TO_WMS alignment driven by the WMS-reported on-hand TOTAL. Books only the
 * positive delta vs current IMS stock, capped to the line's available capacity,
 * and returns the qty actually aligned.
 */
function applyAlignment(ledger: Ledger, wmsReportedTotal: number): number {
  const delta = Math.max(0, wmsReportedTotal - ledger.stock)
  const alreadyCredited = Math.max(ledger.qtyAccountedViaSnapshot, ledger.lastProcessedReceivedQty)
  const availableQty = Math.max(0, ledger.expectedQty - alreadyCredited)
  const aligned = Math.min(delta, availableQty)
  ledger.qtyAccountedViaSnapshot += aligned
  ledger.stock += aligned
  return aligned
}

/** A Mintsoft booked-in callback reporting `remoteReceivedQty` total received. */
function applyBookedInCallback(ledger: Ledger, remoteReceivedQty: number) {
  const reconciled = reconcileBookedInQuantities({
    expectedQty: ledger.expectedQty,
    currentReceivedQty: remoteReceivedQty,
    localReceivedQty: ledger.localReceivedQty,
    lastProcessedReceivedQty: ledger.lastProcessedReceivedQty,
    qtyAccountedViaSnapshot: ledger.qtyAccountedViaSnapshot,
    qtyAccountedViaReceipt: ledger.qtyAccountedViaReceipt,
  })
  ledger.stock += reconciled.stockQtyToAdd
  ledger.qtyAccountedViaReceipt += reconciled.newlyProcessedQty
  ledger.lastProcessedReceivedQty += reconciled.newlyProcessedQty
  ledger.localReceivedQty += reconciled.qtyReceived
  return reconciled
}

test('canonical: alignment 60 then callbacks 60→100 never double-count', () => {
  const ledger = newLedger(100)

  // 1) WMS reports 60 on hand → alignment books 60 from the snapshot.
  assert.equal(applyAlignment(ledger, 60), 60)
  assert.equal(ledger.stock, 60)
  assert.equal(ledger.qtyAccountedViaSnapshot, 60)

  // 2) Booked-in callback reports the same 60 — the snapshot already covers it,
  //    so NO new stock is added (the double-booking guard).
  const first = applyBookedInCallback(ledger, 60)
  assert.equal(first.qtyReceived, 60)
  assert.equal(first.coveredBySnapshotQty, 60)
  assert.equal(first.stockQtyToAdd, 0) // the whole point: not added twice
  assert.equal(ledger.stock, 60)
  assert.equal(ledger.qtyAccountedViaReceipt, 60)

  // 3) Callback reports the full 100 — only the unaccounted 40 is added.
  const second = applyBookedInCallback(ledger, 100)
  assert.equal(second.qtyReceived, 40)
  assert.equal(second.coveredBySnapshotQty, 0)
  assert.equal(second.stockQtyToAdd, 40)
  assert.equal(ledger.stock, 100) // exactly expected — no over-receipt
  assert.equal(ledger.localReceivedQty, 100)
})

test('reverse order: callback 60 first, then a late alignment must book nothing', () => {
  const ledger = newLedger(100)

  // Callback first books 60 (no snapshot yet → all 60 is real stock).
  const first = applyBookedInCallback(ledger, 60)
  assert.equal(first.stockQtyToAdd, 60)
  assert.equal(ledger.stock, 60)
  assert.equal(ledger.lastProcessedReceivedQty, 60)

  // A later alignment where the WMS still reports 60: IMS already holds 60, so
  // the alignment delta is 0 — it books nothing (faithful to the real positive-
  // delta + capacity logic). This is the reverse-order double-booking guard.
  assert.equal(applyAlignment(ledger, 60), 0)
  assert.equal(ledger.stock, 60)

  // Final callback for 100 adds the remaining 40.
  const second = applyBookedInCallback(ledger, 100)
  assert.equal(second.stockQtyToAdd, 40)
  assert.equal(ledger.stock, 100)
})

test('interleaved alignment + callbacks: stock tiles to expected, never over', () => {
  const ledger = newLedger(100)

  assert.equal(applyAlignment(ledger, 30), 30) // WMS 30 → book 30
  assert.equal(ledger.stock, 30)

  applyBookedInCallback(ledger, 30) // covered by snapshot → +0
  assert.equal(ledger.stock, 30)

  assert.equal(applyAlignment(ledger, 50), 20) // WMS 50 vs IMS 30 → book 20
  assert.equal(ledger.stock, 50)

  const cb = applyBookedInCallback(ledger, 50) // 20 new received, snapshot-covered → +0
  assert.equal(cb.stockQtyToAdd, 0)
  assert.equal(ledger.stock, 50)

  applyBookedInCallback(ledger, 100) // remaining 50 not in any snapshot → +50
  assert.equal(ledger.stock, 100)
  assert.equal(ledger.stock, ledger.expectedQty)
})

test('no alignment: callbacks alone tile to expected without double-count', () => {
  const ledger = newLedger(100)
  applyBookedInCallback(ledger, 40)
  assert.equal(ledger.stock, 40)
  applyBookedInCallback(ledger, 40) // same remote total — no progress, no double-add
  assert.equal(ledger.stock, 40)
  applyBookedInCallback(ledger, 100)
  assert.equal(ledger.stock, 100)
})

test('invariant fuzz: any alignment/callback sequence keeps stock in [0, expected]', () => {
  const expected = 100
  // WMS-reported on-hand totals to align to (monotonic, ≤ expected), then a
  // sequence of ascending booked-in remote-received reports.
  const alignTotals = [0, 10, 25, 60, 100]
  const remoteSequences = [
    [10, 40, 70, 100],
    [60, 60, 100],
    [100],
    [25, 25, 50, 100],
  ]
  for (const alignTotal of alignTotals) {
    for (const seq of remoteSequences) {
      const ledger = newLedger(expected)
      if (alignTotal > 0) applyAlignment(ledger, alignTotal)
      for (const remote of seq) {
        applyBookedInCallback(ledger, remote)
        assert.ok(ledger.stock >= 0, `stock went negative (align=${alignTotal}, seq=${seq})`)
        assert.ok(ledger.stock <= expected + 1e-9, `stock exceeded expected (align=${alignTotal}, seq=${seq}): ${ledger.stock}`)
      }
      // Once the remote reports the full expected, stock must equal expected exactly.
      if (seq[seq.length - 1] >= expected) {
        assert.equal(ledger.stock, expected, `did not reach expected (align=${alignTotal}, seq=${seq})`)
      }
    }
  }
})
