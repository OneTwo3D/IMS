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
    notify: { id: string; wcHandled: boolean }[]
    logReversal: { id: string; wcHandled: boolean }[]
  }
}

function makeEffects(opts: {
  recentWcRefund?: boolean
  chargebackResult?: { raised?: boolean; error?: string }
  chargebackThrows?: unknown
} = {}): Recorder {
  const calls = {
    recentWc: [] as string[],
    chargeback: [] as string[],
    clearPaidAt: [] as string[],
    notify: [] as { id: string; wcHandled: boolean }[],
    logReversal: [] as { id: string; wcHandled: boolean }[],
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
    },
    notifyNeedsAttention: async (order, ctx) => {
      calls.notify.push({ id: order.id, wcHandled: ctx.wcHandled })
    },
    logReversalDetected: async (order, ctx) => {
      calls.logReversal.push({ id: order.id, wcHandled: ctx.wcHandled })
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
