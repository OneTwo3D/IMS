import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planRefundBasisBackfill,
  applyRefundBasisBackfill,
  type RefundBasisBackfillOrder,
} from '@/lib/domain/sales/refund-basis-backfill'

// o3d-lvk. o3d-w00's fail-closed shipped in #516: a second refund on an order whose EARLIER refund
// has a NULL totalsBasis is refused and quarantined, because a legacy total may be GROSS and summing
// it with a new NET total can over-refund (a legacy 60 gross + a new 60 net passes a 120 ceiling but
// grosses to 132 of credit).
//
// Every refund written before the totals_basis migration has a NULL basis, so every order that
// already carried one now quarantines its next refund. This backfill establishes the basis where it
// is PROVABLE, and deliberately leaves it NULL where it is not — a wrong basis silently changes what
// a later refund may post, which is worse than continuing to quarantine.

/** An order line stored NET: totalBase 100 + taxBase 20, so gross is 120. */
function order(over: Partial<RefundBasisBackfillOrder> = {}): RefundBasisBackfillOrder {
  return {
    id: 'order-1',
    lines: [{ id: 'line-1', productId: 'p1', qty: 1, totalBase: 100, taxBase: 20 }],
    refunds: [],
    ...over,
  }
}

test('a refund matching the GROSS line total is stamped GROSS (o3d-lvk)', async () => {
  const plan = await planRefundBasisBackfill([order({
    refunds: [{ id: 'r1', totalsBasis: null, totalBase: 120, lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 }] }],
  })])

  assert.deepEqual(plan.decisions, [{ refundId: 'r1', orderId: 'order-1', basis: 'GROSS' }])
  assert.deepEqual(plan.unresolved, [])
})

test('a refund matching the NET line total is stamped NET (o3d-lvk)', async () => {
  const plan = await planRefundBasisBackfill([order({
    refunds: [{ id: 'r1', totalsBasis: null, totalBase: 100, lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 100 }] }],
  })])

  assert.deepEqual(plan.decisions, [{ refundId: 'r1', orderId: 'order-1', basis: 'NET' }])
})

test('a refund with NO evidence is left NULL, not guessed (o3d-lvk)', async () => {
  // An unlinked (monetary-only) refund line has no order line to compare against. Guessing here
  // would silently change what a later refund is allowed to post.
  const plan = await planRefundBasisBackfill([order({
    refunds: [{ id: 'r1', totalsBasis: null, totalBase: 50, lines: [{ productId: null, salesOrderLineId: null, qty: 0, totalBase: 50 }] }],
  })])

  assert.deepEqual(plan.decisions, [], 'nothing is stamped')
  assert.deepEqual(plan.unresolved, [{ refundId: 'r1', orderId: 'order-1' }], 'and it is reported as unresolved')
})

test('CONTRADICTORY evidence is left NULL rather than resolved by majority (o3d-lvk)', async () => {
  // Two lines, one clearly net and one clearly gross. A refund that mixes bases cannot be summed
  // safely under either, so it must keep failing closed.
  const plan = await planRefundBasisBackfill([order({
    lines: [
      { id: 'line-1', productId: 'p1', qty: 1, totalBase: 100, taxBase: 20 },
      { id: 'line-2', productId: 'p2', qty: 1, totalBase: 100, taxBase: 20 },
    ],
    refunds: [{
      id: 'r1',
      totalsBasis: null,
      totalBase: 220,
      lines: [
        { productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 },
        { productId: 'p2', salesOrderLineId: 'line-2', qty: 1, totalBase: 100 },
      ],
    }],
  })])

  assert.deepEqual(plan.decisions, [], 'a mixed-basis refund is never stamped')
  assert.equal(plan.unresolved.length, 1)
})

test('an already-stamped refund is never re-derived (o3d-lvk)', async () => {
  // It was either written by the current code path (authoritative) or by a previous run. Re-deriving
  // could change an answer someone has already acted on.
  const plan = await planRefundBasisBackfill([order({
    refunds: [{ id: 'r1', totalsBasis: 'NET', totalBase: 120, lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 }] }],
  })])

  assert.deepEqual(plan.decisions, [], 'not restamped even though the evidence says GROSS')
  assert.equal(plan.alreadyStamped, 1)
})

test('applying is conditional, so a row stamped concurrently is not overwritten (o3d-lvk)', async () => {
  // Compare-and-set: `count === 0` means something else won the race. That difference is REPORTED,
  // not swallowed, so an operator sees the plan and the outcome disagree.
  // where and data are recorded SEPARATELY: merging them let data.totalsBasis overwrite the
  // where.totalsBasis condition being asserted, so the assertion could never fail.
  const seen: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
  const tx = {
    salesOrderRefund: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        seen.push({ where, data })
        // r2 was stamped by someone else between planning and applying.
        return { count: where.id === 'r2' ? 0 : 1 }
      },
    },
  } as never

  const result = await applyRefundBasisBackfill(tx, [
    { refundId: 'r1', orderId: 'o1', basis: 'NET' },
    { refundId: 'r2', orderId: 'o1', basis: 'GROSS' },
  ])

  assert.equal(result.stamped, 1)
  assert.equal(result.skippedRaced, 1, 'the race is surfaced, not hidden')
  assert.ok(
    seen.every((s) => s.where.totalsBasis === null),
    'every write REQUIRES the row to still be unstamped — that predicate is the whole guard',
  )
  assert.deepEqual(seen.map((s) => s.data.totalsBasis), ['NET', 'GROSS'], 'and each stamps its own verdict')
})

test('a plan over many orders keeps each order\'s lines separate (o3d-lvk)', async () => {
  // The classifier resolves a refund line against ITS OWN order's lines. Sharing one map across
  // orders would let an unrelated order's line satisfy the lookup and produce a confident wrong
  // answer — the failure mode this test exists to prevent.
  const plan = await planRefundBasisBackfill([
    order({
      id: 'order-1',
      lines: [{ id: 'line-1', productId: 'p1', qty: 1, totalBase: 100, taxBase: 20 }],
      refunds: [{ id: 'r1', totalsBasis: null, totalBase: 120, lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 }] }],
    }),
    order({
      id: 'order-2',
      lines: [{ id: 'line-2', productId: 'p2', qty: 1, totalBase: 200, taxBase: 40 }],
      // References order-1's line, which this order does not have: no evidence, not a cross-order match.
      refunds: [{ id: 'r2', totalsBasis: null, totalBase: 120, lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 }] }],
    }),
  ])

  assert.deepEqual(plan.decisions, [{ refundId: 'r1', orderId: 'order-1', basis: 'GROSS' }])
  assert.deepEqual(plan.unresolved, [{ refundId: 'r2', orderId: 'order-2' }])
})

test('a header that does NOT reconcile with its lines is left NULL (o3d-lvk, review)', async () => {
  // totalsBasis describes the HEADER — it is what the cumulative refund ceiling and the status
  // reconciliation consume. The lines can prove a basis while the header disagrees with them, and
  // the schema does not enforce equality. Stamping then tells those consumers to trust a number the
  // lines never justified.
  const plan = await planRefundBasisBackfill([order({
    refunds: [{
      id: 'r1',
      totalsBasis: null,
      totalBase: 200,                     // header
      lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 }], // lines say 120
    }],
  })])

  assert.deepEqual(plan.decisions, [], 'a divergent header blocks the stamp')
  assert.deepEqual(plan.unresolved, [{ refundId: 'r1', orderId: 'order-1' }])
})

test('rounding-scale header drift still reconciles (o3d-lvk, review)', async () => {
  // The tolerance must absorb per-line rounding without absorbing a real divergence — otherwise the
  // check would reject legitimate refunds and this backfill would stamp almost nothing.
  const plan = await planRefundBasisBackfill([order({
    refunds: [{
      id: 'r1',
      totalsBasis: null,
      totalBase: 120.00004,
      lines: [{ productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 120 }],
    }],
  })])

  assert.deepEqual(plan.decisions, [{ refundId: 'r1', orderId: 'order-1', basis: 'GROSS' }])
})

test('a value-carrying UNLINKED sibling blocks the whole refund (o3d-lvk, review)', async () => {
  // The finding that mattered most. A single NET-looking line used to certify a refund that also
  // contained an unclassified value-carrying line — so a legacy GROSS amount could be stamped NET,
  // DISABLING the fail-closed guard for that order and permitting a later over-refund.
  //
  // A missed stamp costs a quarantine an operator can clear. A wrong stamp costs money nobody sees.
  const plan = await planRefundBasisBackfill([order({
    refunds: [{
      id: 'r1',
      totalsBasis: null,
      totalBase: 160,
      lines: [
        { productId: 'p1', salesOrderLineId: 'line-1', qty: 1, totalBase: 100 },  // clearly NET
        { productId: null, salesOrderLineId: null, qty: 0, totalBase: 60 },       // unknown basis
      ],
    }],
  })])

  assert.deepEqual(plan.decisions, [], 'one unknown sibling blocks the whole refund')
  assert.deepEqual(plan.unresolved, [{ refundId: 'r1', orderId: 'order-1' }])
})

test('a link to a DIFFERENT product is not evidence, even when the numbers agree (o3d-lvk, review)', async () => {
  // Product A's refund mislinked to product B whose figures coincide would classify on a
  // coincidence. Identity must match before the comparison means anything.
  const plan = await planRefundBasisBackfill([order({
    refunds: [{
      id: 'r1',
      totalsBasis: null,
      totalBase: 100,
      lines: [{ productId: 'p2', salesOrderLineId: 'line-1', qty: 1, totalBase: 100 }],
    }],
  })])

  assert.deepEqual(plan.decisions, [], 'a mismatched product link proves nothing')
})
