import assert from 'node:assert/strict'
import test from 'node:test'
import {
  repackControlsFor,
  repackRecoveryControlIsAvailable,
  repackReopenControlIsAvailable,
  summariseRepackBlockers,
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
  // Derived by the SAME helper `getOrderShipments` and `reopenShipmentForRepackAction` use, from
  // the same input (the order's shipment statuses). A test that computed these two booleans by hand
  // would be asserting its own arithmetic, not the page's.
  const blockers = summariseRepackBlockers(shipments.map((s) => s.status))
  const out: Record<string, Array<'reopen' | 'finish-recovery'>> = {}
  for (const shipment of shipments) {
    out[shipment.name] = repackControlsFor({
      shipmentStatus: shipment.status,
      orderStatus: order.status,
      recoveryOutstanding: order.recoveryOutstanding,
      ...blockers,
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

test('o3d-2k5r r6 UI sequence: an order that ALREADY has a dispatched shipment offers no reopen to drive it into the dead end', () => {
  // THE STATE BEFORE THE DAMAGE, which is the state the r5 version of this test skipped. It started
  // at A=PENDING/B=SHIPPED and asserted "no control" — but that is the dead end itself, reached one
  // click earlier from HERE. A is PACKED and B is already dispatched (a partial dispatch, then a
  // refund lands on what is left). The r5 code rendered "Reopen for repack" on A: pressing it
  // reverts A, the re-allocation is refused because B is not PENDING, and the refusal COMMITS the
  // revert. The operator's own click is what created the unrecoverable state.
  const order = { status: PROCESSING, recoveryOutstanding: true }
  const beforeTheClick = controlsOnOrder([{ name: 'A', status: 'PACKED' }, { name: 'B', status: 'SHIPPED' }], order)
  assert.deepEqual(beforeTheClick.A, [], 'the packed shipment must not offer a reopen that strands the order')
  assert.deepEqual(beforeTheClick.B, [], 'and a dispatched shipment offers neither, as before')

  // The same is true of a PICKING shipment, and of a third shipment on the same order: it is the
  // ORDER that cannot be recovered, not one shipment's relationship to one sibling.
  const threeUp = controlsOnOrder(
    [{ name: 'A', status: 'PICKING' }, { name: 'B', status: 'PACKED' }, { name: 'C', status: 'SHIPPED' }],
    order,
  )
  assert.deepEqual(threeUp, { A: [], B: [], C: [] })

  // And the state one click later — the only one r5 tested — still offers nothing, which is now a
  // state no control can produce rather than the one every control led to.
  const theDeadEnd = controlsOnOrder([{ name: 'A', status: 'PENDING' }, { name: 'B', status: 'SHIPPED' }], order)
  assert.deepEqual(theDeadEnd, { A: [], B: [] })
})

test('o3d-2k5r r6: a dispatched shipment withholds the reopen ONLY where it makes the order unrecoverable', () => {
  // The rule stated directly, and its LIMIT — the same distinction the action's partial commit
  // turns on. Two PICKING/PACKED shipments refuse each other, and that IS recoverable: reopen one,
  // the refusal keeps it, reopen the other, and that transaction nets the order. So a committed
  // sibling must NOT withhold the reopen; only an unreopenable one may.
  const order = { status: PROCESSING, recoveryOutstanding: true }
  const twoPacked = controlsOnOrder([{ name: 'A', status: 'PACKED' }, { name: 'B', status: 'PACKED' }], order)
  assert.deepEqual(twoPacked, { A: ['reopen'], B: ['reopen'] }, 'a reopenable blocker is a deadlock, not a wall')

  // A status nobody has taught this module about is treated as a wall, not as a draft: guessing the
  // other way hands an operator a button that strands their order.
  assert.equal(
    repackReopenControlIsAvailable({
      shipmentStatus: 'PACKED',
      orderStatus: PROCESSING,
      recoveryOutstanding: true,
      orderHasCommittedShipment: true,
      orderHasUnreopenableCommitment: true,
    }),
    false,
  )
  assert.deepEqual(
    summariseRepackBlockers(['PENDING', 'SOMETHING_NEW']),
    { orderHasCommittedShipment: true, orderHasUnreopenableCommitment: true },
  )
  assert.deepEqual(
    summariseRepackBlockers(['PENDING', 'PACKED', 'PICKING']),
    { orderHasCommittedShipment: true, orderHasUnreopenableCommitment: false },
  )
  assert.deepEqual(
    summariseRepackBlockers(['PENDING', 'PENDING']),
    { orderHasCommittedShipment: false, orderHasUnreopenableCommitment: false },
  )
})

test('o3d-2k5r r4 UI sequence: an order stranded by the earlier non-transactional shape', () => {
  // The reopen committed on its own and the process died before the allocation. The order carries a
  // PENDING draft, the pre-refund reservation, and an unresolved backstop row. Nothing about the
  // shipment distinguishes it from an ordinary draft — only the durable evidence does. And nothing
  // else on the order is committed, so the recovery can actually run.
  const stranded = { shipmentStatus: 'PENDING', orderStatus: PROCESSING, recoveryOutstanding: true, orderHasCommittedShipment: false, orderHasUnreopenableCommitment: false }
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
        repackRecoveryControlIsAvailable({ shipmentStatus, orderStatus: PROCESSING, recoveryOutstanding, orderHasCommittedShipment: true, orderHasUnreopenableCommitment: false }),
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
        for (const orderHasUnreopenableCommitment of [true, false]) {
          const controls = repackControlsFor({ shipmentStatus, orderStatus: PROCESSING, recoveryOutstanding, orderHasCommittedShipment, orderHasUnreopenableCommitment })
          assert.ok(controls.length <= 1, `${shipmentStatus}/${recoveryOutstanding}/${orderHasCommittedShipment}/${orderHasUnreopenableCommitment} offered ${controls.join('+')}`)
        }
      }
    }
  }
})

test('o3d-2k5r r4: a cancelled order offers neither — it takes the discard path', () => {
  // Reopening would leave a draft on an order that will never be invoiced, and the rebuild step
  // refuses a cancelled order anyway, so the recovery would dead-end.
  for (const shipmentStatus of ['PENDING', 'PICKING', 'PACKED']) {
    assert.deepEqual(repackControlsFor({ shipmentStatus, orderStatus: 'CANCELLED', recoveryOutstanding: true, orderHasCommittedShipment: false, orderHasUnreopenableCommitment: false }), [])
  }
  assert.equal(repackReopenControlIsAvailable({ shipmentStatus: 'PACKED', orderStatus: 'CANCELLED', recoveryOutstanding: true, orderHasCommittedShipment: true, orderHasUnreopenableCommitment: false }), false)
  assert.equal(repackRecoveryControlIsAvailable({ shipmentStatus: 'PENDING', orderStatus: 'CANCELLED', recoveryOutstanding: true, orderHasCommittedShipment: false, orderHasUnreopenableCommitment: false }), false)
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

test('o3d-2k5r r6 evidence: a DEAD-LETTERED (PERMANENT_FAILED) row is outstanding — it is the oldest stranded order', async () => {
  // THE ORDERS THE RESUME PATH WAS BUILT FOR. The drain refuses while any shipment exists and burns
  // an attempt each time, so an order stranded long enough dead-letters. `claimIntegrationOutboxWork`
  // never claims a PERMANENT_FAILED row again — so if the evidence read skips it too, the only
  // control that could release that reservation is withheld from precisely the orders that need it,
  // and the stock stays reserved forever.
  const { client } = readClient(['r-dead'], [
    { idempotencyKey: 'sales:refund.reservation-release:r-dead', status: 'PERMANENT_FAILED' },
  ])
  assert.equal(await countOutstandingRefundReservationReleases('order-1', { client }), 1)
})

test('o3d-2k5r r6: a PENDING draft whose only backstop row is PERMANENT_FAILED gets the Finish control', async () => {
  // The finding end to end: the evidence read and the affordance together, on the state an
  // exhausted-retry stranded order is actually in — one draft, nothing else committed, one
  // dead-lettered release row.
  const { client } = readClient(['r-dead'], [
    { idempotencyKey: 'sales:refund.reservation-release:r-dead', status: 'PERMANENT_FAILED' },
  ])
  const outstanding = await countOutstandingRefundReservationReleases('order-1', { client })
  assert.deepEqual(
    controlsOnOrder([{ name: 'A', status: 'PENDING' }], { status: PROCESSING, recoveryOutstanding: outstanding > 0 }),
    { A: ['finish-recovery'] },
  )
})

test('o3d-2k5r r4 evidence: an order with no refunds asks the outbox nothing', async () => {
  // The recovery only exists because of a refund. No refund, no deferred release, no control — and
  // no query either, which is what keeps this off the hot path of every order detail page.
  const { client, counted } = readClient([], [])
  assert.equal(await countOutstandingRefundReservationReleases('order-1', { client }), 0)
  assert.deepEqual(counted, [])
})
