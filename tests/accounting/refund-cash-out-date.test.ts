import assert from 'node:assert/strict'
import test from 'node:test'

import { toDecimal } from '@/lib/domain/math/decimal'
import {
  isRefundCashOutDateEnabled,
  refundCashOutDate,
  REFUND_CASH_OUT_DATE_SETTING_KEY,
  type CreditNoteSettlementPlan,
} from '@/lib/domain/accounting/credit-note-allocation'
import { findSwitch } from '@/lib/domain/settings/system-switches'
import { settlementAsOfFromStored } from '@/lib/accounting-fx'

/**
 * o3d-l9gej: a sales credit note's RECORDED refund payment is dated, and rated, on the day the cash went out (the refund Payment's paidAt), not the credit
 * note's day. Pure: no database, no network. The end-to-end proof (what IMS sends to Xero) is tests/concurrency/sales-cn-refund-cash-out-date.concurrent.test.ts.
 */

const recorded: CreditNoteSettlementPlan = { kind: 'REFUND_PAYMENT', cashEvidence: 'RECORDED', recordedAmount: toDecimal(40), cap: toDecimal(50) }
const gateway: CreditNoteSettlementPlan = { kind: 'REFUND_PAYMENT', cashEvidence: 'GATEWAY', recordedAmount: null, cap: toDecimal(50) }

test('[l9gej] a RECORDED refund payment is dated on its paidAt business day, a week after the credit note', () => {
  const paidAt = new Date('2026-11-09T00:00:00Z')
  assert.deepEqual(refundCashOutDate({ refundPaymentPaidAt: paidAt, refundPaymentPaidAtExplicitInstant: null }, recorded, '2026-11-02'), { date: '2026-11-09', paidAt, explicitInstant: null })
})

test('[l9gej] the business day is London\'s: 23:30 UTC on 9 July is 10 July, and the rate is read at that instant when it was an explicit instant', () => {
  const paidAt = new Date('2026-07-09T23:30:00Z')
  const got = refundCashOutDate({ refundPaymentPaidAt: paidAt, refundPaymentPaidAtExplicitInstant: paidAt }, recorded, '2026-07-01')
  assert.equal(got?.date, '2026-07-10')
  assert.equal(settlementAsOfFromStored(got!.paidAt, got!.explicitInstant).toISOString(), paidAt.toISOString())
})

test('[l9gej] a date-only paidAt (stored midnight) is rated as of the END of that day, so a rate fetched that morning counts', () => {
  const got = refundCashOutDate({ refundPaymentPaidAt: new Date('2026-11-09T00:00:00Z'), refundPaymentPaidAtExplicitInstant: null }, recorded, '2026-11-02')!
  assert.equal(settlementAsOfFromStored(got.paidAt, got.explicitInstant).toISOString(), '2026-11-09T23:59:59.999Z')
})

test('[l9gej] the credit note\'s date stands: a gateway refund, an allocation, no plan, no recorded date, an invalid date, a payment dated before the credit note', () => {
  const paidAt = new Date('2026-11-09T00:00:00Z')
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: paidAt }, gateway, '2026-11-02'), null)
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: paidAt }, { kind: 'ALLOCATE' }, '2026-11-02'), null)
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: paidAt }, null, '2026-11-02'), null)
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: null }, recorded, '2026-11-02'), null)
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: new Date('nope') }, recorded, '2026-11-02'), null)
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: new Date('2026-11-01T00:00:00Z') }, recorded, '2026-11-02'), null)
  // The same day is not "before".
  assert.equal(refundCashOutDate({ refundPaymentPaidAt: new Date('2026-11-02T00:00:00Z') }, recorded, '2026-11-02')?.date, '2026-11-02')
})

test('[l9gej] the switch is a registered boolean system switch, OFF by default, held equal to the literal in the registry; ON only for exactly "true"', async () => {
  assert.equal(REFUND_CASH_OUT_DATE_SETTING_KEY, 'xero_refund_payment_cash_out_date_enabled')
  const def = findSwitch(REFUND_CASH_OUT_DATE_SETTING_KEY)
  assert.ok(def)
  assert.equal(def!.kind, 'boolean')
  assert.equal(def!.defaultValue, 'false')
  for (const [value, on] of [[null, false], ['true', true], ['TRUE', false], ['1', false], ['false', false]] as const) {
    const client = { setting: { findUnique: async () => (value === null ? null : { value }) } }
    assert.equal(await isRefundCashOutDateEnabled(client as never), on, String(value))
  }
})
