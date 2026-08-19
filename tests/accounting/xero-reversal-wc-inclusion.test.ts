// onetwo3d-ims-6oyu.6 — Xero payment-reversal/chargeback detection must include
// WooCommerce-linked paid orders, while never raising a SECOND credit note for a
// reversal the authoritative WooCommerce refund webhook already handled.
//
// These tests cover the pure, dependency-injected reversal handler that the Xero
// payment poller drives per detected reversal.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  handleDetectedReversal,
  type DetectedReversalOrder,
  type ReversalEffects,
} from '@/lib/domain/accounting/reversal-handling'

function makeOrder(overrides: Partial<DetectedReversalOrder> = {}): DetectedReversalOrder {
  return {
    id: 'so_1',
    orderNumber: null,
    externalOrderNumber: 'WC-1001',
    status: 'SHIPPED',
    accountingInvoiceId: 'X1',
    revenueDeferredDate: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  }
}

type Recorder = {
  effects: ReversalEffects
  calls: {
    recentWc: string[]
    chargeback: string[]
    clearPaidAt: string[]
    notify: RecordedCall[]
    logReversal: RecordedCall[]
    /**
     * o3d-w00 (Codex r10 #1): the ORDER the closing effects ran in. paidAt is the poller's re-detection
     * cursor — its candidate query is `paidAt: { not: null }` — so clearing it is what retires the order
     * from every future poll, and anything not yet written when it lands is lost for good. The sequence
     * is asserted on directly, because "the alert came first" is the property, not a side effect of one.
     */
    sequence: string[]
  }
}

// o3d-w00 (Codex r9 #4): the alert and the audit entry carry the chargeback refusal, so a permanent
// refusal reads as an OUTSTANDING revenue unwind rather than a clean reversal. Recorded so the tests
// can assert on it.
type RecordedCall = { id: string; wcHandled: boolean; chargebackManualReason?: string }

function makeEffects(opts: {
  recentWcRefund?: boolean
  chargebackResult?: { raised?: boolean; error?: string; manualResolutionRequired?: boolean }
  chargebackThrows?: unknown
  // o3d-w00 (Codex r9 #4): each closing effect can fail on its own, and one failing must not take the
  // others with it — least of all the notification, which is the only thing that makes a permanent
  // refusal visible.
  clearPaidAtThrows?: unknown
  notifyThrows?: unknown
  logReversalThrows?: unknown
} = {}): Recorder {
  const calls = {
    recentWc: [] as string[],
    chargeback: [] as string[],
    clearPaidAt: [] as string[],
    notify: [] as RecordedCall[],
    logReversal: [] as RecordedCall[],
    sequence: [] as string[],
  }
  const effects: ReversalEffects = {
    wasHandledByRecentWcRefund: async (orderId) => {
      calls.recentWc.push(orderId)
      return opts.recentWcRefund ?? false
    },
    raiseChargeback: async (orderId) => {
      calls.chargeback.push(orderId)
      if (opts.chargebackThrows !== undefined) throw opts.chargebackThrows
      return opts.chargebackResult ?? { raised: true }
    },
    clearPaidAt: async (orderId) => {
      calls.clearPaidAt.push(orderId)
      calls.sequence.push('clearPaidAt')
      if (opts.clearPaidAtThrows !== undefined) throw opts.clearPaidAtThrows
    },
    notifyNeedsAttention: async (order, ctx) => {
      calls.notify.push({
        id: order.id,
        wcHandled: ctx.wcHandled,
        ...(ctx.chargebackManualReason ? { chargebackManualReason: ctx.chargebackManualReason } : {}),
      })
      calls.sequence.push('notify')
      if (opts.notifyThrows !== undefined) throw opts.notifyThrows
    },
    logReversalDetected: async (order, ctx) => {
      calls.logReversal.push({
        id: order.id,
        wcHandled: ctx.wcHandled,
        ...(ctx.chargebackManualReason ? { chargebackManualReason: ctx.chargebackManualReason } : {}),
      })
      calls.sequence.push('logReversal')
      if (opts.logReversalThrows !== undefined) throw opts.logReversalThrows
    },
  }
  return { effects, calls }
}

test('WC order with a Xero reversal and NO recent WC refund → reversed once + notified', async () => {
  const { effects, calls } = makeEffects({ recentWcRefund: false })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'reversed')
  assert.equal(result.wcHandled, false)
  assert.deepEqual(calls.chargeback, ['so_1'], 'chargeback raised exactly once')
  assert.deepEqual(calls.clearPaidAt, ['so_1'], 'paidAt cleared exactly once')
  assert.deepEqual(calls.notify, [{ id: 'so_1', wcHandled: false }], 'needs-attention notification fired once')
  assert.deepEqual(calls.logReversal, [{ id: 'so_1', wcHandled: false }])
})

test('WC order already refunded via WC webhook (recent) → NO second credit note (dedup), paidAt reconciled, still alerted with WC context', async () => {
  const { effects, calls } = makeEffects({ recentWcRefund: true })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'reversed')
  assert.equal(result.wcHandled, true)
  assert.deepEqual(calls.chargeback, [], 'no chargeback — WC refund path owns the revenue reversal (no double credit note)')
  assert.deepEqual(calls.clearPaidAt, ['so_1'], 'paidAt STILL cleared — payment is genuinely gone in Xero and the WC path does not clear it')
  assert.deepEqual(calls.notify, [{ id: 'so_1', wcHandled: true }], 'still alerted (refund may only partially cover the removal) — with WC context')
  assert.deepEqual(calls.logReversal, [{ id: 'so_1', wcHandled: true }])
})

test('manual order path unchanged: no WC refund exists → still reverses + charges back', async () => {
  const { effects, calls } = makeEffects({ recentWcRefund: false })
  const order = makeOrder({ id: 'so_manual', externalOrderNumber: null, orderNumber: 'SO-2001' })
  const result = await handleDetectedReversal(order, { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'reversed')
  assert.deepEqual(calls.chargeback, ['so_manual'])
  assert.deepEqual(calls.clearPaidAt, ['so_manual'])
  assert.deepEqual(calls.notify, [{ id: 'so_manual', wcHandled: false }])
})

test('historic-only WC refund (not recent) does NOT suppress a genuine reversal — chargeback self-dedups, paidAt cleared, alerted', async () => {
  // wasHandledByRecentWcRefund is window-scoped: an old partial WC refund returns false
  // here, so the reversal is treated as genuine. The real raiseChargeback self-skips an
  // order with prior refunds (returns raised:false, no error) — modelled here — and the
  // handler still clears paidAt and raises a needs-attention alert for manual handling.
  const { effects, calls } = makeEffects({
    recentWcRefund: false,
    chargebackResult: { raised: false }, // internal prior-refund self-skip, no error
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'reversed')
  assert.deepEqual(calls.chargeback, ['so_1'], 'chargeback attempted; it self-dedups internally')
  assert.deepEqual(calls.clearPaidAt, ['so_1'], 'paidAt reconciled')
  assert.deepEqual(calls.notify, [{ id: 'so_1', wcHandled: false }], 'genuine reversal is alerted for manual review')
})

test('VOIDED invoice: skip chargeback (Xero already reversed AR/revenue) but still clear paidAt + notify', async () => {
  const { effects, calls } = makeEffects({ recentWcRefund: false })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: true }, effects)

  assert.equal(result.outcome, 'reversed')
  assert.deepEqual(calls.chargeback, [], 'no separate credit note — would double-reverse a voided invoice')
  assert.deepEqual(calls.clearPaidAt, ['so_1'])
  assert.deepEqual(calls.notify, [{ id: 'so_1', wcHandled: false }])
})

test('revenue not posted (no revenueDeferredDate): no chargeback, but clear paidAt + notify', async () => {
  const { effects, calls } = makeEffects({ recentWcRefund: false })
  const result = await handleDetectedReversal(
    makeOrder({ revenueDeferredDate: null }),
    { invoiceVoided: false },
    effects,
  )

  assert.equal(result.outcome, 'reversed')
  assert.deepEqual(calls.chargeback, [], 'no recognised revenue to unwind')
  assert.deepEqual(calls.clearPaidAt, ['so_1'])
  assert.deepEqual(calls.notify, [{ id: 'so_1', wcHandled: false }])
})

test('failed chargeback holds paidAt (retried next poll) — no clear, no notify', async () => {
  const { effects, calls } = makeEffects({
    recentWcRefund: false,
    chargebackResult: { raised: false, error: 'shipped quantity not yet journaled by the daily batch' },
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'chargeback-failed')
  assert.match(result.error ?? '', /not yet journaled/)
  assert.deepEqual(calls.clearPaidAt, [], 'paidAt held so the reversal is re-attempted')
  assert.deepEqual(calls.notify, [], 'no reversal-complete alert on a held chargeback')
})

test('thrown chargeback is treated as a failure and holds paidAt', async () => {
  const { effects, calls } = makeEffects({
    recentWcRefund: false,
    chargebackThrows: new Error('boom'),
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'chargeback-failed')
  assert.match(result.error ?? '', /boom/)
  assert.deepEqual(calls.clearPaidAt, [])
})

test('idempotency: an already-existing chargeback (no error) still clears paidAt once', async () => {
  // Second-pass semantics of raiseChargebackForReversedOrder: it returns
  // { raised: false, reason: "chargeback already exists" } with NO error, meaning the
  // financial reversal is already recorded. The handler must still clear paidAt so the
  // order drops out of the next poll's paidAt-not-null window → reversed exactly once.
  const { effects, calls } = makeEffects({
    recentWcRefund: false,
    chargebackResult: { raised: false },
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'reversed')
  assert.deepEqual(calls.clearPaidAt, ['so_1'])
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 (Codex r8 #3): a chargeback refusal POLLING CANNOT CLEAR is not a retry cursor.
//
// Holding paidAt is the right answer to a transient failure — the next poll re-attempts and completes
// it. It is the wrong answer to the posted-VAT fence refusing to unwind an invoice at a rate the order
// never charged: that stands until an admin changes the tax configuration, and every poll re-fails, so
// IMS goes on presenting and processing the order as PAID after Xero has proved the payment is gone —
// with no alert and no audit entry, both of which sat after the early return.
// ---------------------------------------------------------------------------------------------

test('a NON-TRANSIENT chargeback refusal reconciles paidAt and alerts on the first failure (o3d-w00 Codex r8 #3)', async () => {
  const reason = 'No credit note has been raised: The refunded shipping returned 12.00 of the customer\'s money'
  const { effects, calls } = makeEffects({
    chargebackResult: { raised: false, error: reason, manualResolutionRequired: true },
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'chargeback-manual')
  assert.equal(result.error, reason)
  assert.deepEqual(calls.chargeback, ['so_1'])
  // The payment IS gone in Xero. Showing the order paid until a human edits the tax table is the one
  // outcome that must not be available.
  assert.deepEqual(calls.clearPaidAt, ['so_1'], 'payment truth is reconciled immediately')
  // And the alert carries WHY, because nothing else will ever say it: no later poll can raise this
  // credit note, so a silent hold would be the only record that revenue is still recognised.
  assert.deepEqual(calls.notify, [{ id: 'so_1', wcHandled: false, chargebackManualReason: reason }])
  assert.deepEqual(calls.logReversal, [{ id: 'so_1', wcHandled: false, chargebackManualReason: reason }])
})

test('a TRANSIENT chargeback failure still holds paidAt for the next poll (o3d-w00 Codex r8 #3)', async () => {
  // The distinction is the whole point: an unjournaled shipment or a Xero outage IS cleared by
  // re-attempting, and clearing paidAt for it would drop the order out of the next poll's window and
  // leave the recognised revenue unreversed forever.
  const { effects, calls } = makeEffects({
    chargebackResult: { raised: false, error: 'shipped quantity not yet journaled by the daily batch' },
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'chargeback-failed')
  assert.deepEqual(calls.clearPaidAt, [], 'paidAt is HELD so the reversal is re-attempted')
  assert.deepEqual(calls.notify, [])
  assert.deepEqual(calls.logReversal, [])
})

test('a chargeback that THROWS is transient, not manual (o3d-w00 Codex r8 #3)', async () => {
  // An exception says nothing about whether the condition is permanent, so it keeps the conservative
  // hold-and-retry treatment rather than being promoted to "a human must fix this".
  const { effects, calls } = makeEffects({ chargebackThrows: new Error('ECONNRESET') })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'chargeback-failed')
  assert.deepEqual(calls.clearPaidAt, [])
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 (Codex r9 #4): A PARTIAL FAILURE MUST NOT SWALLOW THE ALERT.
//
// r8 #3 made a PERMANENT chargeback refusal reconcile paidAt, notify and audit on the FIRST failure,
// because the alternative — holding paidAt and re-failing forever — leaves an outstanding revenue
// unwind invisible. All three then ran as one unbroken await chain, so a failure in the first threw
// out of the handler past the other two: the part that goes missing is the alert the branch exists to
// send, and the poller's surrounding catch abandons every remaining order in the pass with it.
// ---------------------------------------------------------------------------------------------

test('a permanent refusal still ALERTS when clearing paidAt fails (o3d-w00 Codex r9 #4)', async () => {
  const { effects, calls } = makeEffects({
    chargebackResult: {
      raised: false,
      error: 'the credit note would come to 10.50 against the 12.00 the invoice charged',
      manualResolutionRequired: true,
    },
    clearPaidAtThrows: new Error('deadlock detected'),
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.deepEqual(calls.clearPaidAt, ['so_1'], 'it was attempted')
  assert.equal(calls.notify.length, 1, 'and the alert fired anyway — this is the only thing that surfaces the refusal')
  assert.equal(calls.logReversal.length, 1, 'as did the audit entry')
  // ...both of them BEFORE the clear was attempted (Codex r10 #1), so neither can be lost by it and
  // neither can claim a reconciliation that has not happened.
  assert.deepEqual(calls.sequence, ['notify', 'logReversal', 'clearPaidAt'])
  assert.equal(
    calls.notify[0].chargebackManualReason,
    'the credit note would come to 10.50 against the 12.00 the invoice charged',
    'carrying the refusal, so the alert says WHY no credit note exists',
  )
  // Not a clean reversal: reported, not counted, and the order still has paidAt set, so the next poll
  // re-detects it and re-runs the whole decision.
  assert.equal(result.outcome, 'reversal-incomplete')
  assert.match(result.error ?? '', /the credit note would come to 10\.50/)
  assert.match(result.error ?? '', /clearing paidAt failed/)
})

test('a failed alert does not take the audit entry with it (o3d-w00 Codex r9 #4)', async () => {
  // The three effects are independent, in both directions: an undeliverable notification must still
  // leave the durable record behind, and must still be reported rather than swallowed.
  const { effects, calls } = makeEffects({ notifyThrows: new Error('notification store unavailable') })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(calls.notify.length, 1)
  assert.equal(calls.logReversal.length, 1, 'the audit entry is written even though the alert failed')
  // o3d-w00 (Codex r10 #1): and paidAt is NOT cleared, because clearing it is what would take the
  // order out of the next poll's window — with the alert that failed never re-sent. r9 cleared it
  // first and called the result self-healing; it only heals when the CLEAR is what failed.
  assert.deepEqual(calls.clearPaidAt, [], 'the re-detection cursor is left intact')
  assert.equal(result.outcome, 'reversal-incomplete')
  assert.match(result.error ?? '', /notifying admins failed/)
  assert.match(result.error ?? '', /paidAt was NOT cleared/)
})

test('a failed audit entry is reported, not swallowed (o3d-w00 Codex r9 #4)', async () => {
  const { effects, calls } = makeEffects({ logReversalThrows: new Error('activity log write failed') })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(calls.notify.length, 1, 'the alert landed')
  assert.equal(result.outcome, 'reversal-incomplete')
  assert.match(result.error ?? '', /recording the audit entry failed/)
})

test('a clean reversal is still a clean reversal (o3d-w00 Codex r9 #4)', async () => {
  // The guards must not turn every success into an "incomplete": with nothing failing, the outcomes
  // r8 established are unchanged.
  const clean = makeEffects()
  assert.equal((await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, clean.effects)).outcome, 'reversed')

  const manual = makeEffects({
    chargebackResult: { raised: false, error: 'tax mapping missing', manualResolutionRequired: true },
  })
  const manualResult = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, manual.effects)
  assert.equal(manualResult.outcome, 'chargeback-manual')
  assert.equal(manualResult.error, 'tax mapping missing')
  assert.deepEqual(manual.calls.clearPaidAt, ['so_1'], 'paidAt is still reconciled on the first failure (r8 #3)')
  assert.deepEqual(manual.calls.sequence, ['notify', 'logReversal', 'clearPaidAt'])
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 (Codex r10 #1): paidAt IS THE POLLER'S RE-DETECTION CURSOR, SO IT IS RETIRED LAST.
//
// r9 #4 made the closing effects independent and defended clearing paidAt FIRST with "a failed paidAt
// clear is self-healing — the order still has paidAt set, so the next poll re-detects it". That covers
// only the case where the CLEAR failed. The poller selects reversal candidates with
// `paidAt: { not: null }`, so the clear SUCCEEDING is exactly what removes the order from every future
// poll — and a notification that failed after it is never re-sent, on the one branch whose entire
// purpose is to make an outstanding revenue unwind visible.
// ---------------------------------------------------------------------------------------------

test('a lost alert holds the re-detection cursor: paidAt is not cleared (o3d-w00 Codex r10 #1)', async () => {
  const { effects, calls } = makeEffects({ notifyThrows: new Error('notification store unavailable') })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.deepEqual(
    calls.clearPaidAt,
    [],
    'paidAt still set: the order stays in the next poll\'s `paidAt: { not: null }` window and the ' +
    'whole decision — including the alert — is re-run',
  )
  assert.equal(result.outcome, 'reversal-incomplete')
  assert.match(result.error ?? '', /notifying admins failed/)
  assert.match(result.error ?? '', /paidAt was NOT cleared/, 'and the run error says so, in those terms')
})

test('a lost audit entry holds the cursor too (o3d-w00 Codex r10 #1)', async () => {
  // The audit entry is the durable, order-linked record of the reversal; losing it while retiring the
  // order from the poll leaves nothing on the order at all.
  const { effects, calls } = makeEffects({ logReversalThrows: new Error('activity log write failed') })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.deepEqual(calls.clearPaidAt, [])
  assert.equal(result.outcome, 'reversal-incomplete')
  assert.match(result.error ?? '', /recording the audit entry failed/)
  assert.match(result.error ?? '', /paidAt was NOT cleared/)
})

test('a permanent refusal alerts BEFORE paidAt is cleared, never after (o3d-w00 Codex r10 #1)', async () => {
  // r8 #3's requirement is unchanged — payment truth reconciled and finance told on the FIRST failure
  // — but the order of the two is now what makes the alert unlosable rather than a detail of phrasing.
  const { effects, calls } = makeEffects({
    chargebackResult: { raised: false, error: 'tax mapping missing', manualResolutionRequired: true },
  })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.outcome, 'chargeback-manual')
  assert.deepEqual(calls.sequence, ['notify', 'logReversal', 'clearPaidAt'])
  assert.deepEqual(calls.clearPaidAt, ['so_1'], 'and paidAt IS reconciled once both have landed')
})

test('a WC-handled reversal clears paidAt last as well (o3d-w00 Codex r10 #1)', async () => {
  // The ordering is a property of the handler, not of one branch of it: the WC-handled path alerts too
  // (a refund can only partially explain a full payment removal) and that alert is just as losable.
  const { effects, calls } = makeEffects({ recentWcRefund: true, notifyThrows: new Error('down') })
  const result = await handleDetectedReversal(makeOrder(), { invoiceVoided: false }, effects)

  assert.equal(result.wcHandled, true)
  assert.deepEqual(calls.clearPaidAt, [])
  assert.equal(result.outcome, 'reversal-incomplete')
  assert.match(result.error ?? '', /paidAt was NOT cleared/)
})
