import assert from 'node:assert/strict'
import test from 'node:test'

import { heldInvoiceDifference, type ExpectedHeldInvoice } from '../../lib/connectors/woocommerce/sync/held-invoice-verification'

/**
 * A held invoice is compared with the order as it is now: any difference keeps it from being released or treated, and anything that cannot be read does not match.
 */
const expected: ExpectedHeldInvoice = {
  lines: [
    { description: 'Widget', quantity: 2, unitAmount: 48, discountAmount: 0, untaxedFee: false, markedFee: false },
    { description: 'EU Customs Fee', quantity: 1, unitAmount: 4, discountAmount: 0, untaxedFee: false, markedFee: true },
  ],
  shippingAmount: 10, discountAmount: undefined, orderTotal: '110.00', currency: 'GBP',
}
const untreated = () => ({
  currency: 'GBP',
  lines: [
    { description: 'Widget', quantity: 2, unitAmount: 48, accountCode: '200', taxType: 'X' },
    { description: 'EU Customs Fee', quantity: 1, unitAmount: 4, accountCode: '200', taxType: 'X' },
  ],
  shippingAmount: 10, shippingAccountCode: '260',
}) as Record<string, unknown> & { lines: Array<Record<string, unknown>> }
const treated = () => {
  const p = untreated()
  p.lines[1] = { description: 'EU Customs Fee', quantity: 1, unitAmount: 4, accountCode: '232', taxType: 'NONE', noTaxKind: 'fee-no-tax' }
  p.lines.push({ description: 'IOSS VAT collected', quantity: 1, unitAmount: 0, accountCode: '821', taxType: 'NONE', noTaxKind: 'eu-vat-recovery' })
  return p
}

test('an untreated hold that still matches the order has no difference', () => {
  assert.equal(heldInvoiceDifference(untreated(), expected, false), null)
})

test('each kind of change is a difference: description, quantity, unit amount, discount, fee marking, shipping, order discount, a missing or an extra line', () => {
  const cases: Array<[string, (p: ReturnType<typeof untreated>) => void, RegExp]> = [
    ['description', (p) => { p.lines[0]!.description = 'Gadget' }, /description is "Gadget"/],
    ['quantity', (p) => { p.lines[0]!.quantity = 3 }, /quantity is 3/],
    ['unit amount (a changed split with the same total)', (p) => { p.lines[0]!.unitAmount = 47; p.lines[1]!.unitAmount = 6 }, /unit amount is 47/],
    ['discount', (p) => { p.lines[0]!.discountAmount = 5 }, /discount is 5/],
    ['fee marking', (p) => { p.lines[1]!.noTaxKind = 'fee-no-tax' }, /no-tax fee marking differs/],
    ['shipping', (p) => { p.shippingAmount = 12 }, /shipping is 12/],
    ['order discount', (p) => { p.discountAmount = 1 }, /order discount is 1/],
    ['a missing line', (p) => { p.lines.pop() }, /has 1 line\(s\) but the order has 2/],
    ['an extra line', (p) => { p.lines.push({ description: 'Other', quantity: 1, unitAmount: 1, accountCode: '200' }) }, /1 line\(s\) the order does not/],
    ['an unreadable quantity', (p) => { p.lines[0]!.quantity = 'two' }, /quantity is two/],
    ['no lines', (p) => { (p as Record<string, unknown>).lines = null }, /no readable lines/],
  ]
  for (const [label, mutate, pattern] of cases) {
    const p = untreated()
    mutate(p)
    assert.match(heldInvoiceDifference(p, expected, false) ?? '', pattern, label)
  }
})

test('a treated hold: matches when the document still totals the order; the order total, a changed line, or a stray extra line is a difference', () => {
  const p = treated()
  ;(p.lines[2] as Record<string, unknown>).unitAmount = 0
  // lines 96 + 4 + shipping 10 + VAT 0 = 110
  assert.equal(heldInvoiceDifference(p, expected, true), null)
  assert.match(heldInvoiceDifference(p, { ...expected, orderTotal: '112.00' }, true) ?? '', /parked invoice totals 110.*order now totals 112/)
  assert.match(heldInvoiceDifference(p, { ...expected, orderTotal: 'x' }, true) ?? '', /cannot be read/)
  const stray = treated(); stray.lines.push({ description: 'Sneaky', quantity: 1, unitAmount: 5, accountCode: '200', taxType: 'X' })
  assert.match(heldInvoiceDifference(stray, expected, true) ?? '', /not the treatment.s VAT or rounding line/)
  const twice = treated(); twice.lines.push({ ...twice.lines[2]! })
  assert.match(heldInvoiceDifference(twice, expected, true) ?? '', /not the treatment.s VAT or rounding line/)
  const split = treated(); split.lines[0]!.unitAmount = 47
  assert.match(heldInvoiceDifference(split, expected, true) ?? '', /unit amount is 47/)
})
