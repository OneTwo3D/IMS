import { db } from '@/lib/db'
import {
  getBranding,
  drawHeader,
  drawTable,
  drawTemplateNotes,
  drawFooter,
  type PdfTableColumn,
} from '@/lib/pdf'
import { formatCountryDisplay } from '@/lib/countries'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirementQuantities } from '@/lib/products/fulfillment-requirement-snapshot'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'
import { packingSlipRefusal, selectShipmentsForSlip } from '@/lib/domain/sales/packing-slip-scope'

/**
 * The packing-slip renderer, shared by the single-order route (/api/packing-slip/[id]) and the
 * batch route (/api/packing-slips) so one slip looks the same however it is printed.
 */

export async function loadPackingSlipOrder(id: string, requestedShipmentId: string | null) {
  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      orderNumber: true,
      externalOrderNumber: true,
      customerName: true,
      shippingAddress: true,
      createdAt: true,
      lines: {
        select: {
          id: true,
          productId: true,
          sku: true,
          description: true,
          qty: true,
          // o3d-kouj: the pinned recipe. A picker must be told to pick what the order was allocated
          // from — the components its reservation actually holds — not what the kit contains today.
          fulfillmentRequirements: true,
          product: { select: { sku: true, name: true } },
        },
      },
    },
  })
  if (!so) return { ok: false, status: 404, error: 'Not found' } as const
  // Same status rule as the buttons: no slip for a cancelled order (its goods must not be picked).
  const refusal = packingSlipRefusal(so.status)
  if (refusal) return { ok: false, status: 409, error: refusal } as const

  // ?shipment=<id> narrows the slip to one parcel (available from PENDING, so it can be printed to pick from).
  const allShipments = await db.shipment.findMany({
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
  const shipments = selectShipmentsForSlip(allShipments, requestedShipmentId)
  if (!shipments) return { ok: false, status: 404, error: 'Shipment not found on this order' } as const
  return { ok: true, data: { so, shipments } } as const
}

export type PackingSlipData = Extract<Awaited<ReturnType<typeof loadPackingSlipOrder>>, { ok: true }>['data']

export async function loadPackingSlipContext() {
  const [branding, tpl] = await Promise.all([
    getBranding(),
    db.documentTemplate.findUnique({
      where: { type: 'packing_slip' },
      select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
    }),
  ])
  const tz = await getDisplayTimeZone()
  return { branding, tpl, tz }
}

export type PackingSlipContext = Awaited<ReturnType<typeof loadPackingSlipContext>>

export function packingSlipOrderNumber(so: PackingSlipData['so']): string {
  return so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
}

/** Draws one order's slip from the current position of `doc` (the caller starts a new page between orders). */
export async function drawPackingSlip(doc: PDFKit.PDFDocument, data: PackingSlipData, ctx: PackingSlipContext): Promise<void> {
  const { so, shipments } = data
  const { branding, tpl, tz } = ctx
  const orderNum = packingSlipOrderNumber(so)

  // Build recipient from shipping address
  const addr = so.shippingAddress as Record<string, string> | null
  const recipientAddr = addr
    ? [addr.line1, addr.line2, addr.city, addr.postcode, formatCountryDisplay(addr.country)].filter(Boolean).join('\n')
    : ''
  const date = formatDateTime(so.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz)

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
    { label: 'Product', width: 245, wrap: true },
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
        '[   ]', // tick box (the built-in and embedded fonts have no ballot-box glyph)
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

      return [...lineFulfillmentRequirementQuantities(line, line.qty, graph).entries()].map(([productId, qty]) => ({
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
        '[   ]',
      ]
    })

    drawTable(doc, columns, rows, branding)
  }

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, '', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
}
