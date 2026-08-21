import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REASSIGNED_REFUND_PARK_STATUS,
  REFUND_PARK_RECOVERY_NOTE_PREFIX,
  RESOLVED_REFUND_PARK_STATUS,
  buildRefundParkDismissData,
  buildRefundParkReassignData,
  describeRefundParkRecoverability,
  describeRefundReadDisagreement,
  isDismissedRefundPark,
  normalizeRefundParkRecoveryAssertion,
  refundParkRecoveryNote,
  refuseDismiss,
  refuseOnLookupFailure,
  refuseReassign,
  refuseUnstableRefundList,
  type RefundParkView,
  type WcOrderRefundEvidence,
} from '@/lib/domain/sales/refund-park-recovery'

// o3d-54p — the DECISION half of the cross-order refund-park recovery: which parks admit one, what
// each outcome writes, and every refusal by its SPECIFIC code. A recovery that refuses for the wrong
// reason is worse than one that refuses for none: it sends an operator to fix something that is not
// broken while the refund stays blocked.

const FETCHED_AT = new Date('2026-08-20T09:00:00.000Z')

function park(over: Partial<RefundParkView> = {}): RefundParkView {
  return { id: 'log-1', status: 'FAILED', entityId: 'order-B', externalId: '7001', ...over }
}

function evidence(over: Partial<WcOrderRefundEvidence> = {}): WcOrderRefundEvidence {
  return { wcOrderId: 1001, refundIds: [7001], fetchedAt: FETCHED_AT, ...over }
}

// ---------------------------------------------------------------------------
// Which rows admit a recovery at all
// ---------------------------------------------------------------------------

test('every actionable park status admits a recovery, and a resolved one does not', () => {
  for (const status of ['PENDING', 'FAILED', 'QUARANTINED']) {
    const verdict = describeRefundParkRecoverability({ status, externalId: '7001', entityId: 'order-B' })
    assert.equal(verdict.recoverable, true, `${status} is actionable and blocks the true owner`)
    assert.equal(verdict.notRecoverableReason, null)
  }
  const resolved = describeRefundParkRecoverability({ status: 'SYNCED', externalId: '7001', entityId: 'order-B' })
  assert.equal(resolved.recoverable, false)
  assert.match(resolved.notRecoverableReason ?? '', /already resolved/)
})

test('QUARANTINED is recoverable, because the quarantine was computed against the WRONG order', () => {
  // o3d-iup quarantines a monetary-only refund against the tax profile of the order the park sits
  // on. If that order is not the refund's order, the quarantine describes an unrelated order's VAT
  // and carries no information about the real one — so it must not be the thing that locks the park.
  const verdict = describeRefundParkRecoverability({ status: 'QUARANTINED', externalId: '7001', entityId: 'order-B' })
  assert.equal(verdict.recoverable, true)
})

test('a row with no refund id or no order is not a refund park and is refused with the reason', () => {
  const noRefund = describeRefundParkRecoverability({ status: 'FAILED', externalId: null, entityId: 'order-B' })
  assert.equal(noRefund.recoverable, false)
  assert.match(noRefund.notRecoverableReason ?? '', /no WooCommerce refund id/)

  const noOrder = describeRefundParkRecoverability({ status: 'FAILED', externalId: '7001', entityId: null })
  assert.equal(noOrder.recoverable, false)
  assert.match(noOrder.notRecoverableReason ?? '', /not attached to an order/)
})

// ---------------------------------------------------------------------------
// TWO READS OF A COLLECTION THAT CAN ONLY BE ADDRESSED BY POSITION
//
// A single walk over offset pages cannot establish that it saw everything: a refund deleted behind
// the cursor shifts every later row down one place, so a row falls between two pages while the list
// still carries the id of the row that was deleted — the same length, the same stated total, one
// refund missing. Two walks are compared instead, and only agreement is evidence.
// ---------------------------------------------------------------------------

test('two reads of the same refunds agree, whatever order the store served them in', () => {
  // A store is free to order a page differently between two requests, and an order that is not a
  // difference in CONTENT is not evidence that anything moved. Refusing on it would make the whole
  // dismissal unreachable on a perfectly stable store.
  assert.equal(
    describeRefundReadDisagreement(
      { refundIds: [7001, 7002, 7003], statedTotal: 3 },
      { refundIds: [7003, 7001, 7002], statedTotal: 3 },
    ),
    null,
  )
})

test('a refund in one read and not the other is named, and says which read had it', () => {
  // The signature of the case no single walk can see: the first read carries a refund that has since
  // been DELETED (so the second cannot serve it), and the second carries the refund that fell through
  // the gap the deletion opened. Both halves are reported, because an operator reading "the list
  // changed" needs to know it changed around the very refund they are deciding about.
  const detail = describeRefundReadDisagreement(
    { refundIds: [8005, 8006, 8007], statedTotal: 3 },
    { refundIds: [8006, 8007, 7001], statedTotal: 3 },
  )
  assert.match(detail ?? '', /the first read listed refund 8005 and the second did not/)
  assert.match(detail ?? '', /the second read listed refund 7001 and the first did not/)
})

test('a long disagreement is summarised rather than dumped', () => {
  const detail = describeRefundReadDisagreement(
    { refundIds: [1, 2, 3, 4, 5, 6, 7], statedTotal: 7 },
    { refundIds: [], statedTotal: 0 },
  )
  assert.match(detail ?? '', /refunds 1, 2, 3, 4, 5 and 2 more/)
})

test('the same refunds with a DIFFERENT stated total is still a collection that moved', () => {
  // The store telling us 250 once and 251 the next time is a plain statement that it changed, even
  // when the two walks happened to bank the same ids — a refund can be created and served on neither.
  const detail = describeRefundReadDisagreement(
    { refundIds: [7001, 7002], statedTotal: 2 },
    { refundIds: [7002, 7001], statedTotal: 3 },
  )
  assert.match(detail ?? '', /a total of 2 on the first read and a total of 3 on the second/)
})

test('a store that states no total at all agrees with itself, and a store that starts stating one does not', () => {
  // "No total" is not zero and not a claim; two reads of a silent store must not refuse for ever.
  assert.equal(
    describeRefundReadDisagreement({ refundIds: [7001], statedTotal: null }, { refundIds: [7001], statedTotal: null }),
    null,
  )
  const detail = describeRefundReadDisagreement(
    { refundIds: [7001], statedTotal: null },
    { refundIds: [7001], statedTotal: 1 },
  )
  assert.match(detail ?? '', /no total at all on the first read and a total of 1 on the second/)
})

test('a list that moved is refused as a list that MOVED, not as a store that could not be asked', () => {
  // Two different remedies. "Could not be asked" sends an operator to look for an outage; this one
  // tells them the answer was changing while it was being given, and that trying again is the fix.
  const refusal = refuseUnstableRefundList(2002, 'the second read listed refund 7001 and the first did not')
  assert.equal(refusal.code, 'wc_refund_list_unstable')
  assert.match(refusal.message, /refund list for order 2002 changed while this check was reading it/)
  assert.match(refusal.message, /the second read listed refund 7001 and the first did not/)
  assert.match(refusal.message, /nothing was changed and the park is exactly as it was/)
  assert.match(refusal.message, /one page at a time BY POSITION/)
  assert.match(refusal.message, /try this recovery again in a moment/)
})

// ---------------------------------------------------------------------------
// REASSIGN — verified against the order the operator named
// ---------------------------------------------------------------------------

test('reassign is permitted only when WooCommerce lists the refund on the named order', () => {
  assert.equal(
    refuseReassign({
      park: park(),
      externalRefundId: 7001,
      targetEvidence: evidence(),
      targetOrderId: 'order-A',
      landedOnOrderId: null,
    }),
    null,
  )
})

test('reassign is refused when WooCommerce does not list the refund on the named order', () => {
  const refusal = refuseReassign({
    park: park(),
    externalRefundId: 7001,
    targetEvidence: evidence({ refundIds: [7002, 7003] }),
    targetOrderId: 'order-A',
    landedOnOrderId: null,
  })
  assert.equal(refusal?.code, 'refund_not_in_asserted_order')
  // The message names what that order DOES have, so the operator can see they transposed a digit
  // rather than being told only that they were wrong.
  assert.match(refusal?.message ?? '', /refunds 7002, 7003/)
})

test('an order with no refunds at all is reported as such, not as an empty list', () => {
  const refusal = refuseReassign({
    park: park(),
    externalRefundId: 7001,
    targetEvidence: evidence({ refundIds: [] }),
    targetOrderId: 'order-A',
    landedOnOrderId: null,
  })
  assert.equal(refusal?.code, 'refund_not_in_asserted_order')
  assert.match(refusal?.message ?? '', /no refunds at all/)
})

test('reassign is refused when the named WooCommerce order has no IMS order', () => {
  const refusal = refuseReassign({
    park: park(),
    externalRefundId: 7001,
    targetEvidence: evidence(),
    targetOrderId: null,
    landedOnOrderId: null,
  })
  assert.equal(refusal?.code, 'asserted_order_not_linked')
  assert.match(refusal?.message ?? '', /Import or re-link that order first/)
})

test('reassigning a park to the order it is already on is refused as WooCommerce agreeing', () => {
  const refusal = refuseReassign({
    park: park({ entityId: 'order-B' }),
    externalRefundId: 7001,
    targetEvidence: evidence(),
    targetOrderId: 'order-B',
    landedOnOrderId: null,
  })
  assert.equal(refusal?.code, 'asserted_order_is_parked_order')
  assert.match(refusal?.message ?? '', /Use Retry/)
})

test('a refund already applied to the park\'s own order makes this a leftover, not a foreign park', () => {
  const refusal = refuseReassign({
    park: park({ entityId: 'order-B' }),
    externalRefundId: 7001,
    targetEvidence: evidence(),
    targetOrderId: 'order-A',
    landedOnOrderId: 'order-B',
  })
  assert.equal(refusal?.code, 'refund_already_landed')
})

test('a refund already applied to a THIRD order is refused rather than pointed at a fourth', () => {
  const refusal = refuseReassign({
    park: park({ entityId: 'order-B' }),
    externalRefundId: 7001,
    targetEvidence: evidence(),
    targetOrderId: 'order-A',
    landedOnOrderId: 'order-C',
  })
  assert.equal(refusal?.code, 'refund_landed_elsewhere')
  assert.match(refusal?.message ?? '', /order-C/)
})

test('a refund already applied to the TARGET is refused with dismissal as the remedy', () => {
  const refusal = refuseReassign({
    park: park({ entityId: 'order-B' }),
    externalRefundId: 7001,
    targetEvidence: evidence(),
    targetOrderId: 'order-A',
    landedOnOrderId: 'order-A',
  })
  assert.equal(refusal?.code, 'refund_landed_elsewhere')
  assert.match(refusal?.message ?? '', /Dismiss the park instead/)
})

// ---------------------------------------------------------------------------
// DISMISS — verified against the park's OWN order
// ---------------------------------------------------------------------------

test('dismissal is permitted only when WooCommerce does NOT list the refund on the parked order', () => {
  assert.equal(
    refuseDismiss({
      park: park(),
      externalRefundId: 7001,
      parkedEvidence: evidence({ wcOrderId: 2002, refundIds: [9001] }),
      landedOnOrderId: null,
    }),
    null,
  )
})

test('dismissal is refused when WooCommerce still confirms the refund on this order', () => {
  const refusal = refuseDismiss({
    park: park(),
    externalRefundId: 7001,
    parkedEvidence: evidence({ wcOrderId: 2002, refundIds: [7001] }),
    landedOnOrderId: null,
  })
  assert.equal(refusal?.code, 'wc_confirms_current_owner')
  assert.match(refusal?.message ?? '', /Nothing was changed; use Retry/)
})

test('dismissal is refused when the parked order has no WooCommerce link to verify against', () => {
  // The whole point of a dismissal is that WooCommerce contradicts the park. With no link there is
  // nothing to ask, so an unverified dismissal would be exactly the silent resolution o3d-ee9's
  // fail-closed exists to prevent.
  const refusal = refuseDismiss({
    park: park(),
    externalRefundId: 7001,
    parkedEvidence: null,
    landedOnOrderId: null,
  })
  assert.equal(refusal?.code, 'parked_order_not_linked')
})

test('a lookup failure is its own refusal and never degrades to the stored payload', () => {
  const refusal = refuseOnLookupFailure(1001, 'HTTP 503')
  assert.equal(refusal.code, 'wc_lookup_failed')
  assert.match(refusal.message, /HTTP 503/)
  assert.match(refusal.message, /will not fall back to the payload stored on the park/)
})

// ---------------------------------------------------------------------------
// What each outcome writes
// ---------------------------------------------------------------------------

test('reassign moves the order, resets to PENDING, and leaves the payload alone', () => {
  const note = refundParkRecoveryNote({ outcome: 'REASSIGN', wcOrderId: 1001 }, evidence(), 7001)
  const data = buildRefundParkReassignData('order-A', note, FETCHED_AT)
  assert.deepEqual(data, {
    entityId: 'order-A',
    status: REASSIGNED_REFUND_PARK_STATUS,
    errorMessage: note,
    syncedAt: FETCHED_AT,
  })
  // PENDING specifically: syncWcRefund treats a QUARANTINED park as handled and skips it, so a
  // reassigned quarantine would arrive on its true owner already unretryable.
  assert.equal(data.status, 'PENDING')
  // payload is ABSENT, not null — it is the only copy IMS has of what WooCommerce sent.
  assert.ok(!('payload' in data))
})

test('dismissal resolves the park without moving it or claiming the refund applied', () => {
  const note = refundParkRecoveryNote({ outcome: 'DISMISS' }, evidence({ wcOrderId: 2002, refundIds: [] }), 7001)
  const data = buildRefundParkDismissData(note, FETCHED_AT)
  assert.equal(data.status, RESOLVED_REFUND_PARK_STATUS)
  // entityId is untouched: the false association stays readable on the row afterwards.
  assert.ok(!('entityId' in data))
  assert.match(data.errorMessage, /did NOT list refund 7001/)
})

test('a dismissed park is distinguishable from one a landed refund resolved', () => {
  // resolveActionableParks CLEARS errorMessage when a refund really lands; a dismissal REPLACES it.
  // That is the whole mechanism by which SYNCED does not become a claim that the refund posted.
  const note = refundParkRecoveryNote({ outcome: 'DISMISS' }, evidence({ refundIds: [] }), 7001)
  assert.equal(isDismissedRefundPark({ status: 'SYNCED', errorMessage: note }), true)
  assert.equal(isDismissedRefundPark({ status: 'SYNCED', errorMessage: null }), false)
  assert.equal(isDismissedRefundPark({ status: 'FAILED', errorMessage: note }), false)
  assert.ok(note.startsWith(REFUND_PARK_RECOVERY_NOTE_PREFIX))
})

test('the note records what WooCommerce said and when, separately from what the operator decided', () => {
  const note = refundParkRecoveryNote({ outcome: 'REASSIGN', wcOrderId: 1001 }, evidence(), 7001)
  assert.match(note, /WooCommerce confirmed refund 7001 on order 1001 at 2026-08-20T09:00:00\.000Z/)
  // And it says plainly that moving the park did NOT apply the refund.
  assert.match(note, /has NOT been applied yet/)
})

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

test('a reassign with a non-integer WooCommerce order id is rejected before anything is fetched', () => {
  // Left to reach the URL, NaN would fetch a 404 that this action would report as "WooCommerce could
  // not be asked" — a refusal naming the wrong cause and sending the operator to check the store.
  for (const wcOrderId of [Number.NaN, 0, -3, 1.5, '1001' as unknown as number, undefined as unknown as number]) {
    assert.equal(normalizeRefundParkRecoveryAssertion({ outcome: 'REASSIGN', wcOrderId }), null, String(wcOrderId))
  }
  assert.deepEqual(
    normalizeRefundParkRecoveryAssertion({ outcome: 'REASSIGN', wcOrderId: 1001 }),
    { outcome: 'REASSIGN', wcOrderId: 1001 },
  )
})

test('an unrecognised outcome is rejected rather than defaulting to either branch', () => {
  assert.equal(normalizeRefundParkRecoveryAssertion({ outcome: 'RESOLVE' }), null)
  assert.equal(normalizeRefundParkRecoveryAssertion(null), null)
  assert.equal(normalizeRefundParkRecoveryAssertion({ outcome: 'DISMISS', reason: 7 }), null)
  assert.deepEqual(normalizeRefundParkRecoveryAssertion({ outcome: 'DISMISS' }), { outcome: 'DISMISS' })
})
