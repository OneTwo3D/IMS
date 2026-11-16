import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfDocument, pdfToBuffer, registerUnicodeFonts, sellerIdentityLines } from '../lib/pdf.ts'
import { invoiceDocumentIdentity, orderDocumentMoney, type OrderDocumentMoneyInput } from '../lib/pdf-order-money.ts'
import { draftCreditNoteModel, postedCreditNoteModel } from '../lib/domain/sales/credit-note-document.ts'
import { getSalesOrderReference } from '../lib/sales-order-display.ts'

// ---- the seller's legal identifiers --------------------------------------------------------------------------------------

test('seller identity lines print the VAT registration and company numbers, and omit blanks', () => {
  assert.deepEqual(sellerIdentityLines({ vatNumber: 'GB000000000', companyNumber: '00000000' }), ['VAT reg. no.: GB000000000', 'Company no.: 00000000'])
  assert.deepEqual(sellerIdentityLines({ vatNumber: ' GB000000000 ', companyNumber: '' }), ['VAT reg. no.: GB000000000'])
  assert.deepEqual(sellerIdentityLines({ vatNumber: '', companyNumber: '   ' }), [])
})

// ---- references ----------------------------------------------------------------------------------------------------------

test('the document reference is the display order number, never the database id', () => {
  assert.equal(getSalesOrderReference({ id: 'cmw9y3di0000abcd', orderNumber: 'SO-TEST-1', externalOrderNumber: '5501' }), 'SO-TEST-1')
  assert.equal(getSalesOrderReference({ id: 'cmw9y3di0000abcd', orderNumber: null, externalOrderNumber: '5501' }), '5501')
})

test('an invoice without a number is a Pro-forma Invoice carrying the order number; with one it shows both', () => {
  const none = invoiceDocumentIdentity({ id: 'cmw9y3di0000abcd', invoiceNumber: null, orderNumber: 'SO-TEST-1', externalOrderNumber: null })
  assert.deepEqual(none, { title: 'Pro-forma Invoice', reference: 'SO-TEST-1', orderReference: null })
  const numbered = invoiceDocumentIdentity({ id: 'cmw9y3di0000abcd', invoiceNumber: 'INV-0001', orderNumber: 'SO-TEST-1' })
  assert.deepEqual(numbered, { title: 'Invoice', reference: 'INV-0001', orderReference: 'SO-TEST-1' })
})

// ---- totals reconcile ------------------------------------------------------------------------------------------------------

const grossOrder: OrderDocumentMoneyInput = {
  pricesIncludeVat: true,
  shoppingLinks: [],
  taxRateName: 'VAT',
  taxRatePercent: 0.2,
  subtotalForeign: 96,
  discountAmount: 5.67,
  shippingForeign: 3.44,
  taxForeign: 18.943,
  totalForeign: 113.658,
  lines: [
    { qty: 1, unitPriceForeign: 28.8, discountAmount: 0, totalForeign: 24, taxForeign: 4.8, taxRate: { rate: 0.2 } },
    { qty: 1, unitPriceForeign: 86.4, discountAmount: 0, totalForeign: 72, taxForeign: 14.4, taxRate: { rate: 0.2 } },
  ],
}

test('a VAT-inclusive order prints gross lines, gross shipping and a Total the printed parts add up to', () => {
  const { view, totalsRows } = orderDocumentMoney(grossOrder)
  assert.equal(view.basisLabel, 'incl. VAT')
  assert.deepEqual(view.lines.map((l) => l.total), [28.8, 86.4])
  assert.equal(view.reconciles, true)
  const byLabel = Object.fromEntries(totalsRows.map((r) => [r.label, r.amount]))
  assert.equal(byLabel['Subtotal (incl. VAT)'], 115.2)
  assert.equal(byLabel['Discount (incl. VAT)'], -5.67)
  assert.equal(byLabel['Shipping (incl. VAT)'], 4.128) // net 3.44 grossed up, NOT the stored net
  assert.equal(byLabel['Total'], 113.658)
  const sum = byLabel['Subtotal (incl. VAT)'] + byLabel['Discount (incl. VAT)'] + byLabel['Shipping (incl. VAT)']
  assert.equal(Math.round(sum * 10000) / 10000, 113.658)
  assert.ok(totalsRows.some((r) => r.label.startsWith('Includes VAT') && r.amount === 18.943))
})

test('a net (storefront) order adds the VAT before the Total and reconciles', () => {
  const { view, totalsRows } = orderDocumentMoney({
    ...grossOrder,
    pricesIncludeVat: false,
    shoppingLinks: [{ connector: 'woocommerce' }],
    subtotalForeign: 100,
    discountAmount: 0,
    shippingForeign: 5,
    taxForeign: 21,
    totalForeign: 126,
    lines: [{ qty: 2, unitPriceForeign: 50, discountAmount: 0, totalForeign: 100, taxForeign: 20, taxRate: { rate: 0.2 } }],
  })
  assert.equal(view.basisLabel, 'excl. VAT')
  assert.equal(view.reconciles, true)
  const above = totalsRows.slice(0, totalsRows.findIndex((r) => r.strong))
  assert.equal(Math.round(above.reduce((s, r) => s + r.amount, 0) * 100) / 100, 126)
  assert.equal(totalsRows.find((r) => r.strong)?.amount, 126)
  assert.equal(totalsRows.find((r) => /^VAT/.test(r.label))?.amount, 21)
})

// ---- credit note -----------------------------------------------------------------------------------------------------------

test("a draft credit note's rows add up to its total, at each line's own rate", () => {
  const { rows, rounding, total } = draftCreditNoteModel({
    currency: 'GBP',
    orderTaxRatePercent: 0.2,
    orderLines: [{ id: 'l1', qty: 1, unitPriceForeign: 10, discountAmount: 0, totalForeign: 10, taxForeign: 2, taxRatePercent: 0.2 }],
    refundLines: [
      { salesOrderLineId: 'l1', postedNet: 10, vatRate: 0.2, description: 'Widget', qty: 1 },
      { salesOrderLineId: null, postedNet: 5.55, vatRate: 0, description: 'Shipping', qty: 1 },
    ],
  })
  assert.deepEqual(rows.map((r) => [r.net, r.vat, r.gross]), [[10, 2, 12], [5.55, 0, 5.55]])
  assert.deepEqual(total, { net: 15.55, vat: 2, gross: 17.55 })
  assert.equal(rounding, null)
})

test('two 0.005 lines: each posts as 0.01 (Xero rounds the line amount), so the rows sum to the total with no Rounding row', () => {
  const { rows, rounding, total } = postedCreditNoteModel({
    currency: 'GBP',
    payloadLines: [{ description: 'A', quantity: 1, unitAmount: 0.005 }, { description: 'B', quantity: 1, unitAmount: 0.005 }],
    lineAmountsIncludeTax: false,
    vatIsOwnLine: false,
    rateOf: () => 0,
  })
  assert.deepEqual(rows.map((r) => r.gross), [0.01, 0.01])
  assert.deepEqual(total, { net: 0.02, vat: 0, gross: 0.02 })
  assert.equal(rounding, null)
  const sum = (k: 'net' | 'vat' | 'gross') => Math.round((rows.reduce((s, r) => s + r[k], 0) + (rounding?.[k] ?? 0)) * 100) / 100
  assert.deepEqual({ net: sum('net'), vat: sum('vat'), gross: sum('gross') }, total)
})

test('a posted credit note prints its payload lines as queued, whatever the current rates; a scheme credit note carries its VAT as its own line', () => {
  const plain = postedCreditNoteModel({
    currency: 'GBP',
    payloadLines: [{ description: 'Widget', quantity: 2, unitAmount: 10 }],
    lineAmountsIncludeTax: false,
    vatIsOwnLine: false,
    rateOf: () => 0.2, // the frozen rate, handed in by the route; no tax table is read here
  })
  assert.deepEqual(plain.total, { net: 20, vat: 4, gross: 24 })
  const scheme = postedCreditNoteModel({
    currency: 'GBP',
    payloadLines: [{ description: 'Widget', quantity: 1, unitAmount: 10 }, { description: 'VAT', quantity: 1, unitAmount: 1.9, noTaxKind: 'eu-vat-recovery' }],
    lineAmountsIncludeTax: false,
    vatIsOwnLine: true,
    rateOf: () => 0.2,
  })
  assert.deepEqual(scheme.rows.map((r) => [r.net, r.vat, r.gross]), [[10, 0, 10], [0, 1.9, 1.9]])
  assert.deepEqual(scheme.total, { net: 10, vat: 1.9, gross: 11.9 })
  assert.equal(scheme.rounding, null)
  // a fee on NONE and a rounding-difference line stay net lines of their own kind
  const kinds = postedCreditNoteModel({
    currency: 'GBP',
    payloadLines: [{ description: 'Fee', quantity: 1, unitAmount: 2, noTaxKind: 'fee-no-tax' }, { description: 'Rounding', quantity: 1, unitAmount: 0.01, noTaxKind: 'rounding-difference' }],
    lineAmountsIncludeTax: false,
    vatIsOwnLine: true,
    rateOf: () => 0.2,
  })
  assert.deepEqual(kinds.total, { net: 2.01, vat: 0, gross: 2.01 })
})

// ---- Unicode ---------------------------------------------------------------------------------------------------------------

test('document text is drawn in an embedded Unicode font: accented, Latin Extended, Greek, Cyrillic and the em dash survive', async () => {
  const { doc } = createPdfDocument({ title: 'T' })
  assert.equal(registerUnicodeFonts(doc), true)
  doc.font('Helvetica')
  const text = 'Müller — Łódź Σίγμα Жуков £€'
  assert.ok(doc.widthOfString(text) > 0)
  // every character has a glyph in the embedded face (the built-in WinAnsi Helvetica has none for Ł, Σ, Ж)
  assert.ok(doc.widthOfString('Ж') > 0 && doc.widthOfString('Ł') > 0) // glyphs the built-in WinAnsi Helvetica does not have
  doc.text(text, 50, 50)
  doc.font('Helvetica-Bold').text(text)
  const pdf = (await pdfToBuffer(doc)).toString('latin1')
  assert.match(pdf, /FontFile2/)
  assert.match(pdf, /LiberationSans/)
})
