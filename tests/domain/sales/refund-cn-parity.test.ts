import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideAmountGap,
  feeRepaymentHold,
  parityRefundBreakdown,
  REFUND_CN_PARITY_SETTING_KEY,
  storeCreditAttemptOf,
  storeCreditCreditNoteNumber,
  storeCreditHoldReason,
  type ParityRefundItem,
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

// ---------------------------------------------------------------------------------------------------------------------
// Rule 1: the EAS fee gap. 166122 / refund 166128: items 20.86 (EUR 3 duty among them), amount 17.86.
// ---------------------------------------------------------------------------------------------------------------------
test('166128 shape: items 20.86, amount 17.86, the 3.00 duty item marked and linked: credited at the ITEM total, the gap recorded', () => {
  const breakdown = parityRefundBreakdown([goods('-14.64', '-3.22'), fee('-3.00', '0')])
  assert.equal(breakdown.grossMinor, 2086)
  assert.equal(breakdown.feeGrossMinor, 300)
  const verdict = decideAmountGap({ refundId: 166128, amount: '17.86', breakdown, refundShipping: [], charged: null })
  assert.deepEqual(verdict, { kind: 'fee-gap', creditedGrossMinor: 2086, feeGapMinor: 300 })
})

test('173532 shape: 76.43 itemised, 73.43 paid, the fee with VAT of its own (fee VAT from 1 Nov) and shipping exactly as charged', () => {
  const breakdown = parityRefundBreakdown([goods('-50.00', '-11.50'), ship('-9.80', '-2.13'), fee('-2.44', '-0.56')])
  const verdict = decideAmountGap({ refundId: 173532, amount: '73.43', breakdown, refundShipping: [{ total: '-9.80', tax: '-2.13' }], charged: { net: '9.80', tax: '2.13' } })
  assert.deepEqual(verdict, { kind: 'fee-gap', creditedGrossMinor: 7643, feeGapMinor: 300 })
})

test('the fee gap is recognised ONLY on the exact signature: a cent off, no goods, a charge, an empty fee, an unlinked fee, an unmarked fee are not', () => {
  const amount = '17.86'
  const cases: Array<[string, ParityRefundItem[], string?]> = [
    ['a cent off', [goods('-14.64', '-3.22'), fee('-3.00', '0')], '17.85'],
    ['no goods refunded', [fee('-3.00', '0')], '0.00'],
    ['an item is a charge', [goods('-14.65', '-3.22'), goods('0.01', '0'), fee('-3.00', '0')]],
    ['the fee has no total of its own', [goods('-14.64', '-3.22'), fee('0', '-3.00')]],
    ['the fee names no original item', [goods('-14.64', '-3.22'), fee('-3.00', '0', { linked: false })]],
    ['the fee is not a landed-cost fee', [goods('-14.64', '-3.22'), fee('-3.00', '0', { marked: false })]],
  ]
  for (const [why, items, paid] of cases) {
    const verdict = decideAmountGap({ refundId: 1, amount: paid ?? amount, breakdown: parityRefundBreakdown(items), refundShipping: [], charged: null })
    assert.notEqual(verdict.kind, 'fee-gap', why)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Rule 3: the shipping fold. 177725: shipping 19.06 + 3.62 against 14.06 + 2.67 charged; fees 3.00 + 0.57 and 2.00 + 0.38; lines 102.18, paid 96.23.
// ---------------------------------------------------------------------------------------------------------------------
const FOLD_ITEMS = [goods('-61.29', '-12.26'), ship('-19.06', '-3.62'), fee('-3.00', '-0.57'), fee('-2.00', '-0.38')]
test('177725 shape: the excess on shipping equals the fees in net AND VAT, so shipping is restored to what was charged and the amount is expected', () => {
  const breakdown = parityRefundBreakdown(FOLD_ITEMS)
  assert.equal(breakdown.grossMinor, 10218)
  const verdict = decideAmountGap({ refundId: 177730, amount: '96.23', breakdown, refundShipping: [{ total: '-19.06', tax: '-3.62' }], charged: { net: '14.06', tax: '2.67' } })
  assert.deepEqual(verdict, { kind: 'fold', shippingNet: '14.06', shippingTax: '2.67', excessNet: '5.00', excessTax: '0.95' })
})

test('a fold that is close but not exact (the VAT excess a cent off) is HELD, naming both readings; never credited at the inflated total', () => {
  const items = [goods('-61.29', '-12.26'), ship('-19.06', '-3.61'), fee('-3.00', '-0.57'), fee('-2.00', '-0.38')]
  const verdict = decideAmountGap({ refundId: 177731, amount: '96.22', breakdown: parityRefundBreakdown(items), refundShipping: [{ total: '-19.06', tax: '-3.61', name: 'Tracked' }], charged: { net: '14.06', tax: '2.67' } })
  assert.equal(verdict.kind, 'hold')
  const message = verdict.kind === 'hold' ? verdict.message : ''
  assert.match(message, /lines total 102\.17 but 96\.22 was paid back/)
  assert.match(message, /"Tracked" refunded 19\.06 \+ 3\.61 VAT; the order charged 14\.06 \+ 2\.67 VAT/)
  assert.match(message, /do NOT issue another storefront refund/)
})

test('a fee-gap shape whose shipping IMS cannot compare (no stored charge, or two shipping lines) is held, not credited', () => {
  for (const [charged, shipping] of [
    [null, [{ total: '-14.06', tax: '-2.67' }]],
    [{ net: '14.06', tax: '2.67' }, [{ total: '-10.00', tax: '-2.00' }, { total: '-9.06', tax: '-1.62' }]],
  ] as const) {
    const items = [goods('-61.29', '-12.26'), ...shipping.map((line) => ship(line.total, line.tax)), fee('-3.00', '-0.57'), fee('-2.00', '-0.38')]
    const breakdown = parityRefundBreakdown(items)
    const paid = ((breakdown.grossMinor - breakdown.feeGrossMinor) / 100).toFixed(2)
    const verdict = decideAmountGap({ refundId: 1, amount: paid, breakdown, refundShipping: shipping, charged })
    assert.equal(verdict.kind, 'hold')
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Rule 2: the fee repayment. 166130: amount 3.00, line and shipping totals 0, tax 1.44 + 1.56.
// ---------------------------------------------------------------------------------------------------------------------
const REPAYMENT = parityRefundBreakdown([goods('0', '-1.44'), ship('0', '-1.56')])
test('166130 shape after a fee-gap credit: HELD with the instruction to apply the payment to that credit note', () => {
  const message = feeRepaymentHold({ refundId: 166130, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ creditNoteNumber: 'CN-00042', externalRefundId: 166128, carriedMarkedFee: true, easFeeGapForeign: '3.0000' }] })
  assert.ok(message)
  assert.match(message, /pays 3\.00 EUR, the landed-cost fee credit note CN-00042 \(WooCommerce refund 166128\) already credits/)
  assert.match(message, /apply this payment \(3\.00 EUR\) to that credit note in Xero/)
})

test('a repayment of a different amount, or after a refund that paid the fee within its amount, is held for a person; with no fee earlier it is not this', () => {
  const off = feeRepaymentHold({ refundId: 2, amount: '2.50', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ creditNoteNumber: 'CN-1', externalRefundId: 1, carriedMarkedFee: true, easFeeGapForeign: '3' }] })
  assert.match(off ?? '', /check by hand what it repays/)
  const second = feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ creditNoteNumber: 'CN-1', externalRefundId: 1, carriedMarkedFee: true, easFeeGapForeign: null }] })
  assert.match(second ?? '', /looks like a second payment/)
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [{ creditNoteNumber: 'CN-1', externalRefundId: 1, carriedMarkedFee: false, easFeeGapForeign: null }] }), null)
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: REPAYMENT, earlier: [] }), null)
})

test('a refund that refunds goods, or a fee, is never a fee repayment', () => {
  const earlier = [{ creditNoteNumber: 'CN-1', externalRefundId: 1, carriedMarkedFee: true, easFeeGapForeign: '3' }]
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: parityRefundBreakdown([goods('-2.50', '-0.50')]), earlier }), null)
  assert.equal(feeRepaymentHold({ refundId: 2, amount: '3.00', currency: 'EUR', breakdown: parityRefundBreakdown([fee('-3.00', '0')]), earlier }), null)
})

// ---------------------------------------------------------------------------------------------------------------------
// Rule 6: store credit (o3d-store-credit-refund 1.1.9).
// ---------------------------------------------------------------------------------------------------------------------
test('a store-credit refund is the plugin\'s attempt on a refund NOT paid through the gateway, numbered SC-<refund id>', () => {
  assert.equal(storeCreditAttemptOf({ meta_data: [{ key: '_o3d_scr_attempt', value: 'att-1' }], refunded_payment: false }), 'att-1')
  assert.equal(storeCreditAttemptOf({ meta_data: [{ key: '_o3d_scr_attempt', value: 'att-1' }], refunded_payment: true }), null, 'a gateway refund is never store credit')
  assert.equal(storeCreditAttemptOf({ meta_data: [{ key: '_o3d_scr_attempt', value: '  ' }], refunded_payment: false }), null)
  assert.equal(storeCreditAttemptOf({ meta_data: [], refunded_payment: false }), null)
  assert.equal(storeCreditCreditNoteNumber(172934), 'SC-172934')
})

test('no credit note while the store credit is not live: the plugin\'s Xero hold, or the order\'s unfinished record naming the attempt or the refund', () => {
  const base = { refundId: 177649, attempt: 'att-9', refundMeta: [] as Array<{ key: string; value: unknown }>, orderMeta: [] as Array<{ key: string; value: unknown }> }
  assert.equal(storeCreditHoldReason(base), null, 'live: nothing records it as unfinished')
  assert.match(storeCreditHoldReason({ ...base, refundMeta: [{ key: '_o3d_scr_xero_held', value: '1' }] }) ?? '', /still held for Xero/)
  assert.match(storeCreditHoldReason({ ...base, orderMeta: [{ key: '_o3d_scr_incomplete', value: { attempt: 'att-9', stage: 'refund-unresolved' } }] }) ?? '', /unfinished \(stage refund-unresolved\)/)
  assert.match(storeCreditHoldReason({ ...base, orderMeta: [{ key: '_o3d_scr_incomplete', value: { attempt: 'other', refund_id: 177649 } }] }) ?? '', /unfinished/)
  assert.equal(storeCreditHoldReason({ ...base, orderMeta: [{ key: '_o3d_scr_incomplete', value: { attempt: 'other', refund_id: 1 } }] }), null, 'another attempt\'s record does not hold this one')
})
