import assert from 'node:assert/strict'
import test from 'node:test'

import { postedDiscountTaxType, postedLineTaxType, postedTaxCodesFromPayload, postedTaxTypeByLineId } from '@/lib/domain/sales/posted-invoice-tax-codes'
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
