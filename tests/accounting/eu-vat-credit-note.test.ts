import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { toDecimal } from '../../lib/domain/math/decimal'
import {
  applyEuVatCreditNoteTreatment, easRefundRefusal, EAS_REFUND_TAX_RATE_ID, noStampRefusal, refundTaxAndTotal, refundTaxOnEasRate,
  type CreditNoteLineKind, type EuVatCreditNotePlan,
} from '../../lib/domain/accounting/eu-vat-credit-note'
import { findSalesDocumentTaxTypeProblems } from '../../lib/domain/accounting/sales-document-tax-types'
import type { TreatablePayload } from '../../lib/domain/accounting/eu-vat-treatment'

/**
 * THE CREDIT-NOTE TREATMENT (pure): the regime and account come from the plan (the order's stamp, never decided here), every goods and shipping line is on the snapshotted zero-rated type at net, a refunded landed-cost fee is on the fee
 * account on NONE (only the fees the refund touches are present), ONE VAT line carries the refund's own tax on the stamped account on NONE, and the document totals the refund exactly. Nothing here reads a database or Xero.
 */
const D = (v: string | number) => toDecimal(v)
const CHARGED = 'DE_CHARGED'

function payload(over: Partial<TreatablePayload> = {}): TreatablePayload {
  return {
    currency: 'EUR',
    lines: [
      { description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: CHARGED, taxRateId: 'r1', taxRateBasis: 'sales_line' },
      { description: 'EU Customs Fee', quantity: 1, unitAmount: 20, accountCode: '200', taxType: CHARGED, taxRateId: 'r1', taxRateBasis: 'sales_line' },
      { description: 'Shipping refund', quantity: 1, unitAmount: 10, accountCode: '260', taxType: CHARGED },
    ],
    lineAmountsIncludeTax: false,
    ...over,
  }
}
function plan(over: Partial<EuVatCreditNotePlan> = {}): EuVatCreditNotePlan {
  const kinds: CreditNoteLineKind[] = ['goods', 'marked-fee', 'goods']
  return {
    regime: 'IOSS', vatAccount: '821', lineKinds: kinds, linePostingTypes: ['TAX131', 'TAX131', 'TAX131'], feeAccount: '232',
    vatAmount: '24.70', refundTotal: '154.70', vatDescription: 'IOSS VAT refunded', schemePostingTypeProblem: null, ...over,
  }
}

test('[credit note] a scheme refund: goods and shipping on the snapshotted zero-rated type, the refunded fee on 232 on NONE, ONE VAT line on the stamped account on NONE, total = refund', () => {
  const result = applyEuVatCreditNoteTreatment(payload(), plan())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const lines = result.payload.lines
  assert.deepEqual(lines.map((l) => [l.description, l.accountCode, l.taxType, l.noTaxKind ?? null]), [
    ['Widget', '200', 'TAX131', null],
    ['EU Customs Fee', '232', 'NONE', 'fee-no-tax'],
    ['Shipping refund', '260', 'TAX131', null],
    ['IOSS VAT refunded', '821', 'NONE', 'eu-vat-recovery'],
  ])
  assert.equal(lines.find((l) => l.noTaxKind === 'eu-vat-recovery')?.unitAmount, 24.7)
  assert.equal(lines.some((l) => 'taxRateId' in l), false, 'the rate binding is dropped from a re-typed line')
  assert.equal(lines.reduce((sum, l) => sum.plus(D(l.unitAmount).times(l.quantity)), D(0)).toString(), '154.7', 'total equals the refund')
  assert.deepEqual(findSalesDocumentTaxTypeProblems(result.payload), [], 'every NONE line names why')
  assert.equal(result.applied.feesRecoded, 1)
})

test('[credit note] a PARTIAL refund carries only the fees it touches: a refund of one of two fees has one fee line, and a refund of no fee has none', () => {
  const one = applyEuVatCreditNoteTreatment(
    { ...payload(), lines: [payload().lines[1]!] },
    plan({ lineKinds: ['marked-fee'], linePostingTypes: ['TAX131'], vatAmount: '3.80', refundTotal: '23.80' }),
  )
  assert.equal(one.ok, true)
  if (one.ok) assert.deepEqual(one.payload.lines.filter((l) => l.noTaxKind === 'fee-no-tax').map((l) => l.description), ['EU Customs Fee'])
  const none = applyEuVatCreditNoteTreatment(
    { ...payload(), lines: [payload().lines[0]!] },
    plan({ lineKinds: ['goods'], linePostingTypes: ['TAX131'], vatAmount: '19.00', refundTotal: '119.00' }),
  )
  assert.equal(none.ok, true)
  if (none.ok) assert.equal(none.payload.lines.some((l) => l.noTaxKind === 'fee-no-tax'), false)
})

test('[credit note] the total must equal the refund to the cent: one cent either way refuses, and there is no rounding line', () => {
  for (const total of ['154.71', '154.69']) {
    const result = applyEuVatCreditNoteTreatment(payload(), plan({ refundTotal: total }))
    assert.equal(result.ok, false, total)
    if (!result.ok) assert.match(result.reason, /must total the refund exactly/)
  }
  const exact = applyEuVatCreditNoteTreatment(payload(), plan())
  assert.equal(exact.ok && exact.payload.lines.some((l) => l.noTaxKind === 'rounding-difference'), false)
})

test('[credit note] a refund with no tax carries no VAT line; a negative tax or an unreadable figure refuses', () => {
  const zero = applyEuVatCreditNoteTreatment({ ...payload(), lines: [payload().lines[0]!] }, plan({ lineKinds: ['goods'], linePostingTypes: ['TAX131'], vatAmount: '0', refundTotal: '100' }))
  assert.equal(zero.ok && zero.applied.vatLine, false)
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ vatAmount: '-1' })).ok, false)
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ vatAmount: 'x' })).ok, false)
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ refundTotal: '' })).ok, false)
})

test('[credit note] fails closed: a missing or mixed posting type, an unproven type, a missing fee account, a tax-inclusive note, a stray line on the VAT account, misaligned lines', () => {
  const missing = applyEuVatCreditNoteTreatment(payload(), plan({ linePostingTypes: ['TAX131', null, 'TAX131'] }))
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.reason, /has no scheme posting type snapshot/)
  const mixed = applyEuVatCreditNoteTreatment(payload(), plan({ linePostingTypes: ['TAX131', 'TAX131', 'TAX999'] }))
  assert.equal(mixed.ok, false)
  if (!mixed.ok) assert.match(mixed.reason, /more than one scheme posting type/)
  const unproven = applyEuVatCreditNoteTreatment(payload(), plan({ schemePostingTypeProblem: 'the scheme posting type TAX131 is 19% in Xero, not zero-rated' }))
  assert.equal(unproven.ok, false)
  if (!unproven.ok) assert.match(unproven.reason, /not zero-rated/)
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ feeAccount: null })).ok, false)
  assert.equal(applyEuVatCreditNoteTreatment(payload({ lineAmountsIncludeTax: true }), plan()).ok, false)
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ vatAccount: '260' })).ok, false, 'shipping already sits on 260')
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ lineKinds: ['goods'] })).ok, false)
  assert.equal(applyEuVatCreditNoteTreatment({ ...payload(), lines: [] }, plan({ lineKinds: [], linePostingTypes: [] })).ok, false)
})

test('[credit note] DDP: the fee account is the VAT account (232), so the fee line sits beside the one VAT line', () => {
  const result = applyEuVatCreditNoteTreatment(payload(), plan({ regime: 'DDP', vatAccount: '232', vatDescription: 'DDP import VAT refunded' }))
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.payload.lines.filter((l) => l.accountCode === '232').length, 2)
})

test('[credit note] the VAT line and total come from the refund: a stated gross gives the tax, and a figure far from the lines\' own rates is not posted', () => {
  const ok = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), statedGross: D('154.70'), currency: 'EUR', toleranceMinorUnits: 4 })
  assert.deepEqual(ok, { ok: true, vatAmount: '24.7', refundTotal: '154.7' })
  const rounding = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), statedGross: D('154.71'), currency: 'EUR', toleranceMinorUnits: 4 })
  assert.equal(rounding.ok && rounding.vatAmount, '24.71')
  const far = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), statedGross: D('157'), currency: 'EUR', toleranceMinorUnits: 4 })
  assert.equal(far.ok, false)
  if (!far.ok) assert.match(far.reason, /more than rounding explains/)
  assert.equal(refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), statedGross: D('120'), currency: 'EUR', toleranceMinorUnits: 4 }).ok, false)
  const manual = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.7'), statedGross: null, currency: 'EUR', toleranceMinorUnits: 4 })
  assert.deepEqual(manual, { ok: true, vatAmount: '24.7', refundTotal: '154.7' })
})

test('[credit note] rate 182: refund tax carried on it is detected on items, shipping and fees (an unreadable 182 figure counts), and others are ignored', () => {
  assert.equal(EAS_REFUND_TAX_RATE_ID, 182)
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 244, total: '-5.00' }] }] }), null)
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 182, total: '0.00' }] }] }), null, 'zero tax on 182 is nothing carried')
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 182, total: '-3.10' }, { id: 244, total: '-1' }] }], shipping_lines: [{ taxes: [{ id: 182, total: '-0.90' }] }] }), '4')
  assert.equal(refundTaxOnEasRate({ fee_lines: [{ taxes: [{ id: 182, total: '-1.00' }] }] }), '1')
  assert.notEqual(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 182, total: 'abc' }] }] }), null)
  assert.equal(refundTaxOnEasRate({}), null)
})

test('[credit note] operator wording: each refusal names what happened, that nothing was sent, and what to do', () => {
  assert.match(easRefundRefusal(77, '4'), /rate 182.*Nothing was sent to Xero.*record it manually/s)
  assert.match(noStampRefusal('CN-1'), /NOTHING WAS QUEUED\. Credit note CN-1.*no recorded VAT regime.*stays marked for accounting retry.*post the credit note by hand in Xero on the same VAT account/s)
})

test('[credit note] this module reads no database and no clock (pure)', () => {
  const src = readFileSync('lib/domain/accounting/eu-vat-credit-note.ts', 'utf8')
  assert.doesNotMatch(src, /from '@\/lib\/db'|new Date\(|Date\.now\(|prisma/i)
})
