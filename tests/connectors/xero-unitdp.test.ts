import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { BillData, CreditNoteData, InvoiceData } from '@/lib/connectors/types'

/**
 * Xero keeps only 2 decimal places of a line UnitAmount unless the request carries `unitdp=4`. IMS sends 4-6 dp, so without it a
 * 3-unit line at 33.3333 was totalled by Xero as 3 x 33.33 = 99.99 against the order's 100.00 (and 9.99 incl. x 3 at 20% came out 2p short).
 *
 * The parameter is added in ONE place (`xeroWritePath`, used by the transport for every POST/PUT). These tests cover the helper, and then
 * the real invoice / bill / credit-note / supplier-credit posters with the transport faked at the module boundary and the REAL helper applied
 * to the path each of them hands it, so the URL that would leave is asserted per document type. Nothing here touches the network.
 */

import { xeroWritePath } from '@/lib/connectors/xero/write-path'

const sent: Array<{ method: string; url: string; body: Record<string, unknown> }> = []
const respond = {
  ok: true, status: 200,
  data: {
    Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'N', Status: 'AUTHORISED' }],
    CreditNotes: [{ CreditNoteID: 'cn-1', CreditNoteNumber: 'N', Status: 'AUTHORISED' }],
  },
}
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, status: 200, data: { CreditNotes: [] } }),
    xeroPost: async (path: string, body: Record<string, unknown>) => { sent.push({ method: 'POST', url: xeroWritePath('POST', path), body }); return respond },
    xeroPut: async (path: string, body: Record<string, unknown>) => { sent.push({ method: 'PUT', url: xeroWritePath('PUT', path), body }); return respond },
  },
})
mock.module('@/lib/connectors/xero/contacts', { namedExports: { findOrCreateContact: async () => ({ success: true, contactId: 'contact-1' }) } })
// Items the fake Xero reports as IsTrackedAsInventory: the quantity of a line on one of them must reach Xero untouched.
const trackedItemCodes = new Set<string>()
let settingsRounding = '860'
mock.module('@/lib/connectors/xero/items', { namedExports: { findOrCreateItem: async (code: string) => ({ success: true, itemId: `item-${code}`, isTracked: trackedItemCodes.has(code) }) } })
mock.module('@/lib/connectors/xero/settings', { namedExports: { getXeroSettings: async () => ({ xero_rounding_difference_account: settingsRounding }) } })

test.beforeEach(() => { sent.length = 0; trackedItemCodes.clear(); settingsRounding = '860' })

const lines = [{ itemCode: 'SKU-1', description: 'Widget', quantity: 3, unitAmount: 33.3333, accountCode: '200', taxType: 'OUTPUT2' }]
const invoice = { invoiceNumber: 'INV-1', contactName: 'C', date: '2026-08-20', currency: 'GBP', lines } as InvoiceData
const bill = { invoiceNumber: 'B-1', contactName: 'S', date: '2026-08-20', currency: 'GBP', lines } as BillData
const credit = { creditNoteNumber: 'SCN-scn-2', contactName: 'C', date: '2026-08-20', currency: 'GBP', lines } as CreditNoteData

test('xeroWritePath: every line-item write endpoint gets unitdp=4; reads and non-document writes are untouched', () => {
  for (const path of ['Invoices', 'CreditNotes', 'PurchaseOrders', 'Invoices/abc-123', 'CreditNotes/abc-123', 'PurchaseOrders/abc-123']) {
    for (const method of ['POST', 'PUT'] as const) assert.equal(xeroWritePath(method, path), `${path}?unitdp=4`, `${method} ${path}`)
  }
  assert.equal(xeroWritePath('POST', 'Invoices?summarizeErrors=false'), 'Invoices?summarizeErrors=false&unitdp=4')
  assert.equal(xeroWritePath('POST', 'Invoices?unitdp=2'), 'Invoices?unitdp=2', 'an explicit value is never overridden')
  for (const path of ['Invoices', 'CreditNotes', 'Invoices/abc-123']) assert.equal(xeroWritePath('GET', path), path)
  for (const path of ['Payments', 'Contacts', 'Items', 'ManualJournals', 'TaxRates', 'Invoices/abc/History', 'CreditNotes/abc/Allocations']) {
    assert.equal(xeroWritePath('POST', path), path, path)
  }
})

test('each document poster sends unitdp=4: invoice, invoice update, bill, bill update, credit note, supplier credit note', async () => {
  const { pushSalesInvoice, updateSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { pushPurchaseBill, updatePurchaseBill } = await import('@/lib/connectors/xero/bills')
  const { pushCreditNote, pushPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  assert.equal((await pushSalesInvoice(invoice, 'AUTHORISED')).success, true)
  assert.equal((await updateSalesInvoice('inv-9', invoice, 'AUTHORISED')).success, true)
  assert.equal((await pushPurchaseBill(bill, 'AUTHORISED')).success, true)
  assert.equal((await updatePurchaseBill('bill-9', bill, 'AUTHORISED')).success, true)
  assert.equal((await pushCreditNote(credit, 'AUTHORISED')).success, true)
  const supplier = await pushPurchaseCreditNote(credit, 'AUTHORISED', {
    firstAttempt: true, creditNote: { referenceType: 'SupplierCreditNote', referenceId: 'scn-2' }, lookup: async () => ({ ok: true, claims: [] }),
  })
  assert.equal(supplier.success, true, String(supplier.error))
  assert.deepEqual(sent.map((s) => `${s.method} ${s.url}`), [
    'POST Invoices?unitdp=4', 'POST Invoices/inv-9?unitdp=4', 'PUT Invoices?unitdp=4', 'POST Invoices/bill-9?unitdp=4',
    'POST CreditNotes?unitdp=4', 'POST CreditNotes?unitdp=4',
  ])
})

test('a 3-unit line at 33.3333 is sent at 4dp and totals 100.00 at unitdp=4 (not 99.99 as at 2dp)', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const payloads = [
    buildSalesInvoicePayload(invoice, 'AUTHORISED', 'c1', new Set(), 'GBP'),
    buildPurchaseBillPayload(bill, 'AUTHORISED', 'c1', 'GBP'),
    buildXeroPurchaseCreditNote(credit, 'AUTHORISED', 'c1', 'GBP'),
  ]
  for (const p of payloads) {
    const line = (p.LineItems as Array<{ UnitAmount: number; Quantity: number }>)[0]!
    assert.equal(line.UnitAmount, 33.3333, 'the 4dp unit amount is not pre-rounded')
    // Xero: line total = round2(Quantity x UnitAmount at the kept precision).
    assert.equal(Math.round(line.Quantity * line.UnitAmount * 100) / 100, 100)
    assert.equal(line.Quantity * Math.round(line.UnitAmount * 100) / 100, 99.99, 'what a 2dp unit amount would have produced')
  }
})

// ---- six-decimal unit prices at a high quantity: unitdp=4 alone is not enough ---------------------------------------------------------

import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { unitDpLineGap, xeroUnitDpFields, XeroRoundingAccountMissingError } from '@/lib/connectors/xero/write-path'
import { expectedLedgerTotal } from '@/lib/domain/sales/sales-invoice-reconciliation'

type Wire = { Description?: string; Quantity: number; UnitAmount: number; ItemCode?: string; AccountCode?: string; TaxType?: string }
/** Xero's document total at unitdp=4: each line is Quantity x UnitAmount, rounded to 2dp. */
const xeroTotal = (items: Wire[]) => items.reduce((t, l) => t + roundQuantity(toDecimal(l.Quantity).mul(toDecimal(l.UnitAmount)), 2).toNumber(), 0)
const high = [{ itemCode: 'SKU-300', description: 'Bulk', quantity: 300, unitAmount: 0.333333, accountCode: '200', taxType: 'OUTPUT2' }]

test('an ItemCode line at 300 x 0.333333 keeps quantity 300 and gets a separate 0.01 rounding line on the Rounding account; the document totals 100.00', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const payloads = [
    buildSalesInvoicePayload({ ...invoice, lines: high } as InvoiceData, 'AUTHORISED', 'c1', new Set(), 'GBP', '860'),
    buildPurchaseBillPayload({ ...bill, lines: high } as BillData, 'AUTHORISED', 'c1', 'GBP', '860'),
    buildXeroPurchaseCreditNote({ ...credit, lines: high } as CreditNoteData, 'AUTHORISED', 'c1', 'GBP', '860'),
  ]
  for (const p of payloads) {
    const items = p.LineItems as Wire[]
    assert.equal(items.length, 2)
    assert.equal(items[0]!.Quantity, 300, 'the real quantity is kept')
    assert.equal(items[0]!.ItemCode, 'SKU-300')
    assert.equal(items[0]!.UnitAmount, 0.3333)
    assert.equal(items[1]!.ItemCode, undefined, 'the rounding line carries no item')
    assert.deepEqual(items[1], { Description: 'Rounding adjustment', Quantity: 1, UnitAmount: 0.01, AccountCode: '860', TaxType: 'NONE' })
    assert.equal(xeroTotal(items), 100)
  }
  const expected = expectedLedgerTotal({ lineAmountsIncludeTax: true, headerRate: 0.2, lines: [{ quantity: 300, unitAmount: 0.333333, discountAmount: 0, rate: 0.2, storedTax: 0 }] } as Parameters<typeof expectedLedgerTotal>[0])
  assert.equal(Math.round(expected * 100) / 100, 100, 'the reconciliation expects the same total')
})

test('no Rounding account mapped: the builders throw and every poster refuses before a contact, an item or a request', async () => {
  const { buildSalesInvoicePayload, pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  for (const account of [undefined, null, '', '  ']) {
    assert.throws(() => buildSalesInvoicePayload({ ...invoice, lines: high } as InvoiceData, 'AUTHORISED', 'c1', new Set(), 'GBP', account), XeroRoundingAccountMissingError)
    assert.throws(() => buildPurchaseBillPayload({ ...bill, lines: high } as BillData, 'AUTHORISED', 'c1', 'GBP', account), /Map a Rounding account/)
    assert.throws(() => buildXeroPurchaseCreditNote({ ...credit, lines: high } as CreditNoteData, 'AUTHORISED', 'c1', 'GBP', account), /Map a Rounding account/)
  }
  settingsRounding = ''
  const refused = await pushSalesInvoice({ ...invoice, lines: high } as InvoiceData, 'AUTHORISED')
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /Map a Rounding account/)
  assert.equal(sent.length, 0, 'nothing was sent')
  settingsRounding = '860'
  assert.equal((await pushSalesInvoice({ ...invoice, lines: high } as InvoiceData, 'AUTHORISED')).success, true)
  assert.equal(((sent[0]!.body.LineItems) as Wire[]).at(-1)!.AccountCode, '860')
})

test('a line the 4dp unit price already reproduces gets no rounding line and needs no account', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const items = buildSalesInvoicePayload(invoice, 'AUTHORISED', 'c1', new Set(), 'GBP').LineItems as Wire[]
  assert.equal(items.length, 1)
  assert.equal(items[0]!.Quantity, 3)
  assert.equal(unitDpLineGap([{ quantity: 3, unitAmount: 8.325 }]).toNumber(), 0)
})

test('a tracked Xero item keeps its quantity: the posted line quantity is the IMS quantity, and the guard refuses any altered one', async () => {
  trackedItemCodes.add('SKU-300')
  const { pushSalesInvoice } = await import('@/lib/connectors/xero/invoices')
  const { assertXeroLineQuantitiesKept } = await import('@/lib/connectors/xero/write-path')
  assert.equal((await pushSalesInvoice({ ...invoice, lines: high } as InvoiceData, 'AUTHORISED')).success, true)
  const line = (sent[0]!.body.LineItems as Wire[])[0]!
  assert.equal(line.ItemCode, 'SKU-300')
  assert.equal(line.Quantity, 300)
  assert.throws(() => assertXeroLineQuantitiesKept([{ quantity: 300 }], [{ Quantity: 1 }]), /never altered/)
  assert.doesNotThrow(() => assertXeroLineQuantitiesKept([{ quantity: 300 }], [{ Quantity: 300 }]))
})

test('a sweep of 6dp unit prices x quantities 1..400: with the rounding line every document totals what the IMS lines total', () => {
  for (const unit of [0.333333, 0.666667, 1.234567, 9.990001, 0.014286, 33.333333, 0.166667]) {
    for (let q = 1; q <= 400; q++) {
      const gap = unitDpLineGap([{ quantity: q, unitAmount: unit }]).toNumber()
      const items: Wire[] = [xeroUnitDpFields(q, unit)]
      if (gap !== 0) items.push({ Quantity: 1, UnitAmount: gap })
      assert.equal(Math.round(xeroTotal(items) * 100), Math.round(q * unit * 100 + 1e-7), `${q} x ${unit}`)
    }
  }
})
