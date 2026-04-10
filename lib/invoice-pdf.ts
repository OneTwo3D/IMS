/**
 * Generic invoice PDF helpers — loading, serving, and signing.
 * These are not Xero-specific; any accounting connector can save PDFs to disk.
 * Xero-specific download logic stays in lib/connectors/xero/invoice-pdf.ts.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { createHmac } from 'crypto'

const PDF_DIR = join(process.cwd(), 'data', 'invoices')
const SIGNING_SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || 'invoice-pdf-secret'

/** Get the file path for a saved invoice PDF */
export function getInvoicePdfPath(orderId: string): string {
  return join(PDF_DIR, `${orderId}.pdf`)
}

/** Load a saved invoice PDF from disk */
export async function loadInvoicePdf(orderId: string): Promise<Buffer | null> {
  try {
    return await readFile(getInvoicePdfPath(orderId))
  } catch {
    return null
  }
}

/** Generate an HMAC-signed token for public PDF download */
export function signPdfToken(orderId: string): string {
  return createHmac('sha256', SIGNING_SECRET).update(orderId).digest('hex')
}

/** Verify an HMAC-signed token */
export function verifyPdfToken(orderId: string, token: string): boolean {
  const expected = signPdfToken(orderId)
  if (expected.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
  }
  return diff === 0
}

/** Get a signed public URL for downloading the invoice PDF */
export function getInvoiceDownloadUrl(orderId: string): string {
  const token = signPdfToken(orderId)
  return `/api/invoices/${orderId}?token=${token}`
}
