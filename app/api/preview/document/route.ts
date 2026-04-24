import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { db } from '@/lib/db'
import {
  getBranding,
  createPdfDocument,
  drawHeader,
  drawTable,
  drawFooter,
  drawTemplateNotes,
  pdfToBuffer,
  type PdfTableColumn,
  type Branding,
} from '@/lib/pdf'

const SAMPLE_RECIPIENT = {
  name: 'Acme Manufacturing Ltd',
  contact: 'John Smith',
  address: '123 Industrial Estate\nBirmingham\nB1 2AB\nGB',
  email: 'orders@acme-mfg.co.uk',
}

const SAMPLE_LINES = [
  { sku: 'PLA-BLK-1KG', name: 'PLA Filament Black 1kg', qty: 10, price: 18.99, tax: 3.80, total: 22.79 },
  { sku: 'PLA-WHT-1KG', name: 'PLA Filament White 1kg', qty: 5, price: 18.99, tax: 1.90, total: 20.89 },
  { sku: 'PETG-BLU-1KG', name: 'PETG Filament Blue 1kg', qty: 8, price: 22.50, tax: 3.60, total: 26.10 },
  { sku: 'NZL-04-BRS', name: 'Brass Nozzle 0.4mm', qty: 20, price: 4.50, tax: 1.80, total: 6.30 },
  { sku: 'BED-PEI-235', name: 'PEI Build Plate 235x235mm', qty: 3, price: 24.99, tax: 1.50, total: 26.49 },
]

const TODAY = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

async function getTemplate(type: string) {
  return db.documentTemplate.findUnique({ where: { type } })
}

async function generateInvoicePreview(branding: Branding) {
  const tpl = await getTemplate('invoice')
  const { doc } = createPdfDocument({ title: 'Invoice Preview' })

  await drawHeader(doc, branding, {
    title: 'Invoice',
    reference: 'INV-2026-00042',
    date: TODAY(),
    recipient: SAMPLE_RECIPIENT,
  })

  drawTemplateNotes(doc, tpl, 'header')

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 230 },
    { label: 'Qty', width: 40, align: 'right' },
    { label: 'Price (£)', width: 65, align: 'right' },
    { label: 'Tax (£)', width: 55, align: 'right' },
    { label: 'Total (£)', width: 75, align: 'right' },
  ]
  const rows = SAMPLE_LINES.map((l, i) => [String(i + 1), `${l.name} (${l.sku})`, String(l.qty), l.price.toFixed(2), l.tax.toFixed(2), l.total.toFixed(2)])
  drawTable(doc, columns, rows, branding)

  // Totals aligned with last table column (right edge = 540)
  doc.y += 5
  const valRight = 540 // table right edge
  const valW = 75      // same as Total column width
  const lblW = 70
  const lblX = valRight - valW - lblW
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  doc.text('Subtotal:', lblX, doc.y, { width: lblW, align: 'right' })
  doc.text('£524.50', valRight - valW, doc.y - doc.currentLineHeight(), { width: valW, align: 'right' })
  doc.text('VAT (20%):', lblX, doc.y, { width: lblW, align: 'right' })
  doc.text('£104.90', valRight - valW, doc.y - doc.currentLineHeight(), { width: valW, align: 'right' })
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total:', lblX, doc.y + 3, { width: lblW, align: 'right' })
  doc.text('£629.40', valRight - valW, doc.y - doc.currentLineHeight(), { width: valW, align: 'right' })

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'Thank you for your business.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  return pdfToBuffer(doc)
}

async function generateSalesOrderPreview(branding: Branding) {
  const tpl = await getTemplate('sales_order')
  const { doc } = createPdfDocument({ title: 'Sales Order Preview' })

  await drawHeader(doc, branding, {
    title: 'Sales Order',
    reference: 'SO-2026-00107',
    date: TODAY(),
    recipient: SAMPLE_RECIPIENT,
  })

  drawTemplateNotes(doc, tpl, 'header')

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Description', width: 195 },
    { label: 'Qty', width: 40, align: 'right' },
    { label: 'Price (£)', width: 65, align: 'right' },
    { label: 'Discount', width: 50, align: 'right' },
    { label: 'Total (£)', width: 65, align: 'right' },
  ]
  const rows = SAMPLE_LINES.map((l, i) => [String(i + 1), l.sku, l.name, String(l.qty), l.price.toFixed(2), '', l.total.toFixed(2)])
  drawTable(doc, columns, rows, branding)

  // Totals aligned with last column
  doc.y += 5
  const lastCol = columns[columns.length - 1]
  const tableRight = 50 + columns.reduce((s, c) => s + c.width, 0)
  const vW = lastCol.width
  const lW = 70
  const lX = tableRight - vW - lW
  doc.font('Helvetica').fontSize(9).fillColor('#666')
  doc.text('Subtotal:', lX, doc.y, { width: lW, align: 'right' })
  doc.text('£524.50', tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  doc.text('Shipping:', lX, doc.y, { width: lW, align: 'right' })
  doc.text('£8.99', tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total:', lX, doc.y + 3, { width: lW, align: 'right' })
  doc.text('£533.49', tableRight - vW, doc.y - doc.currentLineHeight(), { width: vW, align: 'right' })

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'Thank you for your order.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  return pdfToBuffer(doc)
}

async function generatePurchaseOrderPreview(branding: Branding) {
  const tpl = await getTemplate('purchase_order')
  const { doc } = createPdfDocument({ title: 'Purchase Order Preview' })

  await drawHeader(doc, branding, {
    title: 'Purchase Order',
    reference: 'PO-20260405-X7K2',
    date: TODAY(),
    recipient: { ...SAMPLE_RECIPIENT, name: 'Filament Supplies GmbH', address: 'Industriestr. 42\n10115 Berlin\nDE' },
  })

  drawTemplateNotes(doc, tpl, 'header')

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Product', width: 150 },
    { label: 'Barcode / EAN', width: 90 },
    { label: 'Qty', width: 50, align: 'right' },
    { label: 'Unit Price', width: 55, align: 'right' },
    { label: 'Total', width: 55, align: 'right' },
  ]
  const rows = SAMPLE_LINES.map((l, i) => [String(i + 1), l.sku, l.name, '501234567890' + i, String(l.qty), `£${l.price.toFixed(2)}`, `£${(l.qty * l.price).toFixed(2)}`])
  drawTable(doc, columns, rows, branding)

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'Please confirm receipt of this order.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.purchasesEmail })
  return pdfToBuffer(doc)
}

async function generateRfqPreview(branding: Branding) {
  const tpl = await getTemplate('rfq')
  const { doc } = createPdfDocument({ title: 'RFQ Preview' })

  await drawHeader(doc, branding, {
    title: 'Request for Quotation',
    reference: 'PO-20260405-R3Q1',
    date: TODAY(),
    recipient: { ...SAMPLE_RECIPIENT, name: 'Filament Supplies GmbH', address: 'Industriestr. 42\n10115 Berlin\nDE' },
  })

  drawTemplateNotes(doc, tpl, 'header')

  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Please provide your best quotation for the following items:', 50, doc.y)
  doc.y += 12

  const columns: PdfTableColumn[] = [
    { label: '#', width: 30, align: 'right' },
    { label: 'SKU', width: 80 },
    { label: 'Product', width: 170 },
    { label: 'Barcode / EAN', width: 95 },
    { label: 'Quantity', width: 65, align: 'right' },
    { label: 'Unit', width: 55, align: 'right' },
  ]
  const rows = SAMPLE_LINES.map((l, i) => [String(i + 1), l.sku, l.name, '501234567890' + i, String(l.qty), 'pcs'])
  drawTable(doc, columns, rows, branding)

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'Please reply with your quotation including unit prices, lead time, and shipping costs.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.purchasesEmail })
  return pdfToBuffer(doc)
}

async function generatePackingSlipPreview(branding: Branding) {
  const tpl = await getTemplate('packing_slip')
  const { doc } = createPdfDocument({ title: 'Packing Slip Preview' })

  await drawHeader(doc, branding, {
    title: 'Packing Slip',
    reference: 'SO-2026-00107',
    date: TODAY(),
    recipient: SAMPLE_RECIPIENT,
  })

  drawTemplateNotes(doc, tpl, 'header')

  const columns: PdfTableColumn[] = [
    { label: '#', width: 30, align: 'right' },
    { label: 'SKU', width: 90 },
    { label: 'Product', width: 280 },
    { label: 'Qty', width: 60, align: 'right' },
    { label: 'Packed', width: 50, align: 'center' },
  ]
  const rows = SAMPLE_LINES.map((l, i) => [String(i + 1), l.sku, l.name, String(l.qty), '☐'])
  drawTable(doc, columns, rows, branding)

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, '', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  return pdfToBuffer(doc)
}

async function generateCreditNotePreview(branding: Branding) {
  const tpl = await getTemplate('credit_note')
  const { doc } = createPdfDocument({ title: 'Credit Note Preview' })

  await drawHeader(doc, branding, {
    title: 'Credit Note',
    reference: 'CN-2026-00003',
    date: TODAY(),
    recipient: SAMPLE_RECIPIENT,
  })

  drawTemplateNotes(doc, tpl, 'header')

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 260 },
    { label: 'Qty', width: 40, align: 'right' },
    { label: 'Price (£)', width: 65, align: 'right' },
    { label: 'Credit (£)', width: 75, align: 'right' },
  ]
  const rows = SAMPLE_LINES.slice(0, 2).map((l, i) => [String(i + 1), `${l.name} (${l.sku})`, String(l.qty), l.price.toFixed(2), (l.qty * l.price).toFixed(2)])
  drawTable(doc, columns, rows, branding)

  doc.y += 5
  const cnRight = 50 + columns.reduce((s, c) => s + c.width, 0)
  const cnW = columns[columns.length - 1].width
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
  doc.text('Total Credit:', cnRight - cnW - 80, doc.y, { width: 80, align: 'right' })
  doc.text('£284.85', cnRight - cnW, doc.y - doc.currentLineHeight(), { width: cnW, align: 'right' })

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'This credit note has been applied to your account.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  return pdfToBuffer(doc)
}

async function generateManufacturingOrderPreview(branding: Branding) {
  const tpl = await getTemplate('manufacturing_order')
  const { doc } = createPdfDocument({ title: 'Manufacturing Order Preview' })

  await drawHeader(doc, branding, {
    title: 'Manufacturing Order',
    reference: 'MO-20260405-X7K2',
    date: TODAY(),
    recipient: { ...SAMPLE_RECIPIENT, name: 'Precision Assembly Ltd', address: '45 Workshop Lane\nSheffield\nS1 4AB\nGB' },
  })

  drawTemplateNotes(doc, tpl, 'header')

  doc.font('Helvetica').fontSize(9).fillColor('#333')
  doc.text('Product: PLA-BLK-1KG — PLA Filament Black 1kg', 50, doc.y)
  doc.text('Warehouse: Main Warehouse (EAR2)', 50, doc.y)
  doc.text('Quantity: 50', 50, doc.y)
  doc.text('Type: Assembly', 50, doc.y)
  doc.y += 12

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('Components Required:', 50, doc.y)
  doc.y += 8

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 80 },
    { label: 'Component', width: 180 },
    { label: 'Barcode / EAN', width: 90 },
    { label: 'Per Unit', width: 55, align: 'right' },
    { label: 'Total Qty', width: 65, align: 'right' },
  ]
  const rows = SAMPLE_LINES.slice(0, 3).map((l, i) => [String(i + 1), l.sku, l.name, '501234567890' + i, '2', String(2 * 50)])
  drawTable(doc, columns, rows, branding)

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'Please confirm receipt and provide an estimated completion date.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.purchasesEmail })
  return pdfToBuffer(doc)
}

const GENERATORS: Record<string, (b: Branding) => Promise<Buffer>> = {
  invoice: generateInvoicePreview,
  sales_order: generateSalesOrderPreview,
  purchase_order: generatePurchaseOrderPreview,
  rfq: generateRfqPreview,
  packing_slip: generatePackingSlipPreview,
  credit_note: generateCreditNotePreview,
  manufacturing_order: generateManufacturingOrderPreview,
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'settings')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const type = req.nextUrl.searchParams.get('type')
  if (!type || !GENERATORS[type]) return NextResponse.json({ error: 'Invalid document type' }, { status: 400 })

  const branding = await getBranding()
  const buffer = await GENERATORS[type](branding)

  const label = type.replace(/_/g, '-')
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${label}-preview.pdf"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  })
}
