import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  getBranding,
  createPdfDocument,
  drawHeader,
  drawTable,
  drawTemplateNotes,
  drawFooter,
  pdfToBuffer,
  type PdfTableColumn,
} from '@/lib/pdf'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      wcOrderNumber: true,
      customerName: true,
      shippingAddress: true,
      createdAt: true,
      lines: {
        select: {
          sku: true,
          description: true,
          qty: true,
          product: { select: { sku: true, name: true } },
        },
      },
    },
  })
  if (!so) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const shipments = await db.shipment.findMany({
    where: { orderId: id },
    include: {
      warehouse: { select: { name: true } },
      lines: {
        include: {
          product: { select: { sku: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const [branding, tpl] = await Promise.all([
    getBranding(),
    db.documentTemplate.findUnique({
      where: { type: 'packing_slip' },
      select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
    }),
  ])

  const orderNum = so.orderNumber ?? so.wcOrderNumber ?? so.id.slice(0, 8)
  const { doc } = createPdfDocument({ title: `Packing Slip ${orderNum}` })

  // Build recipient from shipping address
  const addr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = addr
    ? [addr.line1, addr.line2, addr.city, addr.postcode, addr.country].filter(Boolean).join('\n')
    : ''
  const date = so.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  await drawHeader(doc, branding, {
    title: 'Packing Slip',
    reference: orderNum,
    date,
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr },
  })

  drawTemplateNotes(doc, tpl, 'header')

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 90 },
    { label: 'Product', width: 245 },
    { label: 'Loc.', width: 40 },
    { label: 'Qty', width: 45, align: 'right' },
    { label: 'Packed', width: 50, align: 'center' },
  ]

  if (shipments.length > 0) {
    // Shipment-based: one table per shipment
    const multipleShipments = shipments.length > 1

    for (const shipment of shipments) {
      if (multipleShipments) {
        if (doc.y > 720) doc.addPage()
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#333')
          .text(`Ship from ${shipment.warehouse.name}`, 50, doc.y)
        doc.y += 8
      }

      const rows = shipment.lines.map((line, i) => [
        String(i + 1),
        line.product.sku,
        line.product.name,
        '', // Location — no shelf field in schema yet
        String(Number(line.qty)),
        '\u2610', // ☐ ballot box
      ])

      drawTable(doc, columns, rows, branding)
    }
  } else {
    // Legacy flow (no shipments): use order lines directly
    const rows = so.lines.map((line, i) => [
      String(i + 1),
      line.product?.sku ?? line.sku ?? '',
      line.product?.name ?? line.description,
      '',
      String(Number(line.qty)),
      '\u2610',
    ])

    drawTable(doc, columns, rows, branding)
  }

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, '', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })

  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Packing-Slip-${orderNum}.pdf"`,
    },
  })
}
