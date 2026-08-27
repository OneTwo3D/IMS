import assert from 'node:assert/strict'
import test from 'node:test'
import {
  repackControlsFor,
  repackRecoveryControlIsAvailable,
  repackReopenControlIsAvailable,
} from '../../../lib/domain/sales/repack-recovery-affordance.ts'
import { countOutstandingRefundReservationReleases } from '../../../lib/domain/sales/refund-reservation-release-outbox.ts'

/**
 * o3d-2k5r r4 — WALKING THE ACTUAL UI SEQUENCE.
 *
 * The action treats ALREADY_PENDING as a resume point, and the review found that no click could
 * ever reach it: the only control that invoked the action rendered for PICKING or PACKED, and after
 * the partial commit the shipment is PENDING. Asserting that the ACTION resumes proves nothing
 * about that — the r3 suite already did, and the path was still unreachable.
 *
 * So these tests walk the sequence step by step and assert the CONTROL SET at each step, for both
 * cases the finding names. Every step below is a state the shipped code actually produces.
 */

const PROCESSING = 'PROCESSING'

test('o3d-2k5r r4 UI sequence: partial commit, then the other shipment is DISPATCHED rather than reopened', () => {
  // Order with a refund and two committed shipments, A and B.
  const A = { shipmentStatus: 'PACKED', orderStatus: PROCESSING, recoveryOutstanding: true }
  const B = { shipmentStatus: 'PACKED', orderStatus: PROCESSING, recoveryOutstanding: true }
  assert.deepEqual(repackControlsFor(A), ['reopen'])
  assert.deepEqual(repackControlsFor(B), ['reopen'])

  // 1. The operator reopens A. The re-allocation is REFUSED because B is still committed — a
  //    deliberate outcome that KEEPS the reopen (rolling back would make neither reopenable
  //    first). A is now a draft, and the order's netting and refund backstop are still owed.
  const afterReopenA = { ...A, shipmentStatus: 'PENDING' }
  assert.deepEqual(repackControlsFor(afterReopenA), ['finish-recovery'],
    'the resume point now HAS a control — before this it had none, and this is the finding')

  // 2. B is DISPATCHED rather than reopened. This is the case that makes the recovery unreachable
  //    for good: no later reopen of B will ever net the order, because SHIPPED is terminal.
  const dispatchedB = { ...B, shipmentStatus: 'SHIPPED' }
  assert.deepEqual(repackControlsFor(dispatchedB), [], 'a dispatched shipment offers neither')
  assert.deepEqual(repackControlsFor(afterReopenA), ['finish-recovery'],
    'and the draft still carries the only door out')

  // 3. The operator presses it. The recovery runs, resolving the deferred backstop rows — so the
  //    evidence goes away and the control goes with it, rather than inviting a second run.
  const afterRecovery = { ...afterReopenA, recoveryOutstanding: false }
  assert.deepEqual(repackControlsFor(afterRecovery), [])
})

test('o3d-2k5r r4 UI sequence: an order stranded by the earlier non-transactional shape', () => {
  // The reopen committed on its own and the process died before the allocation. The order carries a
  // PENDING draft, the pre-refund reservation, and an unresolved backstop row. Nothing about the
  // shipment distinguishes it from an ordinary draft — only the durable evidence does.
  const stranded = { shipmentStatus: 'PENDING', orderStatus: PROCESSING, recoveryOutstanding: true }
  assert.deepEqual(repackControlsFor(stranded), ['finish-recovery'])

  // And the control is NOT offered on every order that happens to have a draft, which is what
  // gating on the shipment status alone would have done. Ordinary "Create Shipments" is the control
  // for this one; it does not perform the allocation-and-backstop transaction, which is exactly why
  // it cannot stand in for the recovery above.
  const ordinaryDraft = { ...stranded, recoveryOutstanding: false }
  assert.deepEqual(repackControlsFor(ordinaryDraft), [])
})

test('o3d-2k5r r4: the two controls are mutually exclusive in every state', () => {
  for (const shipmentStatus of ['PENDING', 'PICKING', 'PACKED', 'SHIPPED', 'SOMETHING_NEW']) {
    for (const recoveryOutstanding of [true, false]) {
      const controls = repackControlsFor({ shipmentStatus, orderStatus: PROCESSING, recoveryOutstanding })
      assert.ok(controls.length <= 1, `${shipmentStatus}/${recoveryOutstanding} offered ${controls.join('+')}`)
    }
  }
})

test('o3d-2k5r r4: a cancelled order offers neither — it takes the discard path', () => {
  // Reopening would leave a draft on an order that will never be invoiced, and the rebuild step
  // refuses a cancelled order anyway, so the recovery would dead-end.
  for (const shipmentStatus of ['PENDING', 'PICKING', 'PACKED']) {
    assert.deepEqual(repackControlsFor({ shipmentStatus, orderStatus: 'CANCELLED', recoveryOutstanding: true }), [])
  }
  assert.equal(repackReopenControlIsAvailable({ shipmentStatus: 'PACKED', orderStatus: 'CANCELLED', recoveryOutstanding: true }), false)
  assert.equal(repackRecoveryControlIsAvailable({ shipmentStatus: 'PENDING', orderStatus: 'CANCELLED', recoveryOutstanding: true }), false)
})

// --- the durable evidence itself -------------------------------------------------------

type OutboxRow = { idempotencyKey: string; status: string }

function readClient(refundIds: string[], rows: OutboxRow[]) {
  const counted: Array<Record<string, unknown>> = []
  return {
    counted,
    client: {
      salesOrderRefund: { findMany: async () => refundIds.map((id) => ({ id })) },
      integrationOutbox: {
        count: async (args: { where: { idempotencyKey: { in: string[] }; status: { in: string[] } } }) => {
          counted.push(args.where)
          return rows.filter((row) => args.where.idempotencyKey.in.includes(row.idempotencyKey)
            && args.where.status.in.includes(row.status)).length
        },
      },
    },
  }
}

test('o3d-2k5r r4 evidence: an unresolved backstop row for one of the order\'s refunds counts', async () => {
  const { client, counted } = readClient(['refund-1'], [
    { idempotencyKey: 'sales:refund.reservation-release:refund-1', status: 'PENDING' },
  ])
  assert.equal(await countOutstandingRefundReservationReleases('order-1', { client }), 1)
  // The key is derived from the REFUND id, so a row belonging to another order's refund cannot be
  // counted for this one — which is what would make the control appear on unrelated orders.
  assert.deepEqual(counted[0].idempotencyKey, { in: ['sales:refund.reservation-release:refund-1'] })
})

test('o3d-2k5r r4 evidence: RETRYABLE_FAILED counts, SUCCEEDED and PROCESSING do not', async () => {
  const rows: OutboxRow[] = [
    { idempotencyKey: 'sales:refund.reservation-release:r-ok', status: 'SUCCEEDED' },
    { idempotencyKey: 'sales:refund.reservation-release:r-claimed', status: 'PROCESSING' },
    { idempotencyKey: 'sales:refund.reservation-release:r-failed', status: 'RETRYABLE_FAILED' },
  ]
  const { client } = readClient(['r-ok', 'r-claimed', 'r-failed'], rows)
  // SUCCEEDED is the recovery already done. PROCESSING is the drain holding the row and running the
  // same repair right now — offering the operator the button there is inviting them to race it.
  assert.equal(await countOutstandingRefundReservationReleases('order-1', { client }), 1)
})

test('o3d-2k5r r4 evidence: an order with no refunds asks the outbox nothing', async () => {
  // The recovery only exists because of a refund. No refund, no deferred release, no control — and
  // no query either, which is what keeps this off the hot path of every order detail page.
  const { client, counted } = readClient([], [])
  assert.equal(await countOutstandingRefundReservationReleases('order-1', { client }), 0)
  assert.deepEqual(counted, [])
})
