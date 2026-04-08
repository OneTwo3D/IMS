import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  getBranding,
  createPdfDocument,
  drawHeader,
  drawTable,
  drawFooter,
  pdfToBuffer,
  type PdfTableColumn,
} from '@/lib/pdf'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: {
      reference: true,
      currency: true,
      notes: true,
      expectedDelivery: true,
      createdAt: true,
      supplier: {
        select: {
          name: true,
          contactName: true,
          email: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          postcode: true,
          country: true,
        },
      },
      lines: {
        select: {
          qty: true,
          purchaseUnitQty: true,
          purchaseUnit: { select: { abbreviation: true, stockUnitName: true } },
          product: { select: { sku: true, name: true, barcode: true } },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  if (!po) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const branding = await getBranding()
  const tpl = await db.documentTemplate.findUnique({
    where: { type: 'rfq' },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true },
  })

  const supplierAddress = [
    po.supplier.addressLine1,
    po.supplier.addressLine2,
    po.supplier.city,
    po.supplier.postcode,
    po.supplier.country,
  ]
    .filter(Boolean)
    .join('\n')

  const dateStr = po.createdAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  // Build PDF
  const { doc } = createPdfDocument({ title: `RFQ — ${po.reference}` })

  await drawHeader(doc, branding, {
    title: 'Request for Quotation',
    reference: po.reference,
    date: dateStr,
    recipient: {
      name: po.supplier.name,
      contact: po.supplier.contactName,
      address: supplierAddress,
      email: po.supplier.email,
    },
  })

  // Expected delivery
  if (po.expectedDelivery) {
    const expectedStr = po.expectedDelivery.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#000000')
      .text(`Required by: ${expectedStr}`, 50, doc.y)
    doc.y += 6
  }

  // Header note from template
  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.headerNote!, 50, doc.y, { width: 495 })
    doc.y += 8
  }

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#333333')
    .text('Please provide your best quotation for the following items:', 50, doc.y)
  doc.y += 12

  // Table
  const columns: PdfTableColumn[] = [
    { label: '#', width: 30, align: 'right' },
    { label: 'SKU', width: 80 },
    { label: 'Product', width: 170 },
    { label: 'Barcode / EAN', width: 95 },
    { label: 'Quantity', width: 65, align: 'right' },
    { label: 'Unit', width: 55, align: 'right' },
  ]

  const rows = po.lines.map((l, i) => {
    const qty = l.purchaseUnitQty != null ? Number(l.purchaseUnitQty) : Number(l.qty)
    const unitLabel = l.purchaseUnit ? l.purchaseUnit.abbreviation : 'pcs'
    const stockQty = Number(l.qty)
    const stockUnit = l.purchaseUnit?.stockUnitName ?? 'pcs'
    const showConversion = l.purchaseUnit != null && l.purchaseUnitQty != null
    const qtyStr = showConversion ? `${qty} (${stockQty} ${stockUnit})` : `${qty}`
    return [
      String(i + 1),
      l.product.sku,
      l.product.name,
      l.product.barcode ?? '—',
      qtyStr,
      unitLabel,
    ]
  })

  drawTable(doc, columns, rows, branding)

  // Notes
  if (po.notes) {
    doc.y += 8
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#888888')
      .text('NOTES', 50, doc.y)
    doc.y += 2
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#333333')
      .text(po.notes, 50, doc.y, { width: 595.28 - 100 })
    doc.y += 10
  }

  // Footer note from template
  if (tpl?.footerNote) {
    doc.y += 10
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(tpl.footerNote, 50, doc.y, { width: 495 })
  }

  // Terms from template
  if (tpl?.termsText) {
    doc.y += 10
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
    doc.font('Helvetica').fontSize(7).fillColor('#888').text(tpl.termsText, 50, doc.y + 2, { width: 495 })
  }

  drawFooter(
    doc,
    'Please reply with your quotation including unit prices, lead time, and shipping costs.',
    branding,
    { customFooter: tpl?.customFooter, contactEmail: branding.purchasesEmail },
  )

  const buffer = await pdfToBuffer(doc)

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="RFQ-${po.reference}.pdf"`,
    },
  })
}
