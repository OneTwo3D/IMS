/**
 * Xero-specific invoice PDF operations.
 * Generic PDF helpers (load, sign, serve) are in lib/invoice-pdf.ts.
 */

import { saveInvoicePdfFile } from '@/lib/invoice-pdf'
import { xeroGetRaw } from './api'

/** Download a Xero invoice as PDF */
export async function downloadXeroInvoicePdf(xeroInvoiceId: string): Promise<Buffer | null> {
  const result = await xeroGetRaw(`Invoices/${xeroInvoiceId}`, 'application/pdf')
  if (!result.ok || !result.buffer) return null
  return result.buffer
}

/** Save invoice PDF to disk */
export async function saveInvoicePdf(orderId: string, buffer: Buffer): Promise<string> {
  return saveInvoicePdfFile(orderId, buffer)
}
