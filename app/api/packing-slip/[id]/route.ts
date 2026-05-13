import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
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
import { formatCountryDisplay } from '@/lib/countries'
import { expandFulfillmentRequirementsDecimal, loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params

  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      customerName: true,
      shippingAddress: true,
      createdAt: true,
      lines: {
        select: {
          productId: true,
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

  const orderNum = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const { doc } = createPdfDocument({ title: `Packing Slip ${orderNum}` })

  // Build recipient from shipping address
  const addr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = addr
    ? [addr.line1, addr.line2, addr.city, addr.postcode, formatCountryDisplay(addr.country)].filter(Boolean).join('\n')
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
    const productIds = so.lines.map((line) => line.productId).filter((value): value is string => !!value)
    const graph = await loadFulfillmentProductGraph(db, productIds)
    type PackingSlipRow = { productId?: string; sku: string; name: string; qty: number }

    const expandedRows: PackingSlipRow[] = so.lines.flatMap((line) => {
      if (!line.productId) {
        return [{
          sku: line.product?.sku ?? line.sku ?? '',
          name: line.product?.name ?? line.description,
          qty: Number(line.qty),
        }]
      }

      return [...expandFulfillmentRequirementsDecimal(line.productId, line.qty, graph).entries()].map(([productId, qty]) => ({
        sku: '',
        name: line.description,
        productId,
        qty: qty.toNumber(),
      }))
    })

    const leafProductIds = expandedRows
      .map((row) => row.productId ?? null)
      .filter((value): value is string => !!value)
    const leafProducts = leafProductIds.length > 0
      ? await db.product.findMany({
          where: { id: { in: [...new Set(leafProductIds)] } },
          select: { id: true, sku: true, name: true },
        })
      : []
    const leafProductById = new Map(leafProducts.map((product) => [product.id, product]))

    const rows = expandedRows.map((row, i) => {
      const product = row.productId ? leafProductById.get(row.productId) : null
      return [
        String(i + 1),
        product?.sku ?? row.sku,
        product?.name ?? row.name,
        '',
        String(row.qty),
        '\u2610',
      ]
    })

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
