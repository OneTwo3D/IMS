/**
 * The purchase order PDF: load a real order into the plain `PurchaseOrderDocument` shape and draw it. The Settings > Documents
 * preview draws sample data through the same `renderPurchaseOrderPdf`, so what is previewed is what a supplier receives.
 */
import { effectiveLineEta, lineEtaDiffersFromHeader } from '@/lib/domain/purchasing/line-eta'
import { db } from '@/lib/db'
import { formatCountryDisplay } from '@/lib/countries'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'
import { formatMoney, type SymbolPos } from '@/lib/utils'
import {
  createPdfDocument,
  drawFooter,
  drawHeader,
  drawTable,
  drawTemplateNotes,
  getBranding,
  pdfToBuffer,
  type Branding,
  type PdfTableColumn,
  type TemplateNoteFields,
} from '@/lib/pdf'
import {
  poDocumentColumns,
  poDocumentRows,
  poLayoutFlags,
  poTaxLabel,
  poTotalsRows,
  type PoDocumentAddress,
  type PoDocumentLine,
  type PoDocumentTotals,
} from '@/lib/domain/purchasing/po-document'

export type PurchaseOrderDocument = {
  reference: string
  currency: string
  currencySymbol: string
  currencySymbolPosition: SymbolPos
  createdAt: Date
  expectedDelivery: Date | null
  notes: string | null
  supplierRef: string | null
  supplier: {
    name: string
    contactName: string | null
    email: string | null
    address: string
    accountNumber: string | null
    vatNumber: string | null
    paymentTermsDays: number | null
  }
  shipTo: PoDocumentAddress | null
  lines: PoDocumentLine[]
  totals: PoDocumentTotals
}

const PO_TEMPLATE_SELECT = { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true } as const

export function addressBlock(parts: Array<string | null | undefined>, country: string | null | undefined): string {
  return [...parts, formatCountryDisplay(country)].filter(Boolean).join('\n')
}

export async function loadPurchaseOrderDocument(id: string): Promise<PurchaseOrderDocument | null> {
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: {
      reference: true,
      supplierId: true,
      currency: true,
      createdAt: true,
      expectedDelivery: true,
      notes: true,
      supplierRef: true,
      subtotalForeign: true,
      taxRateName: true,
      taxRatePercent: true,
      taxForeign: true,
      totalForeign: true,
      directFreightForeign: true,
      discountAmount: true,
      supplier: {
        select: {
          name: true, contactName: true, email: true, addressLine1: true, addressLine2: true, city: true, postcode: true,
          country: true, accountNumber: true, vatNumber: true, paymentTermsDays: true,
        },
      },
      destinationWarehouse: { select: { name: true, addressLine1: true, addressLine2: true, city: true, postcode: true, country: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: {
          productId: true, description: true, qty: true, purchaseUnitQty: true, unitCostForeign: true, discountAmount: true, totalForeign: true, expectedDelivery: true,
          purchaseUnit: { select: { abbreviation: true, stockUnitName: true } },
          product: { select: { sku: true, name: true, barcode: true, mpn: true } },
        },
      },
    },
  })
  if (!po) return null

  const [currency, supplierProducts] = await Promise.all([
    db.currency.findUnique({ where: { code: po.currency } }),
    db.supplierProduct.findMany({
      where: { supplierId: po.supplierId, productId: { in: po.lines.map((l) => l.productId) } },
      select: { productId: true, supplierSku: true },
    }),
  ])
  const supplierSkus = new Map(supplierProducts.map((s) => [s.productId, s.supplierSku]))
  const lines: PoDocumentLine[] = po.lines.map((l) => ({
    sku: l.product.sku,
    name: l.description?.trim() || l.product.name,
    barcode: l.product.barcode,
    mpn: l.product.mpn,
    supplierSku: supplierSkus.get(l.productId) ?? null,
    qty: Number(l.qty),
    purchaseUnitQty: l.purchaseUnitQty != null ? Number(l.purchaseUnitQty) : null,
    purchaseUnitAbbreviation: l.purchaseUnit?.abbreviation ?? null,
    stockUnitName: l.purchaseUnit?.stockUnitName ?? null,
    unitCost: Number(l.unitCostForeign),
    discountAmount: Number(l.discountAmount),
    total: Number(l.totalForeign),
    // Shown only where the line's date differs from the header's; a line that follows the header needs no repeat.
    deliveryDate: lineEtaDiffersFromHeader(l.expectedDelivery, po.expectedDelivery) ? effectiveLineEta(l.expectedDelivery, po.expectedDelivery) : null,
  }))
  const w = po.destinationWarehouse
  return {
    reference: po.reference,
    currency: po.currency,
    currencySymbol: currency?.symbol ?? (po.currency === 'GBP' ? '£' : po.currency),
    currencySymbolPosition: currency?.symbolPosition ?? 'PREFIX',
    createdAt: po.createdAt,
    expectedDelivery: po.expectedDelivery,
    notes: po.notes,
    supplierRef: po.supplierRef,
    supplier: {
      name: po.supplier.name,
      contactName: po.supplier.contactName,
      email: po.supplier.email,
      address: addressBlock([po.supplier.addressLine1, po.supplier.addressLine2, po.supplier.city, po.supplier.postcode], po.supplier.country),
      accountNumber: po.supplier.accountNumber,
      vatNumber: po.supplier.vatNumber,
      paymentTermsDays: po.supplier.paymentTermsDays,
    },
    shipTo: w ? { name: w.name, address: addressBlock([w.addressLine1, w.addressLine2, w.city, w.postcode], w.country) } : null,
    lines,
    totals: {
      subtotal: Number(po.subtotalForeign),
      lineDiscounts: lines.reduce((s, l) => s + l.discountAmount, 0),
      orderDiscount: Number(po.discountAmount),
      tax: Number(po.taxForeign),
      taxLabel: poTaxLabel(po.taxRateName, po.taxRatePercent != null ? Number(po.taxRatePercent) : null),
      additionalCosts: Number(po.directFreightForeign),
      total: Number(po.totalForeign),
    },
  }
}

export function loadPurchaseOrderTemplate() {
  return db.documentTemplate.findUnique({ where: { type: 'purchase_order' }, select: PO_TEMPLATE_SELECT })
}

export async function renderPurchaseOrderPdf(
  po: PurchaseOrderDocument,
  branding: Branding,
  tpl: TemplateNoteFields | null,
  opts: { timeZone: string; title?: string },
): Promise<Buffer> {
  const long = { day: 'numeric', month: 'long', year: 'numeric' } as const
  const money = (n: number) => formatMoney(n, po.currencySymbol, po.currencySymbolPosition)
  const { doc } = createPdfDocument({ title: opts.title ?? `Purchase Order — ${po.reference}` })

  await drawHeader(doc, branding, {
    title: 'Purchase Order',
    reference: po.reference,
    date: formatDateTime(po.createdAt, long, opts.timeZone),
    ...(po.supplierRef ? { secondaryReference: { label: 'Your ref', value: po.supplierRef } } : {}),
    recipient: { name: po.supplier.name, contact: po.supplier.contactName, address: po.supplier.address, email: po.supplier.email },
  })

  drawTemplateNotes(doc, tpl, 'header')

  // Order facts: currency, delivery, ship-to, supplier account and terms.
  const facts: string[] = [`Currency: ${po.currency}`]
  if (branding.vatNumber) facts.push(`Our VAT no: ${branding.vatNumber}`)
  if (po.supplier.accountNumber) facts.push(`Our account with you: ${po.supplier.accountNumber}`)
  if (po.supplier.paymentTermsDays != null) facts.push(`Payment terms: ${po.supplier.paymentTermsDays} days`)
  if (po.expectedDelivery) facts.push(`Expected delivery: ${formatDateTime(po.expectedDelivery, long, opts.timeZone)}`)
  doc.font('Helvetica').fontSize(9).fillColor('#333333').text(facts.join('   |   '), 50, doc.y, { width: 495 })
  doc.y += 4
  if (po.shipTo) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#444444').text('Deliver to', 50, doc.y)
    doc.font('Helvetica').fontSize(8).fillColor('#333333').text([po.shipTo.name, po.shipTo.address].filter(Boolean).join('\n'), 50, doc.y, { width: 495 })
    doc.y += 6
  }
  doc.y += 4

  const flags = poLayoutFlags(po.lines)
  const columns: PdfTableColumn[] = poDocumentColumns(po.currencySymbol, flags)
  drawTable(doc, columns, poDocumentRows(po.lines, { ...flags, formatDate: (d) => formatDateTime(d, { day: 'numeric', month: 'short', year: 'numeric' }, opts.timeZone) }), branding)

  // Totals block, right-aligned under the last column.
  doc.y += 6
  const right = 50 + columns.reduce((s, c) => s + c.width, 0)
  const labelW = 230
  const amountW = 90
  for (const row of poTotalsRows(po.totals, money)) {
    if (doc.y > 760) doc.addPage()
    doc.font(row.strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(row.strong ? 10 : 9).fillColor(row.muted ? '#888888' : '#000000')
    const y = doc.y
    doc.text(row.label, right - amountW - labelW, y, { width: labelW, align: 'right' })
    doc.text(row.amount, right - amountW, y, { width: amountW, align: 'right' })
    doc.y = y + (row.strong ? 16 : 13)
  }

  if (po.notes) {
    doc.y += 8
    doc.font('Helvetica').fontSize(7).fillColor('#888888').text('NOTES', 50, doc.y)
    doc.y += 2
    doc.font('Helvetica').fontSize(9).fillColor('#333333').text(po.notes, 50, doc.y, { width: 495 })
    doc.y += 10
  }

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'Please confirm receipt of this order and quote the PO reference on all delivery notes and invoices.', branding, {
    customFooter: tpl?.customFooter,
    contactEmail: branding.purchasesEmail,
  })
  return pdfToBuffer(doc)
}

/** Load and draw a real order. Null when the order does not exist. */
export async function buildPurchaseOrderPdf(id: string): Promise<{ buffer: Buffer; reference: string } | null> {
  const po = await loadPurchaseOrderDocument(id)
  if (!po) return null
  const [branding, tpl, timeZone] = await Promise.all([getBranding(), loadPurchaseOrderTemplate(), getDisplayTimeZone()])
  const buffer = await renderPurchaseOrderPdf(po, branding, tpl, { timeZone })
  return { buffer, reference: po.reference }
}
