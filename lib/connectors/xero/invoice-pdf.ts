/**
 * Download, save, and serve Xero invoice PDFs.
 */

import { mkdir, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { createHmac } from 'crypto'
import { xeroGetRaw } from './api'

const PDF_DIR = join(process.cwd(), 'data', 'invoices')
const SIGNING_SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || 'invoice-pdf-secret'

/** Download a Xero invoice as PDF */
export async function downloadXeroInvoicePdf(xeroInvoiceId: string): Promise<Buffer | null> {
  const result = await xeroGetRaw(`Invoices/${xeroInvoiceId}`, 'application/pdf')
  if (!result.ok || !result.buffer) return null
  return result.buffer
}

/** Save invoice PDF to disk */
export async function saveInvoicePdf(orderId: string, buffer: Buffer): Promise<string> {
  await mkdir(PDF_DIR, { recursive: true })
  const filename = `${orderId}.pdf`
  const filePath = join(PDF_DIR, filename)
  await writeFile(filePath, buffer)
  return filePath
}

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
  // Timing-safe comparison
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
