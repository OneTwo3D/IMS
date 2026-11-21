import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideAmountGap,
  earlierFeeOwedMinor,
  feeRepaymentHold,
  parityRefundBreakdown,
  REFUND_CN_PARITY_SETTING_KEY,
  storeCreditAttemptOf,
  storeCreditCreditNoteNumber,
  storeCreditVerdict,
  type ParityRefundItem,
  type ParityShippingLine,
} from '@/lib/domain/sales/refund-cn-parity'
import { SYSTEM_SWITCH_KEYS } from '@/lib/domain/settings/system-switches'

/**
 * o3d-k26m.17: the acceptance set of o3d-ioss-xero 0.2.4 (tests/run-tests.php, the fee-gap, fold and fee-repayment cases) and o3d-store-credit-refund 1.1.9,
 * restated on synthetic refunds whose FIGURES mirror the cited live orders (no customer data). Every figure is a WooCommerce refund item: credits negative.
 */
const goods = (total: string, tax: string): ParityRefundItem => ({ type: 'line', total, tax })
const ship = (total: string, tax: string): ParityRefundItem => ({ type: 'shipping', total, tax })
const fee = (total: string, tax: string, extra: Partial<ParityRefundItem> = {}): ParityRefundItem => ({ type: 'fee', total, tax, marked: true, linked: true, ...extra })

test('the switch is registered with the operator CLI under the key the reader asks for', () => {
  assert.equal(REFUND_CN_PARITY_SETTING_KEY, 'wc_refund_credit_note_parity_enabled')
  assert.ok(SYSTEM_SWITCH_KEYS.includes(REFUND_CN_PARITY_SETTING_KEY))
})

const charged = (total: string, tax: string, net: string, ctax: string, name?: string): ParityShippingLine => ({ total, tax, name, charged: { net, tax: ctax } })

// ---------------------------------------------------------------------------------------------------------------------
// Rule 1: the EAS fee gap. 166122 / refund 166128: items 20.86 (EUR 3 duty among them), amount 17.86.
// ---------------------------------------------------------------------------------------------------------------------
test('166128 shape: items 20.86, amount 17.86, the 3.00 duty item marked and linked: credited at the ITEM total, the gap recorded', () => {
  const breakdown = parityRefundBreakdown([goods('-14.64', '-3.22'), fee('-3.00', '0')])
  assert.equal(breakdown.grossMinor, 2086)
  assert.equal(breakdown.feeGrossMinor, 300)
  assert.deepEqual(decideAmountGap({ refundId: 166128, amount: '17.86', breakdown, refundShipping: [] }), { kind: 'fee-gap', creditedGrossMinor: 2086, feeGapMinor: 300 })
})

test('173532 shape: 76.43 itemised, 73.43 paid, the fee with VAT of its own (fee VAT from 1 Nov) and shipping exactly as its own original line charged', () => {
  const breakdown = parityRefundBreakdown([goods('-50.00', '-11.50'), ship('-9.80', '-2.13'), fee('-2.44', '-0.56')])
  const verdict = decideAmountGap({ refundId: 173532, amount: '73.43', breakdown, refundShipping: [charged('-9.80', '-2.13', '9.80', '2.13')] })
  assert.deepEqual(verdict, { kind: 'fee-gap', creditedGrossMinor: 7643, feeGapMinor: 300 })
})

test('the fee gap is recognised ONLY on the exact signature: every near miss is HELD with the reason, never credited at the item total', () => {
  const cases: Array<[string, ParityRefundItem[], string, RegExp]> = [
    ['a cent off', [goods('-14.64', '-3.22'), fee('-3.00', '0')], '17.85', /are more than was paid/],
    ['no goods refunded', [fee('-3.00', '0')], '0.00', /it paid nothing back; it refunds no goods/],
    ['an item is a charge', [goods('-14.65', '-3.22'), goods('0.01', '0'), fee('-3.00', '0')], '17.86', /an item on it is a charge/],
    ['the fee has no total of its own', [goods('-14.64', '-3.22'), fee('0', '-3.00')], '17.86', /has no amount of its own/],
    ['the fee names no original item', [goods('-14.64', '-3.22'), fee('-3.00', '0', { linked: false })], '17.86', /does not name the order fee/],
    ['a gateway fee beside it', [goods('-14.64', '-3.22'), fee('-3.00', '0'), { type: 'fee', total: '-0.50', tax: '0', name: 'Stripe fee' }], '17.86', /payment-gateway fee/],
  ]
  for (const [why, items, paid, reason] of cases) {
    const verdict = decideAmountGap({ refundId: 1, amount: paid, breakdown: parityRefundBreakdown(items), refundShipping: [] })
    assert.equal(verdict.kind, 'hold', why)
    assert.match(verdict.kind === 'hold' ? verdict.message : '', reason, why)
  }
  assert.equal(decideAmountGap({ refundId: 1, amount: '17.86', breakdown: parityRefundBreakdown([goods('-14.64', '-3.22'), fee('-3.00', '0', { marked: false })]), refundShipping: [] }).kind, 'not-recognised', 'an unmarked fee is no landed-cost fee: the ordinary mismatch')
})

test('gateway fees are left out of the breakdown, as the storefront plugin leaves them off its credit notes; amounts round half away from zero to the cent', () => {
  const breakdown = parityRefundBreakdown([goods('-10.00', '-2.00'), { type: 'fee', total: '-0.50', tax: '0', name: ' Stripe Fee ' }])
  assert.equal(breakdown.grossMinor, 1200)
  assert.equal(breakdown.gatewayFees, 1)
  assert.equal(parityRefundBreakdown([goods('-1.005', '0')]).grossMinor, 101, 'PHP round(): -1.005 -> -1.01')
  assert.equal(parityRefundBreakdown([goods('-0.125', '-0.125')]).grossMinor, 26)
})

// ---------------------------------------------------------------------------------------------------------------------
// Rule 3: the shipping fold. 177725: shipping 19.06 + 3.62 against 14.06 + 2.67 charged; fees 3.00 + 0.57 and 2.00 + 0.38; lines 102.18, paid 96.23.
// ---------------------------------------------------------------------------------------------------------------------
const FOLD_ITEMS = [goods('-61.29', '-12.26'), ship('-19.06', '-3.62'), fee('-3.00', '-0.57'), fee('-2.00', '-0.38')]
test('177725 shape: the excess on shipping over its own original equals the fees in net AND VAT, so it is restored and the amount is expected', () => {
  const breakdown = parityRefundBreakdown(FOLD_ITEMS)
  assert.equal(breakdown.grossMinor, 10218)
  const verdict = decideAmountGap({ refundId: 177730, amount: '96.23', breakdown, refundShipping: [charged('-19.06', '-3.62', '14.06', '2.67')] })
  assert.deepEqual(verdict, { kind: 'fold', restore: [{ index: 0, net: '14.06', tax: '2.67' }], excessNet: '5.00', excessTax: '0.95' })
})

test('the fold needs the lines LESS the fees to equal what was paid: an exact excess with any other amount is held, not folded', () => {
  const verdict = decideAmountGap({ refundId: 1, amount: '96.24', breakdown: parityRefundBreakdown(FOLD_ITEMS), refundShipping: [charged('-19.06', '-3.62', '14.06', '2.67')] })
  assert.equal(verdict.kind, 'hold')
})

test('a fold close but not exact (the VAT excess a cent off), or a shipping line with no original, is HELD naming both readings', () => {
  const items = [goods('-61.29', '-12.26'), ship('-19.06', '-3.61'), fee('-3.00', '-0.57'), fee('-2.00', '-0.38')]
  const near = decideAmountGap({ refundId: 177731, amount: '96.22', breakdown: parityRefundBreakdown(items), refundShipping: [charged('-19.06', '-3.61', '14.06', '2.67', 'Tracked')] })
  assert.equal(near.kind, 'hold')
  assert.match(near.kind === 'hold' ? near.message : '', /"Tracked" refunded 19\.06 \+ 3\.61 VAT, charged 14\.06 \+ 2\.67 VAT/)
  assert.match(near.kind === 'hold' ? near.message : '', /do NOT issue another storefront refund/)
  const unmapped = decideAmountGap({ refundId: 177731, amount: '96.23', breakdown: parityRefundBreakdown(FOLD_ITEMS), refundShipping: [{ total: '-19.06', tax: '-3.62', charged: null }] })
  assert.equal(unmapped.kind, 'hold')
  assert.match(unmapped.kind === 'hold' ? unmapped.message : '', /charged unknown \(no link to its order line\)/)
})

test('two shipping lines are each compared with their own original: the fee-gap allowance needs both as charged, a fold restores only the inflated one', () => {
  const asCharged = [charged('-5.00', '-1.00', '5.00', '1.00'), charged('-9.06', '-1.67', '9.06', '1.67')]
  const gap = parityRefundBreakdown([goods('-61.29', '-12.26'), ship('-5.00', '-1.00'), ship('-9.06', '-1.67'), fee('-3.00', '-0.57')])
  const paid = ((gap.grossMinor - gap.feeGrossMinor) / 100).toFixed(2)
  assert.equal(decideAmountGap({ refundId: 1, amount: paid, breakdown: gap, refundShipping: asCharged }).kind, 'fee-gap')
  const folded = parityRefundBreakdown([goods('-61.29', '-12.26'), ship('-5.00', '-1.00'), ship('-12.06', '-2.24'), fee('-3.00', '-0.57')])
  const foldPaid = ((folded.grossMinor - folded.feeGrossMinor) / 100).toFixed(2)
  assert.deepEqual(decideAmountGap({ refundId: 1, amount: foldPaid, breakdown: folded, refundShipping: [asCharged[0]!, charged('-12.06', '-2.24', '9.06', '1.67')] }), { kind: 'fold', restore: [{ index: 1, net: '9.06', tax: '1.67' }], excessNet: '3.00', excessTax: '0.57' })
})

// ---------------------------------------------------------------------------------------------------------------------
// Rule 2: the fee repayment. 166130: amount 3.00, line and shipping totals 0, tax 1.44 + 1.56.
// ---------------------------------------------------------------------------------------------------------------------
const REPAYMENT = parityRefundBreakdown([goods('0', '-1.44'), ship('0', '-1.56')])
test('166130 shape after a fee-gap refund: HELD with the instruction to apply the payment to that refund\'s credit note', () => {
  const owed = earlierFeeOwedMinor({ breakdown: parityRefundBreakdown([goods('-14.64', '-3.22'), fee('-3.00', '0')]), amount: '17.86', folded: false })
  assert.equal(owed, 300)
  const message = feeRepaymentHold({ refundId: 166130, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ label: 'WooCommerce refund 166128 (credit note CN-00042)', carriedMarkedFee: true, owedMinor: owed }] })
  assert.match(message ?? '', /pays 3\.00 EUR, the landed-cost fee that WooCommerce refund 166128 \(credit note CN-00042\) credits beyond what it paid/)
  assert.match(message ?? '', /apply this payment \(3\.00 EUR\) to that refund's credit note in Xero/)
})

test('an earlier refund that paid its fee within its amount (or folded it) owes nothing: a repayment after it is a suspected second payment', () => {
  assert.equal(earlierFeeOwedMinor({ breakdown: parityRefundBreakdown(FOLD_ITEMS), amount: '96.23', folded: true }), 0)
  assert.equal(earlierFeeOwedMinor({ breakdown: parityRefundBreakdown([goods('-14.64', '-3.22'), fee('-3.00', '0')]), amount: '20.86', folded: false }), 0)
  const second = feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ label: 'WooCommerce refund 1', carriedMarkedFee: true, owedMinor: 0 }] })
  assert.match(second ?? '', /looks like a second payment/)
  const off = feeRepaymentHold({ refundId: 2, amount: '2.50', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ label: 'WooCommerce refund 1', carriedMarkedFee: true, owedMinor: 300 }] })
  assert.match(off ?? '', /check by hand what it repays/)
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ label: 'x', carriedMarkedFee: false, owedMinor: 0 }] }), null)
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [] }), null)
})

test('a refund that refunds goods, or a fee, is never a fee repayment', () => {
  const earlier = [{ label: 'x', carriedMarkedFee: true, owedMinor: 300 }]
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: parityRefundBreakdown([goods('-2.50', '-0.50')]), earlier }), null)
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: parityRefundBreakdown([fee('-3.00', '0')]), earlier }), null)
})

// ---------------------------------------------------------------------------------------------------------------------
// Rule 6: store credit (o3d-store-credit-refund 1.1.9): live only on a published coupon carrying the attempt.
// ---------------------------------------------------------------------------------------------------------------------
test('a store-credit refund is the plugin\'s attempt on a refund NOT paid through the gateway, numbered SC-<refund id>', () => {
  assert.equal(storeCreditAttemptOf({ meta_data: [{ key: '_o3d_scr_attempt', value: 'att-1' }], refunded_payment: false }), 'att-1')
  assert.equal(storeCreditAttemptOf({ meta_data: [{ key: '_o3d_scr_attempt', value: 'att-1' }], refunded_payment: true }), null, 'a gateway refund is never store credit')
  assert.equal(storeCreditAttemptOf({ meta_data: [{ key: '_o3d_scr_attempt', value: '  ' }], refunded_payment: false }), null)
  assert.equal(storeCreditCreditNoteNumber(172934), 'SC-172934')
})

test('the store credit is live only on a PUBLISHED coupon for this attempt; the absence of the plugin\'s markers is never enough', () => {
  const t0 = new Date('2026-11-09T10:00:00Z')
  const base = { refundId: 177649, attempt: 'att-9', refundMeta: [], orderMeta: [], refundCreatedAt: t0, now: new Date('2026-11-09T11:00:00Z') }
  const c = (status: string, attempt = 'att-9') => ({ id: 7, status, meta_data: [{ key: '_o3d_scr_attempt', value: attempt }] })
  assert.deepEqual(storeCreditVerdict({ ...base, coupons: [c('publish')] }), { kind: 'live', couponId: 7 })
  assert.equal(storeCreditVerdict({ ...base, coupons: [] }).kind, 'quarantine', 'no markers and no coupon: discarded or never issued')
  assert.equal(storeCreditVerdict({ ...base, coupons: [c('publish', 'other')] }).kind, 'quarantine', 'another attempt\'s coupon proves nothing')
  assert.equal(storeCreditVerdict({ ...base, coupons: [c('draft')] }).kind, 'quarantine', 'a draft with no unfinished record is not in progress')
  assert.equal(storeCreditVerdict({ ...base, coupons: [c('draft')], orderMeta: [{ key: '_o3d_scr_incomplete', value: { attempt: 'att-9' } }] }).kind, 'wait')
  assert.equal(storeCreditVerdict({ ...base, coupons: [], refundMeta: [{ key: '_o3d_scr_xero_held', value: '1' }] }).kind, 'wait')
  assert.equal(storeCreditVerdict({ ...base, coupons: null }).kind, 'wait', 'coupons unreadable: retried')
  assert.equal(storeCreditVerdict({ ...base, coupons: null, now: new Date('2026-11-10T10:00:01Z') }).kind, 'quarantine', 'past 24 hours: a person')
  assert.equal(storeCreditVerdict({ ...base, coupons: [c('publish')], now: new Date('2026-12-01T00:00:00Z') }).kind, 'live', 'a live coupon is live whenever IMS sees it')
})
