/**
 * The payment poller's delta read: which invoices changed in Xero since we last looked.
 *
 * Split out from payment-poller.ts so it can be tested without a database — the paging walk and the
 * type/status partitioning are where this went wrong before, and both are pure given a fetcher.
 */

import { mayHaveReachedLedger } from '@/lib/domain/accounting/cancelled-row-evidence'
import { coversDocumentTotal } from '@/lib/domain/accounting/paid-coverage'
import {
  addMoney,
  compareDecimal,
  isLedgerMinorUnitQuantized,
  ledgerAmountEpsilon,
  ledgerMinorUnits,
  subtractMoney,
  toDecimal,
  type Decimal,
} from '@/lib/domain/math/decimal'

import type { XeroResponse } from './api'

export type XeroInvoice = {
  InvoiceID: string
  Status: string
  Type: string
  FullyPaidOnDate?: string
  /**
   * Xero returns this on every invoice. It is the keyset cursor for a BOUNDED walk (o3d-8f9) —
   * optional only because the fixtures predate it; a bounded walk that meets a row without it
   * fails closed rather than guessing.
   */
  UpdatedDateUTC?: string
  /**
   * What the ledger HOLDS against this invoice, gross. Xero returns both on every invoice in the
   * Invoices collection, and they are the difference between a payment that was REMOVED and one that
   * merely did not cover the whole bill — a distinction Status alone cannot make, because AUTHORISED
   * means "approved and not fully paid" and says nothing about what has been paid (o3d-clxw).
   *
   * Optional only because the fixtures predate them. A reversal verdict that needs them and does not
   * have them is WITHHELD rather than guessed — see partitionPaymentReversals.
   *
   * AmountCredited is deliberately not read: an allocated credit note is not a payment, and `paidAt`
   * records a payment.
   */
  AmountPaid?: number | string
  AmountDue?: number | string
  /**
   * The currency the two amounts above are denominated in, as Xero states it (`"GBP"`, `"KWD"`).
   *
   * IT IS READ FOR ONE REASON: the minor unit is what sizes the magnitude above which those amounts
   * stop surviving JSON transport — see `ledgerAmountMagnitudeBound`. Optional because the fixtures
   * predate it, and an unstated currency is given the STRICTEST reading rather than a default one.
   */
  CurrencyCode?: string
  /**
   * The payments the ledger CURRENTLY HOLDS against this invoice, each carrying the id Xero issued
   * when it created it. Returned by the Invoices LIST endpoint — the same response shape
   * `scripts/audit-xero-live-e2e-footprint.ts` reads against the live tenant to find which payments
   * must be released before an invoice can be voided.
   *
   * THIS IS THE ONLY FIELD THAT CAN ANSWER THE QUESTION THAT MATTERS (o3d-clxw round 2). AmountPaid
   * answers "does the ledger hold ANY payment"; this answers "is the payment IMS REGISTERED still
   * here". They are the same question only while there is exactly one payment, and they diverge the
   * moment somebody in Xero deletes ours and leaves a smaller one behind.
   *
   * Optional, and absence is never read as emptiness: see listedLedgerPaymentIds.
   */
  Payments?: Array<{ PaymentID?: string } | null>
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
 * The BOUNDED walk orders ASCending instead — see walkBoundedKeyset for why the reasoning above
 * inverts once an upper bound exists (o3d-8f9).
 */
export const BOUNDED_POLL_ORDER = 'UpdatedDateUTC ASC'

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
  /**
   * Pass the DRAIN's budget so every chunk, page and saturated-second pass in one poll counts
   * against a single ceiling (o3d-8f9). Omitted, each call gets its own — right for a one-off read.
   */
  budget: RequestBudget = createRequestBudget(),
): Promise<{ ok: true; invoices: XeroInvoice[] } | { ok: false; error: string }> {
  const walked = await walkPages(since, upperBound, get, budget)
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
/**
 * The keyset cursor's lower bound, INCLUSIVE (o3d-8f9).
 *
 * `>=` not `>`: Xero filters at second granularity, so rows can share the cursor's second.
 * Stepping past it with `>` would skip every row after the first in that second; `>=` re-reads
 * them and the dedupe Map absorbs the repeat, which costs nothing and cannot lose a payment.
 */
export function lowerBoundWhere(cursor: Date): string {
  const d = new Date(secondFloor(cursor.getTime()))
  return (
    `UpdatedDateUTC>=DateTime(${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()},` +
    `${d.getUTCHours()},${d.getUTCMinutes()},${d.getUTCSeconds()})`
  )
}

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

/**
 * Xero serialises dates as `/Date(1750000000000+0000)/`. Returns NaN for anything unparseable, so
 * the caller can fail closed rather than treat an unreadable cursor as zero.
 */
export function parseXeroDate(value: string | undefined): number {
  if (!value) return NaN
  const dotNet = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value)
  if (dotNet) return Number(dotNet[1])
  return Date.parse(value)
}

function keysetPath(cursor: Date, upper: Date): string {
  const where = `${lowerBoundWhere(cursor)}&&${upperBoundWhere(upper)}`
  return (
    `Invoices?Statuses=${POLLED_STATUSES.join(',')}&order=${encodeURIComponent(BOUNDED_POLL_ORDER)}` +
    `&page=1&pageSize=${PAGE_SIZE}&where=${encodeURIComponent(where)}`
  )
}

/**
 * Walk a BOUNDED window by KEYSET, not by offset (o3d-8f9).
 *
 * WHY THE UNBOUNDED REASONING DOES NOT CARRY OVER (see POLL_ORDER)
 * ---------------------------------------------------------------
 * Unbounded, DESC is safe: an edited record moves to the HEAD, so unmodified records can only
 * shift toward pages not yet read. Add `UpdatedDateUTC<upper` and that stops being true — an
 * edited record's timestamp rises ABOVE the bound and it leaves the result set entirely. Every
 * record below it then shifts LEFT, so the first row of the next page slides into the page just
 * read and is never returned. `walkPages` sees a short page, calls it completion, and the chunk is
 * CHECKPOINTED past a row nobody read. Codex reproduced exactly that: 1,999 of 2,000 rows returned
 * with status ok, the missing row 1,009 seconds behind the cursor — far outside CURSOR_OVERLAP_MS,
 * so the next poll never revisits it. A silently missed payment, which is the bug this whole module
 * exists to prevent.
 *
 * A keyset cursor is immune to that shift because it names a VALUE, not a position. Ordering ASC,
 * each request asks for `UpdatedDateUTC>=cursor`, and the cursor advances to the newest row seen:
 *
 *   - a record edited mid-walk gets a LATER timestamp, so it moves AWAY from the cursor, toward
 *     rows not yet read — it cannot slip behind into ground already covered;
 *   - if that edit pushes it above `upper` it leaves this window, but its timestamp is now newer
 *     than the bound, so the NEXT window (whose floor is this upper) is guaranteed to return it —
 *     the same argument DESC relies on, now applied to the only record that can escape;
 *   - records nobody touched keep their timestamp and their position relative to the cursor.
 *
 * TIES. Xero's `where` filters at second granularity, so rows can share a cursor value. `>=` (not
 * `>`) re-reads that second rather than stepping over it, and the dedupe Map absorbs the repeat —
 * a re-read is a no-op. The pathological case is a FULL page inside one second: the cursor cannot
 * advance without skipping rows, so the walk refuses and reports an error rather than checkpoint
 * past them. Failing closed is the whole point.
 */
/**
 * Decide whether a drained chunk's `through` may become the persisted cursor (o3d-8f9 r3).
 *
 * Returns the new cursor, or null when the chunk does not advance it.
 *
 * The read floor sits CURSOR_OVERLAP_MS behind the persisted cursor so a record landing during the
 * previous poll gets re-read. That overlap is a QUERY floor, NOT a checkpoint. If the overlap holds
 * more than one chunk — two dense bulk-edit seconds is enough — the first chunk's `through` lands
 * BEFORE the cursor we started from, and persisting it moves the cursor BACKWARD. The next poll then
 * subtracts the overlap from the regressed value and reproduces the same chunking, so it cycles:
 * measured settling at -44s, -49s, -55s, every poll replaying overlap and never reaching either the
 * original checkpoint or newer work, while spending the tenant's whole request budget.
 *
 * Monotonic-only advancement keeps the overlap doing its job — the records ARE re-read and
 * re-processed, idempotently — while making the checkpoint one-way.
 */
export function advanceCheckpoint(current: Date, through: Date): Date | null {
  return through.getTime() > current.getTime() ? through : null
}

/**
 * The hard ceiling on Xero requests ONE poll may make, across everything (o3d-8f9).
 *
 * MAX_CHUNKS_PER_POLL bounds chunks, and MAX_PAGES bounds pages within a window, but neither
 * bounded the total — and the saturated-second verification multiplies it: a 1,900-row chunk spread
 * as 100 invoices across 19 seconds costs roughly 97 requests, and four such chunks plus an
 * overflow probe walk pushes one poll past 400 calls. Xero allows 1,000/day for the whole tenant,
 * shared with every other Xero sync in the system, so a few backlog polls could starve all of them
 * — including the payment polling this module exists to do.
 *
 * 200 leaves the rest of the daily allowance for everything else. Hitting it is not an error in the
 * data: it means the backlog is larger than one poll should chew through, so the cursor is held and
 * the next run continues from the last checkpoint.
 */
export const MAX_REQUESTS_PER_POLL = 200

/**
 * Counts every Xero request a poll makes, including the nested saturated-second passes that
 * otherwise escape MAX_CHUNKS_PER_POLL and MAX_PAGES entirely (o3d-8f9).
 *
 * `spend()` returns an error outcome when the ceiling is reached, so callers stop and hold the
 * cursor rather than breaching the tenant's allowance mid-walk.
 */
export type RequestBudget = {
  spend: () => { status: 'error'; error: string } | null
  spent: () => number
  /**
   * Reconcile the ledger against what the transport ACTUALLY spent (o3d-8f9 r3).
   *
   * `spend()` debits one unit per fetcher invocation, but the production fetcher retries a 429 up
   * to XERO_MAX_RETRIES times, so one invocation can be four tenant API attempts. Counting
   * invocations would let 200 ledger units stand for 800 real calls and defeat the ceiling the
   * ledger exists to enforce. Callers that can observe real attempts settle the difference here.
   */
  settle: (actualAttempts: number) => void
}

export function createRequestBudget(limit: number = MAX_REQUESTS_PER_POLL): RequestBudget {
  let used = 0
  return {
    settle: (actualAttempts: number) => {
      // Only ever upward: a transport that made FEWER calls than we debited (a cache hit, a short
      // circuit) does not earn budget back, because the ceiling is a safety bound, not an allowance
      // to spend down precisely.
      if (actualAttempts > used) used = actualAttempts
    },
    spend: () => {
      if (used >= limit) {
        return {
          status: 'error' as const,
          error:
            `This poll reached its ${limit}-request Xero budget before draining the backlog. The ` +
            `cursor is held at the last checkpoint and the next poll resumes from there; no payment ` +
            `state was changed. Xero allows 1,000 calls/day for the whole tenant, so the remainder ` +
            `is left for other syncs (o3d-8f9).`,
        }
      }
      used += 1
      return null
    },
    spent: () => used,
  }
}

/**
 * How many times to re-read a saturated second before giving up on proving it stable (o3d-8f9).
 *
 * Each attempt costs a full pass over that second, so this is deliberately small: a second that
 * will not hold still across three reads is churning, and holding the cursor is then the right
 * answer rather than burning the daily call budget.
 */
const SATURATED_SECOND_ATTEMPTS = 3

/**
 * Read every invoice whose UpdatedDateUTC falls inside ONE second, and prove the read complete.
 *
 * Offset paging is used here because there is no alternative — the keyset has no resolution left
 * inside a single second, and Xero exposes no secondary sort key to break the tie on. That
 * reintroduces the shift hazard, so the result is VERIFIED rather than trusted.
 *
 * TWO independent checks, because either alone is insufficient:
 *
 * 1. NO DUPLICATE WITHIN A PASS. Under a stable total order, offset pages inside one pass are
 *    disjoint. So an ID appearing on two pages of the SAME pass is proof the server reordered the
 *    tie between requests — and a reorder that pushes one row backwards pushes another forwards,
 *    past the offset we already read. That pass is discarded.
 *
 *    This is the check the first version of this function lacked, and Codex broke it with exactly
 *    the case o3d-8f9 itself warned about: with 150 rows sharing a second, page 1 returns IDs
 *    1-100; if the tie order then shifts so ID 101 moves into the first hundred and ID 1 out of it,
 *    page 2 returns ID 1 again plus 102-150 — a short page, so "complete" — and ID 101 was never
 *    read. Collapsing into a Map HID the duplicate that was the only evidence of the omission, and
 *    a second pass reordering the same legal way agreed with the first. Detecting the duplicate is
 *    what makes the omission visible.
 *
 * 2. TWO PASSES AGREEING ON THE EXACT ID SET. Duplicate detection catches reordering but not pure
 *    departure: if a row is edited mid-pass its timestamp leaves this second, everything below it
 *    shifts left, and the row that was sitting on the page boundary is skipped WITHOUT any
 *    duplicate appearing. A second pass reads the now-shorter set and disagrees, so we retry. The
 *    departed row itself is not lost — its timestamp is now at or above the drain's upper bound, so
 *    the next window returns it.
 *
 * Together: a pass with no internal duplicate, ending on a short page, whose ID set a second pass
 * reproduces exactly, has been read whole. Anything else is retried, and after
 * SATURATED_SECOND_ATTEMPTS it fails closed with the cursor held.
 */
async function readSaturatedSecond(
  second: Date,
  floor: Date,
  get: InvoiceFetcher,
  budget: RequestBudget,
): Promise<WalkOutcome> {
  const windowEnd = new Date(second.getTime() + 1000)

  /** A pass discarded because the server reordered the tie under us — not an error, a retry. */
  type Pass = WalkOutcome | { status: 'unstable'; reason: string }

  const readOnce = async (): Promise<Pass> => {
    const byId = new Map<string, XeroInvoice>()
    for (let page = 1; page <= MAX_PAGES + 1; page++) {
      const where = `${lowerBoundWhere(second)}&&${upperBoundWhere(windowEnd)}`
      const path =
        `Invoices?Statuses=${POLLED_STATUSES.join(',')}&order=${encodeURIComponent(BOUNDED_POLL_ORDER)}` +
        `&page=${page}&pageSize=${PAGE_SIZE}&where=${encodeURIComponent(where)}`
      const spend = budget.spend()
      if (spend) return spend
      const res = await get(path, { ifModifiedSince: floor })
      if (!res.ok) return { status: 'error', error: res.error ?? `HTTP ${res.status}` }
      const batch = res.data?.Invoices ?? []

      for (const invoice of batch) {
        if (byId.has(invoice.InvoiceID)) {
          return {
            status: 'unstable',
            reason:
              `invoice ${invoice.InvoiceID} was returned on two pages of one pass, so the tie order ` +
              `moved between requests`,
          }
        }
        byId.set(invoice.InvoiceID, invoice)
      }

      if (batch.length < PAGE_SIZE) return { status: 'ok', invoices: [...byId.values()] }
    }
    return { status: 'overflow' }
  }

  const sameIds = (a: XeroInvoice[], b: XeroInvoice[]): boolean => {
    if (a.length !== b.length) return false
    const ids = new Set(a.map((i) => i.InvoiceID))
    return b.every((i) => ids.has(i.InvoiceID))
  }

  let previous: XeroInvoice[] | null = null
  let lastReason = 'the reads did not agree'
  for (let attempt = 1; attempt <= SATURATED_SECOND_ATTEMPTS; attempt++) {
    const pass = await readOnce()
    if (pass.status === 'error' || pass.status === 'overflow') return pass
    if (pass.status === 'unstable') {
      lastReason = pass.reason
      previous = null // a discarded pass cannot corroborate the next one
      continue
    }

    if (previous && sameIds(previous, pass.invoices)) return pass
    previous = pass.invoices
  }

  return {
    status: 'error',
    error:
      `The invoices updated at ${second.toISOString()} could not be proven completely read across ` +
      `${SATURATED_SECOND_ATTEMPTS} attempts (${lastReason}). More than ${PAGE_SIZE} invoices share ` +
      `that second and Xero offers no secondary sort key to page it by. The cursor is held and no ` +
      `payment state was changed (o3d-8f9).`,
  }
}

async function walkBoundedKeyset(
  floor: Date,
  upper: Date,
  get: InvoiceFetcher,
  budget: RequestBudget,
): Promise<WalkOutcome> {
  const byId = new Map<string, XeroInvoice>()
  let cursor = floor

  for (let request = 1; request <= MAX_PAGES + 1; request++) {
    const spend = budget.spend()
    if (spend) return spend
    const res = await get(keysetPath(cursor, upper), { ifModifiedSince: floor })
    if (!res.ok) return { status: 'error', error: res.error ?? `HTTP ${res.status}` }

    const batch = res.data?.Invoices ?? []
    for (const invoice of batch) byId.set(invoice.InvoiceID, invoice)

    // A short page ends the window: with a keyset there is nothing beyond the last row read.
    if (batch.length < PAGE_SIZE) return { status: 'ok', invoices: [...byId.values()] }

    let newest = Number.NEGATIVE_INFINITY
    for (const invoice of batch) {
      const at = parseXeroDate(invoice.UpdatedDateUTC)
      // A row we cannot place in time cannot advance a cursor. Guessing would reintroduce exactly
      // the silent skip this function exists to remove.
      if (Number.isNaN(at)) {
        return {
          status: 'error',
          error:
            `Invoice ${invoice.InvoiceID} has no readable UpdatedDateUTC, so the bounded window cannot ` +
            `be paged safely. The cursor is held and no payment state was changed (o3d-8f9).`,
        }
      }
      if (at > newest) newest = at
    }

    const next = new Date(secondFloor(newest))
    if (next.getTime() <= cursor.getTime()) {
      // SATURATED SECOND: a full page shares the cursor's second, so the keyset cannot step forward
      // without skipping the rest of it — Xero's `where` has no finer resolution than a second, and
      // no secondary sort key to break the tie on.
      //
      // Failing here would be wrong: a bulk operation in Xero (exactly what the chunked drain
      // exists for) can easily touch several hundred invoices inside one second, and refusing would
      // hold the cursor forever. That trades a missed payment for a permanent stall, which is the
      // failure #494 and o3d-zdh were built to remove.
      //
      // So read that ONE second exhaustively by offset, and PROVE the read was complete before
      // trusting it (see readSaturatedSecond). Then step the cursor past the whole second, which is
      // now safe precisely because it has been read whole.
      const second = await readSaturatedSecond(cursor, floor, get, budget)
      if (second.status !== 'ok') return second
      for (const invoice of second.invoices) byId.set(invoice.InvoiceID, invoice)
      cursor = new Date(cursor.getTime() + 1000)
      continue
    }
    cursor = next
  }

  return { status: 'overflow' }
}

/**
 * Wrap a fetcher so the budget is reconciled against REAL transport attempts after every call
 * (o3d-8f9 r3). `observeAttempts` returns a monotonic count of HTTP attempts; the delta across one
 * invocation is what that invocation actually cost the tenant's allowance.
 *
 * Without this the ledger counts invocations, and the production fetcher's 429 retries make one
 * invocation up to XERO_MAX_RETRIES + 1 attempts.
 */
export function budgetedFetcher(
  get: InvoiceFetcher,
  budget: RequestBudget,
  observeAttempts: () => number,
): InvoiceFetcher {
  return async (path, opts) => {
    const before = observeAttempts()
    try {
      return await get(path, opts)
    } finally {
      // In `finally`: a throwing request still consumed its attempts.
      budget.settle(budget.spent() + Math.max(0, observeAttempts() - before) - 1)
    }
  }
}

/** Page a window to completion, or report that it holds more than the cap. */
async function walkPages(
  floor: Date,
  upper: Date | undefined,
  get: InvoiceFetcher,
  budget: RequestBudget = createRequestBudget(),
): Promise<WalkOutcome> {
  // A bounded window pages by keyset — offset paging is unsafe once rows can leave the set through
  // the top. Unbounded keeps the DESC offset walk, where that cannot happen (o3d-8f9).
  if (upper) return walkBoundedKeyset(floor, upper, get, budget)

  const byId = new Map<string, XeroInvoice>()

  // MAX_PAGES + 1: the extra request is a sentinel. Stopping at exactly MAX_PAGES full pages cannot
  // tell "there are precisely 2,000" from "there are more than 2,000", and calling the former an
  // overflow would stall a poll that had in fact just finished (#494).
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    const spend = budget.spend()
    if (spend) return spend
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
  budget: RequestBudget,
): Promise<{ status: 'fits' } | { status: 'overflow' } | { status: 'error'; error: string }> {
  // Counted like every other request: the narrowing search can issue up to MAX_CHUNK_PROBES of
  // these, and leaving them off the ledger is how a bound gets quietly exceeded (o3d-8f9).
  const spend = budget.spend()
  if (spend) return spend
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
 * A SECOND HOLDING MORE THAN ONE PAGE is no longer a refusal (o3d-8f9). Both of Xero's date filters
 * are whole-second, so such a window cannot be subdivided by cursor — it is instead read
 * exhaustively by offset and PROVEN complete (readSaturatedSecond) before the cursor steps past it.
 * It refuses only when that proof fails: the second keeps reordering or shrinking under the reads,
 * which is genuinely undrainable rather than merely large.
 *
 * WHERE IT STILL STOPS SHORT: MAX_REQUESTS_PER_POLL. A backlog big enough to need hundreds of calls
 * is handed to the next run at the last checkpoint rather than spending the tenant's whole daily
 * Xero allowance in one poll. That is a pause, not a loss.
 */
export async function drainInvoicesModifiedSince(
  since: Date,
  windowEnd: Date,
  get: InvoiceFetcher,
  onChunk: DeltaChunkHandler,
  /**
   * Supply a monotonic count of real HTTP attempts (xeroHttpAttemptCount in production) so the
   * request ceiling bounds tenant API calls rather than fetcher invocations (o3d-8f9 r3). Omitted in
   * tests whose fetcher makes exactly one call per invocation.
   */
  observeAttempts?: () => number,
): Promise<DeltaDrainResult> {
  // ONE budget for the whole poll — the unbounded probe, every chunk, every page, and every
  // saturated-second verification pass all count against it (o3d-8f9). Without this the nested
  // passes escaped MAX_CHUNKS_PER_POLL entirely and a backlog poll could consume several hundred
  // calls out of the tenant's shared 1,000/day.
  const budget = createRequestBudget()
  // Reconcile the ledger against real transport attempts, so a 429 retry inside the fetcher counts
  // against the ceiling instead of hiding behind one invocation (o3d-8f9 r3).
  const counted = observeAttempts ? budgetedFetcher(get, budget, observeAttempts) : get

  // The ordinary poll: one unbounded read of the whole window, exactly as before chunking existed.
  const whole = await walkPages(since, undefined, counted, budget)
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

    const fit = await fitsUnderCap(floor, upper, counted, budget)
    if (fit.status === 'error') return { ok: false, error: fit.error, chunks }
    if (fit.status === 'overflow') {
      if (upperMs <= narrowest) return undividable()
      span = narrower
      continue
    }

    const walked = await walkPages(floor, upper, counted, budget)
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

// ---------------------------------------------------------------------------
// WHAT COUNTS AS A PAYMENT REVERSAL (o3d-clxw)
// ---------------------------------------------------------------------------
//
// `idsWhere(changed, type, ['AUTHORISED', 'VOIDED'])` was the reversal set for both passes, and
// AUTHORISED is not "unpaid". It is Xero's status for an approved invoice that is NOT FULLY paid,
// which includes one carrying a real PART payment — Xero only moves an invoice to PAID when the
// outstanding amount reaches zero.
//
// So a payment that landed as a part payment read as a payment REMOVAL. On the bill side that
// cleared `paidAt`, logged "no longer present in Xero", and re-armed Mark Paid over a supplier
// payment that had genuinely been made: the operator, seeing IMS say unpaid and the log say the
// payment is gone, presses it again and the supplier is paid a second time (markBillPaid sends no
// idempotency key and BILL_PAYMENT sits outside every live-row dedupe, so nothing downstream
// refuses it). On the sales side the same reading additionally raises an automatic chargeback
// credit note, unwinding revenue against a payment that is still in the ledger.
//
// The ordinary cause is not exotic: the IMS bill total is below the Xero total because the bill was
// edited in Xero after IMS posted it, so the full-total payment IMS sends leaves a balance.
//
// A REVERSAL IS A FALL TO ZERO PAID, NOT A STATUS THAT IS MERELY NOT-PAID. The delta payload
// already carries the number that says so, and this is where it is read.

/**
 * o3d-psrx r11 (Codex HIGH) — WHAT A LEDGER AMOUNT IS, WRITTEN DOWN, RATHER THAN WHAT `Number()`
 * HAPPENS TO SWALLOW.
 *
 * A money figure is: an optional sign, digits, and at most one decimal point with digits after it.
 * Nothing else is a decimal amount, and everything else is REFUSED.
 *
 * This is stated as a GRAMMAR and not as a list of bad shapes on purpose. `Number()` additionally
 * accepts radix-prefixed literals (`0x64` -> 100, `0b101` -> 5, `0o17` -> 15), exponent notation
 * (`1e2` -> 100) and `Infinity`; that set is a property of the language, it is longer than anyone
 * writing a blocklist will remember, and it can grow. A `Balance` of `"0x64"` read as 100 does not
 * fail loudly — it STEERS A REVERSAL, which on the bill side re-arms a second supplier payment.
 *
 * AND THE GRAMMAR MUST COME FIRST, BEFORE ANY PARSER. `new Prisma.Decimal('0x64')` is also 100, as
 * are its `0b`/`0o`/`1e2`/`Infinity` readings (decimal.js documents the radix prefixes as a
 * feature) — so "parse it as a Decimal instead" is a better CONVERSION and not a validation. The
 * refusal has to be made by this expression; the Decimal below only converts what it admits.
 */
const LEDGER_AMOUNT_GRAMMAR = /^[+-]?\d+(?:\.\d+)?$/

/**
 * Money the ledger reports, or null when the payload does not state it in decimal money.
 *
 * Xero serialises invoice amounts as JSON numbers, but a string is accepted rather than coerced
 * blindly: `Number('')` is 0, and a zero conjured out of an empty field is exactly the "no payment
 * is present" answer that clears paidAt and re-arms a second supplier payment.
 *
 * NULL IS A REFUSAL AND NEVER A ZERO. Every caller reads null as "the ledger did not state this",
 * which withholds; a rejected string that came back as 0 would be indistinguishable from a ledger
 * saying it holds nothing, i.e. from the reversal itself.
 */
/**
 * An ISO-4217 code out of a payload field, or NULL when the field does not carry one.
 *
 * Shared by both connectors so "what currency is this document in" has ONE answer: Xero states it as
 * `CurrencyCode: "GBP"`, QuickBooks as `CurrencyRef: { value: "GBP" }`, and the two unwrappings differ
 * while the validation must not. Anything that is not three letters is NULL rather than a guess — the
 * rules built on the result are all written about that null, and all of them take it as "be stricter".
 */
export function ledgerCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/** The currency of the amounts on one Xero invoice, or NULL when the payload did not state it. */
export function xeroInvoiceCurrency(invoice: XeroInvoice): string | null {
  return ledgerCurrencyCode(invoice.CurrencyCode)
}

/**
 * o3d-psrx r14 (Codex HIGH) — THE MAGNITUDE AT WHICH ONE MINOR UNIT STOPS SURVIVING `Response.json()`.
 *
 * r13 guarded every conversion this module performs. It could not guard the one performed BEFORE this
 * module sees anything: both connector clients read their bodies with `Response.json()`, so a JSON
 * numeric token has ALREADY become an IEEE-754 double by the time `parseLedgerAmount` is handed it.
 * No round trip taken afterwards can see that loss — the double round-trips to itself perfectly, and
 * the digits that went missing went missing in the parser.
 *
 * Codex's pair is the demonstration: in CLF (four decimals) `1649267441664` and `1649267441663.9999`
 * are DIFFERENT amounts that `JSON.parse` returns as the SAME double. Subtract that from a total and
 * the difference is an exact zero, which every guard here accepts and which is the one verdict
 * (`HOLDS_NOTHING`) that clears `paidAt`, re-arms Mark Paid over a supplier payment that was made, or
 * raises a sales chargeback against a document the ledger is still accounting for.
 *
 * THE ANSWER IS NOT "NO INVOICE IS THAT BIG". That is an expectation, and nothing in this repository
 * enforces it: the column these amounts land in is `numeric(18,4)`, which holds up to
 * 99,999,999,999,999.9999 — comfortably above the point where the loss starts in every currency this
 * repository supports. An expectation that is never checked is exactly the shape of defect this branch
 * has now closed five times. So the bound is ENFORCED: above it the amount is not readable, and an
 * amount that is not readable is REFUSED, never clamped and never rounded. It joins `"0x64"` and
 * `"0." + "0".repeat(399) + "1"` as a figure this reader answers NULL to, and NULL WITHHOLDS.
 *
 * DERIVED, NOT TABULATED. It is a property of two things this code already knows — the currency's
 * minor unit and the width of a double's significand — so it is computed from them rather than
 * written down per currency. A hand-written table of thresholds is a list somebody must keep in step
 * with `currencyMinorUnits`, and a list that drifts is how the minor unit stopped being respected in
 * the first place. The derivation:
 *
 *   - a double's significand is 53 bits, so within the binade [2^e, 2^(e+1)) the representable values
 *     are spaced exactly 2^(e-52) apart;
 *   - a `d`-decimal currency's minor unit is 10^-d;
 *   - two amounts one minor unit apart can only be guaranteed to land on DIFFERENT doubles while that
 *     spacing is no wider than the minor unit itself: 2^(e-52) <= 10^-d. The moment the spacing
 *     EXCEEDS the minor unit, some pair of adjacent minor-unit amounts shares a double — that is a
 *     pigeonhole, not a rounding accident, so "possible" is the only honest reading of it;
 *   - so the bound is the start of the first binade where that fails, i.e. 2^(E+1) for the largest E
 *     with 2^E * 10^d <= 2^52.
 *
 * The last line is computed in BigInt, exactly, because it is a statement about binary and decimal
 * integers and evaluating it in the floating point it is describing would be circular. It yields:
 *
 *   2 decimals  2^46 =     70,368,744,177,664   (measured: 70368744177664.01 and .02 share a double)
 *   3 decimals  2^43 =      8,796,093,022,208   (BHD, IQD, JOD, KWD, LYD, OMR, TND)
 *   4 decimals  2^39 =        549,755,813,888   (CLF, UYW)
 *   0 decimals  2^53 =  9,007,199,254,740,992   (JPY, KRW, ISK … the familiar integer limit)
 *
 * WHAT THE REFUSAL COSTS: nothing that exists. The smallest of these bounds is 549 billion CLF, and
 * the two-decimal bound is seventy trillion units of an ordinary currency. No document any connector
 * in this repository has ever seen comes within many orders of magnitude of them, so this refusal is
 * UNREACHABLE IN PRACTICE. It is here so that the bound is ENFORCED rather than ASSUMED — the whole
 * point of the finding — and the cost of it firing is the mildest one available: the document is
 * reported as an amount the ledger did not state, and its reversal is withheld for a human.
 *
 * o3d-psrx r15 (Codex HIGH) — WHAT THIS BOUND GUARANTEES, EXACTLY, AND WHY IT IS NOT ONE BINADE
 * LOWER.
 *
 * The finding was that the reversal decision turns on HALF a minor unit (`ledgerAmountEpsilon`, on
 * both connectors since r17) while the bound above is derived from ONE WHOLE minor unit — so
 * the bound protects a coarser quantity than the decision uses, and the obvious correction is to
 * re-derive it against the half unit, one binade lower. THAT CORRECTION WAS TESTED AND IT IS WRONG
 * IN BOTH DIRECTIONS. The measurements are pinned as tests; the argument is:
 *
 *   WHAT THE DECISION ACTUALLY NEEDS. A settled amount that is a whole multiple of its currency's
 *   minor unit is either 0 or at least ONE minor unit, i.e. at least 2x the epsilon. Decoding two
 *   such figures and subtracting them exactly can only move the result by less than one spacing. So
 *   the decision flips only if the decode can collapse a whole minor unit — which is the property
 *   this bound already states, and it is TIGHT: measured, no minor-unit-quantized GBP pair flips at
 *   2^45 or 2^44, and the first one that does sits exactly at 2^46, the bound. Lowering it would
 *   refuse a binade of money that is provably readable, which is how a guard earns its deletion.
 *
 *   WHAT NO BOUND CAN GIVE. The flip Codex reproduced — GBP `35184372088832.003` less
 *   `35184372088831.997`, a true 0.006 decoding as 0.004 — needs digits FINER than the currency's
 *   minor unit. For those the true difference is not quantized to 2x epsilon, so a difference just
 *   ABOVE the epsilon always exists inside one spacing of it, and rounding can always carry it
 *   below. Lowering the bound moves that class down rather than closing it: measured in GBP, a
 *   3-decimal payload flips at 2^44 (below the proposed bound), a 4-decimal one at 2^40, a
 *   6-decimal one at 2^34. There is no finite magnitude at which the class is empty.
 *
 * SO THE BOUND IS KEPT AT THE QUANTITY IT CAN ACTUALLY GUARANTEE, and the claim is narrowed to
 * exactly that rather than widened: BELOW THIS BOUND, A DIFFERENCE OF ONE WHOLE MINOR UNIT SURVIVES
 * DECODING. It does NOT guarantee the half-unit decision for a payload finer than its own minor
 * unit, and it never could. THE STRING ARM IS DIFFERENT AND IS NOT AFFECTED: `"35184372088832.003"`
 * is refused by the round trip at every magnitude (see `parseLedgerAmount`), because there the
 * original digits still exist to be checked. The residual is therefore precisely a JSON NUMERIC
 * TOKEN whose scale exceeds its currency's minor unit, and closing it needs the original token, not
 * a threshold: that is o3d-39jg, the lossless decoder, and it is what remains of this finding.
 */
const magnitudeBoundCache = new Map<number, number>()

/** 2^52 — the spacing of doubles at 1.0 is 2^-52, which is the only IEEE-754 fact this needs. */
const DOUBLE_SIGNIFICAND_SCALE = (() => {
  let value = BigInt(1)
  for (let bit = 0; bit < 52; bit += 1) value *= BigInt(2)
  return value
})()

export function ledgerAmountMagnitudeBound(currency: string | null): number {
  // An unstated currency takes the FINEST supported precision, which yields the SMALLEST bound and so
  // the strictest refusal — the same direction `ledgerAmountEpsilon` resolves a null currency in, and
  // since r16 the same FUNCTION rather than the same sentence written out twice.
  const digits = ledgerMinorUnits(currency)
  const cached = magnitudeBoundCache.get(digits)
  // Memoised on the DIGITS, not written down per currency: this is the derivation's own result being
  // reused, so there is no second place for a threshold to drift out of step with `currencyMinorUnits`.
  if (cached !== undefined) return cached
  // 10^digits, in exact integers. `2^e * 10^d <= 2^52` is the whole rule, rearranged so that both
  // sides are integers and no part of the test is evaluated in the arithmetic it is describing.
  let minorUnitScale = BigInt(1)
  for (let digit = 0; digit < digits; digit += 1) minorUnitScale *= BigInt(10)
  let exponent = -1
  let nextPower = BigInt(1)
  while (nextPower * minorUnitScale <= DOUBLE_SIGNIFICAND_SCALE) {
    exponent += 1
    nextPower *= BigInt(2)
  }
  const bound = Math.pow(2, exponent + 1)
  magnitudeBoundCache.set(digits, bound)
  return bound
}

/**
 * o3d-psrx r12 (Codex HIGH 1), generalised in r13 (Codex HIGH 2) — A DECIMAL READ AS A `number`, OR
 * NULL BECAUSE THE `number` WOULD NOT SAY WHAT THE DECIMAL SAID.
 *
 * `Decimal.toNumber()` is the only lossy step in this file's money handling, and it is lossy in two
 * directions that both land on a value this lifecycle spends:
 *
 *   - OVERFLOW. A grammatical figure with 400 digits is a finite Decimal and an INFINITE double.
 *     Checked first, because the round trip below cannot convert an infinity back into a Decimal.
 *   - UNDERFLOW AND SILENT PRECISION LOSS. `"0." + "0".repeat(399) + "1"` is grammatically perfect
 *     decimal money whose `toNumber()` is 0 — and a zero is precisely the value that puts an amount
 *     in the bucket which clears `paidAt`. `"9007199254740993"` reads as ...992 the same way.
 *
 * STATED AS A LOSSLESSNESS PROPERTY AND NOT AS A RANGE. "Too small" and "too big" are magnitudes
 * somebody has to remember and keep in step with IEEE-754, while "the number does not say what the
 * Decimal said" is the actual defect and catches every instance of it. The comparison is against a
 * Decimal RECONSTRUCTED FROM THE RESULTING NUMBER, so it asks exactly the question that matters: can
 * this number be spent in place of the figure it came from?
 *
 * WHY IT IS A FUNCTION AND NOT A LINE INSIDE `parseLedgerAmount`. r12 guarded the INPUTS and not the
 * ARITHMETIC BETWEEN THEM: QuickBooks' settled figure is `TotalAmt - Balance`, a Decimal subtraction
 * whose result was converted bare. Both operands can round-trip perfectly and their exact difference
 * still not — total `0.005055810576648219` less balance `0.00005581057664821855` is exactly
 * `0.00500000000000000045`, which is ABOVE the GBP epsilon, and whose `toNumber()` is exactly
 * `0.005`, which is NOT. That turns a positive payment into `HOLDS_NOTHING`, the one verdict that
 * proves a full reversal. A guard that lives at one call site is a guard the next conversion does
 * not get; this one belongs to the conversion itself.
 *
 * NULL IS A REFUSAL AND NEVER A ZERO, wherever it is returned — see `parseLedgerAmount` below and
 * `QboLedgerAmount.paid`, both of which withhold on it.
 *
 * o3d-psrx r14 (Codex HIGH) added the magnitude bound HERE, and r15 (Codex MEDIUM 1) TOOK IT BACK
 * OUT — because this function is only ever handed a value whose own evidence still exists.
 *
 * THE TWO RULES HAVE DIFFERENT PREMISES AND ONLY ONE OF THEM HOLDS HERE.
 *
 *   The ROUND TRIP asks "is THIS Decimal representable?", and it can only be asked of something that
 *   still IS a Decimal — a figure whose original decimal text was preserved (a string amount) or one
 *   this code computed exactly (`subtractMoney`). For those it is the STRONGER of the two rules: it
 *   proves the exact value survives, at any magnitude and any scale, rather than proving that values
 *   of this SIZE generally do.
 *
 *   The MAGNITUDE BOUND asks "did the value arrive intact?", and it exists precisely because that
 *   question cannot be answered from the value itself — a double that lost digits inside
 *   `Response.json()` round-trips to itself perfectly. Its premise is that the evidence is ALREADY
 *   GONE, which is true of a JSON numeric token and false of everything reaching this function.
 *
 * SO THE BOUND MOVED TO THE ONE ARM WHOSE PREMISE IT MATCHES, and it is applied there and nowhere
 * else. Keeping it here was not extra safety, it was a rule fired where its premise is false:
 * `parseLedgerAmount('1649267441664', 'CLF')` answered null for a value that is exactly
 * representable and demonstrably intact, which converted a readable zero-paid state into UNPROVEN
 * and withheld a legitimate reversal indefinitely. Applying each rule where its premise holds is not
 * a loosening.
 *
 * NULL IS STILL A REFUSAL AND NEVER A ZERO.
 */
export function readDecimalAsNumber(decimal: Decimal): number | null {
  const parsed = decimal.toNumber()
  if (!Number.isFinite(parsed)) return null
  return toDecimal(parsed).equals(decimal) ? parsed : null
}

/**
 * o3d-psrx r16 (Codex HIGH 1, the half the scale rule does NOT reach) — THE MAGNITUDE A DIFFERENCE OF
 * TWO DECODED AMOUNTS MUST SIT UNDER, WHICH IS HALF THE ONE A SINGLE AMOUNT MUST.
 *
 * `ledgerAmountMagnitudeBound` guarantees that ONE WHOLE MINOR UNIT survives the decode. The reversal
 * decision turns on HALF of one (`ledgerAmountEpsilon`), and r15 argued
 * that the whole unit is nevertheless enough BECAUSE a genuine settlement is a whole multiple of the
 * minor unit, so the smallest one that exists is twice the epsilon. THE SCALE RULE MAKES THAT
 * ARGUMENT TRUE OF THE READING; IT DOES NOT MAKE IT TRUE OF THE TOKEN, and for a DIFFERENCE that gap
 * is still reachable. Measured, in GBP at 2^45 — below the two-decimal bound of 2^46:
 *
 *   "35184372088832.0117" and "35184372088832.0040" are 0.0077 apart, which is ABOVE the epsilon, so
 *   the ledger holds a payment. Both decode to ONE double, whose own decimal reading is
 *   `35184372088832.01` — SCALE 2, so the scale rule admits both, and the magnitude rule admits both.
 *   Their exact difference is then zero and the document reads HOLDS_NOTHING.
 *
 * The scale rule cannot see this because a double's shortest reading may be SHORTER than the token
 * that produced it: `35184372088832.003` reads back as `35184372088832`, scale 0. That is harmless
 * for a SINGLE reading — the value is then within half a spacing of the truth, and every admitted
 * reading is a whole minor unit apart from the next, so "the reading is zero" still means "the token
 * was zero". It is NOT harmless for a difference, because two tokens can hide inside ONE rounding
 * interval and the interval is wider than the epsilon.
 *
 * SO THE ARM THAT TAKES A DIFFERENCE GETS THE BOUND ITS OWN DECISION NEEDS, and that bound is
 * DERIVED FROM THE OTHER ONE rather than written down a second time: the spacing halves with each
 * binade, so requiring `< bound / 2` is exactly requiring `spacing <= epsilon`. Below it, two tokens
 * sharing a double are less than one spacing apart, hence at most half a minor unit apart, hence a
 * ledger that reads as holding nothing IS holding nothing. Above it — the single top binade, and only
 * ever that one, in every supported precision — the difference is refused and the reversal withheld.
 *
 * IT DOES NOT NARROW `parseLedgerAmount`. A single amount is still read to the full bound: the r15
 * measurement that a whole penny survives at 2^45 and 2^44 stands, and refusing those readings would
 * refuse money that is provably intact. The two rules differ because their DECISIONS differ, which is
 * the same reason r15 gave for moving the bound off `readDecimalAsNumber` in the first place.
 *
 * WHAT THE REFUSAL COSTS: nothing that exists. For GBP it begins at 35,184,372,088,832 — eight orders
 * of magnitude above the largest money figure any IMS database holds.
 */
export function ledgerDifferenceMagnitudeBound(currency: string | null): number {
  return ledgerAmountMagnitudeBound(currency) / 2
}

/**
 * The settled figure `total - balance`, or NULL because this code cannot prove what it says.
 *
 * Both operands have already been admitted by `parseLedgerAmount`, so each is a whole multiple of its
 * currency's minor unit. That makes their exact difference a whole multiple too — never a sliver
 * below the epsilon — so the "holds nothing" test on the result is exactly "the two figures are the
 * same figure". The magnitude check is the one stated above: it is what makes SAME-FIGURE mean the
 * tokens were within half a minor unit of each other rather than within a whole one.
 *
 * The subtraction itself is Decimal and its conversion back goes through `readDecimalAsNumber`, which
 * is r13's finding and is unchanged: `100.1 - 0.1` is 100.00000000000001 in IEEE-754, and this figure
 * is compared against a threshold small enough for a four-decimal currency to see that.
 */
export function readLedgerDifferenceAsNumber(
  minuend: number,
  subtrahend: number,
  currency: string | null,
): number | null {
  const bound = ledgerDifferenceMagnitudeBound(currency)
  if (Math.abs(minuend) >= bound || Math.abs(subtrahend) >= bound) return null
  return readDecimalAsNumber(subtractMoney(minuend, subtrahend))
}

/**
 * o3d-78rq (Codex, o3d-acctmoney r21 HIGH) — WHAT A LEDGER'S AMOUNT IS ALLOWED TO MEAN, AS A DECIMAL.
 *
 * This is where the two rules live now; `parseLedgerAmount` below is this function plus a conversion.
 * They were spelt inside it, which was correct while the only consumer wanted a `number`.
 * `classifyLedgerSettlement` wants the FIGURE — it decides whether a ledger record is the payment IMS
 * already made, and its two errors do not point the same way: too wide strands a payment visibly, too
 * narrow posts a SECOND one — so it must compare Decimals, and the Decimal it compares has to be
 * provably the figure the ledger stated rather than merely a reading of the double it arrived as.
 * Re-deriving these rules beside it would have been the fourth copy of a fail-safe direction.
 *
 * o3d-psrx r14 (Codex HIGH) — THE MAGNITUDE RULE, ON THE NUMBER ARM AND (after r15) ONLY THERE. A
 * JSON numeric token reaches here as a double that `Response.json()` has already rounded, and no test
 * applied to the double can recover what it rounded away — which is why the round trip cannot serve
 * here and a magnitude rule must. What it establishes is stated at `ledgerAmountMagnitudeBound` and is
 * narrower than "this value is intact": below the bound a difference of one whole minor unit survives
 * the decode. Above it, it does not, so it is refused.
 *
 * o3d-psrx r16 (Codex HIGH 1) — AND THE OTHER HALF OF THE SAME RECOMMENDATION: the SCALE.
 *
 * r14 was asked for two things — "reject values whose scale exceeds the stated currency's supported
 * precision, OR retain exact Decimals throughout" — and shipped only the magnitude. The residual r15
 * then had to admit was, by its own definition, a token FINER than its currency's minor unit, and the
 * argument for admitting it was that the original token is gone.
 *
 * THE TOKEN IS GONE; ITS SCALE IS NOT. A double has its own decimal reading — the shortest text that
 * decodes back to it — and this is the very fact the STRING arm already turns on. So the question "is
 * this amount quantized to its currency's minor unit?" can be asked of the double alone, without the
 * token, and answered by refusing anything that reads back finer.
 *
 * WHAT THAT BUYS, EXACTLY. Every admitted value is a whole multiple of its currency's minor unit, so a
 * decision taken on ONE of them cannot be wrong by less than a whole unit: `zeroPaid` in
 * `partitionPaymentReversals` means the reading is EXACTLY zero rather than merely inside half a unit
 * of it, and a token that decoded to zero was a token that was zero. It also makes the difference of
 * any two admitted numbers a whole multiple of the minor unit — see `readLedgerDifferenceAsNumber`,
 * which is where the rest of that guarantee is made. And it is what lets o3d-78rq say that the DECIMAL
 * returned here is the figure the ledger stated: below the bound, two amounts one minor unit apart
 * land on different doubles, so exactly one quantized token names the double this reading came from.
 *
 * WHAT IT COSTS. A ledger figure carrying MORE decimals than its own currency has is refused rather
 * than read — `1234567.8901` in GBP, `123456789.99` in JPY. That is the fail-closed direction the
 * finding asked for ("fail closed for numeric-token evidence that cannot be proven quantized"), and it
 * costs nothing that exists: Xero and QuickBooks both state document totals and paid amounts rounded
 * to the document's own currency, and an amount that arrives finer than its currency is precisely the
 * shape this reader cannot read safely. NULL IS A REFUSAL AND NEVER A ZERO, and every caller must
 * withhold on it — in `classifyLedgerSettlement` that is `record-unmeasurable`, which reads as
 * `present` and holds the payment back.
 *
 * IT IS NOT A REFUSAL OF SMALL PRINT: a quantized token BELOW the bound always reads back at its own
 * scale or shorter, because below the bound the double spacing is no wider than one minor unit, so the
 * token itself sits in the rounding interval and nothing longer than it is needed to name that double.
 * Measured across every supported precision in the tests.
 *
 * r18 (Codex HIGH 1) — AND THE SCALE RULE IS ONE FUNCTION ACROSS BOTH ARMS. It was spelt on the number
 * arm alone, which is how a GBP `"0.005"` string was admitted while the identical double was refused.
 * `isLedgerMinorUnitQuantized` is the one spelling; what each arm supplies is the decimal it is to be
 * asked about — the double's own shortest reading, or the digits the string was given, BEFORE any
 * conversion, because converting first would throw away the very digits in question.
 *
 * THE STRING ARM TAKES NO MAGNITUDE BOUND (o3d-psrx r15, Codex MEDIUM 1). A string carries its own
 * evidence: the original decimal text is still here, so `parseLedgerAmount`'s round trip can decide
 * THIS value instead of values of this size. `"1649267441664"` in CLF is such a string, and r14
 * refused it purely for its size. One that does NOT survive the conversion is refused at ANY
 * magnitude: `"35184372088832.003"` and `"17592186044416.002"` are both null from `parseLedgerAmount`,
 * far below the two-decimal bound, because no double answers to those digits. The arm that needs a
 * size rule is the number one, where the digits are already gone and nothing can be asked of them.
 */
export function readLedgerStatedAmount(value: unknown, currency: string | null): Decimal | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (Math.abs(value) >= ledgerAmountMagnitudeBound(currency)) return null
    const reading = toDecimal(value)
    return isLedgerMinorUnitQuantized(reading, currency) ? reading : null
  }
  if (typeof value === 'string') {
    const parsed = decodeLedgerAmountText(value)
    if (parsed === null) return null
    return isLedgerMinorUnitQuantized(parsed, currency) ? parsed : null
  }
  return null
}

/**
 * o3d-obyd — WHAT A LEDGER AMOUNT THAT ARRIVED AS *TEXT* SAYS, AS ONE FUNCTION, FOR EVERY READER.
 *
 * This is the string arm of `readLedgerStatedAmount` lifted out of it verbatim — the grammar above,
 * then the repository's decimal reader on the digits it was given — and it is lifted out for one
 * reason: it now has a SECOND caller, and the last time a reader of these fields had two spellings
 * the two diverged and the divergence moved money.
 *
 * THE DIVERGENCE THIS EXISTS TO PREVENT, twice over. o3d-psrx r10 found `typeof row.Balance ===
 * 'number'` failing on a QuickBooks `Balance` of `"50.00"` and moved the QuickBooks payment POLLER
 * onto `parseLedgerAmount`, which is this reader plus a conversion. o3d-obyd then found the
 * settlement PROBE still holding the r10 shape — `typeof value === 'number'` — over the same fields
 * of the same documents from the same connector. One rule, two readers, one of them fixed. So the
 * probe does not get a third spelling of "is this text a money figure": it calls THIS, which is the
 * function the poller's own reading is built out of, and a change to what a ledger amount may look
 * like now lands on both by construction.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS JUDGE. There is no currency parameter here and no
 * quantization or magnitude rule, because its two callers disagree about those and are RIGHT to:
 * `readLedgerStatedAmount` must refuse a figure it cannot prove the ledger stated, because its
 * refusal WITHHOLDS a payment; the probe's completeness arithmetic must read every stated figure it
 * can, because its business is comparing a ledger's own total against the collection beside it and
 * that comparison must not be dropped merely because a figure is finely stated. What both need,
 * identically, is the decode: which text is a decimal amount at all, and which Decimal it names.
 *
 * NULL MEANS "THIS IS NOT A DECIMAL AMOUNT" — never zero, and never "there was no figure". A caller
 * that must tell an absent field from an unreadable one asks that question of the field, before it
 * gets here (see `wireAmount` in the settlement probe).
 */
export function decodeLedgerAmountText(value: string): Decimal | null {
  const trimmed = value.trim()
  if (!LEDGER_AMOUNT_GRAMMAR.test(trimmed)) return null
  // Read through the repository's decimal reader rather than `Number()`: the shape is already
  // established, and this reads the digits it was given instead of re-deriving them.
  return toDecimal(trimmed)
}

/**
 * The same admission, answered as the `number` two connectors' partitions and evidence types spend.
 *
 * o3d-78rq: the rules moved up into `readLedgerStatedAmount` and this is what is left — the
 * conversion, whose two arms differ exactly as they always have.
 */
export function parseLedgerAmount(value: unknown, currency: string | null): number | null {
  const stated = readLedgerStatedAmount(value, currency)
  if (stated === null) return null
  // THE NUMBER ARM answers with the double it was handed, untouched. It is already a `number`, and
  // re-deriving it from the reading is a conversion that can only lose (`-0` becomes `0`).
  if (typeof value === 'number') return value
  // THE STRING ARM must survive the conversion, which is r12/r13's finding and is unchanged:
  // `"0." + "0".repeat(399) + "1"` is grammatical decimal money whose `toNumber()` is 0 — precisely
  // the value that puts an amount in the bucket which clears `paidAt`.
  //
  // The alternative — carrying Decimal through every classification instead of converting at all — is
  // the stronger shape and is NOT small here: this reader's result is a `number` in the Xero
  // partition, in `QboLedgerAmount`, in `QboLedgerEvidence` and in the activity metadata those
  // verdicts are written into. That is a change to two connectors' public readings, and o3d-78rq
  // needed only the settlement classifier's operands, so it took the Decimal reader above instead.
  return readDecimalAsNumber(stated)
}

// o3d-psrx r17 (Codex HIGH) — `PAYMENT_PRESENT_EPSILON` USED TO LIVE HERE, AND IT WAS THE SECOND
// ANSWER TO A QUESTION THAT MAY ONLY HAVE ONE.
//
// It read: "Below this, the ledger holds no payment. Xero rounds money to 2dp, so half a penny is
// well inside the gap between nothing and the smallest payment that can exist." Every clause of that
// is true OF GBP, and r15 recorded on this branch that it was "not wrong today" for exactly that
// reason. IT IS WRONG NOW, AND THIS BRANCH MADE IT WRONG: r16's scale rule admits `0.001` in KWD and
// `0.0001` in CLF — one WHOLE minor unit, the smallest payment those currencies have — and
// `partitionPaymentReversals` then measured that against a constant sized for pennies and put it in
// `zeroPaid`, the bucket the provenance gate can turn into a cleared `paidAt`.
//
// The constant is DELETED rather than corrected in place. A fixed number that is right for one
// currency is a standing invitation to reach for it from a second call site, and that is how this
// defect was built: r10 moved QuickBooks onto a per-currency threshold and left this one behind,
// because it sat in a module the shared rule could not be imported into. "How small is nothing" is
// now answered in ONE place for both connectors — `ledgerAmountEpsilon`, in lib/domain/math/decimal.ts,
// beside the minor-unit table it derives from and upstream of both.

export type PaymentReversalReading = {
  /**
   * VOIDED invoices, and ONLY those. An unconditional reversal that needs no further evidence: Xero
   * requires every payment to be removed before an invoice can be voided and refuses a payment
   * against a voided one, so re-arming a voided document cannot move money twice.
   */
  voided: Set<string>
  /**
   * AUTHORISED with a STATED zero paid. The ledger says it holds nothing — which is what a removed
   * payment looks like, AND ALSO WHAT A PAYMENT IMS POSTED SECONDS AGO LOOKS LIKE (o3d-clxw round 3).
   *
   * So this is NOT a reversal on its own. It is a reversal only once the registration reading says
   * IMS holds no payment of its own that this read cannot speak for — see zeroPaidIsProvenReversal.
   * The two readings are separate because they answer different questions: this one is about the
   * LEDGER, and it cannot see a payment that has not reached the ledger yet.
   */
  zeroPaid: XeroInvoice[]
  /**
   * No longer PAID, but the ledger STILL HOLDS A PAYMENT — a part payment, or a bill edited upward
   * after being paid. Not a reversal, and the IMS document must stay paid: clearing it re-arms the
   * UI over money that has already moved.
   */
  partPaid: XeroInvoice[]
  /**
   * No longer PAID, and the payload does not say what the ledger holds. UNKNOWN IS NOT A REVERSAL:
   * the cost of withholding is a document IMS still shows as paid, which a human can correct; the
   * cost of guessing the other way is a second payment to a supplier, which nobody can.
   */
  unverifiable: XeroInvoice[]
}

/**
 * Split one delta slice into the four answers the reversal passes may act on.
 *
 * THE ZERO IS NOT SELF-EVIDENT (o3d-clxw round 3). Round 1 replaced "AUTHORISED means unpaid" with
 * "AUTHORISED and nothing paid means the payment was removed", and put that straight into the
 * reversal set. But an AUTHORISED bill reading zero paid is also the ordinary shape of a bill IMS
 * marked paid MOMENTS AGO: Mark Paid sets paidAt locally and queues a BILL_PAYMENT registration, and
 * until the worker posts it the ledger holds nothing. A poll landing in that gap read its own
 * in-flight payment as a reversal, cleared paidAt, and re-armed the button over a payment that was
 * about to land — the branch's own thesis turned on it.
 *
 * `voided` is therefore the only bucket this function can settle by itself. The zero is handed on as
 * a QUESTION, to be answered against the registrations IMS holds and the instant the ledger was read.
 */
export function partitionPaymentReversals(
  invoices: XeroInvoice[],
  type: 'ACCREC' | 'ACCPAY',
): PaymentReversalReading {
  const voided = new Set<string>()
  const zeroPaid: XeroInvoice[] = []
  const partPaid: XeroInvoice[] = []
  const unverifiable: XeroInvoice[] = []

  for (const invoice of invoices) {
    if (invoice.Type !== type) continue
    if (invoice.Status === 'VOIDED') {
      voided.add(invoice.InvoiceID)
      continue
    }
    if (invoice.Status !== 'AUTHORISED') continue

    // ONE currency reading, spent on BOTH halves of the decision (o3d-psrx r17, Codex HIGH). r16 read
    // it here for the parse alone and left the comparison below on a GBP constant, which is how a
    // whole minor unit of KWD got parsed as a payment and then classified as nothing.
    const currency = xeroInvoiceCurrency(invoice)
    const amountPaid = parseLedgerAmount(invoice.AmountPaid, currency)
    if (amountPaid === null) {
      unverifiable.push(invoice)
      continue
    }
    // ABS, not `> 0`: a negative AmountPaid is not a number this code understands, and "the ledger
    // holds something we cannot explain" is not permission to declare the payment gone.
    //
    // DECIMAL, not float, and against the DOCUMENT'S OWN epsilon (o3d-psrx r17, Codex HIGH):
    //
    //   THE THRESHOLD. `ledgerAmountEpsilon` is half one minor unit of this invoice's currency —
    //   0.005 in GBP, so nothing about the ordinary case moves, but 0.0005 in KWD and 0.00005 in CLF.
    //   r16 guaranteed that every amount admitted above is a whole multiple of its currency's minor
    //   unit, so a payment is either 0 or at least ONE unit, which is strictly more than this. The
    //   two rules therefore agree exactly: `zeroPaid` means the ledger stated a zero, in every
    //   supported precision, rather than only in the ones whose minor unit happens to exceed a penny.
    //   An unstated currency takes the strictest threshold, which can only move an invoice OUT of
    //   `zeroPaid` and into `partPaid`, and `partPaid` withholds.
    //
    //   THE ARITHMETIC. Compared through `compareDecimal` rather than `>` on doubles, for the reason
    //   r13 gave one module over: the binary comparison is taken at a magnitude where a four-decimal
    //   currency's epsilon is near the noise, and `Math.abs` on a double that came out of a Decimal is
    //   the conversion this branch has already had to undo twice.
    if (compareDecimal(toDecimal(amountPaid).abs(), ledgerAmountEpsilon(currency)) > 0) {
      partPaid.push(invoice)
      continue
    }
    zeroPaid.push(invoice)
  }

  return { voided, zeroPaid, partPaid, unverifiable }
}

// ---------------------------------------------------------------------------
// WHOSE PAYMENT IS GONE? (o3d-clxw round 2)
// ---------------------------------------------------------------------------
//
// Round 1 fixed a reading that treated "not fully paid" as "the payment was removed". It replaced it
// with "does the ledger hold ANY payment", which is right whenever the invoice has only ever had one.
// It is WRONG the moment a second one exists, and then it fails in the direction that hides money:
//
//   IMS registers a supplier payment of 500 (Xero creates payment P1). Somebody in Xero deletes P1 —
//   wrong bank account, wrong bill, a duplicate they are unwinding — and applies a 20 payment, P2, in
//   its place. The invoice is AUTHORISED with AmountPaid 20. Round 1 sees a payment, calls it a PART
//   payment, and keeps `paidAt`. The 500 IMS believes it paid is GONE and IMS will never say so: the
//   cursor moves past the invoice, the bill reads settled for ever, and the supplier is never paid.
//
// The residual payment is not evidence about OUR payment. It is evidence about somebody else's. So
// the reversal question is asked against the identity IMS recorded — the PaymentID Xero returned when
// the BILL_PAYMENT / INVOICE_PAYMENT registration posted, stored on the sync row as
// externalTransactionId — and answered against the payments the ledger LISTS on the invoice.
//
// Everything here still fails closed. A reversal verdict re-arms Mark Paid, and pressing it pays a
// supplier twice, so "our payment is gone" must be PROVED, never inferred: proof needs a registration
// that certainly posted before the ledger was read, and a ledger answer that certainly enumerates the
// payments it holds. Anything less stays withheld exactly as round 1 left it.

/**
 * The payment ids the ledger states it holds against this invoice, or NULL when the payload does not
 * state them.
 *
 * NULL AND EMPTY ARE DIFFERENT ANSWERS, and conflating them is the same mistake `Number('') === 0`
 * was: an absent array means "Xero did not tell us", and reading that as "Xero holds no payments"
 * would manufacture the proof this module exists to demand. An array containing an entry with no
 * usable PaymentID is also NULL — a list we cannot fully read cannot establish that a particular id
 * is missing from it.
 *
 * Ids are lower-cased: Xero serialises GUIDs in lower case, but a stored id that came back from a
 * POST is compared against one that came back from a GET, and a case difference between the two must
 * not read as "a different payment".
 */
export function listedLedgerPaymentIds(invoice: XeroInvoice): Set<string> | null {
  if (!Array.isArray(invoice.Payments)) return null
  const ids = new Set<string>()
  for (const entry of invoice.Payments) {
    if (entry == null || typeof entry !== 'object') return null
    const id = (entry as { PaymentID?: unknown }).PaymentID
    if (typeof id !== 'string') return null
    const trimmed = id.trim()
    if (trimmed === '') return null
    ids.add(trimmed.toLowerCase())
  }
  return ids
}

/** One payment registration IMS holds for a document, reduced to what the verdict depends on. */
export type RegisteredPaymentRow = {
  /** The sync-log row id, so a withheld verdict can name the entry an operator has to look at. */
  id: string
  status: string
  /** The ledger's id for the payment this registration created, if it got that far. */
  externalTransactionId: string | null
  /**
   * o3d-f709 — WHAT THIS ROW'S `CANCELLED`, IF IT IS CANCELLED, IS ALLOWED TO MEAN.
   *
   * Both REQUIRED, and required rather than optional on purpose. The classifier below asks
   * `mayHaveReachedLedger`, whose whole job is to answer "unproved" for a row that carries neither
   * marker — and `undefined` from a select that forgot the column is indistinguishable from a
   * genuine NULL. Optional fields would therefore turn "this reader did not load the evidence" into
   * a silent, correct-looking verdict. Required, a caller that has not loaded them does not compile.
   *
   * See lib/domain/accounting/cancelled-row-evidence.ts for the rule and
   * lib/domain/accounting/unresolved-abandoned-claim.ts for the argument behind it.
   */
  abandonedBeforeRemoteCall: boolean | null
  settlementBasis: string | null
  /**
   * When the registration became complete — CLAIMED. Which clock produced it is not visible here.
   *
   * `stampSyncedAtFromDatabaseClock` writes `clock_timestamp()`, but an application host's `new
   * Date()` lands in the same column and is indistinguishable once stored. `syncedAtDatabaseClock`
   * is what tells the two apart; nothing may be decided from this field alone.
   */
  syncedAt: Date | null
  /**
   * The provenance marker for `syncedAt`: the same instant, written by the same statement from one
   * evaluation of the database's `clock_timestamp()`.
   *
   * NULL, or any value other than `syncedAt`, means the completion time was NOT minted by the
   * database — an old build wrote it, or moved `syncedAt` out from under a marker it did not know
   * about. See `databaseStampedCompletion`.
   *
   * What makes a present-and-equal pair mean anything is NOT this reader: it is the trigger in
   * 20260821090000, which clears this column whenever a statement changes the completion facts it
   * was minted with and does not mint a new one. Without that, equality is only a statement about
   * two millisecond values, and any writer can produce it.
   */
  syncedAtDatabaseClock: Date | null
  /**
   * o3d-psrx r4 (Codex HIGH) — WHICH LEDGER DOCUMENT THIS REGISTRATION WAS RAISED AGAINST.
   *
   * `payloadAccountingInvoiceId(row.payload)`, i.e. the id the enqueue recorded, NOT the id the
   * document points at now. Null when the payload records none (a legacy row, or one retention-
   * compacted to `{}`), and null must be read as "cannot be tied to any document".
   *
   * OPTIONAL so every existing caller and test keeps its exact previous meaning: a row that does not
   * carry this field is never weighed against a {@link PaidStateBinding}, because only a caller that
   * supplies a binding is asking the question.
   */
  registeredAgainstInvoiceId?: string | null
  /**
   * o3d-psrx r7 (Codex HIGH 1) — HOW MUCH OF THE DOCUMENT'S TOTAL THIS REGISTRATION SETTLES.
   *
   * `payloadRegisteredAmount(row.payload, documentCurrency)`: the amount the enqueue recorded, in the
   * DOCUMENT's currency, from the payload the registration was raised with. NULL means the payload
   * will not say — a legacy row, or one retention-compacted to `{}`, or one raised in another
   * currency — and it is never "zero" and never "all of it".
   *
   * OPTIONAL so every existing caller and test keeps its exact previous meaning. It is read only when
   * a caller also supplies a `documentTotal`, which is the caller saying it wants the coverage
   * question asked at all.
   *
   * o3d-1xq8 — AND IT MAY NOW BE A `Decimal`, WHICH IS WHAT THE PRODUCTION READER SUPPLIES.
   *
   * `payloadRegisteredAmount` prefers the payload's exact decimal string over its JSON number, so the
   * figure it answers with is a `Decimal`. The `number` arm is kept, and kept meaning EXACTLY what it
   * meant before — the double's own exact decimal reading, which is what {@link sumRegisteredAmounts}
   * already made of it — because a historical row carries no string and must settle as it does today.
   * Neither form is preferred by this type; the READER decides which one a given row can supply, and
   * a row that can supply neither answers null.
   */
  registeredAmount?: Decimal | number | null
}

/**
 * WHAT THE DOCUMENT'S PAID FLAG IS ABOUT RIGHT NOW (o3d-psrx r4, Codex HIGH).
 *
 * THE DEFECT. The evidence read grouped registrations by `referenceId` ALONE — one sales order, every
 * INVOICE_PAYMENT ever raised for it — and the classifier then took any one of them that had posted
 * before the fence as evidence about the CURRENT paid flag. Neither half of "current" was checked:
 *
 *   NOT THIS DOCUMENT.  An invoice deleted in the ledger and re-posted gives the order a new
 *                       `accountingInvoiceId`. The registration that settled the OLD document is
 *                       still a SYNCED row against the same order, and it answered for the
 *                       replacement — the cross-document contamination `o3d-hbgo` already states must
 *                       not happen on the settlement side.
 *   NOT THIS PAYMENT.   An order can be paid, registered, reversed and paid AGAIN. Clearing `paidAt`
 *                       does not retire the first episode's registration, so on the second episode
 *                       the evidence read said "a registration posted" — true, and about a payment
 *                       that was taken away. Concretely: the stale row made `posted` non-empty, which
 *                       is what stops `unregisteredPaidAt` producing PAID_WITHOUT_LEDGER_RECEIPT, so
 *                       an off-ledger re-payment was admitted as a reversal and charged back.
 *
 * NO NEW COLUMN CARRIES THIS. Both facts are already recorded:
 *
 *   `accountingInvoiceId`   the document the flag is about now, weighed against the id the
 *                           registration's own payload names.
 *   `unregisteredPaidAt`    the instant THIS paid episode was entered with no ledger receipt behind
 *                           it. It is written by the same statement that sets `paidAt` and cleared by
 *                           the same statement that clears it (the writer census in
 *                           tests/accounting/paid-provenance-writers.test.ts is what keeps that true),
 *                           so while it stands it IS this episode's own timestamp — nothing older
 *                           than it belongs to this paid state. ITS VALUE COMES FROM THE DATABASE,
 *                           not from the writer: the trigger in migration 20260901090000 substitutes
 *                           `clock_timestamp()` for whatever a caller supplies, which is what makes
 *                           it comparable to a database-minted completion instant at all (r5, Codex
 *                           HIGH 1).
 *
 * Null = the caller is not asking. Every existing caller stays exactly as it was.
 */
export type PaidStateBinding = {
  /** `SalesOrder`/`PurchaseInvoice`.`accountingInvoiceId` — the document the paid flag is about NOW. */
  accountingInvoiceId: string | null
  /** `SalesOrder.unregisteredPaidAt` — this episode's own instant, or null for a ledger-sourced flag. */
  unregisteredPaidAt: Date | null
}

/**
 * MAY THIS REGISTRATION SPEAK FOR THE DOCUMENT'S CURRENT PAID STATE?
 *
 * Both tests are conservative in the same direction: `false` never admits a reversal on its own — it
 * only moves a row out of the evidence that DISCHARGES a withholding marker, and the classifier then
 * withholds rather than concludes (see the `unbound` arm there). So an unbindable row costs a warning
 * a human clears; the answer this replaces cost a chargeback credit note against a paid sale.
 *
 * ON THE TWO CLOCKS (r5, Codex HIGH 1). Round 4 argued that this comparison did not need the fence's
 * rigour, because its two ends are separated by a human deciding to mark an order paid again and skew
 * cannot reach across that. THAT ARGUMENT WAS WRONG, and wrong about the case that matters most:
 * `addPayment` can record a receipt on an order that is ALREADY paid off-ledger, its INVOICE_PAYMENT
 * registration completes seconds later, and the marker and the completion are then MILLISECONDS
 * apart, not months. With `unregisteredPaidAt` written by an application host and `completedAt`
 * minted by the database, a host running ahead unbinds a real receipt permanently — the comparison is
 * over two immutable values, so every recheck repeats it.
 *
 * BOTH ENDS ARE NOW DATABASE-MINTED, and neither by this function's doing:
 *
 *   `completedAt`           `databaseStampedCompletion`, i.e. `clock_timestamp()` written inside the
 *                           SYNCED transaction and vouched for by `syncedAtDatabaseClock`.
 *   `unregisteredPaidAt`    `clock_timestamp()` substituted for whatever the writer supplied, by the
 *                           trigger in migration 20260901090000. No application host can put a value
 *                           in that column, so there is no host clock left in this comparison.
 *
 * And the case above no longer arises at all: `addPayment` now CLEARS the marker when it records a
 * receipt on an already-paid order, so a paid flag with a real receipt behind it stops claiming to
 * have none. The fence is what makes that safe rather than merely likely.
 *
 * THE DOCUMENT HALF HAS TWO SOURCES OF EVIDENCE, NOT ONE (r5, Codex HIGH 3). The registration's own
 * payload is the first and the better one. It is not the only one: when the payload names no document
 * — a row from before the field existed, or one an older release compacted to `{}` — and THE LEDGER
 * ITSELF LISTS THIS REGISTRATION'S PAYMENT ON THE DOCUMENT BEING EXAMINED, the ledger has answered
 * "which document" directly, and it is the authority on the question. Rejecting such a row as unbound
 * was not conservative in the useful direction: it dropped a payment the ledger is still holding out
 * of the `posted` set, and `posted` is what the STILL_HELD test runs over — so a document whose OTHER
 * registration had been removed reported GONE while the ledger still held IMS's money on it.
 *
 * WHAT IS STILL UNPROVABLE, said plainly: a payload-less registration whose payment the ledger does
 * NOT list. Absence cannot identify a document — "removed from this invoice" and "belonged to an
 * invoice this order no longer has" produce exactly the same silence — so those rows stay unbound and
 * the classifier withholds over them. See o3d-g7jk for the enumeration of that population.
 */
export function registrationBindsToPaidState(
  row: Pick<RegisteredPaymentRow, 'registeredAgainstInvoiceId' | 'externalTransactionId'>,
  completedAt: Date,
  paidState: PaidStateBinding,
  /**
   * The payment ids the ledger states on THIS document, lowercased, or null when the read did not
   * enumerate them. Null is not emptiness — see `classifyRegisteredPaymentAgainstListing`. Defaulted
   * so a caller that has no listing keeps exactly round 4's behaviour.
   */
  ledgerListedPaymentIds: ReadonlySet<string> | null = null,
): boolean {
  // THE DOCUMENT. A row that names no document names no document — it is not a wildcard.
  const against = typeof row.registeredAgainstInvoiceId === 'string' ? row.registeredAgainstInvoiceId.trim() : ''
  if (against === '') {
    // ...unless the LEDGER names it. The payload is IMS's record of which document it asked about;
    // the listing is the ledger's record of which document is holding the payment that ask created.
    // The second is not weaker evidence, and it is the only kind a compacted row can still produce.
    const paymentId = typeof row.externalTransactionId === 'string' ? row.externalTransactionId.trim() : ''
    if (paymentId === '') return false
    if (ledgerListedPaymentIds == null) return false
    if (!ledgerListedPaymentIds.has(paymentId.toLowerCase())) return false
  } else if (paidState.accountingInvoiceId == null || against !== paidState.accountingInvoiceId) {
    return false
  }
  // THE EPISODE. Only asked of a paid flag that RECORDS its own start; a ledger-sourced flag has no
  // marker to discharge and this arm is not what decides it. Asked of ledger-identified rows on the
  // same terms as payload-identified ones: knowing WHICH document a payment sits on says nothing
  // about WHICH paid episode of that document it belongs to.
  if (paidState.unregisteredPaidAt == null) return true
  return completedAt.getTime() > paidState.unregisteredPaidAt.getTime()
}

/**
 * The instant this registration completed AS THE DATABASE MEASURED IT, or null if no such instant
 * can be produced from the row.
 *
 * MIXED-VERSION FENCE (o3d-clxw round 5, Codex finding 1). Round 4 made both ends of the reversal
 * comparison readings of one clock — the database's — and noted one residual it could not close: a
 * row written by the PREVIOUS release still carries the processor host's `new Date()`, and comparing
 * THAT against a database fence is precisely the cross-host comparison round 4 removed, reintroduced
 * by the deploy rather than by the code. During any rollout both builds run at once, so this is not a
 * historical curiosity; it is the state of the table for as long as the deploy takes, and it enables
 * the exact failure this branch exists to prevent — flag clears, Mark Paid re-arms, supplier paid
 * twice. Round 4's proposal was to let those rows age past any plausible skew, and ageing out is not
 * a fence: "plausible skew" is the assumption the branch spent four rounds deleting.
 *
 * The sibling branch o3d-batch-wcfix answered the same shape of question the same way — make an old
 * build's write DETECTABLE by carrying the marker inside the value it writes, so a build that strips
 * it announces itself, and on disagreement apply no change at all rather than guess which side is
 * right. Here the value is the timestamp and the marker is a second column holding the SAME instant
 * from the SAME single evaluation of `clock_timestamp()`:
 *
 *   marker absent      an old build created the row. It never wrote the column, so it is NULL.
 *   marker disagrees   an old build rewrote `syncedAt` from its host clock and left the marker where
 *                      the database had put it. The row now states two different completion times.
 *   marker equal       the pair was written by one statement of the current build, which is the only
 *                      writer that can produce it, so the instant IS the database's.
 *
 * Only the third is an instant this fence may order against `LedgerReadFence`. The first two withhold
 * — they do not fall back to `syncedAt`, do not tie-break, and do not age out. An undecided
 * registration is work the poller comes back to (the withheld-reversal recheck), whereas a wrong
 * decision here is a second supplier payment.
 *
 * This can only ever SHRINK the decided set relative to round 4, which is what keeps the
 * o3d-batch-payidx merge algebra intact: `billpay` still withholds everywhere the sibling's
 * `OR: [{ syncedAt: null }, { syncedAt: { gte: fence } }]` calls a row undecidable, and now in
 * strictly more places besides.
 *
 * WHAT THE EQUALITY ACTUALLY RESTS ON (o3d-clxw round 6, Codex finding 1). Round 5's third line —
 * "the only writer that can produce it" — was false, and this function cannot repair it. `syncedAt`
 * is `TIMESTAMP(3)`: any writer that lands a value on the same stored millisecond satisfies the
 * equality, and the old build's completion write does not even need luck to do it, because it is a
 * read-modify-write that can carry the database's own stamp forward onto a registration that
 * completed later. A laundered pair is bit-identical to a minted one, so THERE IS NOTHING FOR A
 * READER TO SEE. The rule had to move to write time, and to a place that binds writers this
 * repository does not contain:
 *
 *   the trigger in prisma/migrations/20260821090000_accounting_sync_log_synced_at_database_clock
 *   clears this column whenever a statement changes `status`, `syncedAt`, `externalTransactionId`
 *   or `processingStartedAt` without minting a new marker in the same statement — and refuses one
 *   supplied by an INSERT altogether.
 *
 * So an old build invalidates provenance because of WHAT IT TOUCHED, never because of what value it
 * happened to write (its re-sync must claim the row first, and the claim alone is enough). This
 * function is then what it always claimed to be: a check that the pair the database left behind is
 * still the pair it minted. It is deliberately kept as well — a row from a database where the
 * trigger is somehow absent still has to answer for itself, and the answer is "undecided".
 */
export function databaseStampedCompletion(row: Pick<RegisteredPaymentRow, 'syncedAt' | 'syncedAtDatabaseClock'>): Date | null {
  const { syncedAt, syncedAtDatabaseClock } = row
  if (syncedAt == null || syncedAtDatabaseClock == null) return null
  // Equality, not "the marker exists": a stale marker under a host-clock rewrite would otherwise
  // vouch for an instant that is no longer this row's. What makes the equality PROOF rather than a
  // coincidence is the database refusing to let anyone but the stamp leave the pair agreeing.
  if (syncedAt.getTime() !== syncedAtDatabaseClock.getTime()) return null
  return syncedAtDatabaseClock
}

// ---------------------------------------------------------------------------
// THE FENCE THAT ORDERS THE REVERSAL, AND WHY NO HOST PARTICIPATES (o3d-clxw round 4)
// ---------------------------------------------------------------------------
//
// Round 3 fenced the verdict on `syncedAt < ledgerObservedBefore`, and both sides of that comparison
// were APPLICATION clocks: `syncedAt` was `new Date()` on whichever app instance ran the sync
// processor, and `ledgerObservedBefore` was `new Date()` on whichever instance ran the poll. IMS runs
// more than one instance, so those are two machines, and nothing keeps their clocks together.
//
// Skew in ONE direction is merely wasteful — the fence reads a finished registration as unfinished
// and the reversal is withheld. Skew in the OTHER direction moves money: if the poller's clock runs
// AHEAD of the processor's, a registration that posted its payment AFTER the ledger snapshot was
// taken still carries a `syncedAt` below `ledgerObservedBefore`. The fence calls it decided, the
// payment is (correctly) absent from the older snapshot, the verdict is GONE, `paidAt` is cleared,
// Mark Paid re-arms, and the supplier is paid a second time. That is the exact defect this branch
// exists to prevent, reintroduced by the guard meant to prevent it. A tie-break cannot repair it,
// because there is no true order to break the tie towards.
//
// So the clock is taken out of the decision. BOTH ENDS ARE NOW READ FROM THE DATABASE:
//
//   the row end     `accounting_sync_logs.synced_at`, written as `clock_timestamp()` inside the same
//                   transaction that marks the registration SYNCED — which runs strictly after the
//                   POST to Xero returned, so the stamp is an upper bound on when the payment
//                   reached the ledger.
//   the fence end   `clock_timestamp()` selected from the same database immediately BEFORE the
//                   ledger was asked, so the fence is a lower bound on the snapshot's age.
//
// Two readings of ONE clock, ordered by the poller's own program order (SELECT returns, THEN Xero is
// called). No application host's clock appears on either side, so making any host fast or slow — or
// swapping which one is fast — cannot change the answer.
//
// `now()` would NOT do: PostgreSQL's `now()`/`CURRENT_TIMESTAMP` is TRANSACTION-START time, so a
// registration whose transaction opened before its POST would be stamped before the payment existed.
// `clock_timestamp()` is read at the statement, which is after.
//
// ROUND 5 CLOSED THE ROLLOUT HOLE THIS PARAGRAPH USED TO WAVE AT. A row stamped by the PREVIOUS
// release carries a host clock, and comparing that against a database fence is the same cross-host
// comparison, put back by the deploy. It is no longer allowed to be compared at all: the stamp now
// carries a provenance marker inside the value (`syncedAtDatabaseClock`, see
// `databaseStampedCompletion`), and a row that cannot prove the database minted its completion time
// is UNDECIDABLE rather than aged past a plausible skew.
//
// Residual, stated plainly: a single clock stepped backwards by NTP can still misorder two of its own
// readings. That is far smaller than free-running skew between two machines, and closing it needs a
// monotonic generation rather than a timestamp.

declare const DATABASE_CLOCK_BRAND: unique symbol

/**
 * The instant the ledger was asked, measured by the DATABASE — the only value `classifyRegisteredPayment`
 * will accept as a fence.
 *
 * Branded on purpose. The bug this replaces was a plain `Date` flowing in from `new Date()`, and a
 * plain `Date` parameter cannot tell the two apart. Only `databaseLedgerFence` can mint one, so
 * "which clock is this?" is answered at the type level rather than in a comment.
 */
export type LedgerReadFence = {
  /** `SELECT clock_timestamp()`, taken before the ledger read. */
  readonly databaseClock: Date
  readonly [DATABASE_CLOCK_BRAND]: 'accounting_sync_logs.synced_at'
}

/**
 * Wrap a `clock_timestamp()` reading taken from the application database BEFORE the ledger read.
 *
 * The ONLY correct argument is a value the database produced. Passing `new Date()` here is the
 * defect, not a shortcut around it.
 */
export function databaseLedgerFence(clockTimestamp: Date): LedgerReadFence {
  return { databaseClock: clockTimestamp } as LedgerReadFence
}

export type RegisteredPaymentVerdict =
  /** Every payment IMS registered has been proved absent from the ledger's own list. A REVERSAL. */
  | { verdict: 'GONE'; paymentIds: string[] }
  /** At least one payment IMS registered is still listed on the invoice. Not a reversal. */
  | { verdict: 'STILL_HELD'; paymentIds: string[] }
  /** IMS never told the ledger about a payment, so it holds no opinion about the residual one. */
  | { verdict: 'NOTHING_REGISTERED' }
  /**
   * o3d-psrx — IMS HOLDS A RECEIPT IT HAS NOT TOLD THE LEDGER ABOUT.
   *
   * The local `Payment` rows named here have no INVOICE_PAYMENT registration of any status. That is
   * not "nothing was registered": it is "the registration has not been raised YET", and the two are
   * the same state to a reader that only looks at sync rows — which is exactly the window this
   * verdict exists for. See `unregisteredLocalReceipts`.
   */
  | { verdict: 'RECEIPT_NOT_REGISTERED'; paymentIds: string[] }
  /**
   * o3d-psrx r2 — THE PAID FLAG WAS SET FROM EVIDENCE THE LEDGER WAS NEVER GIVEN, AND THERE IS NO
   * LOCAL RECEIPT TO SAY SO.
   *
   * `RECEIPT_NOT_REGISTERED` above catches the case where IMS holds a `Payment` row it has not
   * registered. It cannot catch the case where IMS holds the order as paid and there is no `Payment`
   * row at all — which is the ordinary shape of a WooCommerce order (`date_paid_gmt`) and of
   * `markSalesOrderPaid`. Nothing was recorded and nothing was registered, so the receipt witness
   * sees nothing to withhold on and the ledger's zero reads as `NOTHING_REGISTERED`: "IMS never told
   * the ledger about a payment here, so the zero is the whole story".
   *
   * It is not the whole story. Nobody ever intended to tell the ledger. See
   * `SalesOrder.unregisteredPaidAt`, which is what separates this from the ledger-sourced paid flag
   * that `NOTHING_REGISTERED` is genuinely about.
   */
  | { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' }
  /** The payload did not enumerate the payments, so absence cannot be established from it. */
  | { verdict: 'LEDGER_DID_NOT_LIST_PAYMENTS' }
  /**
   * o3d-psrx r7 (Codex HIGH 1) — THE REGISTRATIONS THAT WENT MISSING NEVER COVERED THE WHOLE DOCUMENT.
   *
   * The document still carries its off-ledger provenance marker — `SalesOrder.unregisteredPaidAt`,
   * which `addPayment` clears only when the receipts on the order COVER its total — and the
   * registrations bound to this paid state settle LESS than that total. So the ledger's silence about
   * them is an account of a part of the balance, and the rest of it was never in any ledger to be
   * removed from.
   *
   * `registeredTotal` is what the bound registrations state they sent, or NULL when a payload would
   * not say. NULL is not zero: it is the reason this verdict was reached rather than a measurement,
   * and coverage that cannot be established cannot be established in either direction.
   */
  | {
      verdict: 'PART_COVERED_OFF_LEDGER'
      paymentIds: string[]
      /**
       * o3d-psrx r18: `Decimal`, not `number`. These two figures are the ones the guard COMPARED, and
       * the comparison is now exact decimal arithmetic — reporting them as doubles would print the
       * same value twice for exactly the pair the r18 finding is about (`549755813888.0002` covering
       * `549755813888.0003`), which is the one case an operator most needs to be able to read.
       */
      registeredTotal: Decimal | null
      documentTotal: Decimal
    }
  /**
   * o3d-psrx r8 (Codex HIGH 2) — THE LEDGER HAS NOT BEEN SHOWN TO HOLD NOTHING ON THIS DOCUMENT.
   *
   * Every admitting arm of `zeroPaidIsProvenReversal` below rests on ONE unstated precondition: the
   * ledger's own account of this document is ZERO PAID. That is what makes "IMS registered nothing,
   * so the zero is the whole story" and "the payload withheld the list, but it STATED a zero total"
   * sound. It is a fact about the LEDGER's amounts, and it is not established by the classifier —
   * which reads registrations, receipts and provenance, and never an amount the ledger states.
   *
   * Xero establishes it upstream: `partitionPaymentReversals` splits `zeroPaid` from `partPaid` and
   * `unverifiable` on `AmountPaid`, and only the first is asked this question at all. THE QUICKBOOKS
   * POLLER DID NOT. Its candidates were invoices with `Balance > 0` — a PART payment and a removed
   * one look identical in that predicate — and with no listing to enumerate, a document carrying a
   * posted registration landed on `LEDGER_DID_NOT_LIST_PAYMENTS`, which admits. Two registrations
   * covering the total, one payment removed: a positive balance, the other payment still held by
   * QuickBooks, and the whole sale reversed with a chargeback credit note over it.
   *
   * So the precondition is now a VERDICT rather than an assumption, and a connector that cannot show
   * it says so here instead of falling into an admitting arm by default. `paidAmount` is what the
   * ledger states it still holds, or NULL when the read could not produce a figure — NULL is not
   * zero, exactly as in `PART_COVERED_OFF_LEDGER`: it is the reason this verdict was reached rather
   * than a measurement.
   */
  | {
      verdict: 'LEDGER_NOT_PROVEN_ZERO_PAID'
      paidAmount: number | null
      documentTotal: number | null
      /**
       * o3d-psrx r15 (Codex MEDIUM 2) — THE ONE CAUSE OF THIS VERDICT THAT IS A BINDING DEFECT
       * RATHER THAN A LEDGER READING, SAID OUT LOUD.
       *
       * The amounts a ledger states are only readable against a MINOR UNIT, and the minor unit comes
       * from the document's currency. When neither the payload nor the IMS document it is linked to
       * can supply one, the reader falls back to the finest precision this repository supports — the
       * strictest bound — and the figures are refused for a reason that has nothing to do with what
       * the ledger said. An operator told only "IMS could not read the amount" would go and look at a
       * document whose amounts are perfectly ordinary.
       *
       * Optional, and ABSENT MEANS NO: every other producer of this verdict read a currency from
       * somewhere, so only the QuickBooks reader that can reach the unbound state sets it.
       */
      currencyUnbound?: boolean
    }
  /**
   * o3d-psrx r10 (Codex HIGH 1) — THE LEDGER STATES THIS DOCUMENT IS ONLY PARTLY PAID. THAT IS THE
   * WHOLE OF WHAT IS KNOWN, AND THE NAME NOW SAYS SO.
   *
   * r9 called this `LEDGER_PART_PAYMENT_REMOVED`, and its third figure `removedAmount`, on the
   * strength of `TotalAmt - Balance`. Codex's finding is that the arithmetic cannot carry that
   * story. Those two figures describe the CURRENT state of the document and contain no prior amount
   * and no payment history, so a document that was only ever PART PAID — invoiced at 100, settled
   * with a single 50 — is indistinguishable from one that carried 100 and lost 50. Same `TotalAmt`,
   * same `Balance`, same subtraction. r9 measured "partly paid now" and reported "a payment was
   * removed".
   *
   * The quantity was real; the story about it was not, and the story is the part an operator acts
   * on. Being told money was taken back sends somebody hunting a chargeback that may never have
   * happened — and, worse for the next warning, teaches them that these overstate.
   *
   * SO THE VERDICT REPORTS THE COMPARISON AND NOTHING BEYOND IT. `paidAmount` is what the ledger
   * states is settled on the document, `documentTotal` what it states the document is for, and
   * `outstandingAmount` is the ledger's OWN balance figure — the amount still owed, not a loss, and
   * not a subtraction this code performed. `currency` is the document's own, or NULL when the
   * payload did not state one; an amount reported without its currency is the same fault in
   * miniature.
   *
   * WHAT IT STILL DOES, unchanged from r9, is separate a document whose figures IMS read perfectly
   * from one whose figures it could not read at all. Both withhold; only one of them can be
   * quantified, listed and acted on. Collapsed into `LEDGER_NOT_PROVEN_ZERO_PAID` — "IMS could not
   * establish anything" — a stable part-paid document was unfindable, and because `paidAt` stays set
   * it was in practice absorbed as "fully paid".
   *
   * All three amounts are numbers, never null: a figure that could not be read is not this verdict,
   * it is `LEDGER_NOT_PROVEN_ZERO_PAID`, and that distinction is the reason this one can be trusted
   * to quantify anything.
   *
   * IMS DOES NOT RECONCILE IT. There is no partial-settlement accounting path — no partial credit
   * note, no partial unwind of the recognised revenue — and building one is deliberately out of this
   * round's scope (o3d-cdhl). This verdict is the durable, quantified statement that IMS and the
   * ledger disagree about this document, carried by the withheld-marker lifecycle so it is rechecked
   * rather than filed away.
   */
  | {
      verdict: 'LEDGER_PARTIALLY_PAID'
      /** What the ledger states is settled on the document. */
      paidAmount: number
      /** What the ledger states the document is for. */
      documentTotal: number
      /**
       * The ledger's own outstanding balance. It is what is still OWED — never a claim that this
       * amount was once paid and has been taken away, which these figures cannot establish.
       */
      outstandingAmount: number
      /** The document's currency, or NULL when the payload did not state one. */
      currency: string | null
    }
  /** A registration exists whose effect on the ledger this read cannot speak for. */
  | { verdict: 'REGISTRATION_UNDECIDED'; entryIds: string[] }

/**
 * Is the payment IMS registered still in the ledger?
 *
 * `ledgerObservedBefore` is the instant Xero WAS ASKED, as the DATABASE measured it. A registration
 * that finished after it may have created a payment this snapshot never saw, so its absence from the
 * list proves nothing — and that case is the dangerous one, because it is exactly the fifteen minutes
 * between Mark Paid setting `paidAt` locally and the worker posting the payment. Declaring a reversal
 * there would clear the flag over a payment that had just been made and invite a second one.
 *
 * Both ends of the comparison are `clock_timestamp()` readings of the SAME database (see
 * LedgerReadFence): no application host's clock takes part, so host skew cannot flip a verdict.
 *
 * NULL FENCE = NOTHING IS DECIDED. If the database clock could not be read, the poll has no ordering
 * at all, and the fail-closed reading of "no ordering" is that every registration might have landed
 * after the snapshot. Everything withholds. That is also what keeps the o3d-batch-payidx algebra
 * intact: this function's decided set only ever SHRINKS relative to the sibling's
 * `OR: [{ syncedAt: null }, { syncedAt: { gte: fence.databaseClock } }]` undecidable predicate — it
 * is never allowed to grow, so a bill this branch admits is still one the sibling has nothing
 * undecidable for.
 *
 * Undecided beats everything: one registration this read cannot account for withholds the whole
 * verdict, because the document is one document and paidAt is one flag.
 */
export function classifyRegisteredPayment(
  invoice: XeroInvoice,
  registrations: RegisteredPaymentRow[],
  ledgerObservedBefore: LedgerReadFence | null,
  unregisteredReceiptIds: readonly string[] = [],
  paidWithoutLedgerReceipt: boolean = false,
): RegisteredPaymentVerdict {
  return classifyRegisteredPaymentAgainstListing(
    listedLedgerPaymentIds(invoice),
    registrations,
    ledgerObservedBefore,
    unregisteredReceiptIds,
    paidWithoutLedgerReceipt,
  )
}

/**
 * THE DECISION ITSELF, WITH NO LEDGER'S DIALECT IN IT (o3d-psrx r3, Codex HIGH).
 *
 * `classifyRegisteredPayment` above is this function plus ONE line: how a XERO invoice states which
 * payments it carries. Everything the verdict actually turns on -- the registrations, the fence, the
 * unregistered receipts, the recorded provenance -- is connector-neutral, and splitting it here is
 * what lets the QuickBooks poller reach the SAME decision instead of a second one worded like it.
 * Two independently-worded implementations of one money rule is precisely the defect Codex found:
 * the rule enforced for Xero and silently absent for QuickBooks.
 *
 * `ledgerListedPaymentIds` is the set of payment ids the ledger states on this document, LOWERCASED,
 * or NULL when this read did not enumerate them. Null is not "no payments": it is "absence cannot be
 * established from this payload", which is what `LEDGER_DID_NOT_LIST_PAYMENTS` says. The QuickBooks
 * reversal read asks only which invoice ids regressed, so it always passes null, and GONE/STILL_HELD
 * are unreachable from that connector -- see the QuickBooks poller's own note.
 */
export function classifyRegisteredPaymentAgainstListing(
  ledgerListedPaymentIds: ReadonlySet<string> | null,
  registrations: RegisteredPaymentRow[],
  ledgerObservedBefore: LedgerReadFence | null,
  /**
   * o3d-psrx — the local receipts on this document that NO registration names, from
   * {@link unregisteredLocalReceipts}. Defaulted to none so every existing caller and test keeps its
   * exact previous meaning; the sales pass is the one that supplies it. See the verdict's own note.
   */
  unregisteredReceiptIds: readonly string[] = [],
  /**
   * o3d-psrx r2 — WAS THIS DOCUMENT'S PAID FLAG SET FROM SOMETHING THE LEDGER WAS NEVER TOLD?
   *
   * `SalesOrder.unregisteredPaidAt != null`, read straight from the row. Defaulted to false so every
   * existing caller and test keeps its exact previous meaning, and so a BILL — which has no such
   * column and whose half of this defect was closed at source by markBillPaid queueing inside the
   * paid transaction (o3d-a3wx) — never reaches this arm.
   *
   * CONSULTED IN TWO PLACES, AND KNOWING WHICH IS WHICH IS r7's WHOLE FINDING:
   *
   *   nothing posted        it decides outright — PAID_WITHOUT_LEDGER_RECEIPT, withheld.
   *   something posted      it gates the COVERAGE GUARD below, which asks whether what posted
   *                         settles `documentTotal`. If it does, the ledger's own list decides and a
   *                         genuine WooCommerce chargeback reverses exactly as 6oyu.6 intends. If it
   *                         does not, the ledger's silence is an account of a PART of the balance.
   *
   * Round 6 had only the first, and said so as "consulted ONLY when no registration is shown to have
   * posted, which is what makes it self-discharging". Self-discharging on a PART payment is not a
   * discharge, it is a full chargeback bought with a penny's worth of evidence. It is still
   * self-discharging — by the receipt that completes the cover, which clears this flag at the write
   * site — and that is a fact about the ORDER rather than about how much has posted.
   */
  paidWithoutLedgerReceipt: boolean = false,
  /**
   * o3d-psrx r4 — WHAT THE DOCUMENT'S PAID FLAG IS ABOUT RIGHT NOW, so a registration raised against a
   * document the order no longer has, or during a paid state that has since been cleared, cannot
   * answer for this one. See {@link PaidStateBinding}. Null = the caller is not asking, and then every
   * registration weighs exactly as it did before.
   */
  paidState: PaidStateBinding | null = null,
  /**
   * o3d-psrx r7 (Codex HIGH 1) — WHAT THE PAID FLAG IS FOR, AS A NUMBER.
   *
   * `SalesOrder.totalForeign`, in the document's own currency, or NULL when the caller is not asking
   * the coverage question — a bill (which has no off-ledger marker and cannot reach that arm), a test
   * that predates this parameter, or a read that could not produce the total. NULL leaves every
   * verdict exactly as round 6 reached it.
   *
   * It is read ONLY beside a standing `paidWithoutLedgerReceipt`. See the coverage guard below.
   */
  documentTotal: Decimal | null = null,
): RegisteredPaymentVerdict {
  const undecided: string[] = []
  const posted: string[] = []
  // o3d-psrx r7 — THE SAME ROWS AS `posted`, KEPT WHOLE, because the coverage guard needs their
  // amounts and `posted` is a list of the LEDGER's payment ids. Pushed together, always, so the two
  // cannot describe different sets.
  const postedRows: RegisteredPaymentRow[] = []
  // o3d-psrx r4 — POSTED, BUT NOT ABOUT THIS PAID STATE. Kept apart from both other buckets on
  // purpose: counting these as `posted` is the defect Codex found, and DROPPING them would be worse —
  // a document whose only registration is unbound would read as NOTHING_REGISTERED, which is an
  // ADMITTED reversal. They are evidence of a registration and evidence of nothing about this flag,
  // and the only honest verdict over them alone is "undecided".
  const unbound: string[] = []

  for (const row of registrations) {
    // o3d-f709 — THE COMMENT THIS REPLACES WAS FALSE, AND IT WAS LOAD-BEARING. It read: "CANCELLED
    // is the one status this tree only ever asserts where 'nothing was sent' is true, so it holds no
    // payment and blocks nothing." Two settlement writers and the post-time retirement of a claimed
    // row all reach CANCELLED without establishing anything of the kind, and dropping such a row
    // here collapses the verdict to NOTHING_REGISTERED — which is an ADMITTED reversal, clears
    // `PurchaseInvoice.paidAt`, and re-arms Mark Paid over a payment that may be in the ledger.
    //
    // The rule is not restated here: only a cancelled row that carries its own proof of a pre-call
    // abandonment (or an operator's audited NOT_POSTED assertion), and names no document, still
    // drops out.
    if (!mayHaveReachedLedger(row)) continue
    // The completion instant the DATABASE minted, or null when the row cannot prove which clock wrote
    // it — an old build's host-clock stamp is not a fence, it is the defect (round 5, finding 1).
    const completedAt = databaseStampedCompletion(row)
    // SYNCED with an id, finished before the ledger was read: the ledger's answer covers it.
    if (
      row.status === 'SYNCED'
      && typeof row.externalTransactionId === 'string'
      && row.externalTransactionId.trim() !== ''
      && completedAt != null
      // No fence, no decision: see the NULL FENCE note above.
      && ledgerObservedBefore != null
      // STRICTLY before, matching the sibling's `OR: [{ syncedAt: null }, { syncedAt: { gte:
      // fence.databaseClock } }]` undecidable predicate EXACTLY. At the tie the two would otherwise
      // give opposite answers about the same row, and the safe side of a tie about a supplier payment
      // is "this read cannot speak for it". Both sides of this `<` are database readings — the
      // comparison is meaningless, and was actively dangerous, between two hosts.
      && completedAt.getTime() < ledgerObservedBefore.databaseClock.getTime()
    ) {
      // o3d-psrx r4: it posted and the ledger's answer covers it — but does it cover THIS document's
      // CURRENT paid flag? A caller that supplies no binding is not asking, and nothing changes.
      if (paidState != null && !registrationBindsToPaidState(row, completedAt, paidState, ledgerListedPaymentIds)) {
        unbound.push(row.id)
        continue
      }
      posted.push(row.externalTransactionId.trim())
      postedRows.push(row)
      continue
    }
    // Everything else is a registration whose ledger effect is unknown to THIS read: PENDING (about
    // to be sent), PROCESSING (may be on the wire now), FAILED (attempted, outcome unknown — the
    // processor posts before it persists, so a lost response is written down as a rejection), SYNCED
    // with no id (posted, but we do not know what it created), SYNCED after the read, and SYNCED with
    // a completion time no clock will vouch for (an old build's stamp, round 5 finding 1).
    undecided.push(row.id)
  }

  if (undecided.length > 0) return { verdict: 'REGISTRATION_UNDECIDED', entryIds: undecided }

  // o3d-psrx — ASKED BEFORE ANYTHING IS CONCLUDED FROM THE LEDGER'S LIST, and it dominates every
  // answer below including GONE.
  //
  // A receipt IMS has recorded and not registered means the ledger's account of this document is not
  // an account of what IMS believes was paid — the shortfall is IMS's own doing, not a removal. That
  // is true whether the ledger shows zero, a part payment, or no figure at all, so the check sits
  // above the split rather than inside the zero-paid arm.
  if (unregisteredReceiptIds.length > 0) {
    return { verdict: 'RECEIPT_NOT_REGISTERED', paymentIds: [...unregisteredReceiptIds] }
  }

  // o3d-psrx r2 — NOTHING POSTED. WHICH OF THE TWO VERY DIFFERENT REASONS IS IT?
  //
  // `NOTHING_REGISTERED` is a REVERSAL under zeroPaidIsProvenReversal, and it is right to be one for
  // the population it was written for: `paidAt` came from the ledger's own forward pass or from the
  // backlog reconcile, so a ledger that now reads zero has genuinely had the payment taken away.
  //
  // It is catastrophically wrong for the OTHER population that reaches this line with no posted
  // registration — an order whose paid flag came from a channel or from an operator. Nothing was
  // ever going to be registered for it, so the ledger's zero says nothing whatever about a removal,
  // and admitting it clears `paidAt` and raises a chargeback credit note against a sale the customer
  // paid for. The row itself is what separates them; see SalesOrder.unregisteredPaidAt.
  if (posted.length === 0) {
    // o3d-psrx r4 — THE MARKER IS ASKED BEFORE THE UNBOUND ROWS, and that order is the whole finding.
    //
    // The marker says this paid flag was entered with no ledger receipt behind it and none coming. An
    // unbound row cannot contradict that: by construction it is about a document this one replaced, or
    // about a paid state that was cleared before this one began. Asking the rows first is exactly the
    // reading that let a registration from the FIRST paid episode discharge the SECOND.
    if (paidWithoutLedgerReceipt) return { verdict: 'PAID_WITHOUT_LEDGER_RECEIPT' }
    // No marker, and every registration this document has is unbound. `NOTHING_REGISTERED` would be a
    // lie in the admitting direction — IMS DID register a payment, just not for this document or this
    // paid state, and the ledger may still be holding it. Undecided, named, and withheld.
    if (unbound.length > 0) return { verdict: 'REGISTRATION_UNDECIDED', entryIds: unbound }
    return { verdict: 'NOTHING_REGISTERED' }
  }

  const listed = ledgerListedPaymentIds
  if (listed !== null) {
    const stillHeld = posted.filter((id) => listed.has(id.toLowerCase()))
    // ALL of them, not any: with two registrations a bill can have one payment removed and one intact,
    // and clearing paidAt there re-arms Mark Paid for the WHOLE total on top of the surviving payment.
    // ASKED BEFORE THE COVERAGE GUARD BELOW because it is the more useful of two withholdings: it
    // names the payment the ledger is still holding, which is the thing an operator has to go and look
    // at. Both withhold, so the order changes what is SAID and not what is done.
    if (stillHeld.length > 0) return { verdict: 'STILL_HELD', paymentIds: stillHeld }
  }

  // o3d-psrx r7 (Codex HIGH 1) — THE COVERAGE GUARD. IT DOMINATES BOTH REMAINING ANSWERS, AND BOTH OF
  // THEM ARE ADMITTED REVERSALS.
  //
  // THE DEFECT. Round 6 made the WRITER keep `SalesOrder.unregisteredPaidAt` through a partial
  // receipt: a £1 receipt on a £100 order marked paid off-ledger no longer erased the provenance of
  // the other £99. This READER consults that marker only in the `posted.length === 0` arm above — so
  // the moment the £1 receipt's registration posted and bound, the marker was never asked again. An
  // empty ledger listing then produced GONE, `zeroPaidIsProvenReversal` admitted it, and
  // `raiseChargebackForReversedOrder` unwound the WHOLE £100 against a customer who paid.
  //
  // Round 6 argued against making readers amount-aware, on the grounds that the marker is a BOOLEAN
  // fact about the whole balance. That is right about the marker and wrong about this reader, which
  // is already deciding whether one registration's absence justifies reversing a specific total. The
  // amount is its business. The marker stays boolean; this one comparison is where the number enters.
  //
  // WHAT IT ASKS: while the document still says its paid flag was entered with no ledger receipt
  // behind it, do the registrations bound to THAT flag settle its total? If they do, their removal is
  // a removal of the whole balance and the ledger's answer stands unchanged. If they do not — or if a
  // payload will not say how much it sent — the ledger's silence is an account of a PART, and the
  // remainder was never in any ledger to be taken away from.
  //
  // COVERAGE THAT CANNOT BE ESTABLISHED IS NOT COVERAGE (`covered === null`). It is the same reading
  // `LEDGER_DID_NOT_LIST_PAYMENTS` gives an absent `Payments[]` and `databaseStampedCompletion` gives
  // an unvouched timestamp, and the population it withholds is vanishingly small: a compacted payload
  // names no document either, so such a row only reaches `posted` at all when the LEDGER named the
  // document for it — and a ledger that lists the payment has already produced STILL_HELD above.
  //
  // IT IS SELF-DISCHARGING, which is what stops it becoming a permanent withholding. The marker is a
  // property of the order, not of this read: the receipt that completes the cover clears it at the
  // write site, and this guard then does not run at all.
  if (paidWithoutLedgerReceipt && documentTotal != null) {
    const covered = sumRegisteredAmounts(postedRows)
    if (covered === null || !coversDocumentTotal(covered, documentTotal)) {
      return { verdict: 'PART_COVERED_OFF_LEDGER', paymentIds: posted, registeredTotal: covered, documentTotal }
    }
  }

  if (listed === null) return { verdict: 'LEDGER_DID_NOT_LIST_PAYMENTS' }
  return { verdict: 'GONE', paymentIds: posted }
}

/**
 * What these registrations state they sent, or NULL if ANY of them will not say (o3d-psrx r7).
 *
 * One unreadable row makes the whole sum unreadable rather than smaller. A sum with a hole in it is
 * not a smaller sum, it is a number that means nothing — and the direction the hole would push the
 * comparison depends entirely on which row it is in.
 */
function sumRegisteredAmounts(rows: readonly RegisteredPaymentRow[]): Decimal | null {
  // o3d-psrx r18 (Codex HIGH 2): SUMMED AS `Decimal`. `toDecimal` reads each term at its own exact
  // decimal value and `addMoney` adds them without rounding, so the SUM contributes no error of its
  // own on top of the terms. Adding them in `Number` did: two four-decimal registrations against a
  // large order could total to a double a whole minor unit away from their true sum, and this figure
  // is one side of the coverage comparison.
  //
  // o3d-1xq8 (Codex HIGH): AND THE TERMS THEMSELVES ARE NO LONGER ALL DOUBLES. r18 wrote "each term
  // is still a double — the enqueue records it that way in the payload" and left the residue to
  // PAID_COVERAGE_EPSILON. That residue is not one-directional: `Number(receipt.amount)` on the
  // stored `Decimal(18, 4)` rounds UP as readily as down, and a term rounded up can carry the sum
  // over `documentTotal - PAID_COVERAGE_EPSILON` on an order the receipts fall a minor unit short
  // of — manufacturing coverage, standing this guard down, and admitting a whole-document reversal.
  // The enqueue now records the exact decimal string beside the number and
  // `payloadRegisteredAmount` prefers it, so a term from a row written since is EXACT. A term from a
  // historical row is still the double's own exact decimal reading, which is precisely what this
  // loop made of it before — no row is read differently, and every new row is read exactly.
  let total = toDecimal(0)
  for (const row of rows) {
    const stated = row.registeredAmount
    if (stated == null) return null
    if (typeof stated === 'number') {
      if (!Number.isFinite(stated)) return null
      total = addMoney(total, stated)
      continue
    }
    total = addMoney(total, stated)
  }
  return total
}

/**
 * MAY A ZERO-PAID DOCUMENT CLEAR `paidAt`? (o3d-clxw round 3)
 *
 * The ledger saying it holds nothing is one of two very different facts, and it looks identical
 * either way:
 *
 *   the payment was REMOVED         — a genuine reversal, and `paidAt` must be cleared.
 *   the payment HAS NOT LANDED YET  — IMS marked the bill paid and the worker has not posted the
 *                                     registration. Clearing `paidAt` re-arms Mark Paid over a
 *                                     payment that is on its way, and the operator presses it. Xero's
 *                                     idempotency key expires after six minutes, BILL_PAYMENT sits
 *                                     outside every live-row dedupe, and markBillPaid sends no key at
 *                                     all — so nothing downstream refuses the second payment.
 *
 * The ledger CANNOT distinguish them, because the distinguishing fact is not in the ledger: it is in
 * IMS's own registration rows and the instant the ledger was read. So the amount reading proposes and
 * this decides.
 *
 * Verdict by verdict, and every one of them fails towards withholding:
 *
 *   GONE                        our registered payment was posted before the read and is absent from
 *                               a list we could read fully. Removed. REVERSAL.
 *   NOTHING_REGISTERED          IMS never told the ledger about a payment here (or every registration
 *                               is CANCELLED, which asserts nothing was sent), so there is no payment
 *                               of ours to be in flight and the zero is the whole story. REVERSAL.
 *                               `paidAt` came from the forward pass or the reconcile, and the ledger
 *                               has since been emptied.
 *   LEDGER_DID_NOT_LIST_PAYMENTS  the payload withheld `Payments[]`, but it STATED a zero total. An
 *                               aggregate of zero needs no list: if the ledger holds no money at all,
 *                               it is not holding ours either, whatever its id. REVERSAL.
 *   LEDGER_NOT_PROVEN_ZERO_PAID (r8) — AND THE SENTENCE ABOVE IS WHERE THIS ONE COMES FROM. "It
 *                               STATED a zero total" is a precondition of the whole admitting side of
 *                               this table, not a property of the verdict; a caller that hands in a
 *                               document merely showing a BALANCE DUE has not established it, and a
 *                               part-removed payment is indistinguishable from a fully removed one in
 *                               that predicate. WITHHELD.
 *   LEDGER_PARTIALLY_PAID       (r9, renamed in r10) the same withholding, reached on evidence that is
 *                               not missing at all: the ledger STATES a non-zero amount settled,
 *                               short of the document's total. Split out of the verdict above because
 *                               "IMS could not establish this" and "IMS established that the ledger
 *                               holds this document as part paid" are different claims, and only one
 *                               of them is an item somebody can act on. It does NOT say a payment was
 *                               removed: these figures cannot tell that from a document that was only
 *                               ever part paid. WITHHELD, and quantified.
 *   REGISTRATION_UNDECIDED      THE DEFECT THIS FUNCTION EXISTS FOR. A PENDING, PROCESSING or FAILED
 *                               registration, or one that synced after the read, may have created a
 *                               payment this snapshot never saw. WITHHELD.
 *   STILL_HELD                  the ledger lists our payment on an invoice it says is unpaid. That is
 *                               a contradiction IMS cannot settle from one read — Xero can list a
 *                               payment that has since been deleted — and an unsettled contradiction
 *                               is not proof. WITHHELD.
 *   PART_COVERED_OFF_LEDGER     (r7) the document still says its paid flag was entered with no ledger
 *                               receipt behind it, and what posted settles LESS than its total. The
 *                               ledger's account of those registrations is an account of part of the
 *                               balance; the remainder was never in any ledger to be removed from.
 *                               WITHHELD.
 *
 * Note what the withheld answers cost, because it is the asymmetry the whole module turns on: a
 * document IMS keeps showing as paid, loudly warned about on every poll that sees it, which a human
 * can correct in a minute. The other direction costs a second supplier payment, which nobody can.
 */
export function zeroPaidIsProvenReversal(verdict: RegisteredPaymentVerdict): boolean {
  switch (verdict.verdict) {
    case 'GONE':
    case 'NOTHING_REGISTERED':
    case 'LEDGER_DID_NOT_LIST_PAYMENTS':
      return true
    case 'REGISTRATION_UNDECIDED':
    case 'STILL_HELD':
    // o3d-psrx: IMS recorded a receipt and has not told the ledger about it, so the ledger's zero is
    // IMS's own silence rather than a removal. WITHHELD, on the same asymmetry as every other arm
    // here: a wrongly withheld reversal is a warning a human clears in a minute, a wrongly admitted
    // one raises a chargeback credit note against revenue nobody took back.
    case 'RECEIPT_NOT_REGISTERED':
    // o3d-psrx r2: the paid flag was set by a channel or an operator and no registration ever
    // posted, so the ledger has never been told there was a payment at all. Its zero is IMS's own
    // silence — the same asymmetry as every other arm: a wrongly withheld reversal is a warning a
    // human clears, a wrongly admitted one raises a chargeback credit note against a paid sale.
    case 'PAID_WITHOUT_LEDGER_RECEIPT':
    // o3d-psrx r7 (Codex HIGH 1): the registrations that went missing covered PART of a document
    // whose paid flag is still marked off-ledger, so the ledger's account of them is an account of
    // part of the balance. Reversing the whole of it raises a chargeback credit note over the
    // remainder — which no ledger ever held, and so cannot have taken away.
    case 'PART_COVERED_OFF_LEDGER':
    // o3d-psrx r8 (Codex HIGH 2): the caller has not shown that the ledger holds NOTHING on this
    // document, which every admitting arm above assumes and only Xero's `partitionPaymentReversals`
    // was establishing. A balance due is not that proof — it is equally the shape of a payment PART
    // of which is still held — and reversing on it clears `paidAt` and raises a chargeback credit
    // note over money the ledger is still holding for us.
    case 'LEDGER_NOT_PROVEN_ZERO_PAID':
    // o3d-psrx r9 (Codex HIGH), renamed r10: the ledger states a non-zero amount is still SETTLED on
    // this document, so it has not been shown to hold nothing — the precondition every admitting arm
    // above assumes. Reversing here would raise a chargeback credit note over the part the ledger is
    // still accounting for, the identical wrong outcome its parent verdict exists to prevent, and the
    // reason this refinement changes no decision. What it changes is the RECORD: the withheld marker
    // carries the ledger's stated figures instead of "IMS could not tell", so a disagreement is an
    // item somebody can find rather than a document that quietly stays paid. Reconciling it is
    // o3d-cdhl and is not attempted here.
    case 'LEDGER_PARTIALLY_PAID':
      return false
  }
}

/**
 * o3d-psrx — WHICH OF THIS DOCUMENT'S LOCAL RECEIPTS THE LEDGER HAS NEVER BEEN TOLD ABOUT.
 *
 * THE DEFECT. `addPayment` writes the `Payment` row and the order's `paidAt` in ONE transaction and
 * queues the INVOICE_PAYMENT registration AFTERWARDS, outside it — with a `revalidatePath` and an
 * awaited `logActivity` in between. A poll landing in that window sees an order IMS holds as paid,
 * finds no registration for it, and reads that as NOTHING_REGISTERED: "IMS never told the ledger
 * about a payment here, so the zero is the whole story". It is not the whole story. The registration
 * has not been raised yet. `paidAt` is cleared, the reversal pass raises a chargeback credit note
 * against revenue nobody reversed, and Mark Paid re-arms. That is the same double-payment class
 * o3d-clxw closed for bills, reached by a different route.
 *
 * markBillPaid's answer — queue the registration inside the transaction — does not transfer. Marking
 * a bill paid is an INSTRUCTION, so rolling it back when the queue declines is honest; recording a
 * customer receipt is a FACT, and `registerInvoicePaymentWithLedger` says in its own header that it
 * must never fail the receipt the operator just recorded.
 *
 * SO THE WITNESS IS THE RECEIPT ITSELF, AND IT IS ALREADY WRITTEN IN THE RIGHT TRANSACTION. The
 * `Payment` row and `paidAt` commit together, so there is NO instant at which a reader can see the
 * paid flag and not the receipt that produced it. Nothing new has to be made durable — the defect
 * was that nobody read it. What this adds is the reader.
 *
 * PAIRED BY `paymentId`, which is the id `registerInvoicePaymentWithLedger` puts in the registration
 * payload (`payloadPaymentId`) and the same field `findRegisteredPaymentsForReceipt` matches on. A
 * registration whose payload records no `paymentId` — a row from before the field existed, or one
 * raised by the SALES_INVOICE follow-up for an imported order — names no receipt and so clears none;
 * that is the conservative direction and it is deliberate.
 *
 * CANCELLED REGISTRATIONS DO NOT COUNT AS TELLING THE LEDGER. A retired row asserts nothing was
 * sent, which leaves the receipt exactly as unregistered as it was before the row existed.
 */
export function unregisteredLocalReceipts(
  receiptIds: readonly string[],
  registrations: readonly { status: string; paymentId: string | null }[],
): string[] {
  const named = new Set(
    registrations
      .filter((row) => row.status !== 'CANCELLED')
      .map((row) => row.paymentId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  return receiptIds.filter((id) => !named.has(id))
}
