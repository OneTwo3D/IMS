import { NextResponse } from 'next/server'
import { requireApiAuth, type AuthSession } from '@/lib/auth/server'
import type { Prisma } from '@/app/generated/prisma/client'
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

type RfqSession = AuthSession | NextResponse
type RfqQuantity = Prisma.Decimal | number | string
type RfqPurchaseOrder = {
  reference: string
  currency: string
  notes: string | null
  expectedDelivery: Date | null
  createdAt: Date
  supplier: {
    name: string
    contactName: string | null
    email: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    postcode: string | null
    country: string | null
  }
  lines: Array<{
    qty: RfqQuantity
    purchaseUnitQty: RfqQuantity | null
    purchaseUnit: { abbreviation: string; stockUnitName: string } | null
    product: { sku: string; name: string; barcode: string | null; mpn: string | null }
  }>
}
type RfqDocumentTemplate = {
  headerNote: string | null
  footerNote: string | null
  termsText: string | null
  customFooter: string | null
}
type RfqRouteDependencies = {
  authorize: () => Promise<RfqSession>
  hasPermission: typeof hasPermission
  findSupplierOwnedPurchaseOrder: (id: string, supplierId: string) => Promise<{ id: string } | null>
  findPurchaseOrder: (id: string) => Promise<RfqPurchaseOrder | null>
  findDocumentTemplate: () => Promise<RfqDocumentTemplate | null>
  renderPdf: (po: RfqPurchaseOrder, tpl: RfqDocumentTemplate | null) => Promise<Response>
}

const defaultRfqRouteDependencies: RfqRouteDependencies = {
  authorize: requireApiAuth,
  hasPermission,
  findSupplierOwnedPurchaseOrder(id, supplierId) {
    return db.purchaseOrder.findFirst({
      where: { id, supplierId },
      select: { id: true },
    })
  },
  findPurchaseOrder(id) {
    return db.purchaseOrder.findUnique({
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
            product: { select: { sku: true, name: true, barcode: true, mpn: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })
  },
  findDocumentTemplate() {
    return db.documentTemplate.findUnique({
      where: { type: 'rfq' },
      select: { headerNote: true, footerNote: true, termsText: true, customFooter: true },
    })
  },
  renderPdf: renderRfqPdf,
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRfqGetRequest({ params })
}

/** @internal Route adapter seam for tests that need to exercise promised params. */
export async function handleRfqGetRequest(
  { params }: { params: Promise<{ id: string }> },
  overrides: Partial<RfqRouteDependencies> = {},
) {
  return handleRfqGet(await params, overrides)
}

/** @internal Exported for tests; production callers should use the route GET handler. */
export async function handleRfqGet(
  params: { id: string },
  overrides: Partial<RfqRouteDependencies> = {},
) {
  const dependencies = { ...defaultRfqRouteDependencies, ...overrides }
  const session = await dependencies.authorize()
  if (session instanceof NextResponse) return session

  const isSupplier = session.user.role === 'SUPPLIER'
  if (!isSupplier && !dependencies.hasPermission(session.user.role, 'purchasing')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = params

  // Suppliers get 403 before the broad PO lookup to avoid ID existence leaks.
  // Purchasers/admins can distinguish 404 because they have purchasing access.
  if (isSupplier) {
    if (!session.user.supplierId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const owned = await dependencies.findSupplierOwnedPurchaseOrder(id, session.user.supplierId)
    if (!owned) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const po = await dependencies.findPurchaseOrder(id)

  if (!po) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const tpl = await dependencies.findDocumentTemplate()
  return dependencies.renderPdf(po, tpl)
}

async function renderRfqPdf(po: RfqPurchaseOrder, tpl: RfqDocumentTemplate | null) {
  // Branding is intentionally outside the route DI surface; auth tests stub the
  // whole renderPdf dependency. Thread getBranding through only for branding-specific tests.
  const branding = await getBranding()
  const tz = await getDisplayTimeZone()

  const supplierAddress = [
    po.supplier.addressLine1,
    po.supplier.addressLine2,
    po.supplier.city,
    po.supplier.postcode,
    formatCountryDisplay(po.supplier.country),
  ]
    .filter(Boolean)
    .join('\n')

  const dateStr = formatDateTime(po.createdAt, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }, tz)

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
    const expectedStr = formatDateTime(po.expectedDelivery, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }, tz)
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
    { label: '#', width: 25, align: 'right' },
    { label: 'SKU', width: 70 },
    { label: 'Product', width: 125, wrap: true },
    { label: 'Barcode / EAN', width: 75 },
    { label: 'MPN', width: 90 },
    { label: 'Quantity', width: 60, align: 'right' },
    { label: 'Unit', width: 45, align: 'right' },
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
      l.product.mpn ?? '—',
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
