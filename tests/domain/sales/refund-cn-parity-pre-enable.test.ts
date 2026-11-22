import assert from 'node:assert/strict'
import test from 'node:test'
import { toDecimal } from '@/lib/domain/math/decimal'
import {
  decideAmountGap,
  feeRepaymentInstruction,
  isFeeRepaymentOpen,
  isRefundParityHold,
  parityRefundBreakdown,
  SETTLED_OUTSIDE_IMS_NOTE_PREFIX,
  settledOutsideImsNote,
  storeCreditUndatedVerdict,
  vatOnlyRefundHold,
} from '@/lib/domain/sales/refund-cn-parity'
import { isEarlierRefund, needsOrderFeeMarkers, parityItemsOf } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'

/**
 * o3d-pnc8p (refund credit-note parity before wc_refund_credit_note_parity_enabled is turned on), the pure parts, ON THE LIVE FIGURES:
 *   177725: goods 61.81 + 11.74 (DE 19%), shipping charged 14.06 + 2.67, fees 3.00 + 0.57 and 2.00 + 0.38; VAT 15.36 on 821; total 96.23.
 *   166128: goods 6.84 + 1.44, shipping 7.92 + 1.66, fee 3.00 (no VAT); items 20.86, amount 17.86.
 */

test('[pnc8p L8] 177725 LIVE: EAS folded the fees into shipping (19.06 + 3.62 refunded against 14.06 + 2.67 charged): a fold, credited at 96.23 with VAT 15.36, never 102.18', async () => {
  const breakdown = parityRefundBreakdown([
    { type: 'line', total: '-61.81', tax: '-11.74' },
    { type: 'shipping', total: '-19.06', tax: '-3.62' },
    { type: 'fee', total: '-3.00', tax: '-0.57', name: 'EU Import Duty', marked: true, linked: true },
    { type: 'fee', total: '-2.00', tax: '-0.38', name: 'EU Handling Fee', marked: true, linked: true },
  ])
  assert.equal(breakdown.grossMinor, 10218, 'the lines total 102.18')
  const verdict = decideAmountGap({ refundId: 177730, amount: '96.23', breakdown, refundShipping: [{ total: '-19.06', tax: '-3.62', name: 'Tracked', charged: { net: '14.06', tax: '2.67' } }] })
  assert.deepEqual(verdict, { kind: 'fold', restore: [{ index: 0, net: '14.06', tax: '2.67' }], excessNet: '5.00', excessTax: '0.95' })
  // The credit note: goods 61.81, shipping 14.06, fees 3.00 + 2.00 net; the one VAT line is the order's 15.36 (off 821), the total what was paid.
  const { eas182RefundFigures } = await import('@/lib/domain/accounting/eu-vat-credit-note')
  const figures = eas182RefundFigures({ net: toDecimal('80.87'), statedGross: toDecimal('96.23'), statedTax: toDecimal('16.31').sub(toDecimal('0.95')), orderTax: toDecimal('15.36'), priorRefundedTax: toDecimal(0), currency: 'EUR', toleranceMinorUnits: 2, orderAllowanceMinorUnits: 2 })
  assert.deepEqual(figures, { ok: true, vatAmount: '15.36', refundTotal: '96.23' })
})

test('[pnc8p L8] 166128 LIVE: items 20.86 (goods 6.84 + 1.44, shipping 7.92 + 1.66 as charged, the 3.00 duty with no VAT), amount 17.86: the fee gap, credited at 20.86 with 3.00 open', () => {
  const breakdown = parityRefundBreakdown([
    { type: 'line', total: '-6.84', tax: '-1.44' },
    { type: 'shipping', total: '-7.92', tax: '-1.66' },
    { type: 'fee', total: '-3.00', tax: '0', name: 'EU Import Duty', marked: true, linked: true },
  ])
  assert.equal(breakdown.grossMinor, 2086)
  assert.equal(breakdown.feeGrossMinor, 300)
  assert.deepEqual(
    decideAmountGap({ refundId: 166128, amount: '17.86', breakdown, refundShipping: [{ total: '-7.92', tax: '-1.66', charged: { net: '7.92', tax: '1.66' } }] }),
    { kind: 'fee-gap', creditedGrossMinor: 2086, feeGapMinor: 300 },
  )
  // Shipping NOT as charged on the live shape is held, never credited at the item total.
  assert.equal(decideAmountGap({ refundId: 166128, amount: '17.86', breakdown, refundShipping: [{ total: '-7.92', tax: '-1.66', charged: { net: '6.92', tax: '1.45' } }] }).kind, 'hold')
})

const refund = (over: Partial<WcRefund>): WcRefund => ({ id: 1, date_created: '', date_created_gmt: '2026-11-10T10:00:00', amount: '0', reason: '', refunded_by: 1, refunded_payment: true, meta_data: [], line_items: [], ...over })

test('[pnc8p MED-5] a historic fee: neither the refund item nor the IMS line marks it, the ORIGINAL order item does (`_wclc_fee` in the order\'s fee_lines meta), as the plugin judges it', () => {
  const r = refund({ fee_lines: [{ id: 920, name: 'EU Import Duty', total: '-3.00', total_tax: '0', meta_data: [{ id: 1, key: '_refunded_item_id', value: '9001' }] }] })
  const historicLine = [{ id: 'duty-1', wclcFeeKind: null }]
  const before = parityItemsOf(r, historicLine, ['duty-1'])
  assert.equal(before[0]!.marked, false, 'without the order the fee is unmarked (migration 20261029200000 never backfilled wclcFeeKind)')
  assert.equal(needsOrderFeeMarkers(before), true, 'so the order is read')
  const order = { meta_data: [], shipping_lines: [], fee_lines: [{ id: 9001, meta_data: [{ id: 2, key: '_wclc_fee', value: 'yes' }] }, { id: 9002, meta_data: [] }] }
  const after = parityItemsOf(r, historicLine, ['duty-1'], order)
  assert.equal(after[0]!.marked, true)
  assert.equal(needsOrderFeeMarkers(after), false)
  // An order fee WITHOUT the marker stays unmarked; an unlinked refund fee never asks the order.
  assert.equal(parityItemsOf(refund({ fee_lines: [{ id: 921, name: 'Gift wrap', total: '-1.00', total_tax: '0', meta_data: [{ id: 1, key: '_refunded_item_id', value: '9002' }] }] }), historicLine, [null], order)[0]!.marked, false)
  assert.equal(needsOrderFeeMarkers(parityItemsOf(refund({ fee_lines: [{ id: 922, name: 'Duty', total: '-1.00', total_tax: '0', meta_data: [] }] }), historicLine, [null])), false)
})

test('[pnc8p L1] isEarlierRefund: by date_created_gmt, then id; by id alone when a date cannot be read', () => {
  const at = (id: number, gmt: string) => ({ id, date_created_gmt: gmt })
  assert.equal(isEarlierRefund(at(166128, '2026-11-10T10:00:00'), at(166130, '2026-11-12T10:00:00')), true)
  assert.equal(isEarlierRefund(at(166140, '2026-11-14T10:00:00'), at(166130, '2026-11-12T10:00:00')), false, 'a later refund is not earlier, whatever the store\'s list order')
  assert.equal(isEarlierRefund(at(5, '2026-11-12T10:00:00'), at(6, '2026-11-12T10:00:00')), true, 'same second: by id')
  assert.equal(isEarlierRefund(at(7, ''), at(6, '2026-11-12T10:00:00')), false, 'no date: by id')
})

test('[pnc8p IOSS cases 3/4] a VAT-only refund is held with both outcomes named (zero credit note on an ex-VAT invoice; reverse out of 821 on an IOSS order), never Record manually', () => {
  const message = vatOnlyRefundHold({ refundId: 159049, amount: '29.67', currency: 'EUR' })
  assert.match(message, /pays 29\.67 EUR back but its lines carry no net amount/)
  assert.match(message, /the right credit note is zero/)
  assert.match(message, /821/)
  assert.equal(isRefundParityHold(message), true, 'Record manually is refused for it; the settled-outside acknowledgement closes it')
})

test('[pnc8p L4] a store-credit refund with no creation time is quarantined saying so, not blamed on the coupons', () => {
  const verdict = storeCreditUndatedVerdict(177649, 'att-9')
  assert.equal(verdict.kind, 'quarantine')
  assert.match((verdict as { message: string }).message, /no creation time for it \(date_created_gmt\)/)
  assert.equal(isRefundParityHold((verdict as { message: string }).message), true)
})

test('[pnc8p case 8] an OPEN FEE REPAYMENT is its own record: open while the gap stands and no "repayment applied" was recorded; a deleted refund is not open', () => {
  assert.equal(isFeeRepaymentOpen({ easFeeGapForeign: '3.00', feeRepaymentAppliedAt: null }), true)
  assert.equal(isFeeRepaymentOpen({ easFeeGapForeign: '3.00', feeRepaymentAppliedAt: new Date() }), false)
  assert.equal(isFeeRepaymentOpen({ easFeeGapForeign: null, feeRepaymentAppliedAt: null }), false)
  assert.equal(isFeeRepaymentOpen({ easFeeGapForeign: '0', feeRepaymentAppliedAt: null }), false)
  assert.equal(isFeeRepaymentOpen({ easFeeGapForeign: '3.00', feeRepaymentAppliedAt: null, deletedAt: new Date() }), false)
  assert.match(feeRepaymentInstruction({ externalRefundId: 166128, creditNoteNumber: 'CN-00042', gapForeign: '3', storefrontAmountForeign: '17.86', currency: 'EUR' }), /refund 166128: credit note CN-00042 credits the landed-cost fee 3\.00 EUR that EAS left out of the refund amount 17\.86 - apply the fee repayment to it in Xero/)
})

test('[pnc8p] the settled-outside note names who, why and the hold it closed, under the prefix the refund sync recognises', () => {
  const note = settledOutsideImsNote({ by: 'Jan', reason: ' CN-11629 raised in Xero by the accountant ', hold: 'the hold' })
  assert.ok(note.startsWith(SETTLED_OUTSIDE_IMS_NOTE_PREFIX))
  assert.match(note, /Jan: CN-11629 raised in Xero by the accountant\. Nothing was created in IMS or sent to Xero\. The hold it closed: the hold/)
  assert.equal(isRefundParityHold(note.replace('the hold', 'x')), false, 'a closed park is no longer a hold')
})
