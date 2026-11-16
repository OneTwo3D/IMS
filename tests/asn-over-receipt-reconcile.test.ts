import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBookedInDryRun, reconcileBookedInQuantities, resolveManualReceiptPool } from '../lib/domain/wms/asn-reconciliation.ts'

const pool = resolveManualReceiptPool({ lineQtyReceived: 0, lineReconciledAcrossAsns: 0, rowManualQtyBaseline: 0 })

test('o3d-hqvrp.119: the default clamps to the expected quantity (unchanged for transfers)', () => {
  const r = reconcileBookedInQuantities({ expectedQty: 10, currentReceivedQty: 12, manualReceiptPool: pool, lastProcessedReceivedQty: 0 })
  assert.equal(r.stockQtyToAdd, 10)
  assert.equal(r.newlyProcessedQty, 10)
})

test('o3d-hqvrp.119: an approved over-receipt receives the full booked quantity', () => {
  const r = reconcileBookedInQuantities({ expectedQty: 10, currentReceivedQty: 12, manualReceiptPool: pool, lastProcessedReceivedQty: 0, allowOverReceipt: true })
  assert.equal(r.stockQtyToAdd, 12)
  assert.equal(r.qtyReceived, 12)
  assert.equal(r.newlyProcessedQty, 12)
})

test('o3d-hqvrp.119: after the over-receipt is accounted a re-read books nothing more, and a further excess books only the difference', () => {
  const same = reconcileBookedInQuantities({ expectedQty: 10, currentReceivedQty: 12, manualReceiptPool: pool, lastProcessedReceivedQty: 12, allowOverReceipt: true })
  assert.equal(same.newlyProcessedQty, 0)
  const more = reconcileBookedInQuantities({ expectedQty: 10, currentReceivedQty: 13, manualReceiptPool: pool, lastProcessedReceivedQty: 12, allowOverReceipt: true })
  assert.equal(more.newlyProcessedQty, 1)
  assert.equal(more.stockQtyToAdd, 1)
})

function dry(overrides: { remote: number; last?: number; allowOverReceipt?: boolean }) {
  return buildBookedInDryRun({
    externalAsnId: 'A', generatedAt: new Date('2026-11-16T00:00:00Z'),
    lines: [{
      asnLineMapId: 'l', externalAsnLineId: 'x', sourceType: 'PURCHASE_ORDER_LINE', sourceLineId: 'p', productId: 'pr', sku: 's',
      expectedQty: 10, currentRemoteReceivedQty: overrides.remote, manualReceiptPool: pool, lastProcessedReceivedQty: overrides.last ?? 0,
      localLineExists: true, parentReceivable: true, allowOverReceipt: overrides.allowOverReceipt,
    }],
  })
}

test('o3d-hqvrp.119: the review shows the quantity approval will book', () => {
  const run = dry({ remote: 12, allowOverReceipt: true })
  assert.ok(run.warnings.includes('received_over_expected'))
  assert.equal(run.lines[0]!.stockQtyToAdd, 12)
  assert.equal(dry({ remote: 12 }).lines[0]!.stockQtyToAdd, 10, 'without the flag the review shows the clamp')
})

test('o3d-hqvrp.119: an over-receipt already accounted does not raise the warning again; a new excess does', () => {
  assert.equal(dry({ remote: 12, last: 12, allowOverReceipt: true }).warnings.includes('received_over_expected'), false)
  assert.equal(dry({ remote: 13, last: 12, allowOverReceipt: true }).warnings.includes('received_over_expected'), true)
})
