/**
 * Ask Xero who holds an invoice number, before we post under it (o3d-k26m.5).
 *
 * This is the one live read that licenses the sales-invoice create. The decision it feeds is in
 * lib/domain/accounting/invoice-number-ownership.ts — that file carries the reasoning; this one is
 * only the wire call, kept separate so the rule can be tested without a ledger.
 *
 * `GET /Invoices?InvoiceNumbers=<n>` is Xero's exact-match filter on the number and returns the
 * documents holding it (an empty `Invoices` array when none do). It is NOT cacheable: it is a
 * per-transaction question whose whole value is being current, which is why it goes through
 * `xeroGet` and not `xeroGetCached` — the latter refuses non-reference paths outright.
 *
 * EVERY UNEXPECTED SHAPE IS A LOOKUP FAILURE, NOT AN EMPTY RESULT. A 200 with no body, or a body
 * with no `Invoices` key, tells us nothing about who holds the number, and the caller turns
 * "nothing" into permission to post. Xero says "nobody holds it" with `{"Invoices":[]}` and
 * nothing else, so anything else is refused into the fail-closed branch.
 *
 * ACCREC ONLY. Purchase bills (ACCPAY) share the endpoint and their numbers are the SUPPLIER's,
 * explicitly non-unique, and posted create-only via PUT (see bills.ts). A bill that happens to
 * carry the same number as a sales invoice is not a claim on the sales-invoice sequence and must
 * not block a receivable.
 */

import { xeroGet } from './api'
import type { InvoiceNumberLookup, LedgerInvoiceClaim } from '@/lib/domain/accounting/invoice-number-ownership'

type XeroInvoiceNumberLookupResponse = {
  Invoices?: Array<{
    InvoiceID?: unknown
    InvoiceNumber?: unknown
    Type?: unknown
    Status?: unknown
    Total?: unknown
    Contact?: { Name?: unknown }
  }>
}

type LookupDeps = {
  get: <T>(path: string) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Who — if anyone — holds `invoiceNumber` as an ACCREC document in the connected organisation.
 *
 * The number is compared again on the way back rather than trusted from the filter. Xero's
 * matching on this parameter is its own, and an ownership fence that accepts "close enough" is
 * not a fence; a document that comes back under a DIFFERENT number is not a claim on this one.
 * The comparison is case-insensitive because Xero's invoice numbers are, so `AB-1` and `ab-1`
 * are the same claim to the ledger and must be to us.
 */
export async function lookupXeroInvoiceNumberClaim(
  invoiceNumber: string,
  deps: LookupDeps = { get: (path) => xeroGet(path) },
): Promise<InvoiceNumberLookup> {
  const wanted = invoiceNumber.trim()
  if (!wanted) return { ok: false, error: 'no invoice number to look up' }

  let res: { ok: boolean; status: number; data?: XeroInvoiceNumberLookupResponse; error?: string }
  try {
    res = await deps.get<XeroInvoiceNumberLookupResponse>(`Invoices?InvoiceNumbers=${encodeURIComponent(wanted)}`)
  } catch (error) {
    // A throw here is a lookup failure like any other. Letting it propagate would abort the entry
    // with a stack trace instead of the fail-closed refusal the caller knows how to describe.
    return { ok: false, error: `the invoice-number lookup threw: ${String(error)}` }
  }

  if (!res.ok) {
    return { ok: false, error: res.error ?? `invoice-number lookup failed with HTTP ${res.status}` }
  }
  if (!res.data || !Array.isArray(res.data.Invoices)) {
    return { ok: false, error: 'the invoice-number lookup returned no Invoices array' }
  }

  const match = res.data.Invoices.find((inv) => {
    const number = asString(inv?.InvoiceNumber)
    if (!number || number.toLowerCase() !== wanted.toLowerCase()) return false
    const type = asString(inv?.Type)
    // Absent Type is treated as a match: the endpoint returns it, so a missing one is a shape we
    // do not understand, and on this fence an unknown document counts as a claim.
    return type === undefined || type.toUpperCase() === 'ACCREC'
  })

  if (!match) return { ok: true, claim: null }

  const invoiceId = asString(match.InvoiceID)
  if (!invoiceId) {
    // Something holds the number and the ledger did not say what. That is the least safe possible
    // state to guess in.
    return { ok: false, error: `a document holds invoice number ${wanted} but the lookup returned no InvoiceID` }
  }

  const claim: LedgerInvoiceClaim = {
    invoiceId,
    invoiceNumber: asString(match.InvoiceNumber) ?? wanted,
    status: asString(match.Status) ?? 'UNKNOWN',
  }
  const contactName = asString(match.Contact?.Name)
  if (contactName) claim.contactName = contactName
  if (typeof match.Total === 'number' && Number.isFinite(match.Total)) claim.total = match.Total

  return { ok: true, claim }
}
