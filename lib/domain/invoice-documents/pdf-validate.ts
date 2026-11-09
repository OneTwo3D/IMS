import { createHash } from 'node:crypto'

/** Default ceiling for one fetched document. An invoice PDF is tens of kilobytes; this is a runaway guard. */
export const DEFAULT_INVOICE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
const MIN_PDF_BYTES = 200
const TAIL_WINDOW = 2048

export type PdfValidation =
  | { ok: true; sha256: string; byteSize: number }
  | { ok: false; reason: string }

export function invoiceDocumentMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.INVOICE_DOCUMENT_MAX_BYTES?.trim()
  const parsed = raw ? Number(raw) : NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INVOICE_DOCUMENT_MAX_BYTES
}

/**
 * Is this buffer a whole PDF? Checks the leading magic, a minimum and maximum size, and the end-of-file
 * marker (a truncated download has the header and not the trailer). It does not parse the document.
 */
export function validateFetchedPdf(buffer: Buffer, maxBytes: number = invoiceDocumentMaxBytes()): PdfValidation {
  if (buffer.length < MIN_PDF_BYTES) return { ok: false, reason: `the response is ${buffer.length} bytes, too small to be a PDF` }
  if (buffer.length > maxBytes) return { ok: false, reason: `the response is ${buffer.length} bytes, over the ${maxBytes}-byte limit` }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, reason: 'the response does not start with the PDF header' }
  const tail = buffer.subarray(Math.max(0, buffer.length - TAIL_WINDOW)).toString('latin1')
  if (!tail.includes('%%EOF')) return { ok: false, reason: 'the response has no PDF end-of-file marker (truncated?)' }
  return { ok: true, sha256: createHash('sha256').update(buffer).digest('hex'), byteSize: buffer.length }
}
