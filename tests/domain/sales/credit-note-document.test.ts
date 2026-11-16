import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CreditNoteRateUnprovableError,
  draftCreditNoteModel,
  postedCreditNoteModel,
  postedLineVatRate,
  predictedPostedTotal,
  CreditNotePostingUnprovableError,
} from '@/lib/domain/sales/credit-note-document'
import { predictXeroDocumentTotal, xeroUnitDpFields } from '@/lib/connectors/xero/write-path'
import { creditNoteAmounts } from '@/lib/domain/sales/sales-order-money-view'

function render(payloadLines: Array<Record<string, unknown>>, currency = 'GBP', includeTax = false) {
  return postedCreditNoteModel({
    currency,
    payloadLines,
    lineAmountsIncludeTax: includeTax,
    vatIsOwnLine: false,
    rateOf: (i) => postedLineVatRate(payloadLines[i]),
  })
}
const line = (taxRatePosted: number | undefined, unitAmount: number, description = 'Widget', quantity = 1, taxType?: string) => ({ refundLineId: 'r', description, quantity, unitAmount, ...(taxType ? { taxType } : {}), ...(taxRatePosted === undefined ? {} : { taxRatePosted }) })

test('0.13 net at a 20% code prints 0.03 VAT (the ledger rounds the code rate, not the source stated 0.02)', () => {
  const m = render([line(0.2, 0.13)])
  assert.deepEqual(m.rows.map((r) => [r.net, r.vat, r.gross]), [[0.13, 0.03, 0.16]])
  assert.deepEqual(m.total, { net: 0.13, vat: 0.03, gross: 0.16 })
})

test('a zero-rated code prints no VAT, whatever the description (empty descriptions post as "Refund line")', () => {
  assert.deepEqual(render([line(0, 50, 'Refund line')]).total, { net: 50, vat: 0, gross: 50 })
})

test('two lines with the same description and different rates each keep their own rate', () => {
  assert.deepEqual(render([line(0, 10), line(0.2, 10)]).rows.map((r) => r.vat), [0, 2])
})

test('VAT is rounded per line and the total is the sum of the rounded lines, as the ledger posts', () => {
  const m = render([line(0.2, 0.13), line(0.2, 0.13), line(0.2, 0.13)])
  assert.equal(m.total.vat, 0.09) // 3 x 0.03, not round(0.078) = 0.08
  assert.equal(m.rounding, null)
})

test('amounts that include tax: the tax part is rounded per line', () => {
  const m = render([line(0.2, 1.2)], 'GBP', true)
  assert.deepEqual(m.rows.map((r) => [r.net, r.vat, r.gross]), [[1, 0.2, 1.2]])
})

test('an unknown tax code (no recorded rate) or a legacy payload is refused with an operator-facing message', () => {
  assert.throws(
    () => render([line(undefined, 10)]),
    (e: unknown) => e instanceof CreditNoteRateUnprovableError && /IMS will not guess a rate/.test(e.message) && e.lineNumbers.join() === '1',
  )
  assert.throws(() => render([line(0.2, 10), line(undefined, 10)]), CreditNoteRateUnprovableError)
})

// ---- minor-unit precision --------------------------------------------------------------------------------------------------

for (const [currency, digits, unit] of [['KWD', 3, 0.001], ['CLF', 4, 0.0001], ['UYW', 4, 0.0001]] as const) {
  test(`${currency}: rows and totals keep ${digits} decimals, so a ${unit} credit is not rounded away`, () => {
    const model = render([line(0, unit, 'Tiny')], currency)
    assert.equal(model.digits, digits)
    assert.deepEqual(model.total, { net: unit, vat: 0, gross: unit })
    assert.equal(model.rounding, null)
  })
}

test('KWD: VAT is rounded to the third decimal, not the second', () => {
  const model = render([line(0.2, 1.234, 'W')], 'KWD')
  assert.deepEqual(model.rows.map((r) => [r.net, r.vat, r.gross]), [[1.234, 0.247, 1.481]])
})

test('GBP still rounds to two decimals', () => {
  assert.equal(render([line(0, 0.004, 'W')]).total.gross, 0)
})

// ---- the PDF's figures are the credit note's figures -----------------------------------------------------------------------

for (const [currency, digits] of [['GBP', 2], ['KWD', 3], ['CLF', 4]] as const) {
  test(`${currency}: the rendered model's totals equal creditNoteAmounts' (what the credit note posts)`, () => {
    const order = { taxRatePercent: 0.2, lines: [{ id: 'l1', qty: 3, unitPriceForeign: 3.3333, discountAmount: 0, totalForeign: 10, taxForeign: 2, taxRatePercent: 0.2 }] }
    const facts = [
      { salesOrderLineId: 'l1', postedNet: 3.33333, vatRate: 0.2 },
      { salesOrderLineId: 'l1', postedNet: 3.33333, vatRate: 0.2 },
      { salesOrderLineId: null, postedNet: 0.00449, vatRate: 0 },
    ]
    const model = draftCreditNoteModel({
      currency,
      orderTaxRatePercent: 0.2,
      orderLines: order.lines,
      refundLines: facts.map((f) => ({ ...f, description: 'x', qty: 1 })),
    })
    assert.equal(model.digits, digits)
    assert.deepEqual(model.total, creditNoteAmounts(order, { lines: facts }, digits).total)
    const sum = (k: 'net' | 'vat' | 'gross') => Number((model.rows.reduce((s, r) => s + r[k], 0) + (model.rounding?.[k] ?? 0)).toFixed(digits))
    assert.deepEqual({ net: sum('net'), vat: sum('vat'), gross: sum('gross') }, model.total)
  })
}

// ---- Xero's 4-decimal unit prices and the untaxed Rounding adjustment line ---------------------------------------------------

// What the writer posts, by its own functions: the 4dp lines plus its planned adjustment line, predicted by predictXeroDocumentTotal.
function writerTotal(lines: ReturnType<typeof line>[], rounding: number): number {
  const rates = new Map(lines.map((l) => [l.taxType as string, (l.taxRatePosted as number) * 100]))
  const four = lines.map((l) => ({ quantity: l.quantity, unitAmount: xeroUnitDpFields(l.quantity, l.unitAmount).UnitAmount, taxType: l.taxType }))
  const p = predictXeroDocumentTotal([...four, { quantity: 1, unitAmount: rounding, taxType: 'NONE' }], false, (t) => rates.get(t) ?? null)
  assert.ok(p.ok)
  return p.total.toNumber()
}

test('300 x 0.33342 at 20%: the 4dp line Xero keeps plus an untaxed Rounding adjustment row; the total is what the writer posts', () => {
  const lines = [line(0.2, 0.33342, 'Widget', 300, 'OUTPUT2')]
  const m = render(lines)
  assert.deepEqual(m.rows.map((r) => [r.description, r.net, r.vat, r.gross]), [['Widget', 100.02, 20, 120.02], ['Rounding adjustment', 0.02, 0, 0.02]])
  assert.deepEqual(m.total, { net: 100.04, vat: 20, gross: 120.04 })
  assert.equal(m.rounding, null)
  assert.equal(m.total.gross, writerTotal(lines, 0.02))
  // the writer's prediction over the IMS (full-precision) lines is the order's total, which the adjusted document reaches
  assert.equal(m.total.gross, predictedPostedTotal({ currency: 'GBP', payloadLines: lines, lineAmountsIncludeTax: false }))
})

test('a document that needs no adjustment has no rounding row', () => {
  const m = render([line(0.2, 10, 'Widget', 3, 'OUTPUT2')])
  assert.equal(m.rows.length, 1)
  assert.deepEqual(m.total, { net: 30, vat: 6, gross: 36 })
})

test('offsetting mixed-rate gaps (+ on a 20% line, - on a zero-rated one) still get the planned adjustment; the total equals the writer\'s', () => {
  const lines = [line(0.2, 0.33342, 'A', 300, 'OUTPUT2'), line(0, 0.33338, 'B', 300, 'ZERORATED')]
  const m = render(lines)
  assert.deepEqual(m.rows.map((r) => [r.net, r.vat]), [[100.02, 20], [100.02, 0], [0.01, 0]])
  assert.equal(m.total.gross, 220.05)
  assert.equal(m.total.gross, writerTotal(lines, 0.01))
})

test('the writer\'s planner refusing the document (a rate it does not know) refuses the PDF', () => {
  assert.throws(() => render([{ ...line(0.2, 0.33342, 'W', 300, 'OUTPUT2'), taxType: undefined }]), CreditNotePostingUnprovableError)
})
