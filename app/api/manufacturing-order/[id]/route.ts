import { NextRequest, NextResponse } from 'next/server'
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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const order = await db.productionOrder.findUnique({
    where: { id },
    select: {
      reference: true,
      orderType: true,
      qtyPlanned: true,
      scheduledAt: true,
      notes: true,
      createdAt: true,
      outputProduct: {
        select: {
          sku: true,
          name: true,
          barcode: true,
          productComponents: {
            select: {
              qty: true,
              component: { select: { sku: true, name: true, barcode: true } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
      warehouse: { select: { name: true, code: true } },
      manufacturer: {
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
    },
  })

  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const branding = await getBranding()
  const tpl = await db.documentTemplate.findUnique({
    where: { type: 'manufacturing_order' },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true },
  })

  const isDisassembly = order.orderType === 'DISASSEMBLY'
  const title = isDisassembly ? 'Disassembly Order' : 'Manufacturing Order'
  const { doc } = createPdfDocument({ title: `${title} ${order.reference}` })

  const dateStr = order.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const recipientAddr = order.manufacturer
    ? [order.manufacturer.addressLine1, order.manufacturer.addressLine2, order.manufacturer.city, order.manufacturer.postcode, order.manufacturer.country].filter(Boolean).join('\n')
    : undefined

  await drawHeader(doc, branding, {
    title,
    reference: order.reference,
    date: dateStr,
    recipient: order.manufacturer
      ? {
          name: order.manufacturer.name,
          contact: order.manufacturer.contactName,
          address: recipientAddr,
          email: order.manufacturer.email,
        }
      : undefined,
  })

  // Header note from template
  if (tpl?.headerNote) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 10
  }

  // Order details
  doc.font('Helvetica').fontSize(9).fillColor('#333')
  doc.text(`Product: ${order.outputProduct.sku} — ${order.outputProduct.name}`, 50, doc.y)
  if (order.outputProduct.barcode) {
    doc.text(`Barcode: ${order.outputProduct.barcode}`, 50, doc.y)
  }
  doc.text(`Warehouse: ${order.warehouse.name} (${order.warehouse.code})`, 50, doc.y)
  doc.text(`Quantity: ${Number(order.qtyPlanned)}`, 50, doc.y)
  doc.text(`Type: ${isDisassembly ? 'Disassembly' : 'Assembly'}`, 50, doc.y)
  if (order.scheduledAt) {
    doc.text(`Scheduled: ${order.scheduledAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, 50, doc.y)
  }
  doc.y += 12

  // Components table
  const qtyPlanned = Number(order.qtyPlanned)
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333')
    .text(isDisassembly ? 'Components Produced:' : 'Components Required:', 50, doc.y)
  doc.y += 8

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 80 },
    { label: 'Component', width: 180 },
    { label: 'Barcode / EAN', width: 90 },
    { label: 'Per Unit', width: 55, align: 'right' },
    { label: 'Total Qty', width: 65, align: 'right' },
  ]

  const rows = order.outputProduct.productComponents.map((c, i) => [
    String(i + 1),
    c.component.sku,
    c.component.name,
    c.component.barcode ?? '—',
    String(Number(c.qty)),
    String(Number(c.qty) * qtyPlanned),
  ])

  drawTable(doc, columns, rows, branding)

  // Notes
  if (order.notes) {
    doc.y += 8
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('NOTES', 50, doc.y)
    doc.y += 2
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(order.notes, 50, doc.y, { width: 495 })
    doc.y += 10
  }

  // Template footer notes
  if (tpl?.termsText) {
    doc.font('Helvetica').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
    doc.y += 2
    doc.font('Helvetica').fontSize(7).fillColor('#666').text(tpl.termsText, 50, doc.y, { width: 495 })
    doc.y += 10
  }
  if (tpl?.footerNote) {
    doc.font('Helvetica').fontSize(8).fillColor('#888').text(tpl.footerNote, 50, doc.y, { width: 495, align: 'center' })
    doc.y += 6
  }

  const contactEmail = branding.purchasesEmail || branding.email
  drawFooter(doc, order.manufacturer ? 'Please confirm receipt and provide an estimated completion date.' : '', branding, { customFooter: tpl?.customFooter, contactEmail })

  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${order.reference}.pdf"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}
