import assert from 'node:assert/strict'
import test from 'node:test'

import { creditNoteLineFacts } from '@/lib/domain/sales/credit-note-display'

const taxRates = [{ accountingTaxType: 'OUTPUT2', rate: 0.2 }, { accountingTaxType: 'ZERORATED', rate: 0 }]
const orderLines = [{ id: 'l1', taxRate: { accountingTaxType: 'ZERORATED', reverseCharge: false } }]

// [mutation: read totalForeign unconditionally, or take the order line's code instead of the persisted snapshot]
test('a base-only refund line on a base-currency order shows the BASE column the credit note posts, at its snapshotted code', () => {
  const [fact] = creditNoteLineFacts({
    orderCurrency: 'GBP', baseCurrency: 'GBP', orderLines, taxRates,
    refundLines: [{ salesOrderLineId: 'l1', accountingTaxType: 'OUTPUT2', totalForeign: 0, totalBase: 12.5 }],
  })
  assert.equal(fact.postedNet, 12.5)
  assert.equal(fact.vatRate, 0.2, 'the persisted code, not the order line (0%)')
})

test('on a foreign-currency order the foreign column is the posted one', () => {
  const [fact] = creditNoteLineFacts({
    orderCurrency: 'EUR', baseCurrency: 'GBP', orderLines, taxRates,
    refundLines: [{ salesOrderLineId: 'l1', accountingTaxType: null, totalForeign: 15, totalBase: 12.5 }],
  })
  assert.equal(fact.postedNet, 15)
  assert.equal(fact.vatRate, 0, 'no snapshot: the order line code, as the payload builder falls back')
})

test('a code that cannot be priced yields no rate, never a guess', () => {
  const [unmapped, ambiguous] = creditNoteLineFacts({
    orderCurrency: 'GBP', baseCurrency: 'GBP', orderLines, taxRates: [...taxRates, { accountingTaxType: 'TWICE', rate: 0.1 }, { accountingTaxType: 'TWICE', rate: 0.2 }],
    refundLines: [
      { salesOrderLineId: 'l1', accountingTaxType: 'NOSUCH', totalForeign: 1, totalBase: 1 },
      { salesOrderLineId: null, accountingTaxType: 'TWICE', totalForeign: 1, totalBase: 1 },
    ],
  })
  assert.equal(unmapped.vatRate, null)
  assert.equal(ambiguous.vatRate, null)
})

test('each fact keeps the order line its refund line belongs to', () => {
  const facts = creditNoteLineFacts({
    orderCurrency: 'GBP', baseCurrency: 'GBP', orderLines, taxRates,
    refundLines: [{ salesOrderLineId: 'l1', accountingTaxType: 'OUTPUT2', totalForeign: 1, totalBase: 1 }, { salesOrderLineId: null, accountingTaxType: 'OUTPUT2', totalForeign: 2, totalBase: 2 }],
  })
  assert.deepEqual(facts.map((f) => f.salesOrderLineId), ['l1', null])
})

// o3d-hqvrp.321 [mutation: ignore postedTaxRate and price from the table]
test('a stored rate wins over the current tax table: editing the mapping after posting does not change the shown VAT', () => {
  const editedTable = [{ accountingTaxType: 'OUTPUT2', rate: 0.25 }]
  const [fact] = creditNoteLineFacts({
    orderCurrency: 'GBP', baseCurrency: 'GBP', orderLines, taxRates: editedTable,
    refundLines: [{ salesOrderLineId: 'l1', accountingTaxType: 'OUTPUT2', postedTaxRate: '0.2', totalForeign: 10, totalBase: 10 }],
  })
  assert.equal(fact.vatRate, 0.2)
  assert.equal(fact.vatRateEstimated, false)
})

test('a stored 0% rate is a rate, not an absence', () => {
  const [fact] = creditNoteLineFacts({
    orderCurrency: 'GBP', baseCurrency: 'GBP', orderLines, taxRates,
    refundLines: [{ salesOrderLineId: 'l1', accountingTaxType: 'OUTPUT2', postedTaxRate: 0, totalForeign: 10, totalBase: 10 }],
  })
  assert.equal(fact.vatRate, 0)
  assert.equal(fact.vatRateEstimated, false)
})

test('a line with no stored rate is priced from the table and marked estimated', () => {
  const [fact] = creditNoteLineFacts({
    orderCurrency: 'GBP', baseCurrency: 'GBP', orderLines, taxRates,
    refundLines: [{ salesOrderLineId: 'l1', accountingTaxType: 'OUTPUT2', postedTaxRate: null, totalForeign: 10, totalBase: 10 }],
  })
  assert.equal(fact.vatRate, 0.2)
  assert.equal(fact.vatRateEstimated, true)
})
