import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sumPostedUnearnedReversal,
  isFullyShippedNetOfRefunds,
  batchContainsFinalUnjournaledShipment,
} from '@/lib/domain/accounting/deferred-trueup'

// --- sumPostedUnearnedReversal ---

test('sums only the unearned-account debit, ignoring the allocation-reversal line', () => {
  const syncs = [
    {
      payload: {
        lines: [
          { accountCode: 'UNEARNED', description: 'unearned reversal', debit: 30 },
          { accountCode: 'SALES', description: 'unearned reversal', credit: 30 },
          { accountCode: 'INVENTORY', description: 'allocation reversal', debit: 12 },
          { accountCode: 'ALLOC_CONTRA', description: 'allocation reversal', credit: 12 },
        ],
      },
    },
  ]
  assert.equal(sumPostedUnearnedReversal(syncs, 'UNEARNED'), 30)
})

test('accumulates across multiple reversal syncs', () => {
  const syncs = [
    { payload: { lines: [{ accountCode: 'UNEARNED', debit: 10 }] } },
    { payload: { lines: [{ accountCode: 'UNEARNED', debit: 5.5 }] } },
  ]
  assert.equal(sumPostedUnearnedReversal(syncs, 'UNEARNED'), 15.5)
})

test('tolerates missing/!malformed payloads and rounds to 2dp', () => {
  const syncs = [
    { payload: null },
    { payload: {} },
    { payload: { lines: 'nope' } },
    { payload: { lines: [{ accountCode: 'UNEARNED', debit: 10.005 }] } },
  ]
  assert.equal(sumPostedUnearnedReversal(syncs, 'UNEARNED'), 10.01)
})

test('empty list yields zero', () => {
  assert.equal(sumPostedUnearnedReversal([], 'UNEARNED'), 0)
})

// --- isFullyShippedNetOfRefunds ---

test('fully shipped when every line covered by shipments alone', () => {
  assert.equal(isFullyShippedNetOfRefunds([
    { orderedQty: 5, coveredQty: 5 },
    { orderedQty: 2, coveredQty: 2 },
  ]), true)
})

test('fully shipped net of refunds: shipped + refunded-unshipped reaches ordered', () => {
  // 5 ordered, 3 shipped, 2 refunded while unshipped -> covered 5
  assert.equal(isFullyShippedNetOfRefunds([{ orderedQty: 5, coveredQty: 5 }]), true)
})

test('NOT fully shipped when a line is short net of refunds', () => {
  // 5 ordered, 3 shipped, 1 refunded-unshipped -> covered 4 < 5
  assert.equal(isFullyShippedNetOfRefunds([{ orderedQty: 5, coveredQty: 4 }]), false)
})

test('one short line fails the whole order', () => {
  assert.equal(isFullyShippedNetOfRefunds([
    { orderedQty: 5, coveredQty: 5 },
    { orderedQty: 3, coveredQty: 2 },
  ]), false)
})

test('ignores non-shippable (zero ordered qty) lines but requires at least one shippable', () => {
  assert.equal(isFullyShippedNetOfRefunds([
    { orderedQty: 0, coveredQty: 0 },
    { orderedQty: 4, coveredQty: 4 },
  ]), true)
  assert.equal(isFullyShippedNetOfRefunds([{ orderedQty: 0, coveredQty: 0 }]), false)
  assert.equal(isFullyShippedNetOfRefunds([]), false)
})

test('tolerates tiny floating-point coverage shortfall within epsilon', () => {
  assert.equal(isFullyShippedNetOfRefunds([{ orderedQty: 3, coveredQty: 3 - 1e-9 }]), true)
  assert.equal(isFullyShippedNetOfRefunds([{ orderedQty: 3, coveredQty: 2.99 }]), false)
})

// --- batchContainsFinalUnjournaledShipment ---

test('true when every unjournaled shipment is in this batch', () => {
  const shipments = [
    { id: 's1', shipmentJournalDate: new Date('2026-06-01') }, // already journaled
    { id: 's2', shipmentJournalDate: null },
    { id: 's3', shipmentJournalDate: null },
  ]
  assert.equal(batchContainsFinalUnjournaledShipment(shipments, new Set(['s2', 's3'])), true)
})

test('false when an unjournaled shipment is outside this batch (window split)', () => {
  const shipments = [
    { id: 's1', shipmentJournalDate: null },
    { id: 's2', shipmentJournalDate: null },
  ]
  assert.equal(batchContainsFinalUnjournaledShipment(shipments, new Set(['s1'])), false)
})

test('false when there are no unjournaled shipments (nothing to true up here)', () => {
  const shipments = [{ id: 's1', shipmentJournalDate: new Date('2026-06-01') }]
  assert.equal(batchContainsFinalUnjournaledShipment(shipments, new Set(['s1'])), false)
})

test('a dispatched shipment held in a later batch window blocks the true-up', () => {
  // both SHIPPED & unjournaled, but the daily-batch limit only pulled s1 this run
  const shipments = [
    { id: 's1', shipmentJournalDate: null },
    { id: 's2', shipmentJournalDate: null },
  ]
  assert.equal(batchContainsFinalUnjournaledShipment(shipments, new Set(['s1'])), false)
  assert.equal(batchContainsFinalUnjournaledShipment(shipments, new Set(['s1', 's2'])), true)
})
