import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WMS_RECEIPT_QTY_EPSILON,
  bookedInDeltaIsActionable,
  bookedInLineIsComplete,
  buildBookedInDryRun,
  resolveManualReceiptPool,
} from '@/lib/domain/wms/asn-reconciliation'

// o3d-b8x0f: the booked-in apply path and its own dry run must agree on whether a delta is worth booking.

function dryRunFor(delta: number) {
  return buildBookedInDryRun({
    externalAsnId: '1',
    generatedAt: new Date('2026-11-18T00:00:00Z'),
    lines: [{
      asnLineMapId: 'l1',
      externalAsnLineId: 'e1',
      sourceType: 'PURCHASE_ORDER_LINE',
      sourceLineId: 'pl1',
      productId: 'p1',
      sku: 'S',
      expectedQty: 10,
      currentRemoteReceivedQty: delta,
      manualReceiptPool: resolveManualReceiptPool({ lineQtyReceived: 0, lineReconciledAcrossAsns: 0, rowManualQtyBaseline: 0 }),
      qtyAccountedViaSnapshot: 0,
      qtyAccountedViaReceipt: 0,
      lastProcessedReceivedQty: 0,
      localLineExists: true,
    }],
  }).lines[0]!
}

test('o3d-b8x0f: a line is actionable exactly when its own dry run says it would create a receipt', () => {
  for (const delta of [0, 0.00001, 0.00005, WMS_RECEIPT_QTY_EPSILON, 0.00011, 0.5, 4]) {
    const line = dryRunFor(delta)
    assert.equal(
      bookedInDeltaIsActionable(delta, 0),
      line.wouldCreateReceipt,
      `delta ${delta}: actionable must equal wouldCreateReceipt (${line.wouldCreateReceipt})`,
    )
    assert.equal(bookedInDeltaIsActionable(delta, 0), line.wouldCreateCostLayer, `delta ${delta}: and wouldCreateCostLayer`)
  }
})

test('o3d-b8x0f: a sub-epsilon sliver on top of a processed quantity is not actionable, floating point included', () => {
  assert.equal(bookedInDeltaIsActionable(10.00005, 10), false)
  assert.equal(bookedInDeltaIsActionable(10.0001, 10), false, '10.0001 - 10 is 0.00009999999999976694 in IEEE doubles')
  assert.equal(bookedInDeltaIsActionable(10.0002, 10), true)
})

test('o3d-b8x0f: a line short of expected by a sub-epsilon sliver counts as complete, so the ASN can still close', () => {
  assert.equal(bookedInLineIsComplete(9.99995, 10), true)
  assert.equal(bookedInLineIsComplete(9.99, 10), false)
  assert.equal(bookedInLineIsComplete(10, 10), true)
})
