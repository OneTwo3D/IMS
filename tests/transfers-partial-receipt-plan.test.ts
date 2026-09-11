import assert from 'node:assert/strict'
import test from 'node:test'

import { planTransferPartialReceipt } from '../lib/domain/inventory/transfer-partial-receipt.ts'
import { resolveTransferLineLandedQty } from '../lib/domain/inventory/transfer-landed-quantity.ts'

/**
 * The planner takes a LANDED quantity, not a raw `qtyReceived` (6oyu.19 Codex r6).
 * `landed` builds one from the two counters the way production does, so these cases
 * can express "arrived via a manual receipt" and "arrived via a WMS stock-sync
 * alignment" separately — the distinction the planner used to be blind to.
 */
function landed(id: string, qtyReceived: number, wmsSnapshotCredit = 0) {
  return resolveTransferLineLandedQty({
    transferLineId: id,
    qtyReceived,
    wmsAsnLines: wmsSnapshotCredit > 0
      ? [{ qtyAccountedViaSnapshot: wmsSnapshotCredit, qtyAccountedViaReceipt: 0 }]
      : [],
  })
}

const lines = [
  { id: 'l1', qty: 100, landed: landed('l1', 0) },
  { id: 'l2', qty: 50, landed: landed('l2', 10) },
]

test('caps each requested delta to the line remaining', () => {
  const { plan, fullyReceivedAfter } = planTransferPartialReceipt(lines, [
    { lineId: 'l1', qty: 60 },
    { lineId: 'l2', qty: 999 }, // requested more than remaining (40)
  ])
  assert.deepEqual(plan, [
    { lineId: 'l1', receiveQty: 60 },
    { lineId: 'l2', receiveQty: 40 },
  ])
  assert.equal(fullyReceivedAfter, false) // l1 still has 40 outstanding
})

test('fullyReceivedAfter is true when every line reaches its qty', () => {
  const { plan, fullyReceivedAfter } = planTransferPartialReceipt(lines, [
    { lineId: 'l1', qty: 100 },
    { lineId: 'l2', qty: 40 },
  ])
  assert.deepEqual(plan, [
    { lineId: 'l1', receiveQty: 100 },
    { lineId: 'l2', receiveQty: 40 },
  ])
  assert.equal(fullyReceivedAfter, true)
})

test('omitted lines are not received and keep the transfer open', () => {
  const { plan, fullyReceivedAfter } = planTransferPartialReceipt(lines, [{ lineId: 'l1', qty: 100 }])
  assert.deepEqual(plan, [{ lineId: 'l1', receiveQty: 100 }])
  assert.equal(fullyReceivedAfter, false) // l2 untouched
})

test('drops unknown lines, non-positive and non-finite quantities', () => {
  const { plan } = planTransferPartialReceipt(lines, [
    { lineId: 'ghost', qty: 5 },
    { lineId: 'l1', qty: 0 },
    { lineId: 'l2', qty: -3 },
    { lineId: 'l1', qty: Number.NaN },
  ])
  assert.deepEqual(plan, [])
})

test('already-fully-received line yields no plan entry', () => {
  const { plan, fullyReceivedAfter } = planTransferPartialReceipt(
    [{ id: 'l1', qty: 100, landed: landed('l1', 100) }],
    [{ lineId: 'l1', qty: 50 }],
  )
  assert.deepEqual(plan, [])
  assert.equal(fullyReceivedAfter, true) // nothing outstanding
})

test('sums duplicate requests for the same line before capping', () => {
  const { plan } = planTransferPartialReceipt([{ id: 'l1', qty: 100, landed: landed('l1', 0) }], [
    { lineId: 'l1', qty: 30 },
    { lineId: 'l1', qty: 40 },
  ])
  assert.deepEqual(plan, [{ lineId: 'l1', receiveQty: 70 }])
})

// ---------------------------------------------------------------------------
// 6oyu.19 (Codex round-6 HIGH-1): the reader must consult BOTH counters
// ---------------------------------------------------------------------------

test('a line landed ENTIRELY by a WMS alignment offers nothing left to receive (Codex r6)', () => {
  // qtyReceived is ZERO — the stock-sync alignment credits
  // wms_asn_line_maps.qtyAccountedViaSnapshot and never touches the transfer line.
  // A planner that reads qtyReceived alone answers "100 outstanding" and hands those
  // units to the receipt path, which lays their cost layers down a SECOND time.
  const { plan, fullyReceivedAfter } = planTransferPartialReceipt(
    [{ id: 'l1', qty: 100, landed: landed('l1', 0, 100) }],
    [{ lineId: 'l1', qty: 100 }],
  )
  assert.deepEqual(plan, [], 'nothing may be offered for a line that has already landed')
  assert.equal(fullyReceivedAfter, true)
})

test('a part-aligned, part-received line offers only the genuine remainder (Codex r6)', () => {
  // 30 landed by a manual receipt + 50 credited by an alignment = 80 of 100.
  const { plan } = planTransferPartialReceipt(
    [{ id: 'l1', qty: 100, landed: landed('l1', 30, 50) }],
    [{ lineId: 'l1', qty: 100 }],
  )
  assert.deepEqual(plan, [{ lineId: 'l1', receiveQty: 20 }])
})

test('an alignment credit a webhook has since ABSORBED is not counted twice (Codex r6)', () => {
  // Once a receipt folds the credit into qtyReceived, qtyAccountedViaReceipt records
  // the same amount and the snapshot arm contributes nothing more. Summing the two
  // columns blindly would report 80 landed here instead of 40.
  const line = {
    id: 'l1',
    qty: 100,
    landed: resolveTransferLineLandedQty({
      transferLineId: 'l1',
      qtyReceived: 40,
      wmsAsnLines: [{ qtyAccountedViaSnapshot: 40, qtyAccountedViaReceipt: 40 }],
    }),
  }
  assert.equal(line.landed.qtyNumber, 40)
  const { plan } = planTransferPartialReceipt([line], [{ lineId: 'l1', qty: 100 }])
  assert.deepEqual(plan, [{ lineId: 'l1', receiveQty: 60 }])
})
