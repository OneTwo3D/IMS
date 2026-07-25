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
 * Refuse to walk more than this many pages in ONE window.
 *
 * 2,000 invoices changing inside one 15-minute window is not our traffic — it is a bulk operation in
 * Xero, or a cursor stuck in the past. Truncating would silently miss payments (the exact bug #494
 * removed), so a window this size is never read whole: it is carved into bounded chunks and drained
 * with a checkpoint per chunk (o3d-zdh — see drainInvoicesModifiedSince).
 *
 * Raising this number was explicitly NOT the fix: a bigger cap moves the cliff, it does not remove
 * it, and every extra page is a call against a 1,000/day budget.
 */
export const MAX_PAGES = 20

/**
 * Chunks drained in a single poll before handing back to the next one.
 *
 * The drain is bounded, not exhaustive: each chunk costs up to MAX_PAGES+1 calls against a
 * 1,000/day Xero budget, and the cron runs every 15 minutes anyway. Progress is checkpointed per
 * chunk, so stopping early is a pause, not a loss — the next poll resumes from the cursor.
 */
export const MAX_CHUNKS_PER_POLL = 4

/**
 * Attempts spent narrowing a chunk before the drain gives up and says so.
 *
 * Halving a 24h window reaches the one-second floor in ~17 steps, so hitting this budget means the
 * window is not narrowing (records appearing as fast as we bisect) — a condition to report, not to
 * keep spending calls on.
 */
export const MAX_CHUNK_PROBES = 32

/**
 * The smallest window Xero's date filters can express, and therefore the floor of subdivision.
 *
 * If-Modified-Since is whole seconds (formatIfModifiedSince truncates), and `where` compares against
 * DateTime(y,M,d,H,m,s) — also whole seconds. A sub-second chunk is not a narrower question, it is
 * the same question asked with a misleading label, so the drain never asks one.
 */
export const MIN_CHUNK_MS = 1_000

/**
 * How far BELOW the last checkpoint the next chunk starts.
 *
 * The two filters bounding a chunk read the boundary differently, and both readings have to be
 * survivable because only one of them is verified:
 *   - the upper bound is `UpdatedDateUTC < B`, so a record at exactly B is NOT in this chunk;
 *   - the next chunk's floor is the If-Modified-Since header, truncated to the second and — on the
 *     pessimistic reading — compared STRICTLY greater-than. A floor of exactly B would then also
 *     exclude a record at exactly B, and it would be lost between two chunks that both "covered" it.
 * Starting one full second below the checkpoint makes the floor strictly earlier than any record the
 * previous chunk excluded, under either reading. The cost is re-reading one second of invoices per
 * chunk, and re-reading is a no-op — every pass off this delta is idempotent (see CURSOR_OVERLAP_MS,
 * which is the same trade at poll scale).
 */
export const CHUNK_FLOOR_BACKOFF_MS = 1_000

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
 *
 * ALL-OR-NOTHING by design: an oversized window is an error here, never a truncated answer. The
 * poller does not call this directly any more — it goes through drainInvoicesModifiedSince, which
 * turns that error into bounded chunks instead of a stall (o3d-zdh). This remains the one-window
 * read: pass `upperBound` to close the window at the top as well as the bottom.
 */
export async function fetchInvoicesModifiedSince(
  since: Date,
  get: InvoiceFetcher,
  upperBound?: Date,
): Promise<{ ok: true; invoices: XeroInvoice[] } | { ok: false; error: string }> {
  const walked = await walkPages(since, upperBound, get)
  if (walked.status === 'ok') return { ok: true, invoices: walked.invoices }
  if (walked.status === 'error') return { ok: false, error: walked.error }
  return {
    ok: false,
    error:
      `More than ${MAX_PAGES * PAGE_SIZE} invoices changed since ${since.toISOString()}. Refusing to ` +
      `truncate: the cursor is held and no payment state was changed. Check for a bulk operation in ` +
      `Xero, or a cursor stuck far in the past (o3d-zdh).`,
  }
}

const secondFloor = (ms: number): number => Math.floor(ms / 1000) * 1000
const secondCeil = (ms: number): number => Math.ceil(ms / 1000) * 1000

/**
 * The UPPER bound If-Modified-Since cannot express.
 *
 * If-Modified-Since is a floor and nothing else — there is no matching header, and no `ModifiedBefore`
 * query param — so the ceiling has to come from the `where` filter. Xero's date literal is
 * DateTime(y,M,d,H,m,s): WHOLE SECONDS, no sub-second component. The bound is therefore FLOORED to
 * the second here, and callers must treat the floored value (chunkEnd below) as what they actually
 * covered. Rounding up instead would have the caller checkpoint past records the literal excluded —
 * precisely the silent skip this whole module exists to prevent.
 *
 * ASSUMPTION, NOT YET VERIFIED LIVE (o3d-0py): that Xero ANDs this `where` with both the
 * `Statuses` parameter and the If-Modified-Since header (rather than one overriding another), and
 * that `order=UpdatedDateUTC DESC` + `page`/`pageSize` behave under a `where` exactly as they do
 * without one. Every unverified assumption in #494 turned out to matter, so this is deliberately
 * kept OFF the normal poll path: the clause is only ever sent once a window has already proved
 * oversized, and a rejection surfaces as a held cursor plus a WARNING, never as a silent skip.
 */
export function upperBoundWhere(upper: Date): string {
  const d = new Date(secondFloor(upper.getTime()))
  return (
    `UpdatedDateUTC<DateTime(${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()},` +
    `${d.getUTCHours()},${d.getUTCMinutes()},${d.getUTCSeconds()})`
  )
}

function invoicesPath(page: number, upper?: Date): string {
  const query =
    `Statuses=${POLLED_STATUSES.join(',')}&order=${encodeURIComponent(POLL_ORDER)}` +
    `&page=${page}&pageSize=${PAGE_SIZE}`
  return upper ? `Invoices?${query}&where=${encodeURIComponent(upperBoundWhere(upper))}` : `Invoices?${query}`
}

type WalkOutcome =
  | { status: 'ok'; invoices: XeroInvoice[] }
  | { status: 'overflow' }
  | { status: 'error'; error: string }

/** Page a window to completion, or report that it holds more than the cap. */
async function walkPages(floor: Date, upper: Date | undefined, get: InvoiceFetcher): Promise<WalkOutcome> {
  const byId = new Map<string, XeroInvoice>()

  // MAX_PAGES + 1: the extra request is a sentinel. Stopping at exactly MAX_PAGES full pages cannot
  // tell "there are precisely 2,000" from "there are more than 2,000", and calling the former an
  // overflow would stall a poll that had in fact just finished (#494).
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    const res = await get(invoicesPath(page, upper), { ifModifiedSince: floor })
    if (!res.ok) return { status: 'error', error: res.error ?? `HTTP ${res.status}` }

    const batch = res.data?.Invoices ?? []
    // Deduplicate: paging a live set newest-first can hand back a record we already have when
    // something is edited mid-walk. Last write wins, so the freshest status of a given invoice is
    // the one we keep.
    for (const invoice of batch) byId.set(invoice.InvoiceID, invoice)

    // A short page is the last page; an exactly-full one means there may be more.
    if (batch.length < PAGE_SIZE) return { status: 'ok', invoices: [...byId.values()] }
  }

  return { status: 'overflow' }
}

/**
 * Does this window fit under the cap? ONE request, not a walk.
 *
 * Asking for the sentinel page directly answers "is there anything past the cap" for the price of a
 * single call, which is what makes bisecting an oversized window affordable — walking each candidate
 * would cost MAX_PAGES+1 calls per guess against a 1,000/day budget.
 */
async function fitsUnderCap(
  floor: Date,
  upper: Date,
  get: InvoiceFetcher,
): Promise<{ status: 'fits' } | { status: 'overflow' } | { status: 'error'; error: string }> {
  const res = await get(invoicesPath(MAX_PAGES + 1, upper), { ifModifiedSince: floor })
  if (!res.ok) return { status: 'error', error: res.error ?? `HTTP ${res.status}` }
  return (res.data?.Invoices ?? []).length === 0 ? { status: 'fits' } : { status: 'overflow' }
}

/** One drained slice of the window, and the point up to which the caller may now checkpoint. */
export type DeltaChunk = {
  invoices: XeroInvoice[]
  /** Exclusive upper bound of this chunk: every invoice modified before it has now been handed over. */
  through: Date
}

/** `stop` leaves the cursor where the last successful chunk put it and ends the drain. */
export type DeltaChunkHandler = (chunk: DeltaChunk) => Promise<'continue' | 'stop'>

export type DeltaDrainResult =
  | { ok: true; chunks: number; complete: boolean; stopped: boolean }
  | { ok: false; error: string; chunks: number }

/**
 * Read `[since, windowEnd)` in bounded pieces, handing each to `onChunk` before reading the next.
 *
 * WHY THIS EXISTS (o3d-zdh). fetchInvoicesModifiedSince refuses to truncate an oversized window, and
 * the poller correctly holds its cursor when it does — advancing past invoices nobody read is the
 * silent payment loss #494 removed. But holding is not recovering: the next poll re-asked the same
 * oversized question and failed identically, so payment detection stopped dead until a human
 * intervened. A window that cannot be read whole is now read in pieces instead.
 *
 * THE CONTRACT WITH THE CALLER is the only thing that keeps this safe: `through` is the exclusive
 * upper bound of a chunk that has been handed over IN FULL. Checkpoint it and everything below it is
 * accounted for; nothing above it has been touched. So a failure three chunks in costs the work of
 * one chunk, not of the whole backlog.
 *
 * SHAPE OF THE WALK:
 *  - The first attempt is the unbounded read a normal poll has always done — one request, no `where`
 *    clause, no behaviour change on the hot path. Only when THAT overflows does chunking begin, so
 *    the unverified `where` combination can never break an ordinary poll. The price is that a poll
 *    resuming a drain re-establishes the overflow at MAX_PAGES+1 calls before chunking; that is
 *    deliberate (no extra persisted state, and the common path stays one request) and it is bounded
 *    by how few polls a drain takes.
 *  - A candidate chunk is sized by halving on overflow and doubling on success, and each candidate
 *    is settled with a single sentinel-page request rather than a full walk.
 *  - Chunks per poll are capped: an incomplete drain reports `complete: false` and resumes from the
 *    checkpoint on the next 15-minute run.
 *
 * AN INVOICE EDITED MID-DRAIN cannot be lost, for the same reason POLL_ORDER gives: its
 * UpdatedDateUTC becomes ~now, which is at or above windowEnd, so it drops out of every remaining
 * chunk — and every checkpoint this drain can write is at or below windowEnd, so the next poll's
 * window still contains it. The cursor never passes a record it has not read.
 *
 * WHERE IT STILL REFUSES: more than the cap inside ONE SECOND. Both of Xero's date filters are
 * whole-second, so such a window cannot be subdivided, and reading part of it would mean either
 * checkpointing over unread invoices or spinning forever. It drains everything up to that second,
 * then fails loudly with the second named. That is a far narrower cliff than "2,000 in one poll",
 * and unlike the old one it cannot be reached without a genuinely undrainable second.
 */
export async function drainInvoicesModifiedSince(
  since: Date,
  windowEnd: Date,
  get: InvoiceFetcher,
  onChunk: DeltaChunkHandler,
): Promise<DeltaDrainResult> {
  // The ordinary poll: one unbounded read of the whole window, exactly as before chunking existed.
  const whole = await walkPages(since, undefined, get)
  if (whole.status === 'error') return { ok: false, error: whole.error, chunks: 0 }
  if (whole.status === 'ok') {
    const decision = await onChunk({ invoices: whole.invoices, through: windowEnd })
    return { ok: true, chunks: 1, complete: decision === 'continue', stopped: decision === 'stop' }
  }

  // Oversized. Everything below reads bounded sub-windows only.
  // The end is floored to the second because that is the resolution the upper bound can express;
  // the sliver between it and windowEnd simply belongs to the next poll's window.
  const end = secondFloor(windowEnd.getTime())
  let watermark = since.getTime()
  if (watermark >= end) {
    return {
      ok: false,
      error:
        `More than ${MAX_PAGES * PAGE_SIZE} invoices changed since ${since.toISOString()} and the ` +
        `window ending ${windowEnd.toISOString()} is too short to subdivide. The cursor is held ` +
        `(o3d-zdh).`,
      chunks: 0,
    }
  }

  let span = Math.max(MIN_CHUNK_MS, Math.floor((end - watermark) / 2))
  let chunks = 0
  let probes = 0

  while (watermark < end) {
    if (chunks >= MAX_CHUNKS_PER_POLL) return { ok: true, chunks, complete: false, stopped: false }

    const floor = new Date(watermark - CHUNK_FLOOR_BACKOFF_MS)
    // The narrowest chunk that still moves the cursor a whole second forward. Anything smaller is
    // indistinguishable to Xero's second-resolution filters.
    const narrowest = secondCeil(watermark + MIN_CHUNK_MS)
    const upperMs = Math.min(end, Math.max(narrowest, secondFloor(watermark + span)))
    const upper = new Date(upperMs)

    const undividable = (): DeltaDrainResult => ({
      ok: false,
      error:
        `More than ${MAX_PAGES * PAGE_SIZE} invoices share the window ${floor.toISOString()} to ` +
        `${upper.toISOString()}, which cannot be split any further — Xero filters UpdatedDateUTC to ` +
        `whole seconds. Everything before ${new Date(watermark).toISOString()} was processed and ` +
        `checkpointed; the cursor is held there rather than skipping invoices nobody read. This ` +
        `needs an operator: look for a bulk edit in Xero at that timestamp (o3d-zdh).`,
      chunks,
    })

    if (++probes > MAX_CHUNK_PROBES) {
      return {
        ok: false,
        error:
          `Gave up narrowing an oversized Xero delta after ${MAX_CHUNK_PROBES} attempts (last window ` +
          `${floor.toISOString()} to ${upper.toISOString()}). ${chunks} chunk(s) were processed and ` +
          `checkpointed; the cursor is held at ${new Date(watermark).toISOString()} (o3d-zdh).`,
        chunks,
      }
    }

    // Halve the width ACTUALLY attempted, not the notional span: near the end of the window the
    // span is clamped, and halving the clamped-away number would re-issue the identical request
    // until the arithmetic caught up — probe budget spent learning nothing.
    const width = upperMs - watermark
    const narrower = Math.max(MIN_CHUNK_MS, Math.floor(width / 2))

    const fit = await fitsUnderCap(floor, upper, get)
    if (fit.status === 'error') return { ok: false, error: fit.error, chunks }
    if (fit.status === 'overflow') {
      if (upperMs <= narrowest) return undividable()
      span = narrower
      continue
    }

    const walked = await walkPages(floor, upper, get)
    if (walked.status === 'error') return { ok: false, error: walked.error, chunks }
    if (walked.status === 'overflow') {
      // The window grew between the sentinel probe and the walk. Narrow and re-ask rather than
      // trust a half-read chunk.
      if (upperMs <= narrowest) return undividable()
      span = narrower
      continue
    }

    const decision = await onChunk({ invoices: walked.invoices, through: upper })
    chunks++
    watermark = upperMs
    if (decision === 'stop') return { ok: true, chunks, complete: false, stopped: true }
    // Grow back after a success: one dense stretch must not pin every later chunk to a second, or a
    // day-long backlog would need 86,400 of them.
    span = Math.min(Math.max(end - watermark, MIN_CHUNK_MS), width * 2)
  }

  return { ok: true, chunks, complete: true, stopped: false }
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
