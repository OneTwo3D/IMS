import assert from 'node:assert/strict'
import test from 'node:test'

import { heldInvoiceDifference, heldTaxBindingDifference, heldUntreatedTaxDifference, type ExpectedHeldInvoice } from '../../lib/connectors/woocommerce/sync/held-invoice-verification'

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
  p.lines[1] = { description: 'EU Customs Fee', quantity: 1, unitAmount: 4, accountCode: '232', taxType: 'NONE', noTaxKind: 'fee-no-tax', euFeeMarked: true }
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
    ['currency', (p) => { p.currency = 'EUR' }, /parked invoice is in EUR but the order is now in GBP/],
    ['no currency', (p) => { delete p.currency }, /\(no currency\)/],
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

test('the landed-cost fee marker is checked apart from the no-tax status: a marker removed (or added) on the order while held is a difference', () => {
  // Parked treated with the fee marked; the order now says the fee is NOT marked (an untaxed fee: still no-tax, no longer the landed-cost fee).
  const unmarked: ExpectedHeldInvoice = { ...expected, lines: [expected.lines[0]!, { ...expected.lines[1]!, markedFee: false, untaxedFee: true }] }
  const p = treated()
  ;(p.lines[2] as Record<string, unknown>).unitAmount = 0
  assert.match(heldInvoiceDifference(p, unmarked, true) ?? '', /landed-cost fee marker differs/)
  // The reverse: the order marks the fee but the parked line carries no marker.
  const q = treated(); delete (q.lines[1] as Record<string, unknown>).euFeeMarked
  assert.match(heldInvoiceDifference(q, expected, true) ?? '', /landed-cost fee marker differs/)
  // An untreated hold never carries the marker.
  const r = untreated(); (r.lines[1] as Record<string, unknown>).euFeeMarked = true
  assert.match(heldInvoiceDifference(r, expected, false) ?? '', /landed-cost fee marker differs/)
})


const recorded = { lineRateIds: [10, 11, null], shippingRateIds: [10], resolved: { '10': 'OUTPUT2', '11': 'ZERORATEDOUTPUT' } }
const nowSame = { lineRateIds: [10, 11, null], shippingRateIds: [10], resolved: { '10': { type: 'OUTPUT2', mapped: true }, '11': { type: 'ZERORATEDOUTPUT', mapped: true } } }

test('the recorded tax binding of a treated hold: unchanged matches; swapped rates, shipping, a re-mapped rate, an unmapped rate and an unrecorded binding are differences', () => {
  assert.equal(heldTaxBindingDifference(recorded, nowSame), null)
  assert.match(heldTaxBindingDifference(recorded, { ...nowSame, lineRateIds: [11, 10, null] }) ?? '', /lines changed \(for example two lines exchanged tax classes\)/)
  assert.match(heldTaxBindingDifference(recorded, { ...nowSame, shippingRateIds: [11] }) ?? '', /shipping changed/)
  assert.match(heldTaxBindingDifference(recorded, { ...nowSame, resolved: { ...nowSame.resolved, '11': { type: 'OUTPUT2', mapped: true } } }) ?? '', /rate 11 now posts on OUTPUT2, not ZERORATEDOUTPUT/)
  assert.match(heldTaxBindingDifference(recorded, { ...nowSame, resolved: { ...nowSame.resolved, '10': { type: 'OUTPUT2', mapped: false } } }) ?? '', /rate 10 can no longer be resolved/)
  assert.match(heldTaxBindingDifference(undefined, nowSame) ?? '', /not recorded/)
  assert.match(heldTaxBindingDifference({ lineRateIds: 'x' }, nowSame) ?? '', /unreadable/)
})

test('an untreated hold: each parked line type must be the one the line resolves to now; a null expectation is skipped; the shipping type must be one of its rates\' types', () => {
  const parked = { lines: [{ taxType: 'OUTPUT2' }, { taxType: 'ZERORATEDOUTPUT' }], shippingAmount: 10, shippingTaxType: 'OUTPUT2' }
  assert.equal(heldUntreatedTaxDifference(parked, ['OUTPUT2', 'ZERORATEDOUTPUT'], ['OUTPUT2']), null)
  assert.equal(heldUntreatedTaxDifference(parked, ['OUTPUT2', null], ['OUTPUT2']), null)
  assert.match(heldUntreatedTaxDifference(parked, ['ZERORATEDOUTPUT', 'OUTPUT2'], ['OUTPUT2']) ?? '', /line 1: the parked tax type is OUTPUT2, the order's line now resolves to ZERORATEDOUTPUT/)
  assert.match(heldUntreatedTaxDifference(parked, ['OUTPUT2', 'UNRESOLVED'], ['OUTPUT2']) ?? '', /line 2/)
  assert.match(heldUntreatedTaxDifference(parked, ['OUTPUT2', 'ZERORATEDOUTPUT'], ['ZERORATEDOUTPUT']) ?? '', /shipping tax type is OUTPUT2/)
})
