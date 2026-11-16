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
mock.module('@/lib/connectors/xero/items', { namedExports: { findOrCreateItem: async () => ({ success: true }) } })

test.beforeEach(() => { sent.length = 0 })

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
import { fitLineToXeroUnitDp } from '@/lib/connectors/xero/write-path'
import { expectedLedgerTotal } from '@/lib/domain/sales/sales-invoice-reconciliation'

/** Xero's line total at unitdp=4: Quantity x UnitAmount (kept to 4dp), rounded to 2dp. */
const xeroLineTotal = (l: { Quantity: number; UnitAmount: number }) => roundQuantity(toDecimal(l.Quantity).mul(toDecimal(l.UnitAmount)), 2).toNumber()

test('fitLineToXeroUnitDp: 100.00 over 300 units (0.333333) would total 99.99 at 4dp, so the line is sent as one unit of its own total', () => {
  const naive = Math.round(300 * 0.3333 * 100) / 100
  assert.equal(naive, 99.99, 'the penny the report is about')
  const fit = fitLineToXeroUnitDp(300, 0.333333)
  assert.deepEqual(fit, { Quantity: 1, UnitAmount: 100, collapsed: true })
  assert.equal(xeroLineTotal(fit), 100)
})

test('fitLineToXeroUnitDp: a line the 4dp unit amount already reproduces is left alone (quantity kept)', () => {
  assert.deepEqual(fitLineToXeroUnitDp(3, 33.3333), { Quantity: 3, UnitAmount: 33.3333, collapsed: false })
  assert.deepEqual(fitLineToXeroUnitDp(3, 8.325), { Quantity: 3, UnitAmount: 8.325, collapsed: false })
  const sixDp = fitLineToXeroUnitDp(2, 1.234567)
  assert.deepEqual(sixDp, { Quantity: 2, UnitAmount: 1.2346, collapsed: false })
  assert.equal(xeroLineTotal(sixDp), 2.47)
})

test('every fitted line totals, at Xero\'s precision, what the IMS line totals (6dp unit prices, quantities 1..400)', () => {
  for (const unit of [0.333333, 0.666667, 1.234567, 9.990001, 0.014286, 33.333333, 0.166667]) {
    for (let q = 1; q <= 400; q++) {
      const fit = fitLineToXeroUnitDp(q, unit)
      assert.equal(xeroLineTotal(fit), roundQuantity(toDecimal(q).mul(toDecimal(unit)), 2).toNumber(), `${q} x ${unit}`)
    }
  }
})

test('invoice, credit note and bill built from a 300 x 0.333333 line carry the exact total, and the reconciliation expects the same figure', async () => {
  const { buildSalesInvoicePayload } = await import('@/lib/connectors/xero/invoices')
  const { buildPurchaseBillPayload } = await import('@/lib/connectors/xero/bills')
  const { buildXeroPurchaseCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const high = [{ itemCode: 'SKU-1', description: 'Bulk', quantity: 300, unitAmount: 0.333333, accountCode: '200', taxType: 'OUTPUT2' }]
  const payloads = [
    buildSalesInvoicePayload({ ...invoice, lines: high } as InvoiceData, 'AUTHORISED', 'c1', new Set(), 'GBP'),
    buildPurchaseBillPayload({ ...bill, lines: high } as BillData, 'AUTHORISED', 'c1', 'GBP'),
    buildXeroPurchaseCreditNote({ ...credit, lines: high } as CreditNoteData, 'AUTHORISED', 'c1', 'GBP'),
  ]
  for (const p of payloads) {
    const items = p.LineItems as Array<{ Description: string; Quantity: number; UnitAmount: number }>
    assert.equal(items.length, 1)
    assert.equal(xeroLineTotal(items[0]!), 100)
    assert.match(items[0]!.Description, /Bulk \(300 x 0\.333333\)/)
  }
  const expected = expectedLedgerTotal({
    lineAmountsIncludeTax: true, headerRate: 0.2,
    lines: [{ quantity: 300, unitAmount: 0.333333, discountAmount: 0, rate: 0.2, storedTax: 0 }],
  } as Parameters<typeof expectedLedgerTotal>[0])
  assert.equal(Math.round(expected * 100) / 100, 100)
})
