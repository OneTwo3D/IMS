import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { roundMoney, toDecimal } from '../../lib/domain/math/decimal'
import {
  applyEuVatCreditNoteTreatment, easRefundRefusal, refusedCreditNoteError, refusedCreditNotePayload, EAS_REFUND_TAX_RATE_ID, noStampRefusal, refundTaxAndTotal, refundTaxOnEasRate, refundStatedTax, eas182RefundFigures, refund182HeldRefusal,
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
  const ok = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), rawGross: D('154.70'), statedGross: D('154.70'), currency: 'EUR', toleranceMinorUnits: 4 })
  assert.deepEqual(ok, { ok: true, vatAmount: '24.7', refundTotal: '154.7' })
  const rounding = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), rawGross: D('154.70'), statedGross: D('154.71'), currency: 'EUR', toleranceMinorUnits: 4 })
  assert.equal(rounding.ok && rounding.vatAmount, '24.71')
  const far = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), rawGross: D('154.70'), statedGross: D('157'), currency: 'EUR', toleranceMinorUnits: 4 })
  assert.equal(far.ok, false)
  if (!far.ok) assert.match(far.reason, /more than rounding explains/)
  assert.equal(refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), rawGross: D('154.70'), statedGross: D('120'), currency: 'EUR', toleranceMinorUnits: 4 }).ok, false)
  const manual = refundTaxAndTotal({ net: D('130'), pricedTax: D('24.7'), rawGross: D('154.7'), statedGross: null, currency: 'EUR', toleranceMinorUnits: 4 })
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
  assert.match(easRefundRefusal(77, '4'), /rate 182[\s\S]*Nothing was sent to Xero[\s\S]*record it manually/)
  assert.match(noStampRefusal('CN-1'), /NOTHING WAS SENT\. Credit note CN-1[\s\S]*no recorded VAT regime[\s\S]*This row is refused and is never sent\. Check Xero for credit note CN-1 first[\s\S]*post the credit note by hand in Xero on the same VAT account[\s\S]*settle action on \/sync/)
})

test('[credit note] this module reads no database and no clock (pure)', () => {
  const src = readFileSync('lib/domain/accounting/eu-vat-credit-note.ts', 'utf8')
  assert.doesNotMatch(src, /from '@\/lib\/db'|new Date\(|Date\.now\(|prisma/i)
})

test('[credit note] rounding boundaries (table): the credit note totals the refund\'s own gross to the cent, whatever the per-line rounding; EUR 0.03 at 20% is 0.03, never 0.04', () => {
  const rows: Array<{ rawNet: string; rate: string; stated: string | null; total: string; vat: string }> = [
    { rawNet: '0.025', rate: '0.2', stated: null, total: '0.03', vat: '0' },
    { rawNet: '0.025', rate: '0.2', stated: '0.03', total: '0.03', vat: '0' },
    { rawNet: '0.05', rate: '0.2', stated: '0.06', total: '0.06', vat: '0.01' },
    { rawNet: '33.333', rate: '0.19', stated: null, total: '39.67', vat: '6.34' },
    { rawNet: '33.333', rate: '0.19', stated: '39.67', total: '39.67', vat: '6.34' },
    { rawNet: '10.005', rate: '0.19', stated: null, total: '11.91', vat: '1.9' },
    { rawNet: '100', rate: '0.19', stated: '119.00', total: '119', vat: '19' },
  ]
  for (const row of rows) {
    const raw = D(row.rawNet)
    const net = roundMoney(raw, 'EUR')
    const figures = refundTaxAndTotal({ net, pricedTax: raw.times(row.rate), rawGross: raw.times(D(1).plus(row.rate)), statedGross: row.stated === null ? null : D(row.stated), currency: 'EUR', toleranceMinorUnits: 2 })
    assert.equal(figures.ok, true, JSON.stringify(row))
    if (!figures.ok) continue
    assert.deepEqual([figures.refundTotal, figures.vatAmount], [row.total, row.vat], JSON.stringify(row))
    // The finished document: the line at its rounded net plus the VAT line is exactly the total.
    const result = applyEuVatCreditNoteTreatment(
      { currency: 'EUR', lines: [{ description: 'W', quantity: 1, unitAmount: raw.toNumber(), accountCode: '200', taxType: CHARGED }], lineAmountsIncludeTax: false },
      plan({ lineKinds: ['goods'], linePostingTypes: ['TAX131'], vatAmount: figures.vatAmount, refundTotal: figures.refundTotal }),
    )
    assert.equal(result.ok, true, JSON.stringify(row))
  }
})

// MUTATION-DRIVEN CASES: each pins one decision of the builder that no other case reaches.
test('[credit note] the builder: alignment, blanks, trims and the exact shape of each line it writes', () => {
  const refused = (pl: TreatablePayload, pn: EuVatCreditNotePlan, pattern: RegExp) => { const r = applyEuVatCreditNoteTreatment(pl, pn); assert.equal(r.ok, false); if (!r.ok) assert.match(r.reason, pattern) }
  // Each aligned list is checked on its own.
  refused(payload(), plan({ lineKinds: ['goods', 'goods'] }), /do not line up/)
  refused(payload(), plan({ linePostingTypes: ['TAX131', 'TAX131'] }), /do not line up/)
  refused(payload({ lines: [] }), plan({ lineKinds: [], linePostingTypes: [], vatAmount: '0', refundTotal: '0' }), /no lines/)
  // A blank VAT account is refused, even if only spaces.
  refused(payload(), plan({ vatAccount: '  ' }), /names no account/)
  // The posting type is trimmed; a padded and a plain copy are ONE type.
  const padded = applyEuVatCreditNoteTreatment(payload(), plan({ linePostingTypes: [' TAX131 ', 'TAX131', ' TAX131'] }))
  assert.equal(padded.ok, true)
  if (padded.ok) { assert.deepEqual(padded.payload.lines.filter((l) => l.noTaxKind === undefined).map((l) => l.taxType), ['TAX131', 'TAX131']); assert.equal(padded.applied.schemePostingTaxType, 'TAX131'); assert.equal(padded.applied.regime, 'IOSS') }
  // No fee on the refund: no fee account is needed.
  const noFee = applyEuVatCreditNoteTreatment(payload({ lines: [payload().lines[0]!, payload().lines[2]!] }), plan({ lineKinds: ['goods', 'goods'], linePostingTypes: ['TAX131', 'TAX131'], feeAccount: null, vatAmount: '22.00', refundTotal: '132.00' }))
  assert.equal(noFee.ok, true)
  if (noFee.ok) assert.equal(noFee.applied.feesRecoded, 0)
  // The fee line: padded account trimmed, marked as a fee, binding dropped; the VAT line account trimmed too; no line keeps a binding.
  const shaped = applyEuVatCreditNoteTreatment(payload(), plan({ feeAccount: ' 232 ', vatAccount: ' 821 ' }))
  assert.equal(shaped.ok, true)
  if (shaped.ok) {
    const fee = shaped.payload.lines.find((l) => l.noTaxKind === 'fee-no-tax')!
    assert.equal(fee.accountCode, '232'); assert.equal((fee as { euFeeMarked?: boolean }).euFeeMarked, true)
    assert.equal(shaped.payload.lines.find((l) => l.noTaxKind === 'eu-vat-recovery')!.accountCode, '821')
    for (const l of shaped.payload.lines) { assert.equal('taxRateId' in l, false); assert.equal('taxRateBasis' in l, false) }
  }
  // Tax: negative refused, unrounded figure rounded onto the line, a padded VAT-account line already present refused.
  refused(payload(), plan({ vatAmount: '-1' }), /negative/)
  const rounded = applyEuVatCreditNoteTreatment(payload(), plan({ vatAmount: '24.704' }))
  assert.equal(rounded.ok, true)
  if (rounded.ok) assert.equal(rounded.payload.lines.find((l) => l.noTaxKind === 'eu-vat-recovery')!.unitAmount, 24.7)
  refused(payload({ lines: [{ ...payload().lines[0]!, accountCode: ' 821 ' }, payload().lines[1]!, payload().lines[2]!] }), plan(), /already posted to the VAT account/)
  // The refund total: unreadable refused (not thrown), a line amount that cannot be read refused (not thrown), the target rounded before comparing.
  refused(payload(), plan({ refundTotal: 'abc' }), /refund amount cannot be read/)
  refused(payload({ lines: [{ ...payload().lines[0]!, unitAmount: Number.NaN }, payload().lines[1]!, payload().lines[2]!] }), plan(), /line amount cannot be read/)
  assert.equal(applyEuVatCreditNoteTreatment(payload(), plan({ refundTotal: '154.704' })).ok, true)
})

test('[credit note] the refund figures at their boundaries: negative tax, rounding of the stated gross, the tolerance edge, its floor and its sign, and a currency with no minor unit', () => {
  const f = (over: Partial<Parameters<typeof refundTaxAndTotal>[0]>) => refundTaxAndTotal({ net: D('130'), pricedTax: D('24.70'), rawGross: D('154.70'), statedGross: D('154.70'), currency: 'EUR', toleranceMinorUnits: 4, ...over })
  // No stated gross: a recorded total below the lines' net refuses.
  assert.equal(f({ statedGross: null, rawGross: D('100') }).ok, false)
  // A stated gross is rounded before it is used.
  assert.deepEqual(f({ statedGross: D('154.704') }), { ok: true, vatAmount: '24.7', refundTotal: '154.7' })
  // A stated gross below the net refuses, even where the lines' own rate gives no tax (so the tolerance alone would accept it).
  assert.equal(f({ pricedTax: D('0'), statedGross: D('129.99') }).ok, false)
  // The tolerance: exactly 4 minor units is accepted, 5 is not; a tolerance of 0 still allows 1; the difference is judged in either direction.
  assert.equal(f({ statedGross: D('154.74') }).ok, true)
  assert.equal(f({ statedGross: D('154.75') }).ok, false)
  assert.equal(f({ statedGross: D('154.71'), toleranceMinorUnits: 0 }).ok, true)
  assert.equal(f({ statedGross: D('154.72'), toleranceMinorUnits: 0 }).ok, false)
  assert.equal(f({ statedGross: D('154.20') }).ok, false, 'tax below the lines\' own: refused')
  // A currency with no minor unit: the tolerance is whole units.
  assert.equal(f({ currency: 'JPY', net: D('1000'), pricedTax: D('200'), rawGross: D('1200'), statedGross: D('1201'), toleranceMinorUnits: 1 }).ok, true)
  assert.equal(f({ currency: 'JPY', net: D('1000'), pricedTax: D('200'), rawGross: D('1200'), statedGross: D('1202'), toleranceMinorUnits: 1 }).ok, false)
})

test('[credit note] the refused-row record carries the credit note\'s identity, and a marker with no usable reason still refuses', () => {
  const rec = refusedCreditNotePayload({ creditNoteNumber: 'CN-9', currency: 'EUR', reference: 'REF', date: '2026-11-13', refundId: 'r1', orderId: 'o1', lines: [{ quantity: 2, unitAmount: 5 }], reason: 'why' })
  assert.deepEqual(rec, { creditNoteNumber: 'CN-9', currency: 'EUR', reference: 'REF', date: '2026-11-13', lines: [], _euVatCreditNoteRefused: { reason: 'why', refundId: 'r1', orderId: 'o1', netAmount: '10' } })
  assert.equal(refusedCreditNoteError(rec), 'why')
  assert.match(refusedCreditNoteError({ _euVatCreditNoteRefused: { reason: '' } }) ?? '', /refused when it was built and is never sent/)
  assert.match(refusedCreditNoteError({ _euVatCreditNoteRefused: { reason: 5 } }) ?? '', /refused when it was built and is never sent/)
  assert.match(refusedCreditNoteError({ _euVatCreditNoteRefused: {} }) ?? '', /never sent/)
  assert.equal(refusedCreditNoteError({}), null)
})

test('[credit note] rate 182 figures: an unreadable one counts as 1, a number is read, a padded string is trimmed, an item with no taxes is skipped', () => {
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 182, total: 'abc' }] }] }), '1')
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 182, total: -3.1 }] }] }), '3.1')
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: [{ id: 182, total: ' -3.10 ' }] }] }), '3.1')
  assert.equal(refundTaxOnEasRate({ line_items: [{ taxes: null }, { }], shipping_lines: [{ taxes: [{ id: 182, total: '-1' }] }] }), '1')
})

// ---- rate 182: post-and-hold (the figures and the wording; the hold itself is tested against a real database in tests/concurrency/refund-eas182-hold.concurrent.test.ts) ----
test('[credit note 182] the stated tax sums ALL rate ids (182 included) on items, shipping and fees, and an unreadable figure is flagged, not summed', () => {
  assert.deepEqual(refundStatedTax({ line_items: [{ taxes: [{ id: 182, total: '-3.10' }, { id: 244, total: '-1.00' }] }], shipping_lines: [{ taxes: [{ id: 182, total: -0.9 }] }], fee_lines: [{ taxes: [{ id: 5, total: ' -0.5 ' }] }] }), { total: '5.5', unreadable: false })
  assert.deepEqual(refundStatedTax({}), { total: '0', unreadable: false })
  assert.equal(refundStatedTax({ line_items: [{ taxes: [{ id: 182, total: 'abc' }] }] }).unreadable, true)
  assert.equal(refundStatedTax({ line_items: [{ taxes: [{ id: 182 }] }] }).unreadable, true, 'a missing figure is unreadable')
})

const figures182 = (over: Partial<Parameters<typeof eas182RefundFigures>[0]> = {}) => eas182RefundFigures({ net: D('100'), statedGross: D('119'), statedTax: D('19'), orderTax: D('25.46'), priorRefundedTax: D('0'), currency: 'GBP', toleranceMinorUnits: 2, orderAllowanceMinorUnits: 3, ...over })

test('[credit note 182] figures: the VAT is gross less net, confirmed against the stated tax and held to the order\'s VAT not already refunded', () => {
  assert.deepEqual(figures182(), { ok: true, vatAmount: '19', refundTotal: '119' })
  // The EAS plugin re-priced the tax: the lines' own rate (19%) is NOT consulted, only the stated figures.
  assert.deepEqual(figures182({ statedGross: D('125'), statedTax: D('25') }), { ok: true, vatAmount: '25', refundTotal: '125' })
  // Within the rounding allowance of the stated tax (2 minor units): accepted. Beyond: refused.
  assert.equal(figures182({ statedTax: D('19.02') }).ok, true)
  const total = figures182({ statedTax: D('19.03') })
  assert.equal(total.ok, false)
  assert.match(!total.ok ? total.reason : '', /tax it states across its tax rates is 19.03; that is more than rounding explains/)
  // Gross below net.
  assert.equal(figures182({ statedGross: D('99') }).ok, false)
})

test('[credit note 182] bound: on the AGGREGATE with one fixed order allowance; nothing positive once the VAT is all refunded', () => {
  assert.equal(figures182({ statedGross: D('125.46'), statedTax: D('25.46') }).ok, true, 'all of the order\'s VAT')
  assert.equal(figures182({ priorRefundedTax: D('6.46') }).ok, true, '19.00 left, 19 asked')
  assert.equal(figures182({ priorRefundedTax: D('6.48') }).ok, true, 'within the order\'s 3-minor-unit allowance')
  const over = figures182({ priorRefundedTax: D('6.50') })
  assert.equal(over.ok, false)
  assert.match(!over.ok ? over.reason : '', /more than the order's collected VAT not already refunded \(18.96 GBP of 25.46\)/)
  const spent = figures182({ priorRefundedTax: D('30') })
  assert.match(!spent.ok ? spent.reason : '', /\(0 GBP\)/, 'nothing left reads as zero')
  const unknown = figures182({ priorRefundedTax: null })
  assert.match(!unknown.ok ? unknown.reason : '', /earlier refund on this order cannot be established/)
  // The allowance is not granted again per refund: once the VAT is exactly used up, a run of one-cent refunds all refuse.
  let prior = D('25.46')
  for (let i = 0; i < 5; i++) {
    const tiny = figures182({ net: D('1'), statedGross: D('1.01'), statedTax: D('0.01'), priorRefundedTax: prior })
    assert.equal(tiny.ok, false, `refund ${i + 1} after exhaustion refuses`)
  }
  // Below exhaustion the overshoot is bounded once for the order: 25.45 refunded, a 0.02 refund passes (25.47 <= 25.46 + 0.03); the VAT is then used up, so the next one refuses.
  prior = D('25.45')
  assert.equal(figures182({ net: D('1'), statedGross: D('1.02'), statedTax: D('0.02'), priorRefundedTax: prior }).ok, true)
  assert.equal(figures182({ net: D('1'), statedGross: D('1.02'), statedTax: D('0.02'), priorRefundedTax: prior.plus(D('0.02')) }).ok, false, 'used up')
})

test('[credit note 182] the held wording names the account, the amounts, the place among the first N, and the way out (check Xero, then settle on /sync)', () => {
  const text = refund182HeldRefusal({ creditNoteNumber: 'CN-0001', heldNumber: 3, threshold: 10, vatAccount: '821', vatAmount: '19', refundTotal: '119', currency: 'EUR' })
  assert.match(text, /NOTHING WAS SENT/)
  assert.match(text, /rate 182[\s\S]*account \(821\)[\s\S]*first 10[\s\S]*number 3/)
  assert.match(text, /total 119 EUR, of which 19 is VAT|119 EUR, of which 19 is VAT/)
  assert.match(text, /Check Xero for credit note CN-0001 first[\s\S]*settle action on \/sync/)
})

test('[credit note 182] a refund that states LESS than its net refuses; the VAT booked is gross less net (not the stated tax); exactly the order bound passes', () => {
  const less = figures182({ statedGross: D('99.99'), statedTax: D('0') })
  assert.equal(less.ok, false)
  assert.match(!less.ok ? less.reason : '', /less than the 100 its lines net to/)
  assert.deepEqual(figures182({ statedGross: D('119'), statedTax: D('19.02') }), { ok: true, vatAmount: '19', refundTotal: '119' }, 'the VAT is gross less net; the stated tax only confirms it')
  // 19 + 6.49 = 25.49 = 25.46 + the 3-minor-unit allowance: on the bound passes.
  assert.equal(figures182({ priorRefundedTax: D('6.49') }).ok, true)
  assert.equal(figures182({ priorRefundedTax: D('6.50') }).ok, false)
})
