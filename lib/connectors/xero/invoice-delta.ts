/**
 * The payment poller's delta read: which invoices changed in Xero since we last looked.
 *
 * Split out from payment-poller.ts so it can be tested without a database — the paging walk and the
 * type/status partitioning are where this went wrong before, and both are pure given a fetcher.
 */

import type { XeroResponse } from './api'

export type XeroInvoice = {
  InvoiceID: string
  Status: string
  Type: string
  FullyPaidOnDate?: string
}

export type XeroInvoicesResponse = {
  Invoices: XeroInvoice[]
}

/**
 * Every status the poller reasons about, fetched in ONE request.
 *
 * PAID drives the forward passes; AUTHORISED (payment removed) and VOIDED both mean an invoice IMS
 * thinks is paid no longer is (audit-M-acct #3). Xero recommends `Statuses` over OR-ing them into
 * `where` ("For faster response times we recommend using these explicit parameters") and it needs
 * no escaping — which is the entire class of bug behind scjz.71 and o3d-1d9.
 */
export const POLLED_STATUSES = ['PAID', 'AUTHORISED', 'VOIDED'] as const

/** Xero's page cap. Verified against the live API: an UNPAGED response silently stops at 100. */
export const PAGE_SIZE = 100

/**
 * Refuse to walk more than this many pages in one poll.
 *
 * 2,000 invoices changing inside one 15-minute window is not our traffic — it is a bulk operation in
 * Xero, or a cursor stuck in the past. Rather than truncate (silently missing payments, the exact
 * bug this fixes) we fail the poll, which holds the cursor and raises a WARNING an operator sees.
 */
export const MAX_PAGES = 20

/**
 * Re-ask for a couple of minutes we have already seen.
 *
 * The cursor is OUR clock; `UpdatedDateUTC` is XERO's. Skew between them, plus the whole-second
 * truncation If-Modified-Since requires, could drop a record into the gap between two polls where
 * nothing would ever look at it again. Overlapping is free: every pass is idempotent (forward passes
 * only consider paidAt:null, reversal passes only paidAt:not-null), so re-seeing a reconciled
 * invoice is a no-op.
 */
export const CURSOR_OVERLAP_MS = 2 * 60_000

export type InvoiceFetcher = (
  path: string,
  opts: { ifModifiedSince: Date },
) => Promise<XeroResponse<XeroInvoicesResponse>>

/**
 * One delta read for the whole poll: every invoice of any type that changed since `since`.
 *
 * Replaces four separate unfiltered queries (sales forward, sales reversal ×2 statuses, bills
 * forward, bills reversal ×2 = 6 calls/run, ~576/day against a 1,000/day cap). The type and status
 * splits now happen client-side off a SINGLE point-in-time snapshot, which also removes an ordering
 * hazard: an invoice paid and then reversed inside one window holds exactly one current status here,
 * so it cannot be seen as both paid and reversed.
 *
 * Paging is not optional — see PAGE_SIZE.
 */
export async function fetchInvoicesModifiedSince(
  since: Date,
  get: InvoiceFetcher,
): Promise<{ ok: true; invoices: XeroInvoice[] } | { ok: false; error: string }> {
  const invoices: XeroInvoice[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await get(
      `Invoices?Statuses=${POLLED_STATUSES.join(',')}&page=${page}&pageSize=${PAGE_SIZE}`,
      { ifModifiedSince: since },
    )
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` }

    const batch = res.data?.Invoices ?? []
    invoices.push(...batch)
    // A short page is the last page; an exactly-full one means there may be more.
    if (batch.length < PAGE_SIZE) return { ok: true, invoices }
  }

  return {
    ok: false,
    error:
      `More than ${MAX_PAGES * PAGE_SIZE} invoices changed since ${since.toISOString()}. Refusing to ` +
      `truncate: the cursor is held and no payment state was changed. Check for a bulk operation in ` +
      `Xero, or a cursor stuck far in the past.`,
  }
}

/** Invoice IDs of one type currently sitting at one of `statuses`. */
export function idsWhere(
  invoices: XeroInvoice[],
  type: 'ACCREC' | 'ACCPAY',
  statuses: readonly string[],
): Set<string> {
  return new Set(
    invoices.filter((i) => i.Type === type && statuses.includes(i.Status)).map((i) => i.InvoiceID),
  )
}
