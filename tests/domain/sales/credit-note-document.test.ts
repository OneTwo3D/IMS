import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CreditNoteRateUnprovableError,
  draftCreditNoteModel,
  postedCreditNoteModel,
  postedLineVatRate,
} from '@/lib/domain/sales/credit-note-document'
import { creditNoteAmounts } from '@/lib/domain/sales/sales-order-money-view'

// A 20% order: l1 is a standard line, l2 a zero-rated line.
const orderLines = [
  { id: 'l1', totalForeign: 100, taxForeign: 20 },
  { id: 'l2', totalForeign: 50, taxForeign: 0 },
]
const refundLine = (id: string, salesOrderLineId: string | null, totalForeign: number, extra: Record<string, unknown> = {}) => ({
  id, salesOrderLineId, totalForeign, schemeTaxRateValue: null, chargedTaxForeign: null, ...extra,
})

function render(payloadLines: Array<Record<string, unknown>>, refundLines: ReturnType<typeof refundLine>[], currency = 'GBP') {
  return postedCreditNoteModel({
    currency,
    payloadLines,
    lineAmountsIncludeTax: false,
    vatIsOwnLine: false,
    rateOf: (i) => postedLineVatRate({ payloadLine: payloadLines[i], refundLines, orderLines, orderRate: 0.2, orderDefaultTaxType: 'OUTPUT2' }),
  })
}

// [mutation: look the rate up by description, or fall back to the order rate when the description misses]
test('a zero-rated line with an EMPTY description on a 20% order prints no VAT', () => {
  const model = render(
    [{ refundLineId: 'r1', description: 'Refund line', quantity: 1, unitAmount: 50 }],
    [refundLine('r1', 'l2', 50)], // posted as "Refund line" because the stored description is ''
  )
  assert.deepEqual(model.rows.map((r) => [r.net, r.vat, r.gross]), [[50, 0, 50]])
  assert.deepEqual(model.total, { net: 50, vat: 0, gross: 50 })
})

test('two lines with the same description and different rates each keep their own rate, in either order', () => {
  const refundLines = [refundLine('r1', 'l1', 10), refundLine('r2', 'l2', 10)]
  const lines = [
    { refundLineId: 'r2', description: 'Widget', quantity: 1, unitAmount: 10 },
    { refundLineId: 'r1', description: 'Widget', quantity: 1, unitAmount: 10 },
  ]
  const model = render(lines, refundLines)
  assert.deepEqual(model.rows.map((r) => r.vat), [0, 2])
})

test('a legacy payload (no refundLineId) is refused with an operator-facing message, never printed with a guessed rate', () => {
  assert.throws(
    () => render([{ description: 'Widget', quantity: 1, unitAmount: 10 }], [refundLine('r1', 'l1', 10)]),
    (e: unknown) => e instanceof CreditNoteRateUnprovableError && /IMS will not guess a rate/.test(e.message) && e.lineNumbers.join() === '1',
  )
  // an id that names no refund line proves nothing either
  assert.throws(() => render([{ refundLineId: 'gone', description: 'W', quantity: 1, unitAmount: 10 }], []), CreditNoteRateUnprovableError)
})

test('a line with no order line takes the order rate only when it posted under the order default tax code', () => {
  const shipping = refundLine('r9', null, 5)
  const rate = (taxType: string | undefined) => postedLineVatRate({ payloadLine: { refundLineId: 'r9', taxType }, refundLines: [shipping], orderLines, orderRate: 0.2, orderDefaultTaxType: 'OUTPUT2' })
  assert.equal(rate('OUTPUT2'), 0.2)
  assert.equal(rate('ZERORATED'), null)
  assert.equal(rate(undefined), null)
})

test('the refund line frozen scheme rate and the stated VAT outrank the order line', () => {
  const rl = (extra: Record<string, unknown>) => postedLineVatRate({ payloadLine: { refundLineId: 'r1' }, refundLines: [refundLine('r1', 'l1', 10, extra)], orderLines, orderRate: 0.2, orderDefaultTaxType: null })
  assert.equal(rl({ schemeTaxRateValue: 0.05 }), 0.05)
  assert.equal(rl({ chargedTaxForeign: 0.5 }), 0.05)
  assert.equal(rl({}), 0.2)
})

// ---- minor-unit precision --------------------------------------------------------------------------------------------------

for (const [currency, digits, unit] of [['KWD', 3, 0.001], ['CLF', 4, 0.0001], ['UYW', 4, 0.0001]] as const) {
  test(`${currency}: rows and totals keep ${digits} decimals, so a ${unit} credit is not rounded away`, () => {
    const model = render([{ refundLineId: 'r1', description: 'Tiny', quantity: 1, unitAmount: unit }], [refundLine('r1', 'l2', unit)], currency)
    assert.equal(model.digits, digits)
    assert.deepEqual(model.total, { net: unit, vat: 0, gross: unit })
    assert.equal(model.rounding, null)
  })
}

test('KWD: VAT is rounded to the third decimal, not the second', () => {
  const model = render([{ refundLineId: 'r1', description: 'W', quantity: 1, unitAmount: 1.234 }], [refundLine('r1', 'l1', 1.234)], 'KWD')
  assert.deepEqual(model.rows.map((r) => [r.net, r.vat, r.gross]), [[1.234, 0.247, 1.481]])
})

test('GBP still rounds to two decimals', () => {
  assert.equal(render([{ refundLineId: 'r1', description: 'W', quantity: 1, unitAmount: 0.004 }], [refundLine('r1', 'l2', 0.004)]).total.gross, 0)
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
