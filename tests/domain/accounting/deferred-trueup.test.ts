import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sumPostedUnearnedReversal,
  durableUnearnedReversalTopUp,
  unreadableUnearnedReversalRows,
  isFullyShippedNetOfRefunds,
  batchContainsFinalUnjournaledShipment,
} from '@/lib/domain/accounting/deferred-trueup'
import { unearnedReversalDebit } from '@/lib/domain/accounting/journal-account-nets'

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

test('o3d-oyur: a compacted row is read from its preserved account net; a row with neither lines nor summary is unreadable, not zero', () => {
  const compacted = { payload: {}, payloadAccountNets: { version: 1, accounts: { UNEARNED: { credit: 0, debit: 30 } } } }
  const legacy = { payload: {}, payloadAccountNets: null }
  assert.equal(sumPostedUnearnedReversal([compacted], 'UNEARNED'), 30)
  assert.equal(sumPostedUnearnedReversal([compacted, legacy], 'UNEARNED'), 30)
  assert.deepEqual(unreadableUnearnedReversalRows([compacted, legacy]), [legacy])
  assert.deepEqual(unreadableUnearnedReversalRows([compacted]), [])
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

// --- o3d-fk9py: durable per-refund figure ---

test('o3d-fk9py: a refund whose sync row retention erased is still netted from its durable column', () => {
  // no readable rows at all: the sync-row-only sum is 0, which let the true-up re-recognise the 30 the refund took
  assert.equal(sumPostedUnearnedReversal([], 'UNEARNED'), 0)
  assert.equal(durableUnearnedReversalTopUp([], [{ id: 'r1', unearnedReversedAmount: 30 }], 'UNEARNED'), 30)
})

test('o3d-fk9py: a still-readable row is never counted twice, and the larger source wins per refund', () => {
  const rows = [{ refundId: 'r1', payload: { lines: [{ accountCode: 'UNEARNED', debit: 30 }] } }]
  assert.equal(durableUnearnedReversalTopUp(rows, [{ id: 'r1', unearnedReversedAmount: 30 }], 'UNEARNED'), 0)
  assert.equal(durableUnearnedReversalTopUp(rows, [{ id: 'r1', unearnedReversedAmount: 45 }], 'UNEARNED'), 15)
  assert.equal(durableUnearnedReversalTopUp(rows, [{ id: 'r1', unearnedReversedAmount: 10 }], 'UNEARNED'), 0)
})

test('o3d-fk9py: a NULL column (pre-column refund) adds nothing; other refunds rows do not offset this one', () => {
  const rows = [{ refundId: 'r2', payload: { lines: [{ accountCode: 'UNEARNED', debit: 50 }] } }]
  assert.equal(durableUnearnedReversalTopUp(rows, [{ id: 'r1', unearnedReversedAmount: null }], 'UNEARNED'), 0)
  assert.equal(durableUnearnedReversalTopUp(rows, [{ id: 'r1', unearnedReversedAmount: 20 }, { id: 'r2', unearnedReversedAmount: 50 }], 'UNEARNED'), 20)
})

test('o3d-nz0e0: a reversal posted under a since re-mapped unearned account is read by its label, not by the current code', () => {
  const row = { payload: { lines: [
    { accountCode: '2099', description: 'Unearned revenue reversal: SO-1', debit: 40 },
    { accountCode: '4000', description: 'Unearned revenue reversal: SO-1', credit: 40 },
    { accountCode: '1500', description: 'Allocation reversal: SO-1', debit: 12 },
  ] } }
  assert.equal(unearnedReversalDebit(row, 'UNEARNED'), 40)
  assert.equal(sumPostedUnearnedReversal([row], 'UNEARNED'), 40)
  // unlabelled legacy payload and compacted rows fall back to the account-code read
  assert.equal(unearnedReversalDebit({ payload: { lines: [{ accountCode: 'UNEARNED', debit: 7 }] } }, 'UNEARNED'), 7)
  assert.equal(unearnedReversalDebit({ payload: {}, payloadAccountNets: null }, 'UNEARNED'), null)
})
