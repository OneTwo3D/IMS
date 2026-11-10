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


const rate = (over: Record<string, unknown> = {}) => ({
  mapped: true, imsRateId: 'r10', accountingTaxType: 'OUTPUT2', reverseCharge: false, active: true, rate: '0.2', isCompound: false, schemePostingTaxType: null, reportingCategory: null, countryCode: 'GB',
  replacedById: null, components: '[]', nowRateId: 'r10', nowAccountingTaxType: 'OUTPUT2', nowReverseCharge: false, ...over,
})
const binding = (over: Record<string, unknown> = {}) => ({
  lineRateIds: [10, 11, null], shippingRateIds: [10], reverseChargeSalesTaxType: '',
  rates: { '10': rate(), '11': rate({ imsRateId: 'r11', accountingTaxType: 'ZERORATEDOUTPUT', rate: '0', nowRateId: 'r11', nowAccountingTaxType: 'ZERORATEDOUTPUT' }) },
  lines: [{ rateId: 'r10', source: 'woo-rate', type: 'OUTPUT2' }, { rateId: 'r11', source: 'woo-rate', type: 'ZERORATEDOUTPUT' }, { rateId: 'rc', source: 'category', type: 'OUTPUT2' }],
  shipping: { rateId: 'r10', type: 'OUTPUT2' }, ...over,
})

test('the recorded tax binding of a treated hold: unchanged matches; EVERY recorded input is compared (rate ids, mapping, type, reverse-charge flag and setting, active, rate, compound, scheme fields, replacement, components, the rate as it stands now) and so are the effective types', () => {
  assert.equal(heldTaxBindingDifference(binding(), binding()), null)
  assert.match(heldTaxBindingDifference(binding(), binding({ lineRateIds: [11, 10, null] })) ?? '', /lines changed \(for example two lines exchanged tax classes\)/)
  assert.match(heldTaxBindingDifference(binding(), binding({ shippingRateIds: [11] })) ?? '', /shipping changed/)
  assert.match(heldTaxBindingDifference(binding(), binding({ reverseChargeSalesTaxType: 'ECOUTPUTSERVICES' })) ?? '', /reverse-charge sales tax type setting changed from "" to "ECOUTPUTSERVICES"/)
  const keys: Array<[string, unknown, RegExp]> = [
    ['imsRateId', 'other', /imsRateId changed/], ['accountingTaxType', 'OUTPUT', /accountingTaxType changed/], ['reverseCharge', true, /reverseCharge changed from false to true/], ['active', false, /active changed from true to false/],
    ['rate', '0.25', /rate changed/], ['isCompound', true, /isCompound changed/], ['schemePostingTaxType', 'TAX131', /schemePostingTaxType changed/], ['reportingCategory', 'IOSS', /reportingCategory changed/],
    ['countryCode', 'DE', /countryCode changed/], ['replacedById', 'r99', /replacedById changed/], ['components', '[["0.2",false,null,0]]', /components changed/], ['nowRateId', 'r99', /nowRateId changed/],
    ['nowAccountingTaxType', 'OUTPUT', /nowAccountingTaxType changed/], ['nowReverseCharge', true, /nowReverseCharge changed/],
  ]
  for (const [key, value, pattern] of keys) {
    const now = binding(); ;(now.rates['10'] as Record<string, unknown>)[key] = value
    assert.match(heldTaxBindingDifference(binding(), now) ?? '', pattern, key)
  }
  // The OUTPUTS: a rate-less line (resolved by the category resolver or the order default) is compared like any other.
  const lines = (over: Record<string, unknown>) => binding({ lines: [binding().lines[0], binding().lines[1], { ...binding().lines[2], ...over }] })
  assert.match(heldTaxBindingDifference(binding(), lines({ type: 'OUTPUT3' })) ?? '', /line 3: the resolved tax rate and type changed/)
  assert.match(heldTaxBindingDifference(binding(), lines({ rateId: 'rc2' })) ?? '', /line 3: the resolved tax rate and type changed/)
  assert.match(heldTaxBindingDifference(binding(), lines({ source: 'default' })) ?? '', /line 3: the resolved tax rate and type changed/)
  assert.match(heldTaxBindingDifference(binding(), lines({ rateId: null, type: null })) ?? '', /line 3/)
  assert.equal(heldTaxBindingDifference(binding({ lines: [{ rateId: null, source: 'category', type: null }] , lineRateIds: [null]}), binding({ lines: [{ rateId: null, source: 'category', type: null }], lineRateIds: [null] })), null, 'a line that resolves to no rate both times matches exactly')
  assert.match(heldTaxBindingDifference(binding(), binding({ lines: binding().lines.slice(0, 2) })) ?? '', /now has 2 lines, the hold 3/)
  assert.match(heldTaxBindingDifference(binding(), binding({ shipping: { rateId: 'r10', type: 'ZERORATEDOUTPUT' } })) ?? '', /shipping's resolved tax rate and type changed/)
  const unmapped = binding(); unmapped.rates['10'] = rate({ mapped: false })
  assert.match(heldTaxBindingDifference(binding(), unmapped) ?? '', /can no longer be resolved to an IMS rate/)
  const gone = binding(); delete (gone.rates as Record<string, unknown>)['10']
  assert.match(heldTaxBindingDifference(binding(), gone) ?? '', /can no longer be resolved/)
  assert.match(heldTaxBindingDifference(undefined, binding()) ?? '', /not recorded/)
  assert.match(heldTaxBindingDifference({ lineRateIds: 'x' }, binding()) ?? '', /unreadable/)
})

test('an untreated hold: each parked line type must be EXACTLY the effective type the builder resolves now, with no skip for null; the shipping type likewise', () => {
  const parked = { lines: [{ taxType: 'OUTPUT2' }, { taxType: 'ZERORATEDOUTPUT' }, {}], shippingAmount: 10, shippingTaxType: 'OUTPUT2' }
  const now = (types: Array<string | null>, shipping: string | null = 'OUTPUT2') => ({ lines: types.map((type) => ({ type })), shipping: { type: shipping } })
  assert.equal(heldUntreatedTaxDifference(parked, now(['OUTPUT2', 'ZERORATEDOUTPUT', null])), null, 'a line parked with no type that still resolves to none matches')
  assert.match(heldUntreatedTaxDifference(parked, now(['ZERORATEDOUTPUT', 'ZERORATEDOUTPUT', null])) ?? '', /line 1: the parked tax type is OUTPUT2, the order's line now resolves to ZERORATEDOUTPUT/)
  assert.match(heldUntreatedTaxDifference(parked, now(['OUTPUT2', 'ZERORATEDOUTPUT', 'OUTPUT2'])) ?? '', /line 3: the parked tax type is \(none\), the order's line now resolves to OUTPUT2/)
  assert.match(heldUntreatedTaxDifference(parked, now(['OUTPUT2', null, null])) ?? '', /line 2: the parked tax type is ZERORATEDOUTPUT, the order's line now resolves to \(none\)/)
  assert.match(heldUntreatedTaxDifference(parked, now(['OUTPUT2', 'ZERORATEDOUTPUT', null], 'ZERORATEDOUTPUT')) ?? '', /shipping tax type is OUTPUT2, the order's shipping now resolves to ZERORATEDOUTPUT/)
  assert.equal(heldUntreatedTaxDifference({ ...parked, shippingAmount: 0 }, now(['OUTPUT2', 'ZERORATEDOUTPUT', null], 'ZERORATEDOUTPUT')), null, 'shipping is only sent with a positive amount')
})
