import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { BillData, CreditNoteData, InvoiceData } from '@/lib/connectors/types'

/**
 * o3d-q0x56.3 - A FOREIGN XERO DOCUMENT NEVER LEAVES WITHOUT IMS'S RATE.
 *
 * An omitted `CurrencyRate` makes Xero apply its own XE.com day rate, a second FX reference the owner has ruled out (2026-10-24). So, at the
 * connector (defence in depth behind the enqueue refusal in tests/db/foreign-currency-rate-enqueue.test.ts):
 *
 *  - a foreign sales invoice, bill, sales credit note and supplier credit note WITHOUT a usable rate is refused BEFORE any request: no contact is
 *    created, no item is created, nothing is posted (the pure builders THROW, the push functions return a named failure);
 *  - a foreign document WITH a rate carries CurrencyRate = 1 / rate, to 6 dp, exactly;
 *  - a BASE-currency document is unchanged: with no rate it carries none, with a rate it carries it.
 *
 * Named mutations (each shown red, restored from a copy, md5-verified):
 *  a  rate-check-removed     xeroCurrencyRateOrRefuse returns undefined instead of throwing for a foreign document: every "refused" arm goes red
 *  b  every-currency-base    isForeignCurrency always answers false: every "refused" arm goes red
 *  c  rate-not-inverted      the rate is sent as given instead of 1/rate: every exact-value arm goes red
 *  d  prepare-check-late     the early check in a push function is removed (the builder still throws): the "no contact created" arm goes red
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
      return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'N', Status: 'AUTHORISED' }], CreditNotes: [{ CreditNoteID: 'cn-1', CreditNoteNumber: 'N', Status: 'AUTHORISED' }] } }
    },
    xeroPut: async (path: string, body: Record<string, unknown>) => {
      wire.push({ method: 'PUT', path, body })
      return { ok: true, status: 200, data: { Invoices: [{ InvoiceID: 'bill-1', InvoiceNumber: 'N', Status: 'AUTHORISED' }] } }
    },
  },
})
mock.module('@/lib/connectors/xero/contacts', {
  namedExports: { findOrCreateContact: async () => { contactResolves += 1; return { success: true, contactId: 'contact-1' } } },
})
mock.module('@/lib/connectors/xero/items', {
  namedExports: { findOrCreateItem: async () => { itemResolves += 1; return { success: true } } },
})

test.beforeEach(() => { wire.length = 0; contactResolves = 0; itemResolves = 0 })

const invoice = (extra: Partial<InvoiceData> = {}): InvoiceData => ({
  invoiceNumber: 'INV-1', contactName: 'Customer', date: '2026-08-20', currency: 'EUR',
  lines: [{ itemCode: 'SKU-1', description: 'Widget', quantity: 1, unitAmount: 10, accountCode: '200' }], ...extra,
}) as InvoiceData
const billData = (extra: Partial<BillData> = {}): BillData => ({
  invoiceNumber: 'B-1', contactName: 'Supplier', date: '2026-08-20', currency: 'EUR',
  lines: [{ description: 'Goods', quantity: 1, unitAmount: 10, accountCode: '630' }], ...extra,
}) as BillData
const credit = (extra: Partial<CreditNoteData> = {}): CreditNoteData => ({
  creditNoteNumber: 'SCN-scn-2', contactName: 'Supplier', date: '2026-08-20', currency: 'EUR',
  lines: [{ description: 'Credit', quantity: 1, unitAmount: 10, accountCode: '6200' }], ...extra,
}) as CreditNoteData

const UNUSABLE: Array<[string, unknown]> = [
  ['missing', undefined], ['null', null], ['zero', 0], ['negative', -1.17], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
  ['so large it rounds to zero', 1e12],
]

// ---- the pure builders THROW ---------------------------------------------------------------------------------------------------------

for (const [label, rate] of UNUSABLE) {
  test(`builders: a FOREIGN document with a ${label} rate throws before a payload exists (invoice, bill, supplier credit note)`, async () => {
    const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
    const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
    const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
    const r = rate as number | undefined
    assert.throws(() => buildSalesInvoicePayload(invoice({ currencyRateToBase: r }), 'AUTHORISED', 'c1', new Set(), 'GBP'), /EUR but carries no usable IMS rate to GBP/)
    assert.throws(() => buildPurchaseBillPayload(billData({ currencyRateToBase: r }), 'AUTHORISED', 'c1', 'GBP'), /EUR but carries no usable IMS rate to GBP/)
    assert.throws(() => buildXeroPurchaseCreditNote(credit({ currencyRateToBase: r }), 'AUTHORISED', 'c1', 'GBP'), /EUR but carries no usable IMS rate to GBP/)
  })
}

test('builders: a foreign document WITH a rate carries CurrencyRate = 1 / rate, to 6 dp, exactly', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  for (const [rate, expected] of [[1.17, 0.854701], [1.25, 0.8], [0.8, 1.25], [3, 0.333333], [1.1234567, 0.89011]] as const) {
    assert.equal(buildSalesInvoicePayload(invoice({ currencyRateToBase: rate }), 'AUTHORISED', 'c1', new Set(), 'GBP').CurrencyRate, expected, `invoice ${rate}`)
    assert.equal(buildPurchaseBillPayload(billData({ currencyRateToBase: rate }), 'AUTHORISED', 'c1', 'GBP').CurrencyRate, expected, `bill ${rate}`)
    assert.equal(buildXeroPurchaseCreditNote(credit({ currencyRateToBase: rate }), 'AUTHORISED', 'c1', 'GBP').CurrencyRate, expected, `credit note ${rate}`)
  }
})

test('builders: a BASE-currency document is unchanged - no rate omits CurrencyRate, a rate of 1 sends 1, a code in any case is base', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  for (const currency of ['GBP', 'gbp', ' GBP ']) {
    assert.equal('CurrencyRate' in buildSalesInvoicePayload(invoice({ currency }), 'AUTHORISED', 'c1', new Set(), 'GBP'), false)
    assert.equal('CurrencyRate' in buildPurchaseBillPayload(billData({ currency }), 'AUTHORISED', 'c1', 'GBP'), false)
    assert.equal('CurrencyRate' in buildXeroPurchaseCreditNote(credit({ currency }), 'AUTHORISED', 'c1', 'GBP'), false)
    assert.equal(buildSalesInvoicePayload(invoice({ currency, currencyRateToBase: 1 }), 'AUTHORISED', 'c1', new Set(), 'GBP').CurrencyRate, 1)
    assert.equal(buildPurchaseBillPayload(billData({ currency, currencyRateToBase: 1 }), 'AUTHORISED', 'c1', 'GBP').CurrencyRate, 1)
    assert.equal(buildXeroPurchaseCreditNote(credit({ currency, currencyRateToBase: 1 }), 'AUTHORISED', 'c1', 'GBP').CurrencyRate, 1)
  }
})

// ---- the push functions refuse before ANY request -----------------------------------------------------------------------------------

test('push: a foreign document without a rate is refused BEFORE the contact, item or document request (invoice, invoice update, bill, bill update, sales credit note)', async () => {
  const { pushSalesInvoice, updateSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { pushPurchaseBill, updatePurchaseBill } = await import('@/lib/connectors/xero/bills')
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const results = [
    await pushSalesInvoice(invoice(), 'AUTHORISED'),
    await updateSalesInvoice('inv-9', invoice(), 'AUTHORISED'),
    await pushPurchaseBill(billData(), 'AUTHORISED'),
    await updatePurchaseBill('bill-9', billData(), 'AUTHORISED'),
    await pushCreditNote(credit(), 'AUTHORISED'),
  ]
  for (const result of results) {
    assert.equal(result.success, false)
    assert.match(String(result.error), /EUR but carries no usable IMS rate to GBP/)
    assert.match(String(result.error), /XE\.com/)
  }
  assert.deepEqual(wire, [], 'nothing reached the wire')
  assert.equal(contactResolves, 0, 'no Xero contact was created for a document that cannot be sent')
  assert.equal(itemResolves, 0, 'no Xero item was created either')
})

test('push: a foreign SUPPLIER credit note without a rate is refused before the contact and the ledger lookup', async () => {
  const { pushPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const lookups: string[] = []
  const result = await pushPurchaseCreditNote(credit(), 'AUTHORISED', {
    firstAttempt: true, creditNote: { referenceType: 'SupplierCreditNote', referenceId: 'scn-2' },
    lookup: async (n) => { lookups.push(n); return { ok: true, claims: [] } },
  })
  assert.equal(result.success, false)
  assert.match(String(result.error), /EUR but carries no usable IMS rate to GBP/)
  assert.deepEqual(wire, [])
  assert.deepEqual(lookups, [])
  assert.equal(contactResolves, 0)
})

test('push: a foreign document WITH a rate posts, carrying 1 / rate on the body that leaves', async () => {
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { pushPurchaseBill } = await import('@/lib/connectors/xero/bills')
  const { pushCreditNote, pushPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  assert.equal((await pushSalesInvoice(invoice({ currencyRateToBase: 1.17 }), 'AUTHORISED')).success, true)
  assert.equal((await pushPurchaseBill(billData({ currencyRateToBase: 1.17 }), 'AUTHORISED')).success, true)
  assert.equal((await pushCreditNote(credit({ currencyRateToBase: 1.17 }), 'AUTHORISED')).success, true)
  assert.equal((await pushPurchaseCreditNote(credit({ currencyRateToBase: 1.17 }), 'AUTHORISED', {
    firstAttempt: true, creditNote: { referenceType: 'SupplierCreditNote', referenceId: 'scn-2' }, lookup: async () => ({ ok: true, claims: [] }),
  })).success, true)
  const posts = wire.filter((w) => w.method !== 'GET')
  assert.equal(posts.length, 4)
  for (const post of posts) assert.equal(post.body!.CurrencyRate, 0.854701, post.path)
})

test('push: a base-currency document posts exactly as before - no rate, no CurrencyRate', async () => {
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { pushPurchaseBill } = await import('@/lib/connectors/xero/bills')
  const { pushCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  assert.equal((await pushSalesInvoice(invoice({ currency: 'GBP' }), 'AUTHORISED')).success, true)
  assert.equal((await pushPurchaseBill(billData({ currency: 'GBP' }), 'AUTHORISED')).success, true)
  assert.equal((await pushCreditNote(credit({ currency: 'GBP' }), 'AUTHORISED')).success, true)
  const posts = wire.filter((w) => w.method !== 'GET')
  assert.equal(posts.length, 3)
  for (const post of posts) assert.equal('CurrencyRate' in post.body!, false, post.path)
})
