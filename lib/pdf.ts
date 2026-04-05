import PDFDocument from 'pdfkit'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Branding — reads from organisation + settings, with sensible defaults
// ---------------------------------------------------------------------------

export type Branding = {
  companyName: string
  legalName: string
  address: string
  phone: string
  email: string
  website: string
  logoUrl: string | null
  primaryColor: string   // hex, e.g. '#1a1a2e'
  accentColor: string    // hex, e.g. '#0f4c81'
}

export async function getBranding(): Promise<Branding> {
  const [org, primarySetting, accentSetting] = await Promise.all([
    db.organisation.findFirst(),
    db.setting.findUnique({ where: { key: 'brand_primary_color' } }),
    db.setting.findUnique({ where: { key: 'brand_accent_color' } }),
  ])

  const address = [org?.addressLine1, org?.addressLine2, org?.city, org?.postcode, org?.country]
    .filter(Boolean)
    .join(', ')

  return {
    companyName: org?.name ?? 'Our Company',
    legalName: org?.legalName ?? org?.name ?? 'Our Company',
    address,
    phone: org?.phone ?? '',
    email: org?.email ?? '',
    website: org?.website ?? '',
    logoUrl: org?.logoUrl ?? null,
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
export function drawHeader(
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

  // Title bar
  doc
    .rect(50, 50, pageWidth, 32)
    .fill(primaryRgb)
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor('#ffffff')
    .text(opts.title, 60, 58, { width: pageWidth - 20 })

  doc.fillColor('#000000')
  doc.y = 95

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

  // Header background
  const totalWidth = columns.reduce((s, c) => s + c.width, 0)
  doc.rect(startX, y, totalWidth, headerHeight).fill([...accentRgb, 0.1] as unknown as string)

  // Header text
  let x = startX
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#444444')
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
 * Draw a footer note
 */
export function drawFooter(doc: PDFKit.PDFDocument, text: string, branding: Branding) {
  if (doc.y > 720) doc.addPage()
  doc.y += 10
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#888888')
    .text(text, 50, doc.y, { width: 595.28 - 100, align: 'center' })
  if (branding.email) {
    doc.text(`Contact: ${branding.email}`, { width: 595.28 - 100, align: 'center' })
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
