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
