import assert from 'node:assert/strict'
import test from 'node:test'
import { orderTurnoverBase, type TurnoverRefund } from '@/lib/domain/sales/customer-turnover'

const order = (refunds: TurnoverRefund[], over: Record<string, unknown> = {}) => ({
  status: 'SHIPPED', invoiceNumber: 'INV-1', totalBase: 120, refunds, ...over,
})
const line = (totalBase: number, rate: number | null, taxBase = 0) => ({
  totalBase, salesOrderLine: { taxBase, taxRate: rate == null ? null : { rate } },
})

test('a 10 NET credit on a 120 order at 20% takes 12 off in gross terms: 108', () => {
  const t = orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(10, 0.2, 20)] }]))
  assert.deepEqual(t, { value: 108, complete: true })
})

test('a GROSS credit comes off as it stands', () => {
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 12, totalsBasis: 'GROSS', lines: [] }])), { value: 108, complete: true })
})

test('mixed-rate NET credit converts line by line: 10 at 20% + 10 at 0% = 22 gross', () => {
  const t = orderTurnoverBase(order([{ totalBase: 20, totalsBasis: 'NET', lines: [line(10, 0.2, 20), line(10, 0, 0)] }]))
  assert.deepEqual(t, { value: 98, complete: true })
})

test('a NET credit that cannot be converted exactly stays out and flags an upper bound', () => {
  // no lines
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET' }])), { value: 120, complete: false })
  // line with no known rate (taxed, but no rate row)
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(10, null, 20)] }])), { value: 120, complete: false })
  // lines do not add up to the header
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(8, 0.2, 20)] }])), { value: 120, complete: false })
  // unproven basis
  assert.deepEqual(orderTurnoverBase(order([{ totalBase: 10, totalsBasis: null, lines: [line(10, 0.2, 20)] }])), { value: 120, complete: false })
})

test('exact credits still come off when another credit on the same order cannot be placed', () => {
  const t = orderTurnoverBase(order([
    { totalBase: 10, totalsBasis: 'NET', lines: [line(10, 0.2, 20)] },
    { totalBase: 5, totalsBasis: null },
  ]))
  assert.deepEqual(t, { value: 108, complete: false })
})

test('drafts, cancelled and un-invoiced orders contribute nothing', () => {
  assert.equal(orderTurnoverBase(order([], { status: 'DRAFT' })), null)
  assert.equal(orderTurnoverBase(order([], { status: 'CANCELLED' })), null)
  assert.equal(orderTurnoverBase(order([], { invoiceNumber: null })), null)
})

test('a negative tax rate is not a rate: the credit is left out and flagged', () => {
  const t = orderTurnoverBase(order([{ totalBase: 10, totalsBasis: 'NET', lines: [line(10, -0.2, 0)] }]))
  assert.deepEqual(t, { value: 120, complete: false })
})
