import assert from 'node:assert/strict'
import test from 'node:test'

import { planTransferPartialReceipt } from '../lib/domain/inventory/transfer-partial-receipt.ts'

const lines = [
  { id: 'l1', qty: 100, qtyReceived: 0 },
  { id: 'l2', qty: 50, qtyReceived: 10 },
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
    [{ id: 'l1', qty: 100, qtyReceived: 100 }],
    [{ lineId: 'l1', qty: 50 }],
  )
  assert.deepEqual(plan, [])
  assert.equal(fullyReceivedAfter, true) // nothing outstanding
})

test('sums duplicate requests for the same line before capping', () => {
  const { plan } = planTransferPartialReceipt([{ id: 'l1', qty: 100, qtyReceived: 0 }], [
    { lineId: 'l1', qty: 30 },
    { lineId: 'l1', qty: 40 },
  ])
  assert.deepEqual(plan, [{ lineId: 'l1', receiveQty: 70 }])
})
