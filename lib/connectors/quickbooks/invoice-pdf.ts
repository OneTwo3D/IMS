/**
 * QuickBooks Online invoice PDF download and storage.
 * QBO serves invoice PDFs at GET /v3/company/{realmId}/invoice/{id}/pdf.
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { qboGetRaw } from './api'

const PDF_DIR = join(process.cwd(), 'data', 'invoices')

/**
 * Download an invoice PDF from QuickBooks.
 */
export async function downloadQuickBooksInvoicePdf(qboInvoiceId: string): Promise<Buffer | null> {
  const res = await qboGetRaw(`invoice/${qboInvoiceId}/pdf`, 'application/pdf')
  if (!res.ok || !res.buffer) return null
  return res.buffer
}

/**
 * Save an invoice PDF to disk. Returns the relative path.
 */
export async function saveInvoicePdf(orderId: string, buffer: Buffer): Promise<string> {
  await mkdir(PDF_DIR, { recursive: true })
  const filePath = join(PDF_DIR, `${orderId}.pdf`)
  await writeFile(filePath, buffer)
  return `data/invoices/${orderId}.pdf`
}
