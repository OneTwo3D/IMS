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

/**
 * o3d-2k5r r5 — AND WALKING IT WITH THE ACTION'S PREDICATE, NOT ONLY THE EVIDENCE.
 *
 * The r4 version of the first sequence below asserted `['finish-recovery']` on the state
 * immediately after A is reopened — while B is still PACKED. That state is exactly where
 * `reopenShipmentForRepackAction`'s re-allocation is REFUSED (`refuseIfCommittedShipmentsExist`
 * matches any shipment that is not PENDING), and a refusal keeps the reopen and returns
 * `success: true` with a warning: nothing re-netted, no backstop row resolved, and the operator
 * told it worked. The test documented that as the control's correct behaviour.
 *
 * The sequences now assert the PREREQUISITE ACTION at each intermediate step — the sibling's own
 * Reopen, which is a control the operator can actually press — and Finish recovery only where the
 * action can complete.
 */

/** The whole order's control set, keyed by shipment, which is the only way "which control renders
 *  where" can be asserted for an ORDER-level prerequisite. */
function controlsOnOrder(
  shipments: Array<{ name: string; status: string }>,
  order: { status: string; recoveryOutstanding: boolean },
): Record<string, Array<'reopen' | 'finish-recovery'>> {
  // The same predicate `allocateSalesOrder` applies, and the same one `getOrderShipments` computes
  // for the page: any shipment on the order that is not a draft.
  const orderHasCommittedShipment = shipments.some((s) => s.status !== 'PENDING')
  const out: Record<string, Array<'reopen' | 'finish-recovery'>> = {}
  for (const shipment of shipments) {
    out[shipment.name] = repackControlsFor({
      shipmentStatus: shipment.status,
      orderStatus: order.status,
      recoveryOutstanding: order.recoveryOutstanding,
      orderHasCommittedShipment,
    })
  }
  return out
}

test('o3d-2k5r r5 UI sequence: while another shipment is committed, the draft offers the PREREQUISITE, not Finish recovery', () => {
  // Order with a refund and two committed shipments, A and B.
  const order = { status: PROCESSING, recoveryOutstanding: true }
  assert.deepEqual(
    controlsOnOrder([{ name: 'A', status: 'PACKED' }, { name: 'B', status: 'PACKED' }], order),
    { A: ['reopen'], B: ['reopen'] },
  )

  // 1. The operator reopens A. The re-allocation is REFUSED because B is still committed — a
  //    deliberate outcome that KEEPS the reopen (rolling back would make neither reopenable
  //    first). A is now a draft, and the order's netting and refund backstop are still owed.
  //
  //    THE DRAFT MUST NOT OFFER FINISH RECOVERY HERE. The action would take the ALREADY_PENDING
  //    resume path, re-run the same re-allocation, be refused by the same predicate for the same
  //    reason, resolve nothing and report success. What CAN be done is on B, and B offers it.
  const afterReopenA = controlsOnOrder([{ name: 'A', status: 'PENDING' }, { name: 'B', status: 'PACKED' }], order)
  assert.deepEqual(afterReopenA.A, [], 'the draft offers nothing while the order still holds a commitment')
  assert.deepEqual(afterReopenA.B, ['reopen'], 'and the prerequisite action is the one on offer')

  // 2. B is reopened too. NOW nothing on the order is committed, the re-allocation the recovery
  //    needs can actually run, and the control appears — on both drafts, since either finishes the
  //    same order-level work.
  const afterReopenB = controlsOnOrder([{ name: 'A', status: 'PENDING' }, { name: 'B', status: 'PENDING' }], order)
  assert.deepEqual(afterReopenB, { A: ['finish-recovery'], B: ['finish-recovery'] })

  // 3. The operator presses it. The recovery runs, resolving the deferred backstop rows — so the
  //    evidence goes away and the control goes with it, rather than inviting a second run.
  assert.deepEqual(
    controlsOnOrder(
      [{ name: 'A', status: 'PENDING' }, { name: 'B', status: 'PENDING' }],
      { ...order, recoveryOutstanding: false },
    ),
    { A: [], B: [] },
  )
})

test('o3d-2k5r r5 UI sequence: dispatching the sibling instead closes the door, and no button pretends otherwise', () => {
  // The case the r4 doc block described as one the recovery "exists for". It is not: SHIPPED is not
  // PENDING, so `refuseIfCommittedShipmentsExist` still refuses, and `reopenShipmentForRepack`
  // refuses SHIPPED outright — no click completes this recovery ever again. Offering the button
  // would be the "remedy that cannot be performed" shape one more time; the outstanding release is
  // reconciled by hand (o3d-339) and stays visible as a failed outbox row meanwhile.
  const order = { status: PROCESSING, recoveryOutstanding: true }
  const dispatchedSibling = controlsOnOrder([{ name: 'A', status: 'PENDING' }, { name: 'B', status: 'SHIPPED' }], order)
  assert.deepEqual(dispatchedSibling.B, [], 'a dispatched shipment offers neither')
  assert.deepEqual(dispatchedSibling.A, [], 'and the draft offers nothing it cannot deliver')
})

test('o3d-2k5r r4 UI sequence: an order stranded by the earlier non-transactional shape', () => {
  // The reopen committed on its own and the process died before the allocation. The order carries a
  // PENDING draft, the pre-refund reservation, and an unresolved backstop row. Nothing about the
  // shipment distinguishes it from an ordinary draft — only the durable evidence does. And nothing
  // else on the order is committed, so the recovery can actually run.
  const stranded = { shipmentStatus: 'PENDING', orderStatus: PROCESSING, recoveryOutstanding: true, orderHasCommittedShipment: false }
  assert.deepEqual(repackControlsFor(stranded), ['finish-recovery'])

  // And the control is NOT offered on every order that happens to have a draft, which is what
  // gating on the shipment status alone would have done. Ordinary "Create Shipments" is the control
  // for this one; it does not perform the allocation-and-backstop transaction, which is exactly why
  // it cannot stand in for the recovery above.
  const ordinaryDraft = { ...stranded, recoveryOutstanding: false }
  assert.deepEqual(repackControlsFor(ordinaryDraft), [])
})

test('o3d-2k5r r5: the recovery control never renders where the action would refuse', () => {
  // The rule, asserted directly rather than only along the two sequences: `orderHasCommittedShipment`
  // is `allocateSalesOrder`'s refusal, so wherever it is true the control must be absent for EVERY
  // shipment state and every evidence value.
  for (const shipmentStatus of ['PENDING', 'PICKING', 'PACKED', 'SHIPPED', 'SOMETHING_NEW']) {
    for (const recoveryOutstanding of [true, false]) {
      assert.equal(
        repackRecoveryControlIsAvailable({ shipmentStatus, orderStatus: PROCESSING, recoveryOutstanding, orderHasCommittedShipment: true }),
        false,
        `${shipmentStatus}/${recoveryOutstanding} offered Finish recovery while the order held a commitment`,
      )
    }
  }
})

test('o3d-2k5r r4: the two controls are mutually exclusive in every state', () => {
  for (const shipmentStatus of ['PENDING', 'PICKING', 'PACKED', 'SHIPPED', 'SOMETHING_NEW']) {
    for (const recoveryOutstanding of [true, false]) {
      for (const orderHasCommittedShipment of [true, false]) {
        const controls = repackControlsFor({ shipmentStatus, orderStatus: PROCESSING, recoveryOutstanding, orderHasCommittedShipment })
        assert.ok(controls.length <= 1, `${shipmentStatus}/${recoveryOutstanding}/${orderHasCommittedShipment} offered ${controls.join('+')}`)
      }
    }
  }
})

test('o3d-2k5r r4: a cancelled order offers neither — it takes the discard path', () => {
  // Reopening would leave a draft on an order that will never be invoiced, and the rebuild step
  // refuses a cancelled order anyway, so the recovery would dead-end.
  for (const shipmentStatus of ['PENDING', 'PICKING', 'PACKED']) {
    assert.deepEqual(repackControlsFor({ shipmentStatus, orderStatus: 'CANCELLED', recoveryOutstanding: true, orderHasCommittedShipment: false }), [])
  }
  assert.equal(repackReopenControlIsAvailable({ shipmentStatus: 'PACKED', orderStatus: 'CANCELLED', recoveryOutstanding: true, orderHasCommittedShipment: true }), false)
  assert.equal(repackRecoveryControlIsAvailable({ shipmentStatus: 'PENDING', orderStatus: 'CANCELLED', recoveryOutstanding: true, orderHasCommittedShipment: false }), false)
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
