import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CreditNoteRateUnprovableError,
  draftCreditNoteModel,
  postedCreditNoteModel,
  postedLineVatRate,
} from '@/lib/domain/sales/credit-note-document'
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
const line = (taxRatePosted: number | undefined, unitAmount: number, description = 'Widget') => ({ refundLineId: 'r', description, quantity: 1, unitAmount, ...(taxRatePosted === undefined ? {} : { taxRatePosted }) })

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
