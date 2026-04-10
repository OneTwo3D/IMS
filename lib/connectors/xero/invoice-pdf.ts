/**
 * Xero-specific invoice PDF operations.
 * Generic PDF helpers (load, sign, serve) are in lib/invoice-pdf.ts.
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { xeroGetRaw } from './api'

const PDF_DIR = join(process.cwd(), 'data', 'invoices')

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
