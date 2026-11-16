import assert from 'node:assert/strict'
import test from 'node:test'

import { toDecimal } from '@/lib/domain/math/decimal'
import { matchRemovedRegisteredPayments, measurePartialPaymentRemoval, shortfallAfter, type PartialRemovalFacts } from '@/lib/domain/accounting/partial-payment-removal'
import { hasPaymentRemoved, isFullyPaid, paidAmountForeign } from '@/lib/domain/sales/paid-state'
import { receivableBalance } from '@/lib/domain/sales/receivable-balance'
import { WMS_CREATE_ELIGIBLE_ORDER_FENCES } from '@/lib/domain/wms/create-eligibility'

// o3d-cdhl: the measurement is pure, so every fact it weighs is pinned here; the database wiring is in
// tests/concurrency/partial-payment-reversal.concurrent.test.ts.

const base: PartialRemovalFacts = {
  orderCurrency: 'GBP', ledgerCurrency: 'GBP', orderTotal: '100', ledgerPaid: 60, ledgerCredited: 0,
  alreadyRemoved: null, orderHasRefunds: false, paidFlagIsLedgerSourced: true, registrationVerdict: 'STILL_HELD',
}

test('a ledger that holds less than IMS recorded is a measured removal of the difference', () => {
  const m = measurePartialPaymentRemoval(base)
  assert.equal(m.kind, 'REMOVED')
  if (m.kind === 'REMOVED') {
    assert.equal(m.removed.toString(), '40')
    assert.equal(m.recordedPaid.toString(), '100')
    assert.equal(m.ledgerPaid.toString(), '60')
  }
})

test('the control: paid == total is NOT a partial loss (a rule that treats every paid < total as one raises a loss on settled documents)', () => {
  assert.equal(measurePartialPaymentRemoval({ ...base, ledgerPaid: 100 }).kind, 'AGREES')
  assert.equal(measurePartialPaymentRemoval({ ...base, ledgerPaid: 99.996 }).kind, 'AGREES', 'within half a minor unit of the total')
})

test('measured against what is already recorded, so the same ledger figure measures zero the second time', () => {
  const m = measurePartialPaymentRemoval({ ...base, alreadyRemoved: '40' })
  assert.equal(m.kind, 'AGREES')
  const more = measurePartialPaymentRemoval({ ...base, alreadyRemoved: '40', ledgerPaid: 30 })
  assert.equal(more.kind === 'REMOVED' && more.removed.toString(), '30')
  const back = measurePartialPaymentRemoval({ ...base, alreadyRemoved: '40', ledgerPaid: 80 })
  assert.equal(back.kind === 'RESTORED' && back.restored.toString(), '20')
  const overshoot = measurePartialPaymentRemoval({ ...base, alreadyRemoved: '40', ledgerPaid: 250 })
  assert.equal(overshoot.kind === 'RESTORED' && overshoot.restored.toString(), '40', 'bounded by the shortfall on record')
})

test('anything the facts do not prove is UNPROVEN, never a guess', () => {
  const unproven = (over: Partial<PartialRemovalFacts>) => {
    const m = measurePartialPaymentRemoval({ ...base, ...over })
    assert.equal(m.kind, 'UNPROVEN', JSON.stringify(over))
    return m.kind === 'UNPROVEN' ? m.reason : ''
  }
  assert.equal(unproven({ ledgerPaid: -5 }), 'ledger-amount-not-stated')
  assert.equal(unproven({ ledgerPaid: null }), 'ledger-amount-not-stated')
  assert.equal(unproven({ ledgerCurrency: 'EUR' }), 'currency-differs')
  assert.equal(unproven({ ledgerCurrency: null }), 'currency-differs')
  assert.equal(unproven({ ledgerCredited: 10 }), 'ledger-holds-credit')
  assert.equal(unproven({ orderHasRefunds: true }), 'order-has-refunds')
  assert.equal(unproven({ paidFlagIsLedgerSourced: false }), 'not-ledger-evidence')
  for (const verdict of ['RECEIPT_NOT_REGISTERED', 'PAID_WITHOUT_LEDGER_RECEIPT', 'PART_COVERED_OFF_LEDGER', 'REGISTRATION_UNDECIDED', 'GONE']) {
    assert.equal(unproven({ registrationVerdict: verdict }), 'not-ledger-evidence', verdict)
  }
  assert.equal(unproven({ orderTotal: 0 }), 'total-not-readable')
})

test('four-decimal currencies measure against their own minor unit', () => {
  const m = measurePartialPaymentRemoval({ ...base, orderCurrency: 'KWD', ledgerCurrency: 'KWD', orderTotal: '10.000', ledgerPaid: 9.999 })
  assert.equal(m.kind, 'REMOVED')
  assert.equal(m.kind === 'REMOVED' && m.removed.toString(), '0.001')
})

test('shortfall arithmetic never goes negative', () => {
  assert.equal(shortfallAfter(null, { kind: 'REMOVED', removed: toDecimal(40) }).toString(), '40')
  assert.equal(shortfallAfter('40', { kind: 'RESTORED', restored: toDecimal(90) }).toString(), '0')
})

test('a removed registered payment is named only when the absent ones add up to the removal', () => {
  const reg = [
    { ledgerPaymentId: 'A', amount: toDecimal(60) },
    { ledgerPaymentId: 'B', amount: toDecimal(40) },
  ]
  assert.deepEqual(matchRemovedRegisteredPayments(toDecimal(40), 'GBP', reg, new Set(['a'])), ['B'], 'ids compare case-insensitively')
  assert.deepEqual(matchRemovedRegisteredPayments(toDecimal(25), 'GBP', reg, new Set(['a'])), [], 'amounts that do not add up name nothing')
  assert.deepEqual(matchRemovedRegisteredPayments(toDecimal(40), 'GBP', reg, null), [], 'an unlisted ledger cannot show absence')
  assert.deepEqual(matchRemovedRegisteredPayments(toDecimal(40), 'GBP', [{ ledgerPaymentId: 'B', amount: null }], new Set()), [], 'an amount IMS cannot state names nothing')
  assert.deepEqual(matchRemovedRegisteredPayments(toDecimal(40), 'GBP', reg, new Set(['a', 'b'])), [])
})

test('paid state: a recorded removal means not fully paid, and the paid amount is reduced', () => {
  const paidAt = new Date('2026-08-01T00:00:00Z')
  assert.equal(isFullyPaid({ paidAt, paymentRemovedForeign: null }), true)
  assert.equal(isFullyPaid({ paidAt, paymentRemovedForeign: '0' }), true)
  assert.equal(isFullyPaid({ paidAt, paymentRemovedForeign: '40' }), false)
  assert.equal(isFullyPaid({ paidAt: null, paymentRemovedForeign: null }), false)
  assert.equal(hasPaymentRemoved({ paymentRemovedForeign: '0.01' }), true)
  assert.equal(paidAmountForeign({ paidAt, totalForeign: '100', paymentRemovedForeign: '40' }).toString(), '60')
  assert.equal(paidAmountForeign({ paidAt: null, totalForeign: '100', paymentRemovedForeign: '40' }).toString(), '0')
})

test('refund open balance: the receivable includes the removed part from when it was recorded', () => {
  const paidAt = new Date('2026-08-01T00:00:00Z')
  const removedAt = new Date('2026-09-01T00:00:00Z')
  const order = { totalBase: 100, totalForeign: 100, currency: 'GBP', paidAt, payments: [{ amount: 100, currency: 'GBP', paidAt, refundId: null }], paymentRemovedForeign: '40', paymentRemovedAt: removedAt }
  assert.equal(receivableBalance(order, new Date('2026-10-01T00:00:00Z')).balance, 40)
  assert.equal(receivableBalance(order, new Date('2026-08-15T00:00:00Z')).balance, 0, 'as of a date before the removal was recorded it is settled')
  assert.equal(receivableBalance({ ...order, paymentRemovedForeign: null }, new Date('2026-10-01T00:00:00Z')).balance, 0)
  // An order booked at 1.25 (foreign per base 0.8): the removed foreign amount comes off at the booked rate.
  const eur = { ...order, totalBase: 80, totalForeign: 100, currency: 'EUR', payments: [{ amount: 100, currency: 'EUR', paidAt, refundId: null }] }
  assert.equal(receivableBalance(eur, new Date('2026-10-01T00:00:00Z')).balance, 32)
})

test('dispatch gate: the warehouse create fence excludes an order with a recorded removal', () => {
  assert.equal(WMS_CREATE_ELIGIBLE_ORDER_FENCES.paymentRemovedForeign, null)
})
