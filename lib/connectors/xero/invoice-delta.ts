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
 * Page NEWEST-FIRST. This is a correctness choice, not a cosmetic one.
 *
 * Offset paging over a live result set is not a snapshot: rows shift under us between page requests.
 * Which direction they shift decides whether that is survivable.
 *
 *   - ASCending (Xero's default — verified live) a record edited mid-walk moves to the TAIL. Every
 *     record behind it shifts back one, so the first row of the next page slides into the page we
 *     just read and is never returned. That record was NOT edited, so its UpdatedDateUTC is old, the
 *     next poll's window excludes it, and the payment is lost for good.
 *   - DESCending, an edited record moves to the HEAD. Unmodified records can only shift toward pages
 *     we have not read yet, so none can be skipped. The one record that can slip past is the edited
 *     one itself — and its UpdatedDateUTC is now newer than pollStartedAt, so the next poll is
 *     guaranteed to return it.
 *
 * So DESC turns "silently lose an untouched invoice forever" into "re-read an edited one next poll",
 * and re-reading is a no-op. Verified live: Xero accepts this order and honours it.
 */
export const POLL_ORDER = 'UpdatedDateUTC DESC'

/**
 * Refuse to walk more than this many pages in one poll.
 *
 * 2,000 invoices changing inside one 15-minute window is not our traffic — it is a bulk operation in
 * Xero, or a cursor stuck in the past. Rather than truncate (silently missing payments, the exact
 * bug this fixes) we fail the poll, which holds the cursor and raises a WARNING an operator sees.
 *
 * KNOWN LIMIT, stated rather than papered over: this does not self-heal. Holding the cursor means
 * the next poll re-requests the same oversized window and fails the same way, so payment detection
 * stops until someone intervenes. That is deliberate — a loud stall beats advancing the cursor past
 * invoices nobody read — but it is a stall, not a recovery. Draining a delta this size needs bounded
 * chunks (an upper bound via `where UpdatedDateUTC < x` alongside the If-Modified-Since floor) with
 * per-chunk checkpointing: tracked as o3d-zdh.
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
 * splits now happen client-side off ONE read, which also removes an ordering hazard: an invoice paid
 * and then reversed inside one window appears here with exactly one current status, so it cannot be
 * seen as both paid and reversed.
 *
 * "One read" is precise for the single-page case, which is every normal poll. A multi-page walk is
 * NOT a point-in-time snapshot — see POLL_ORDER for what that costs and why newest-first makes it
 * survivable.
 *
 * Paging is not optional — see PAGE_SIZE.
 */
export async function fetchInvoicesModifiedSince(
  since: Date,
  get: InvoiceFetcher,
): Promise<{ ok: true; invoices: XeroInvoice[] } | { ok: false; error: string }> {
  const byId = new Map<string, XeroInvoice>()
  const order = encodeURIComponent(POLL_ORDER)

  // MAX_PAGES + 1: the extra request is a sentinel. Stopping at exactly MAX_PAGES full pages cannot
  // tell "there are precisely 2,000" from "there are more than 2,000", and calling the former an
  // overflow would stall a poll that had in fact just finished.
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    const res = await get(
      `Invoices?Statuses=${POLLED_STATUSES.join(',')}&order=${order}&page=${page}&pageSize=${PAGE_SIZE}`,
      { ifModifiedSince: since },
    )
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` }

    const batch = res.data?.Invoices ?? []
    // Deduplicate: paging a live set newest-first can hand back a record we already have when
    // something is edited mid-walk. Last write wins, so the freshest status of a given invoice is
    // the one we keep.
    for (const invoice of batch) byId.set(invoice.InvoiceID, invoice)

    // A short page is the last page; an exactly-full one means there may be more.
    if (batch.length < PAGE_SIZE) return { ok: true, invoices: [...byId.values()] }
  }

  return {
    ok: false,
    error:
      `More than ${MAX_PAGES * PAGE_SIZE} invoices changed since ${since.toISOString()}. Refusing to ` +
      `truncate: the cursor is held and no payment state was changed. Check for a bulk operation in ` +
      `Xero, or a cursor stuck far in the past — a delta this large will not clear on its own and ` +
      `needs an operator (o3d-zdh).`,
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
