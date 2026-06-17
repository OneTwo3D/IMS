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
  pdfToBuffer,
  type PdfTableColumn,
} from '@/lib/pdf'
import { formatCountryDisplay } from '@/lib/countries'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'manufacturing')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
      currency: true,
      outputProduct: {
        select: {
          sku: true,
          name: true,
          barcode: true,
          mpn: true,
          productComponents: {
            select: {
              qty: true,
              component: { select: { sku: true, name: true, barcode: true, mpn: true } },
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
      manufacturingCostLines: {
        select: { description: true, amountForeign: true, accountCode: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const tz = await getDisplayTimeZone()
  const branding = await getBranding()
  const tpl = await db.documentTemplate.findUnique({
    where: { type: 'manufacturing_order' },
    select: { headerNote: true, footerNote: true, termsText: true, customFooter: true },
  })

  const isDisassembly = order.orderType === 'DISASSEMBLY'
  const title = isDisassembly ? 'Disassembly Order' : 'Manufacturing Order'
  const { doc } = createPdfDocument({ title: `${title} ${order.reference}` })

  const dateStr = formatDateTime(order.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)

  const recipientAddr = order.manufacturer
    ? [order.manufacturer.addressLine1, order.manufacturer.addressLine2, order.manufacturer.city, order.manufacturer.postcode, formatCountryDisplay(order.manufacturer.country)].filter(Boolean).join('\n')
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
  if (order.outputProduct.mpn) {
    doc.text(`MPN: ${order.outputProduct.mpn}`, 50, doc.y)
  }
  doc.text(`Warehouse: ${order.warehouse.name} (${order.warehouse.code})`, 50, doc.y)
  doc.text(`Quantity: ${Number(order.qtyPlanned)}`, 50, doc.y)
  doc.text(`Type: ${isDisassembly ? 'Disassembly' : 'Assembly'}`, 50, doc.y)
  if (order.scheduledAt) {
    doc.text(`Scheduled: ${formatDateTime(order.scheduledAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)}`, 50, doc.y)
  }
  doc.y += 12

  // Components table
  const qtyPlanned = Number(order.qtyPlanned)
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333')
    .text(isDisassembly ? 'Components Produced:' : 'Components Required:', 50, doc.y)
  doc.y += 8

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Component', width: 130 },
    { label: 'Barcode / EAN', width: 75 },
    { label: 'MPN', width: 90 },
    { label: 'Per Unit', width: 50, align: 'right' },
    { label: 'Total Qty', width: 50, align: 'right' },
  ]

  const rows = order.outputProduct.productComponents.map((c, i) => [
    String(i + 1),
    c.component.sku,
    c.component.name,
    c.component.barcode ?? '—',
    c.component.mpn ?? '—',
    String(Number(c.qty)),
    String(Number(c.qty) * qtyPlanned),
  ])

  drawTable(doc, columns, rows, branding)

  // Manufacturing cost lines (per-run overhead)
  if (order.manufacturingCostLines.length > 0) {
    doc.y += 12
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('Manufacturing Costs:', 50, doc.y)
    doc.y += 8
    const costColumns: PdfTableColumn[] = [
      { label: '#', width: 25, align: 'right' },
      { label: 'Description', width: 270 },
      { label: 'Account', width: 95 },
      { label: `Amount (${order.currency})`, width: 105, align: 'right' },
    ]
    let costTotal = 0
    const costRows = order.manufacturingCostLines.map((l, i) => {
      const amt = Number(l.amountForeign)
      costTotal += amt
      return [
        String(i + 1),
        l.description,
        l.accountCode ?? '—',
        amt.toFixed(2),
      ]
    })
    costRows.push(['', '', 'Total', costTotal.toFixed(2)])
    drawTable(doc, costColumns, costRows, branding)
  }

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
