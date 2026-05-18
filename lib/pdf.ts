import PDFDocument from 'pdfkit'
import { readFile } from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import { filenameFromBrandingUploadUrl, resolveBrandingUploadFilePath } from '@/lib/upload-storage'
import { db } from '@/lib/db'
import { formatCountryDisplay } from '@/lib/countries'

// ---------------------------------------------------------------------------
// Branding — reads from organisation + settings, with sensible defaults
// ---------------------------------------------------------------------------

export type Branding = {
  companyName: string
  legalName: string
  vatNumber: string
  address: string
  phone: string
  email: string
  website: string
  salesEmail: string
  purchasesEmail: string
  supportEmail: string
  logoUrl: string | null          // square icon logo
  documentLogoUrl: string | null  // wide rectangular logo for PDF headers
  primaryColor: string   // hex, e.g. '#1a1a2e'
  accentColor: string    // hex, e.g. '#0f4c81'
}

export async function getBranding(): Promise<Branding> {
  const [org, primarySetting, accentSetting, salesEmailSetting, purchasesEmailSetting, supportEmailSetting] = await Promise.all([
    db.organisation.findFirst(),
    db.setting.findUnique({ where: { key: 'brand_primary_color' } }),
    db.setting.findUnique({ where: { key: 'brand_accent_color' } }),
    db.setting.findUnique({ where: { key: 'email_sales_email' } }),
    db.setting.findUnique({ where: { key: 'email_purchases_email' } }),
    db.setting.findUnique({ where: { key: 'email_support_email' } }),
  ])

  const address = [org?.addressLine1, org?.addressLine2, [org?.city, org?.postcode].filter(Boolean).join(' '), formatCountryDisplay(org?.country)]
    .filter(Boolean)
    .join('\n')

  return {
    companyName: org?.name ?? 'Our Company',
    legalName: org?.legalName ?? org?.name ?? 'Our Company',
    vatNumber: org?.vatNumber ?? '',
    address,
    phone: org?.phone ?? '',
    email: org?.email ?? '',
    website: org?.website ?? '',
    salesEmail: salesEmailSetting?.value ?? '',
    purchasesEmail: purchasesEmailSetting?.value ?? '',
    supportEmail: supportEmailSetting?.value ?? '',
    logoUrl: org?.logoUrl ?? null,
    documentLogoUrl: org?.documentLogoUrl ?? null,
    primaryColor: primarySetting?.value ?? '#1a1a2e',
    accentColor: accentSetting?.value ?? '#0f4c81',
  }
}

// ---------------------------------------------------------------------------
// Shared PDF helpers
// ---------------------------------------------------------------------------

/** Hex color string to RGB array */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export type PdfTableColumn = {
  label: string
  width: number       // in points
  align?: 'left' | 'right' | 'center'
}

export type PdfTableRow = string[]

/**
 * Creates a new PDFDocument with standard page setup, header, and returns it
 * along with helper functions for drawing tables, etc.
 */
export function createPdfDocument(options?: { title?: string }) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: { Title: options?.title ?? 'Document' },
    bufferPages: true,
  })

  const pageWidth = 595.28 - 100 // A4 width minus margins

  return { doc, pageWidth }
}

/**
 * Draw the document header with company info and recipient
 */
/**
 * Load a logo image from configured upload storage, or from public assets for
 * static bundled logos.
 * Returns null if the file doesn't exist or isn't a supported format.
 */
async function loadLogoBuffer(logoUrl: string | null): Promise<Buffer | null> {
  if (!logoUrl) return null
  try {
    const brandingFilename = filenameFromBrandingUploadUrl(logoUrl)
    let filePath = brandingFilename ? resolveBrandingUploadFilePath(brandingFilename) : null

    if (!filePath) {
      const urlPath = logoUrl.split('?')[0] ?? ''
      const publicDir = path.resolve(process.cwd(), 'public')
      filePath = path.resolve(publicDir, urlPath.replace(/^\//, ''))
      if (!filePath.startsWith(publicDir + path.sep)) return null
    }

    const raw = await readFile(filePath)
    // SVG → convert to PNG via sharp (PDFKit doesn't support SVG natively)
    if (filePath.endsWith('.svg')) {
      return Buffer.from(await sharp(raw).resize({ width: 600 }).png().toBuffer())
    }
    return raw
  } catch {
    return null
  }
}

export async function drawHeader(
  doc: PDFKit.PDFDocument,
  branding: Branding,
  opts: {
    title: string
    reference: string
    date: string
    recipient?: {
      name: string
      contact?: string | null
      address?: string
      email?: string | null
    }
  },
) {
  const primaryRgb = hexToRgb(branding.primaryColor)
  const pageWidth = 595.28 - 100

  // Logo row: logo on left, document title right-aligned on same line
  const logoBuf = await loadLogoBuffer(branding.documentLogoUrl)
  const logoRowTop = 50
  const logoHeight = 50
  if (logoBuf) {
    try {
      doc.image(logoBuf, 50, logoRowTop, { width: 180, height: logoHeight, fit: [180, logoHeight] })
    } catch {
      // If image fails to load, skip it
    }
  }

  // Title — right-aligned, vertically centred with logo, in accent colour
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(hexToRgb(branding.accentColor))
    .text(opts.title.toUpperCase(), 50, logoRowTop + (logoBuf ? 15 : 0), { width: pageWidth, align: 'right' })

  const headerTop = logoRowTop + logoHeight + 12

  // Coloured accent bar
  doc
    .rect(50, headerTop, pageWidth, 3)
    .fill(primaryRgb)

  doc.fillColor('#000000')
  doc.y = headerTop + 12

  // From / To columns
  const colW = pageWidth / 2
  const startY = doc.y

  // From
  doc.font('Helvetica').fontSize(7).fillColor('#888888').text('FROM', 50, startY)
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(branding.legalName, 50, startY + 10)
  let y = startY + 22
  if (branding.address) {
    doc.font('Helvetica').fontSize(8).fillColor('#444444').text(branding.address, 50, y, { width: colW - 20 })
    y = doc.y + 2
  }
  if (branding.email) { doc.fontSize(8).text(branding.email, 50, y); y = doc.y + 1 }
  if (branding.phone) { doc.fontSize(8).text(branding.phone, 50, y); y = doc.y + 1 }

  // To
  if (opts.recipient) {
    const rx = 50 + colW
    doc.font('Helvetica').fontSize(7).fillColor('#888888').text('TO', rx, startY)
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(opts.recipient.name, rx, startY + 10)
    let ry = startY + 22
    if (opts.recipient.contact) {
      doc.font('Helvetica').fontSize(8).fillColor('#444444').text(`Attn: ${opts.recipient.contact}`, rx, ry, { width: colW - 20 })
      ry = doc.y + 2
    }
    if (opts.recipient.address) {
      doc.fontSize(8).text(opts.recipient.address, rx, ry, { width: colW - 20 })
      ry = doc.y + 2
    }
    if (opts.recipient.email) { doc.fontSize(8).text(opts.recipient.email, rx, ry) }
  }

  // Reference + date right-aligned
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#888888')
    .text(`Ref: ${opts.reference}`, 50 + colW, startY + 60, { width: colW, align: 'right' })
    .text(`Date: ${opts.date}`, 50 + colW, doc.y, { width: colW, align: 'right' })

  doc.y = Math.max(doc.y, y) + 20
  doc.fillColor('#000000')
}

/**
 * Draw a table with headers and rows
 */
export function drawTable(
  doc: PDFKit.PDFDocument,
  columns: PdfTableColumn[],
  rows: PdfTableRow[],
  branding: Branding,
) {
  const accentRgb = hexToRgb(branding.accentColor)
  const startX = 50
  const rowHeight = 20
  const headerHeight = 22

  // Check if we need a new page
  const estimatedHeight = headerHeight + rows.length * rowHeight
  if (doc.y + estimatedHeight > 780) doc.addPage()

  let y = doc.y

  // Header background — light tint of accent colour
  const totalWidth = columns.reduce((s, c) => s + c.width, 0)
  // Mix accent RGB with white at 15% opacity for a subtle tint
  const tintR = Math.round(accentRgb[0] + (255 - accentRgb[0]) * 0.85)
  const tintG = Math.round(accentRgb[1] + (255 - accentRgb[1]) * 0.85)
  const tintB = Math.round(accentRgb[2] + (255 - accentRgb[2]) * 0.85)
  doc.rect(startX, y, totalWidth, headerHeight).fill([tintR, tintG, tintB])

  // Header text — dark colour matching accent
  let x = startX
  doc.font('Helvetica-Bold').fontSize(7).fillColor(accentRgb)
  for (const col of columns) {
    const textOpts = { width: col.width - 8, align: (col.align ?? 'left') as 'left' | 'right' | 'center' }
    doc.text(col.label.toUpperCase(), x + 4, y + 7, textOpts)
    x += col.width
  }

  // Header bottom border
  y += headerHeight
  doc.moveTo(startX, y).lineTo(startX + totalWidth, y).lineWidth(0.5).strokeColor('#cccccc').stroke()

  // Rows
  doc.font('Helvetica').fontSize(8).fillColor('#000000')
  for (let ri = 0; ri < rows.length; ri++) {
    if (y + rowHeight > 780) {
      doc.addPage()
      y = 50
    }

    // Zebra stripe
    if (ri % 2 === 1) {
      doc.rect(startX, y, totalWidth, rowHeight).fill('#fafafa')
      doc.fillColor('#000000')
    }

    x = startX
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci]
      const val = rows[ri][ci] ?? ''
      const textOpts = { width: col.width - 8, align: (col.align ?? 'left') as 'left' | 'right' | 'center' }
      doc.text(val, x + 4, y + 6, textOpts)
      x += col.width
    }

    // Row border
    y += rowHeight
    doc.moveTo(startX, y).lineTo(startX + totalWidth, y).lineWidth(0.25).strokeColor('#eeeeee').stroke()
  }

  doc.y = y + 10
}

/**
 * Draw a footer note. If customFooter is provided it appears as a separate
 * free-text block at the very bottom of the page.
 */
export function drawFooter(doc: PDFKit.PDFDocument, text: string, branding: Branding, opts?: { customFooter?: string | null; contactEmail?: string | null }) {
  if (doc.y > 720) doc.addPage()
  doc.y += 10
  const pw = 595.28 - 100
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#888888')
    .text(text, 50, doc.y, { width: pw, align: 'center' })
  const email = opts?.contactEmail || branding.email
  if (email) {
    doc.text(`Contact: ${email}`, { width: pw, align: 'center' })
  }
  const customFooter = opts?.customFooter
  // Custom footer — free text at the bottom
  if (customFooter) {
    const pageBottom = 842 - 50 // A4 height minus bottom margin
    const footerHeight = 30
    const footerY = Math.max(doc.y + 20, pageBottom - footerHeight)
    doc.moveTo(50, footerY - 5).lineTo(545, footerY - 5).lineWidth(0.25).strokeColor('#dddddd').stroke()
    doc.font('Helvetica').fontSize(7).fillColor('#888888')
      .text(customFooter, 50, footerY, { width: 595.28 - 100, align: 'center' })
  }
}

/**
 * Group a set of lines by their effective tax rate and return one row per
 * distinct rate. Used by PDF routes to render a grouped VAT breakdown when
 * an order has lines at mixed rates (e.g. 20% on goods, 5% on car seats,
 * 0% on books).
 *
 * `lines` each carry their own `taxRatePercent` (a decimal like 0.20) and
 * `taxForeign` amount. Rows with a null rate fall into the bucket labelled
 * by `fallbackLabel` so shipping/fees VAT (tracked on the order, not on
 * lines) can still be displayed.
 *
 * Returns a deterministic order: highest rate first, then zero.
 */
export function groupVatBreakdown(
  lines: { taxRatePercent: number | null; taxForeign: number }[],
  extra?: { label: string; amount: number }[],
): { label: string; amount: number }[] {
  const buckets = new Map<string, { rate: number; amount: number }>()
  for (const l of lines) {
    const rate = l.taxRatePercent == null ? 0 : Number(l.taxRatePercent)
    const amount = Number(l.taxForeign) || 0
    if (amount === 0 && rate === 0) continue
    const key = rate.toFixed(4)
    const cur = buckets.get(key) ?? { rate, amount: 0 }
    cur.amount += amount
    buckets.set(key, cur)
  }
  if (extra) {
    for (const e of extra) {
      if (!e.amount) continue
      const existing = Array.from(buckets.values())[0]
      // Fold the extra VAT into the first bucket if one already exists —
      // otherwise emit it as a standalone row.
      if (existing) existing.amount += e.amount
      else buckets.set('extra', { rate: 0, amount: e.amount })
    }
  }
  const rows = Array.from(buckets.values())
    .sort((a, b) => b.rate - a.rate)
    .map((b) => ({
      label: `VAT @ ${(b.rate * 100).toFixed(b.rate === 0 ? 0 : b.rate * 100 % 1 === 0 ? 0 : 1)}%`,
      amount: Math.round(b.amount * 10000) / 10000,
    }))
  return rows
}

/**
 * Draw header/footer notes from a document template.
 * Shared by the preview route and all real PDF routes.
 */
export type TemplateNoteFields = {
  headerNote?: string | null
  footerNote?: string | null
  termsText?: string | null
  customFooter?: string | null
  showPaymentTerms?: boolean
  paymentTermsText?: string | null
}

export function drawTemplateNotes(
  doc: PDFKit.PDFDocument,
  tpl: TemplateNoteFields | null,
  position: 'header' | 'footer',
) {
  if (!tpl) return
  if (position === 'header' && tpl.headerNote) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(tpl.headerNote, 50, doc.y, { width: 495 })
    doc.y += 10
  }
  if (position === 'footer') {
    if (tpl.showPaymentTerms && tpl.paymentTermsText) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text('Payment Terms', 50, doc.y)
      doc.font('Helvetica').fontSize(8).fillColor('#333').text(tpl.paymentTermsText, 50, doc.y + 2, { width: 495 })
      doc.y += 10
    }
    if (tpl.termsText) {
      doc.font('Helvetica').fontSize(7).fillColor('#888').text('TERMS & CONDITIONS', 50, doc.y)
      doc.y += 2
      doc.font('Helvetica').fontSize(7).fillColor('#666').text(tpl.termsText, 50, doc.y, { width: 495 })
      doc.y += 10
    }
    if (tpl.footerNote) {
      doc.font('Helvetica').fontSize(8).fillColor('#888').text(tpl.footerNote, 50, doc.y, { width: 495, align: 'center' })
      doc.y += 6
    }
  }
}

/**
 * Collect a PDFDocument's output into a Buffer
 */
export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}
