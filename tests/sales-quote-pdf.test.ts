import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The renderer is real; pdfkit is replaced by a recorder so the TEXT the document prints can be asserted (the real fonts encode glyph ids, not characters).
const printed: string[] = []
let headerTitle = ''
let template: Record<string, unknown> | null = null
const templateTypesAsked: string[] = []
const fakeDoc: Record<string, unknown> = {
  y: 100,
  currentLineHeight() { return 10 },
  font() { return fakeDoc }, fontSize() { return fakeDoc }, fillColor() { return fakeDoc },
  text(t: string) { printed.push(t); return fakeDoc },
}
mock.module('@/lib/db', {
  namedExports: {
    db: {
      currency: { findUnique: async () => null },
      organisation: { findFirst: async () => ({ timezone: 'Europe/London' }) },
      documentTemplate: { findUnique: async ({ where }: { where: { type: string } }) => { templateTypesAsked.push(where.type); return template } },
    },
  },
})

// Everything pdfkit-bound is replaced; the pure helpers the money block imports from the same module stay real. (Registered lazily: no top-level await in this CommonJS build.)
let pdfMocked = false
async function mockPdf() {
  if (pdfMocked) return
  const realPdf = await import('../lib/pdf.ts')
  mock.module('@/lib/pdf', {
    namedExports: {
      ...realPdf,
      createPdfDocument: () => ({ doc: fakeDoc, pageWidth: 495 }),
      drawHeader: async (_d: unknown, _b: unknown, o: { title: string }) => { headerTitle = o.title.toUpperCase() },
      drawTable: () => {},
      drawFooter: (_d: unknown, text: string) => { printed.push(`FOOTER:${text}`) },
      pdfToBuffer: async () => Buffer.from('%PDF-fake'),
    },
  })
  pdfMocked = true
}
const BRANDING = { companyName: 'Acme', legalName: 'Acme Ltd', vatNumber: '', companyNumber: '', address: '', phone: '', email: '', website: '', salesEmail: 'sales@acme.test', purchasesEmail: '', supportEmail: '', logoUrl: null, documentLogoUrl: null, primaryColor: '#000000', accentColor: '#111111' }
const ORDER = {
  id: 'so-1', orderNumber: 'SO-Q-1', externalOrderNumber: null, customerName: 'Buyer', customerEmail: 'b@example.test', currency: 'GBP', pricesIncludeVat: false, shoppingLinks: [],
  billingAddress: null, shippingAddress: null, subtotalForeign: 100, shippingForeign: 0, shippingService: null, taxForeign: 20, taxRateName: 'VAT', taxRatePercent: 0.2, totalForeign: 120, totalBase: 120,
  taxBase: 20, discountAmount: 0, invoiceNumber: null, invoicedAt: null, paidAt: null, expectedDelivery: null, notes: null, createdAt: new Date('2026-11-18T10:00:00.000Z'),
  quoteValidUntil: new Date('2026-12-31T00:00:00.000Z'),
  lines: [{ description: 'Widget', sku: 'W-1', qty: 2, unitPriceForeign: 50, discountAmount: 0, totalForeign: 100, taxForeign: 20, taxRate: { rate: 0.2 } }],
}
function reset(tpl: Record<string, unknown> | null) { printed.length = 0; headerTitle = ''; template = tpl; templateTypesAsked.length = 0 }

test('the quote document has a QUOTE heading, prints the validity date (as the stored calendar day) and its own template', async () => {
  await mockPdf()
  const { renderSalesOrderPdf } = await import('../lib/sales-order-pdf.ts')
  reset(null)
  const out = await renderSalesOrderPdf(ORDER, BRANDING, { variant: 'quote' })
  assert.equal(out.subarray(0, 4).toString(), '%PDF')
  assert.equal(headerTitle, 'QUOTE')
  assert.ok(printed.includes('Valid until 31 December 2026'), `validity line printed: ${JSON.stringify(printed)}`)
  assert.deepEqual(templateTypesAsked, ['quote'], 'the quote template, not the sales order one')
  assert.ok(printed.includes('FOOTER:Thank you for your enquiry.'))
  assert.ok(printed.some((t) => /not an order or an invoice/.test(t)), 'the built-in default template applies until one is saved')
})

test('a quote prints no payment terms even when its template switches them on; an order document still does', async () => {
  await mockPdf()
  const { renderSalesOrderPdf } = await import('../lib/sales-order-pdf.ts')
  const withTerms = { headerNote: null, footerNote: null, termsText: null, customFooter: null, showPaymentTerms: true, paymentTermsText: 'Net 30 days' }
  reset(withTerms)
  await renderSalesOrderPdf(ORDER, BRANDING, { variant: 'quote' })
  assert.ok(!printed.some((t) => /Payment terms/i.test(t)), 'no payment terms on a quote')
  reset(withTerms)
  await renderSalesOrderPdf(ORDER, BRANDING)
  assert.equal(headerTitle, 'SALES ORDER')
  assert.ok(printed.some((t) => t === 'Payment terms: Net 30 days'), 'the order document is unchanged')
  assert.ok(!printed.some((t) => /Valid until/.test(t)), 'and prints no validity line')
  assert.deepEqual(templateTypesAsked, ['sales_order'])
})

test('a saved Quote template replaces the built-in default (its notes print, the default footer does not)', async () => {
  await mockPdf()
  const { renderSalesOrderPdf } = await import('../lib/sales-order-pdf.ts')
  reset({ headerNote: 'Prices exclude carriage', footerNote: 'Custom footer note', termsText: null, customFooter: null, showPaymentTerms: false, paymentTermsText: null })
  await renderSalesOrderPdf(ORDER, BRANDING, { variant: 'quote' })
  assert.ok(printed.includes('Prices exclude carriage'))
  assert.ok(printed.includes('Custom footer note'))
  assert.ok(!printed.some((t) => /not an order or an invoice/.test(t)))
})

test('the download route serves a quote with the quote renderer and an order with the order one, through the single shared renderer', async () => {
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/sales-order/[id]/route.ts', import.meta.url), 'utf8')
  assert.match(route, /variant: so\.isQuote \? 'quote' : 'order'/)
  assert.doesNotMatch(route, /createPdfDocument/, 'the route has no renderer of its own')
  const email = readFileSync(new URL('../lib/order-email.ts', import.meta.url), 'utf8')
  assert.match(email, /renderSalesOrderPdf\(so, branding, \{ variant: 'order' \}\)/)
})
