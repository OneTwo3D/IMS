import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { CreditNoteData, InvoiceData } from '@/lib/connectors/types'

/**
 * The Xero connector's refusal floor: a sales invoice (create and update) or credit note with a line that has no decided tax type is
 * refused BEFORE any request - no contact, no item, nothing on the wire - and the pure builder throws. NONE posts only on a line that
 * names why, and the name is never sent.
 */

const wire: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
let contactResolves = 0
let itemResolves = 0

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => { wire.push({ method: 'GET', path }); return { ok: true, status: 200, data: { CreditNotes: [] } } },
    xeroPost: async (path: string, body: Record<string, unknown>) => {
      wire.push({ method: 'POST', path, body })
      return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'N', Status: 'AUTHORISED' }], CreditNotes: [{ CreditNoteID: 'cn-1' }] } }
    },
    xeroPut: async (path: string, body: Record<string, unknown>) => { wire.push({ method: 'PUT', path, body }); return { ok: true, status: 200, data: {} } },
  },
})
mock.module('@/lib/connectors/xero/contacts', {
  namedExports: { findOrCreateContact: async () => { contactResolves += 1; return { success: true, contactId: 'contact-1' } } },
})
mock.module('@/lib/connectors/xero/items', {
  namedExports: { findOrCreateItem: async () => { itemResolves += 1; return { success: true } } },
})

test.beforeEach(() => { wire.length = 0; contactResolves = 0; itemResolves = 0 })

const line = { itemCode: 'SKU-1', description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200', taxType: 'OUTPUT2' }
const invoice = (extra: Partial<InvoiceData> = {}): InvoiceData => ({
  invoiceNumber: 'INV-1', contactName: 'Customer', date: '2026-11-02', currency: 'GBP', lines: [line], ...extra,
}) as InvoiceData
const credit = (extra: Partial<CreditNoteData> = {}): CreditNoteData => ({
  creditNoteNumber: 'CN-1', contactName: 'Customer', date: '2026-11-02', currency: 'GBP', lines: [line], ...extra,
}) as CreditNoteData

const BAD: Array<[string, Partial<InvoiceData>]> = [
  ['a product line with no TaxType', { lines: [{ ...line, taxType: undefined }] }],
  ['a product line with a blank TaxType', { lines: [{ ...line, taxType: '  ' }] }],
  ['shipping with no TaxType', { shippingAmount: 4, shippingAccountCode: '300' }],
  ['an order discount with no TaxType', { discountAmount: 2, discountAccountCode: '310' }],
  ['an explicit NONE on an ordinary line', { lines: [{ ...line, taxType: 'NONE' }] }],
  ['an explicit NONE on shipping', { shippingAmount: 4, shippingAccountCode: '300', shippingTaxType: 'NONE' }],
  ['an explicit NONE on the order discount', { discountAmount: 2, discountAccountCode: '310', discountTaxType: 'NONE' }],
]

for (const [label, extra] of BAD) {
  test(`builder throws and ${label} is refused before any request (invoice create and update)`, async () => {
    const { buildSalesInvoicePayload, pushSalesInvoice, updateSalesInvoice } = await import('@/lib/connectors/xero/invoices')
    assert.throws(() => buildSalesInvoicePayload(invoice(extra), 'AUTHORISED', 'c1', new Set(), 'GBP'), /NOTHING WAS SENT/)
    for (const result of [await pushSalesInvoice(invoice(extra), 'AUTHORISED'), await updateSalesInvoice('inv-9', invoice(extra), 'AUTHORISED')]) {
      assert.equal(result.success, false)
      assert.match(String(result.error), /^NOTHING WAS SENT\. Sales invoice INV-1 was refused/)
    }
    assert.deepEqual(wire, [], 'nothing reached the wire')
    assert.equal(contactResolves, 0, 'no Xero contact was created')
    assert.equal(itemResolves, 0, 'no Xero item was created')
  })
}

test('a credit note line with no TaxType, or an explicit NONE, is refused before any request', async () => {
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  for (const taxType of [undefined, '', 'NONE']) {
    const result = await pushCreditNote(credit({ lines: [{ ...line, taxType }] }), 'AUTHORISED')
    assert.equal(result.success, false)
    assert.match(String(result.error), /^NOTHING WAS SENT\. Credit note CN-1 was refused/)
  }
  assert.deepEqual(wire, [])
  assert.equal(contactResolves, 0)
})

test('a fully typed document posts, with the type it was given; the line-kind name is never sent', async () => {
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const withFee = invoice({
    lines: [line, { description: 'Import Duty', quantity: 1, unitAmount: 3, accountCode: '260', taxType: 'NONE', noTaxKind: 'fee-no-tax' }],
    shippingAmount: 4, shippingAccountCode: '300', shippingTaxType: 'OUTPUT2',
    discountAmount: 1, discountAccountCode: '310', discountTaxType: 'OUTPUT2',
  })
  assert.equal((await pushSalesInvoice(withFee, 'AUTHORISED')).success, true)
  assert.equal((await pushCreditNote(credit({ lines: [line, { ...withFee.lines[1] }] }), 'AUTHORISED')).success, true)
  const sent = wire.filter((w) => w.method === 'POST')
  assert.equal(sent.length, 2)
  const invoiceLines = sent[0].body!.LineItems as Array<Record<string, unknown>>
  assert.deepEqual(invoiceLines.map((l) => l.TaxType), ['OUTPUT2', 'NONE', 'OUTPUT2', 'OUTPUT2'])
  const creditLines = sent[1].body!.LineItems as Array<Record<string, unknown>>
  assert.deepEqual(creditLines.map((l) => l.TaxType), ['OUTPUT2', 'NONE'])
  for (const l of [...invoiceLines, ...creditLines]) assert.equal('noTaxKind' in l, false)
})

test('a SUPPLIER credit note keeps its own default: the floor is sales documents only (bills are filed separately)', async () => {
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const built = buildXeroPurchaseCreditNote(credit({ lines: [{ ...line, taxType: undefined }] }), 'AUTHORISED', 'c1', 'GBP')
  assert.equal((built.LineItems as Array<Record<string, unknown>>)[0].TaxType, 'NONE')
})
