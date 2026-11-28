import assert from 'node:assert/strict'
import test from 'node:test'

import { postedDiscountTaxType, postedHeaderDiscountTaxType, postedLineTaxType, postedShippingTaxType, postedTaxCodesFromPayload, postedTaxTypeByLineId, withPostedCodeRates, postedInvoicePayloadProjection, invoiceRowTombstonePayload } from '@/lib/domain/sales/posted-invoice-tax-codes'
import { creditNoteLineTaxTypeResolver, resolvePostedRefundTaxIdentity, buildTaxTypeRateIndex } from '@/lib/domain/sales/refund-posted-tax-identity'

/**
 * THE CODES A POSTED INVOICE CARRIED, read back from its payload (owner ruling: a refund reverses the invoice on the codes it posted with, a later rate remap only affects new invoices).
 * [mutation: read the rate's current code instead of the posted one, key a code by position, or guess for an ambiguous rate: red]
 */
const payload = {
  lines: [
    { taxType: 'OLD-A', taxRateId: 'A', taxRateBasis: 'sales_line' },
    { taxType: 'OLD-B', taxRateId: 'B', taxRateBasis: 'sales_line' },
    { taxType: 'OLD-B', taxRateId: 'B', taxRateBasis: 'sales_line' },
    { taxType: 'DEF', description: 'no rate' },
  ],
  discountTaxType: 'DEF',
  discountParts: [
    { amount: 10, taxType: 'OLD-A', taxRateId: 'A' },
    { amount: 5, taxType: 'DEF' },
  ],
}

test('goods codes are keyed by the rate id the line was read from', () => {
  const posted = postedTaxCodesFromPayload(payload)!
  assert.equal(postedLineTaxType(posted, 'A'), 'OLD-A')
  assert.equal(postedLineTaxType(posted, 'B'), 'OLD-B')
  assert.equal(postedLineTaxType(posted, 'Z'), null, 'a rate the invoice does not name has no posted code')
  assert.equal(postedLineTaxType(posted, null), null)
  assert.equal(postedLineTaxType(null, 'A'), null, 'no posted record: the caller keeps the rate\'s current code')
})

test('a discount part resolves by its rate, else by its goods lines\' code; a no-rate group takes the order default part', () => {
  const posted = postedTaxCodesFromPayload(payload)!
  assert.equal(postedDiscountTaxType(posted, { taxRateId: 'A' }), 'OLD-A')
  assert.equal(postedDiscountTaxType(posted, { taxRateId: 'B' }), 'OLD-B', 'merged into another part: the goods lines of that rate say it')
  assert.equal(postedDiscountTaxType(posted, { taxRateId: null }), 'DEF')
  assert.equal(postedDiscountTaxType(posted, { taxRateId: 'Z' }), null)
})

test('an invoice with no per-rate discount parts states no discount code (the header-rate discount is not reversed per rate)', () => {
  const posted = postedTaxCodesFromPayload({ lines: payload.lines, discountTaxType: 'DEF' })!
  assert.equal(posted.hasDiscountParts, false)
  assert.equal(postedDiscountTaxType(posted, { taxRateId: 'A' }), null)
  assert.equal(postedLineTaxType(posted, 'A'), 'OLD-A')
})

test('a rate the record gives two different codes is ambiguous and left out; an unreadable payload is no record', () => {
  const posted = postedTaxCodesFromPayload({ lines: [{ taxType: 'X', taxRateId: 'A' }, { taxType: 'Y', taxRateId: 'A' }] })!
  assert.equal(postedLineTaxType(posted, 'A'), null)
  assert.equal(postedTaxCodesFromPayload(null), null)
  assert.equal(postedTaxCodesFromPayload({ noLines: true }), null)
  assert.equal(postedTaxCodesFromPayload('x'), null)
})

test('postedTaxTypeByLineId maps order lines through their rate and skips lines the record does not state', () => {
  const posted = postedTaxCodesFromPayload(payload)
  const map = postedTaxTypeByLineId([{ id: 'l1', taxRateId: 'A' }, { id: 'l2', taxRateId: null }, { id: 'l3', taxRateId: 'Z' }], posted)
  assert.deepEqual([...map], [['l1', 'OLD-A']])
  assert.equal(postedTaxTypeByLineId([{ id: 'l1', taxRateId: 'A' }], null).size, 0)
})

test('the credit-note line code: snapshot, then the POSTED code, then the rate\'s current code', () => {
  const orderLines = [{ id: 'l1', taxRate: { accountingTaxType: 'NEW-A', reverseCharge: false } }]
  const resolve = (postedTaxTypeByLineId?: ReadonlyMap<string, string>) => creditNoteLineTaxTypeResolver({ orderLines, orderDefaultTaxType: 'DEF', postedTaxTypeByLineId })
  assert.equal(resolve()({ lineId: 'l1' }), 'NEW-A', 'no posted record: today\'s behaviour')
  const posted = new Map([['l1', 'OLD-A']])
  assert.equal(resolve(posted)({ lineId: 'l1' }), 'OLD-A')
  assert.equal(resolve(posted)({ lineId: 'l1', accountingTaxType: 'SNAP' }), 'SNAP', 'a persisted refund-line snapshot still wins')
})

test('the posted-VAT identity of a linked line is the posted code, priced from the tax table; the current mapping is the fallback', () => {
  const rateByTaxType = buildTaxTypeRateIndex([{ accountingTaxType: 'OLD-A', rate: '0.2' }, { accountingTaxType: 'NEW-A', rate: '0.2' }])
  const base = {
    kind: 'sale' as const, lineTaxRate: { accountingTaxType: 'NEW-A', reverseCharge: false }, chargedLine: { currency: 'GBP', netForeign: 100, taxForeign: 20 },
    orderDefaultTaxType: 'DEF', rateByTaxType, label: 'l',
  }
  const posted = resolvePostedRefundTaxIdentity({ ...base, postedTaxType: 'OLD-A' })
  assert.ok(posted.ok)
  assert.equal(posted.ok && posted.accountingTaxType, 'OLD-A')
  const current = resolvePostedRefundTaxIdentity(base)
  assert.equal(current.ok && current.accountingTaxType, 'NEW-A')
  // The posted code is not swapped a second time for a reverse-charged line.
  const rc = resolvePostedRefundTaxIdentity({ ...base, lineTaxRate: { accountingTaxType: 'NEW-A', reverseCharge: true }, reverseChargeSalesTaxType: 'RC-NEW', postedTaxType: 'OLD-A' })
  assert.equal(rc.ok && rc.accountingTaxType, 'OLD-A')
})

test('shipping and the header-rate discount are read only when the record binds them to the rate they were read from', () => {
  const bound = postedTaxCodesFromPayload({ lines: [], shippingTaxType: 'S', shippingTaxRateId: 'R', discountTaxType: 'H', discountTaxRateId: 'R' })!
  assert.equal(postedShippingTaxType(bound), 'S')
  assert.equal(postedHeaderDiscountTaxType(bound), 'H')
  const unbound = postedTaxCodesFromPayload({ lines: [], shippingTaxType: 'S', discountTaxType: 'H' })!
  assert.equal(postedShippingTaxType(unbound), null, 'a retyped (scheme) payload lost its bindings: not read')
  assert.equal(postedHeaderDiscountTaxType(unbound), null)
  const parts = postedTaxCodesFromPayload({ lines: [], discountTaxType: 'H', discountTaxRateId: 'R', discountParts: [{ amount: 1, taxType: 'P', taxRateId: 'R' }] })!
  assert.equal(postedHeaderDiscountTaxType(parts), null, 'with per-rate parts the header code is not the discount\'s')
  assert.equal(postedShippingTaxType(null), null)
})

test('the posted code\'s rate is unioned into the index: a code on no row is priced at the posted rate, a code mapped to another rate stays ambiguous', () => {
  const posted = { ...postedTaxCodesFromPayload({ lines: [] })!, ratesByCode: new Map([['OLD', new Set(['0.05'])], ['BOTH', new Set(['0.05'])]]) }
  const index = withPostedCodeRates(buildTaxTypeRateIndex([{ accountingTaxType: 'NEW', rate: '0.05' }, { accountingTaxType: 'BOTH', rate: '0.2' }]), posted)
  assert.deepEqual([...index.get('OLD')!], ['0.05'])
  assert.deepEqual([...index.get('NEW')!], ['0.05'])
  assert.equal(index.get('BOTH')!.size, 2, 'the table disagrees with the posted rate: ambiguous, so the fence refuses')
  const untouched = buildTaxTypeRateIndex([{ accountingTaxType: 'NEW', rate: '0.05' }])
  assert.equal(withPostedCodeRates(untouched, null), untouched)
})

test('the record keeps the basis each code was bound on: goods and discount parts are sales_line, shipping and the header discount are plain', () => {
  const posted = postedTaxCodesFromPayload({
    lines: [{ taxType: 'L', taxRateId: 'R' }], shippingTaxType: 'S', shippingTaxRateId: 'R', discountTaxType: 'S', discountTaxRateId: 'R',
  })!
  assert.deepEqual(posted.rateIdsByCode.get('L'), [{ rateId: 'R', basis: 'sales_line' }])
  assert.deepEqual(posted.rateIdsByCode.get('S'), [{ rateId: 'R', basis: 'plain' }], 'bound once on the plain basis')
})

test('the retention projection keeps the posted codes and non-personal fields, drops names, emails, line text and the reference, and reads exactly like the original', () => {
  const original = {
    contactName: 'A Person', contactEmail: 'a@example.test', reference: 'SO-1', accountingInvoiceId: 'inv-1', date: '2026-01-02', currency: 'GBP',
    lines: [{ description: 'secret text', quantity: 2, unitAmount: 5, taxType: 'L', taxRateId: 'R', taxRateBasis: 'sales_line', itemCode: 'SKU' }],
    shippingTaxType: 'S', shippingTaxRateId: 'R', shippingTaxRateBasis: 'plain', discountTaxType: 'H', discountTaxRateId: 'R',
    discountParts: [{ amount: 3, taxType: 'P', taxRateId: 'R', taxRateBasis: 'sales_line' }],
  }
  const projection = postedInvoicePayloadProjection(original)
  const text = JSON.stringify(projection)
  for (const gone of ['A Person', 'a@example.test', 'secret text', 'SO-1']) assert.equal(text.includes(gone), false, gone)
  assert.equal(projection._compactedProjection, true)
  const a = postedTaxCodesFromPayload(original)!
  const b = postedTaxCodesFromPayload(projection)!
  assert.deepEqual([...b.lineCodeByRateId], [...a.lineCodeByRateId])
  assert.deepEqual([...b.discountCodeByRateId], [...a.discountCodeByRateId])
  assert.equal(b.shippingCode, a.shippingCode)
  assert.equal(b.headerDiscountCode, a.headerDiscountCode)
})

test('every other invoice row retention compacts keeps only the document id it names', () => {
  assert.deepEqual(invoiceRowTombstonePayload('SALES_INVOICE_UPDATE', { accountingInvoiceId: 'inv-1', contactName: 'x' }), { accountingInvoiceId: 'inv-1' })
  assert.equal(invoiceRowTombstonePayload('SALES_INVOICE', { lines: [] }), null)
  assert.equal(invoiceRowTombstonePayload('CREDIT_NOTE', { accountingInvoiceId: 'inv-1' }), null)
})
