/**
 * The ledger side of the invoice-document fetch: find the customer's invoice / credit note by NUMBER and
 * download its PDF. READ ONLY: three GETs, no write, no claim on any number.
 *
 * The documents are created by another writer (the sales invoicing incumbent), so IMS has no ledger id for
 * them and must ask. Both lookups are the fail-closed kind: a page that cannot prove it holds the whole
 * answer, an answer that cannot be attributed to an organisation, a number the filter cannot express, are
 * failures and never "nobody holds it". Every call goes through `performRequest`, so the daily and minute
 * budget, the egress authorisation and the tenant pinning that govern every other Xero read apply here too.
 */

import type { DocumentClaim } from '@/lib/domain/invoice-documents/claim-selection'
import { xeroGet, xeroGetRaw } from './api'
import { PAGE_SIZE } from './invoice-delta'
import { lookupXeroInvoiceNumberClaim } from './invoice-number-claim'

export type DocumentClaimsLookup =
  | { ok: true; claims: DocumentClaim[] }
  | { ok: false; error: string; unaskable?: boolean; /** The ledger refused or is rate-limited: the sweep should stop, not try the next order. */ stop?: boolean }

export type DocumentPdfDownload =
  | { ok: true; buffer: Buffer }
  | {
      ok: false
      error: string
      /** The ledger cannot be reached or is rate-limited right now: the run should stop, not move to the next order. */
      stop: boolean
    }

/** A refusal that means the ledger cannot or will not answer right now: rate-limited, not sent (0), or unauthorised. */
function isStopStatus(status: number | undefined): boolean {
  return status === 429 || status === 0 || status === 401 || status === 403
}

export async function lookupInvoiceDocumentClaims(invoiceNumber: string): Promise<DocumentClaimsLookup> {
  const lookup = await lookupXeroInvoiceNumberClaim(invoiceNumber)
  if (!lookup.ok) return { ok: false, error: lookup.error, unaskable: lookup.unaskable, stop: isStopStatus(lookup.httpStatus) }
  return {
    ok: true,
    claims: lookup.claims.map((claim) => ({
      documentId: claim.invoiceId,
      documentNumber: claim.invoiceNumber,
      status: claim.status,
      ...(claim.total !== undefined ? { total: claim.total } : {}),
      ...(claim.reference ? { reference: claim.reference } : {}),
      ...(claim.contactName ? { contactName: claim.contactName } : {}),
      ...(claim.currencyCode ? { currencyCode: claim.currencyCode } : {}),
      ...(claim.dateString ? { dateString: claim.dateString } : {}),
    })),
  }
}

const SALES_CREDIT_NOTE_TYPE = 'ACCRECCREDIT'
const WHERE_CLAUSE_HAZARDS = ['"', '\\']

type XeroSalesCreditNoteLookupResponse = {
  CreditNotes?: Array<{
    CreditNoteID?: unknown
    CreditNoteNumber?: unknown
    Type?: unknown
    Status?: unknown
    Total?: unknown
    Reference?: unknown
    CurrencyCode?: unknown
    DateString?: unknown
    Contact?: { Name?: unknown }
  }>
  pagination?: { pageCount?: unknown }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Who holds this credit note number as a SALES credit note (ACCRECCREDIT). Same fail-closed shape as the invoice lookup. */
export async function lookupSalesCreditNoteDocumentClaims(
  creditNoteNumber: string,
  deps: { get: <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }> } = { get: (path) => xeroGet(path) },
): Promise<DocumentClaimsLookup> {
  const wanted = creditNoteNumber.trim()
  if (!wanted) return { ok: false, unaskable: true, error: 'the refund carries no credit note number to look up' }
  for (const hazard of WHERE_CLAUSE_HAZARDS) {
    if (wanted.includes(hazard)) {
      return { ok: false, unaskable: true, error: `credit note number ${JSON.stringify(wanted)} contains ${JSON.stringify(hazard)}, which would change the meaning of the ledger's quoted where-clause` }
    }
  }
  const where = `Type=="${SALES_CREDIT_NOTE_TYPE}" AND CreditNoteNumber=="${wanted}"`
  let res: { ok: boolean; status: number; data?: XeroSalesCreditNoteLookupResponse; error?: string }
  try {
    res = await deps.get<XeroSalesCreditNoteLookupResponse>(`CreditNotes?where=${encodeURIComponent(where)}&page=1&pageSize=${PAGE_SIZE}`)
  } catch (error) {
    return { ok: false, error: `the credit-note lookup threw: ${String(error)}` }
  }
  if (!res.ok) return { ok: false, error: res.error ?? `credit-note lookup failed with HTTP ${res.status}`, stop: isStopStatus(res.status) }
  if (!res.data || !Array.isArray(res.data.CreditNotes)) return { ok: false, error: 'the credit-note lookup returned no CreditNotes array' }
  const rows = res.data.CreditNotes
  if (rows.length >= PAGE_SIZE) return { ok: false, error: `the credit-note lookup filled its page (${rows.length}) for ${wanted}, so it cannot show it saw every document` }
  const pageCount = res.data.pagination?.pageCount
  if (typeof pageCount === 'number' && pageCount > 1) return { ok: false, error: `the credit-note lookup for ${wanted} spans ${pageCount} pages` }

  const claims: DocumentClaim[] = []
  for (const row of rows) {
    const number = asString(row?.CreditNoteNumber)
    if (!number || number.toLowerCase() !== wanted.toLowerCase()) continue
    const type = asString(row?.Type)
    if (type !== undefined && type.toUpperCase() !== SALES_CREDIT_NOTE_TYPE) continue
    const documentId = asString(row?.CreditNoteID)
    if (!documentId) return { ok: false, error: `a document holds credit note number ${wanted} but the lookup returned no CreditNoteID` }
    const reference = asString(row?.Reference)
    const contactName = asString(row?.Contact?.Name)
    const currencyCode = asString(row?.CurrencyCode)
    const dateString = asString(row?.DateString)
    claims.push({
      documentId,
      documentNumber: number,
      status: (asString(row?.Status) ?? 'UNKNOWN').toUpperCase(),
      ...(typeof row?.Total === 'number' && Number.isFinite(row.Total) ? { total: row.Total } : {}),
      ...(reference ? { reference } : {}),
      ...(contactName ? { contactName } : {}),
      ...(currencyCode ? { currencyCode: currencyCode.toUpperCase() } : {}),
      ...(dateString ? { dateString } : {}),
    })
  }
  return { ok: true, claims }
}

/** GET the document as a PDF. A 429, a refusal to send, or an auth failure means the run should stop. */
export async function downloadLedgerDocumentPdf(kind: 'INVOICE' | 'CREDIT_NOTE', documentId: string): Promise<DocumentPdfDownload> {
  const path = kind === 'INVOICE' ? `Invoices/${encodeURIComponent(documentId)}` : `CreditNotes/${encodeURIComponent(documentId)}`
  const result = await xeroGetRaw(path, 'application/pdf')
  if (result.ok && result.buffer) return { ok: true, buffer: result.buffer }
  const stop = isStopStatus(result.status)
  return { ok: false, stop, error: result.error ?? `PDF download failed with HTTP ${result.status}` }
}
