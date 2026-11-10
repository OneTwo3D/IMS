import assert from 'node:assert/strict'
import test from 'node:test'
import { orderTurnoverBase, type TurnoverRefund } from '@/lib/domain/sales/customer-turnover'

const order = (refunds: TurnoverRefund[], over: Record<string, unknown> = {}) => ({
  status: 'SHIPPED', invoiceNumber: 'INV-1', shoppingLinks: [{ connector: 'woocommerce' }], totalBase: 120, refunds, ...over,
})
/** A credit line of `totalBase` against a sales line whose STORED net and tax are `lineNet` and `lineTax`. */
const line = (totalBase: number, lineNet: number | null, lineTax: number | null) => ({
  totalBase, salesOrderLine: { totalBase: lineNet, taxBase: lineTax },
})

test('a 10 NET credit on a 120 order at 20% takes 12 off in gross terms: 108', () => {
  const t = orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(10, 100, 20)] }]))
  assert.deepEqual(t, { value: 108, complete: true })
})

test('a GROSS credit comes off as it stands', () => {
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 12, totalsBasis: 'GROSS', lines: [] }])), { value: 108, complete: true })
})

test('mixed-rate NET credit converts line by line: 10 at 20% + 10 at 0% = 22 gross', () => {
  const t = orderTurnoverBase(order([{ totalBase: 20, totalsBasis: 'NET', lines: [line(10, 100, 20), line(10, 50, 0)] }]))
  assert.deepEqual(t, { value: 98, complete: true })
})

test('a NET credit that cannot be converted exactly stays out and flags an upper bound', () => {
  // no lines
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET' }])), { value: 120, complete: false })
  // line with no known rate (taxed, but no rate row)
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(10, null, null)] }])), { value: 120, complete: false })
  // lines do not add up to the header
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(8, 100, 20)] }])), { value: 120, complete: false })
  // unproven basis
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: null, lines: [line(10, 100, 20)] }])), { value: 120, complete: false })
})

test('exact credits still come off when another credit on the same order cannot be placed', () => {
  const t = orderTurnoverBase(order([
    { totalBase: 10, totalsBasis: 'NET', lines: [line(10, 100, 20)] },
    { totalBase: 5, totalsBasis: null },
  ]))
  assert.deepEqual(t, { value: 108, complete: false })
})

test('drafts, cancelled and un-invoiced orders contribute nothing', () => {
  assert.equal(orderTurnoverBase(order([], { status: 'DRAFT' })), null)
  assert.equal(orderTurnoverBase(order([], { status: 'CANCELLED' })), null)
  assert.equal(orderTurnoverBase(order([], { invoiceNumber: null })), null)
  assert.equal(orderTurnoverBase(order([], { shoppingLinks: [] })), null, 'an IMS-minted number alone is not an invoice')
})

test('the charged rate is read from the line\u2019s stored net and tax, not from a TaxRate edited since the sale', () => {
  // The linked rate now says 5%, but the line was sold at 20% (net 100, stored tax 20): 10 NET is still 12 gross.
  const credit = {
    totalBase: 10, totalsBasis: 'NET',
    lines: [{ totalBase: 10, salesOrderLine: { totalBase: 100, taxBase: 20, taxRate: { rate: 0.05 } } }],
  }
  assert.deepEqual(orderTurnoverBase(order([credit])), { value: 108, complete: true })
})

test('stored amounts that cannot give an exact rate leave the credit unplaced and flagged', () => {
  const cases = [
    line(10, 0, 0), // zero net
    line(10, 100, null), // missing tax
    line(10, null, 20), // missing net
    line(10, 100, -5), // negative tax
    line(150, 100, 20), // credit larger than the line it reverses
  ]
  for (const c of cases) {
    const total = (c as { totalBase: number }).totalBase
    assert.deepEqual(orderTurnoverBase(order([{ totalBase: total, totalsBasis: 'NET', lines: [c] }])), { value: 120, complete: false })
  }
})
