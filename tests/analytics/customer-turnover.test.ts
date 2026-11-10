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
  assert.deepEqual(t, { value: 108, complete: true, bound: 'exact' })
})

test('a GROSS credit comes off as it stands', () => {
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 12, totalsBasis: 'GROSS', lines: [] }])), { value: 108, complete: true, bound: 'exact' })
})

test('mixed-rate NET credit converts line by line: 10 at 20% + 10 at 0% = 22 gross', () => {
  const t = orderTurnoverBase(order([{ totalBase: 20, totalsBasis: 'NET', lines: [line(10, 100, 20), line(10, 50, 0)] }]))
  assert.deepEqual(t, { value: 98, complete: true, bound: 'exact' })
})

test('a NET credit that cannot be converted exactly stays out and flags an upper bound', () => {
  // no lines
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET' }])), { value: 120, complete: false, bound: 'upper' })
  // line with no known rate (taxed, but no rate row)
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(10, null, null)] }])), { value: 120, complete: false, bound: 'upper' })
  // lines do not add up to the header
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(8, 100, 20)] }])), { value: 120, complete: false, bound: 'upper' })
  // unproven basis
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: null, lines: [line(10, 100, 20)] }])), { value: 120, complete: false, bound: 'upper' })
})

test('exact credits still come off when another credit on the same order cannot be placed', () => {
  const t = orderTurnoverBase(order([
    { totalBase: 10, totalsBasis: 'NET', lines: [line(10, 100, 20)] },
    { totalBase: 5, totalsBasis: null },
  ]))
  assert.deepEqual(t, { value: 108, complete: false, bound: 'upper' })
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
  assert.deepEqual(orderTurnoverBase(order([credit])), { value: 108, complete: true, bound: 'exact' })
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
    assert.deepEqual(orderTurnoverBase(order([{ totalBase: total, totalsBasis: 'NET', lines: [c] }])), { value: 120, complete: false, bound: 'upper' })
  }
})

test('a negative discount line against a negative sales line is placed in gross terms, not skipped', () => {
  // Sales discount line: net -50, stored tax -10 (20%). A credit of -5 NET against it is -6 gross, which RAISES turnover by 6.
  const t = orderTurnoverBase(order([{ totalBase: -5, totalsBasis: 'NET', lines: [line(-5, -50, -10)] }]))
  assert.deepEqual(t, { value: 126, complete: true, bound: 'exact' })
})

test('a mixed-sign NET credit is placed line by line: +10 at 20% and -4 at 20% = 6 net, 7.20 gross', () => {
  const t = orderTurnoverBase(order([{ totalBase: 6, totalsBasis: 'NET', lines: [line(10, 100, 20), line(-4, -40, -8)] }]))
  assert.deepEqual(t, { value: 112.8, complete: true, bound: 'exact' })
})

test('an unplaced credit that is negative, zero or mixed-sign makes the figure indeterminate, not an upper bound', () => {
  // negative total, line cannot be placed
  assert.equal(orderTurnoverBase(order([{ totalBase: -5, totalsBasis: 'NET', lines: [line(-5, null, null)] }]))!.bound, 'indeterminate')
  // zero total
  assert.equal(orderTurnoverBase(order([{ totalBase: 0, totalsBasis: null }]))!.bound, 'indeterminate')
  // positive total but one line negative and unplaceable: mixed, so no bound can be proved
  assert.equal(orderTurnoverBase(order([{ totalBase: 6, totalsBasis: 'NET', lines: [line(10, 100, 20), line(-4, null, null)] }]))!.bound, 'indeterminate')
  // positive and unplaced stays an upper bound
  assert.equal(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: null }]))!.bound, 'upper')
  // indeterminate wins over an upper bound on the same order
  assert.equal(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: null }, { totalBase: -2, totalsBasis: null }]))!.bound, 'indeterminate')
})

test('degenerate NET credits are left unplaced, not placed as zero or NaN', () => {
  // zero-net sales line with a zero credit
  const zero = orderTurnoverBase(order([{ totalBase: 0, totalsBasis: 'NET', lines: [line(0, 0, 0)] }]))!
  assert.equal(zero.value, 120)
  assert.equal(zero.bound, 'indeterminate')
  // NET credit with no lines and a zero total
  const none = orderTurnoverBase(order([{ totalBase: 0, totalsBasis: 'NET' }]))!
  assert.equal(none.bound, 'indeterminate')
  // credit line with no sales line at all
  const orphan = orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [{ totalBase: 10, salesOrderLine: null }] }]))!
  assert.deepEqual(orphan, { value: 120, complete: false, bound: 'upper' })
  // a negative credit against a positive sales line is not a share of it
  const neg = orderTurnoverBase(order([{ totalBase: -5, totalsBasis: 'NET', lines: [line(-5, 100, 20)] }]))!
  assert.equal(neg.value, 120)
  assert.equal(neg.bound, 'indeterminate')
})

test('an indeterminate credit stays indeterminate whichever order the credits arrive in', () => {
  assert.equal(orderTurnoverBase(order([{ totalBase: -2, totalsBasis: null }, { totalBase: 10, totalsBasis: null }]))!.bound, 'indeterminate')
  assert.equal(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: null }, { totalBase: -2, totalsBasis: null }]))!.bound, 'indeterminate')
})
