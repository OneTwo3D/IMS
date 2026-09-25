/**
 * QuickBooks Online invoice PDF download and storage.
 * QBO serves invoice PDFs at GET /v3/company/{realmId}/invoice/{id}/pdf.
 */

import { saveInvoicePdfFile } from '@/lib/invoice-pdf'
import { qboGetRaw } from './api'

/**
 * Download an invoice PDF from QuickBooks.
 */
export async function downloadQuickBooksInvoicePdf(qboInvoiceId: string): Promise<Buffer | null> {
  const res = await qboGetRaw(`invoice/${qboInvoiceId}/pdf`, 'application/pdf')
  if (!res.ok || !res.buffer) return null
  return res.buffer
}

/**
 * Save an invoice PDF to configured persistent storage. Returns the logical stored path.
 */
export async function saveInvoicePdf(orderId: string, buffer: Buffer): Promise<string> {
  return saveInvoicePdfFile(orderId, buffer)
}
