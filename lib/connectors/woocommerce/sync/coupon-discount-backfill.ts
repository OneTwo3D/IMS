/**
 * o3d-y14 corrective backfill: clear the DUPLICATED order-level coupon off legacy WooCommerce orders.
 *
 * WooCommerce allocates cart-coupon money INTO the line items, and mapWcLineItems already carries it
 * as a per-line `discountAmount`. The pre-fix importer ALSO wrote the whole coupon total into the
 * ORDER-LEVEL `SalesOrder.discountAmount` slot — which means "a discount NOT already in the lines" —
 * so every consumer deducted the same coupon twice: the Xero/QuickBooks invoice (per-line
 * `DiscountRate` AND a negative "Order discount" line), the chargeback credit note, and the SO detail
 * totals block. The importer is fixed going forward (`resolveWcOrderLevelDiscount`); this corrects the
 * rows written before that.
 *
 * IT MUTATES HISTORICAL FINANCIAL DATA, so the governing rule is that it must never make a CORRECT row
 * wrong. Skipping a row it could have fixed is recoverable — re-run it. Overwriting a correct value
 * with a reconstructed one destroys the truth and nothing downstream can tell. Everything below is
 * built around that asymmetry: each decision names the evidence it rests on, anything unprovable is
 * reported rather than reconstructed, and the write is fenced rather than optimistic.
 *
 * THREE SAFETY PROPERTIES, ONE PER BLOCKING BUG:
 *
 *   THE ALLOWLIST — CONSENT. Provenance narrows the candidate set; it does not establish it. The
 *   database does NOT enforce that `discountAmount` is write-once, so a row corrected by hand
 *   (raw SQL, an ad-hoc script — anything outside the application) is still unmarked and still
 *   pre-cutoff, and re-deriving it turns a correct 6 into 2 and then stamps that permanently. The
 *   markerless interval makes it worse: `development` shipped the fixed importer BEFORE it stamped
 *   `discountModel`, so a cutoff even slightly later than that rollout's true earliest moment
 *   misclassifies correct imports. Neither is decidable from the row. So APPLY DOES NOT SCAN: a dry
 *   run emits a proposal carrying the evidence for each candidate, a human reviews and signs it, and
 *   apply touches only the ids on that reviewed list — re-verifying every evidence field and
 *   RE-DERIVING the amount, so a row that moved since review is skipped rather than corrected. For a
 *   one-shot destructive operation against posted invoices, opt-in is the only defensible default.
 *
 *   o3d-9te — PROVENANCE. `SalesOrder.createdAt` is NOT when IMS imported the order: the initial
 *   import backdates it to the historical Woo order date (`useWcDateAsCreatedAt`). Scoping "legacy" by
 *   it treats an order imported AFTER the fix, whose Woo date is old, as a pre-fix duplicate — and
 *   subtracts the line discounts from a residual the FIXED importer stored on purpose. See
 *   `classifyWcCouponProvenance` for what is used instead, and why.
 *
 *   o3d-5ct — THE QUEUE. A queued SALES_INVOICE row carries a payload SNAPSHOT and both processors
 *   post from it. Patching that payload cannot be made safe from here, because a worker reads the row
 *   BEFORE it conditionally claims it: it can hold the old snapshot while this script sees the row
 *   still PENDING. So this never touches a queued payload. `applyWcCouponCorrection` instead takes the
 *   sales-order row lock — the SAME lock every accounting enqueue takes
 *   (`lockOrderForAccountingEnqueue`) — and DECLINES any order that has live invoice work, reporting
 *   it. Under that lock "this order has no unposted invoice job" is a decided fact rather than a
 *   sampled one, and no enqueue can interleave between the check and the write.
 *
 * EVERY PRODUCER OF A DISCOUNT-DERIVED ACCOUNTING SNAPSHOT (o3d-y14 r2 finding 1).
 *
 * The first version of the fence was written as "fence the invoice queue", and that framing is what
 * let a producer through: the daily batch reads the same column, is not an invoice, and does not go
 * anywhere near `queueXeroSync`. So the question was re-asked as "what turns this column into
 * something an accountant will see", and answered exhaustively:
 *
 *   DIRECT readers of `SalesOrder.discountAmount`
 *   1. `queueSalesInvoiceForOrder` (app/actions/sales.ts) — SALES_INVOICE / SALES_INVOICE_UPDATE.
 *      Reads and builds the payload outside any lock. FENCED by `findStaleOrderLevelDiscount`.
 *   2. `importWcOrder` (order-import.ts) — SALES_INVOICE on import, from the value it just wrote.
 *      Same route, so FENCED by the same check.
 *   3. Xero daily batch Group A1 (`runDailyBatchSync`) — DAILY_BATCH_REVENUE_DEFERRAL, and the
 *      `unearnedRevenueAmount` stamp. Reads outside its transaction, writes via
 *      `createPendingSyncLog`, which never touches the queue helpers. FENCED by
 *      `assertRevenueDeferralsUnchanged`; orders with a live batch are additionally DECLINED here.
 *   4. QuickBooks daily batch Group A1 — identical twin of (3), fenced identically.
 *   5. `raiseChargebackForReversedOrder` (app/actions/sales.ts) — mirrors the order-level discount
 *      into a CREDIT_NOTE line. NOT a freshness fence, and that distinction is the whole of
 *      o3d-y14 r3 finding 1. An earlier round left this path alone on the argument that its job is
 *      to mirror WHAT THE INVOICE POSTED, so a drift check would report the same drift forever on
 *      every corrected order. The argument was right about the check and wrong about the
 *      consequence: the path did not read what the invoice posted, it read the LIVE COLUMN — so
 *      after a correction it silently omitted the invoice's discount leg and over-reversed AR and
 *      revenue by the cleared amount. It now RECOVERS the posted figure from the mirrored
 *      `AccountingEvent` for the document (`resolvePostedOrderDiscount`), and refuses to
 *      auto-raise a credit note when that figure disagrees with the order or cannot be read at
 *      all, naming both figures in the manual-handling alert. Refusing rather than reversing the
 *      recovered figure is deliberate: the manual ledger adjustment this backfill reports happens
 *      in the accounting system, so IMS cannot tell whether the document still holds the figure it
 *      posted with. That recovery is only REACHED for rows this script restated, and only decides
 *      anything because `applyWcCouponCorrection` writes a durable `discountRestatement` record in
 *      the same UPDATE as the amount: absence of a ledger trace is prunable and proves nothing,
 *      whereas that record is the one statement about the moment of the rewrite that survives
 *      (o3d-y14 r4 finding 1).
 *
 *   DERIVED readers — they consume `unearnedRevenueAmount` / `revenueRecognizedAmount` / a stored
 *   payload, all of which are RECORDS of a decision already taken. Group B recognition,
 *   `recreateMissingDailyBatchLogs`, the refund unearned-revenue reversal, `INVOICE_PAYMENT`
 *   follow-ups and the AccountingEvent mirror are all in this set. This backfill does not touch any
 *   of those columns, so it cannot make them stale — they were computed from the pre-correction
 *   amount and still faithfully record it. What it CAN do is leave them disagreeing with the
 *   corrected order, which is why `revenueDeferredBatchRef` and `unearnedRevenueAmount` are read
 *   live and reported. What is REPORTED about them is decided per document by
 *   `coupon-discount-ledger-handoff.ts` and not asserted here: an invoice posted without a discount
 *   account code never carried the duplicate at all and needs nothing done to it, and the deferral
 *   journal must be left alone because IMS recognises back out exactly what it deferred (r5 F1).
 *
 *   `queueAccountingSyncTx` carries no discount fence. No order-scoped SALES_INVOICE reaches it
 *   today (its order-scoped callers are COGS_REVERSAL and INVOICE_PAYMENT), but its type union
 *   permits one, so a future caller would arrive unfenced. Noted rather than pre-emptively guarded,
 *   because the guard belongs at the point a caller hoists the lock (o3d-3zgy).
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { addMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'
import { liveDailyBatchDeferralWhere } from '@/lib/domain/accounting/daily-batch-discount-fence'
import { buildDiscountRestatement } from '@/lib/domain/accounting/discount-restatement'

import { resolveWcOrderLevelDiscount } from './field-mapping'
import {
  buildWcCouponLedgerHandoff,
  isWcCouponOrderRefunded,
  wcCouponRemedySteps,
  wcCouponNetClaimSteps,
  type WcCouponLedgerHandoff,
  type WcCouponRefundEvidence,
} from './coupon-discount-ledger-handoff'

/** ActivityLog action written for every corrected order — the audit trail, not the guard. */
export const WC_COUPON_BACKFILL_ACTION = 'wc_coupon_order_discount_backfilled'

/**
 * ActivityLog action for the OTHER write this script can make: stamping a row the reviewer has
 * declared already correct, WITHOUT changing its amount. Distinct from the correction action
 * because it records a human's assertion rather than a computation.
 */
export const WC_COUPON_STAMP_ACTION = 'wc_coupon_order_discount_marked_correct'

/**
 * The `OrderDiscountModel` value the fixed WooCommerce importer stamps, and that this backfill stamps
 * on every row it corrects. Its presence is the DURABLE statement that `discountAmount` already holds
 * only the residual — it survives log pruning, and unlike a timestamp it does not need a cutoff to
 * interpret.
 */
export const WC_COUPON_DISCOUNT_MODEL = 'LINE_ALLOCATED'

/**
 * SALES_INVOICE work that could still post. PROCESSING is obvious; PENDING and FAILED are here because
 * a worker prefetches the row before claiming it, and FAILED rows stay eligible for "Retry All".
 * SYNCED and CANCELLED are terminal — no claim can succeed against them, so no worker can be holding a
 * snapshot it will still post.
 *
 * IT IS THE SHARED CONSTANT, not a local copy: `purgeExpiredData` exempts exactly this set from the
 * age-based delete. If the two ever drift, retention deletes a row a worker is still holding, this
 * count reads zero, and the correction is stamped while an understated invoice is on its way to the
 * ledger — the failure the count exists to prevent, reintroduced silently.
 */
export const LIVE_SALES_INVOICE_STATUSES = POSTABLE_ACCOUNTING_SYNC_STATUSES
export const SALES_INVOICE_SYNC_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

/**
 * Terminal statuses that mean a sales invoice REACHED the ledger.
 *
 * Read as well as `SalesOrder.accountingInvoiceId`, because the two can disagree and the disagreement
 * is not rare: o3d-9kek exists precisely because a row can post, receive its `externalTransactionId`,
 * and then fail to write the id back onto the order. An order in that state has a real invoice in
 * Xero and a NULL `accountingInvoiceId`, so an "is it posted?" question answered from the column
 * alone answers "no" about a document that exists.
 */
export const POSTED_SALES_INVOICE_STATUSES = ['SYNCED'] as const

/**
 * The canonical form of "which ledger documents exist for this order", used on BOTH sides of the
 * review→apply comparison (o3d-y14 r3 finding 2).
 *
 * Sorted and de-duplicated, because the comparison is between two SETS read at different times by
 * different queries, and neither Prisma nor PostgreSQL promises a stable order for either. An
 * unsorted comparison would refuse rows for a row-order difference — which reads to an operator
 * exactly like a real posting change, and is unfixable by re-running.
 */
export function sortedPostedInvoiceIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))].sort()
}

/**
 * CREDIT NOTES that reached the ledger, and the refund rows behind them (o3d-y14 r6 finding 1).
 *
 * The same two-source read the invoice side does, for the same o3d-9kek reason: a credit note can
 * post and fail to write its id onto the refund, so `accountingCreditNoteId` alone under-reports.
 * SYNCED is the terminal status that means the document reached the accounting system.
 */
export const CREDIT_NOTE_SYNC_TYPES = ['CREDIT_NOTE'] as const

/**
 * The canonical form of a refund position, used on BOTH sides of the review→apply comparison.
 *
 * Same reason as `sortedPostedInvoiceIds`: two sets read at different times by different queries,
 * and an unsorted comparison would refuse a row for a row-order difference that no re-run can fix.
 */
export function sortedWcCouponRefundEvidence(refunds: WcCouponRefundEvidence): WcCouponRefundEvidence {
  return {
    disposition: refunds.disposition,
    refundIds: sortedPostedInvoiceIds(refunds.refundIds),
    postedCreditNoteExternalIds: sortedPostedInvoiceIds(refunds.postedCreditNoteExternalIds),
    unresolvedRefundParkExternalIds: sortedPostedInvoiceIds(refunds.unresolvedRefundParkExternalIds ?? []),
  }
}

/** Is this the SAME refund position the reviewer saw? Compared field by field, in canonical form. */
export function sameWcCouponRefundEvidence(left: WcCouponRefundEvidence, right: WcCouponRefundEvidence): boolean {
  const a = sortedWcCouponRefundEvidence(left)
  const b = sortedWcCouponRefundEvidence(right)
  return (
    a.disposition === b.disposition &&
    a.refundIds.join('|') === b.refundIds.join('|') &&
    a.postedCreditNoteExternalIds.join('|') === b.postedCreditNoteExternalIds.join('|') &&
    // r7 finding 1. A park that appeared since the review changes the SAME decision the other three
    // signals change — from "raise a further invoice" to "prescribe nothing" — so it is compared on
    // exactly the same terms, and a park that RESOLVED since is a change too: the refund it stood
    // for has now landed as a real row the reviewer never saw.
    a.unresolvedRefundParkExternalIds.join('|') === b.unresolvedRefundParkExternalIds.join('|')
  )
}

/** Render a refund position for an operator message. */
export function describeWcCouponRefundEvidence(refunds: WcCouponRefundEvidence): string {
  const canonical = sortedWcCouponRefundEvidence(refunds)
  return (
    `refundStatus=${canonical.disposition}, refund(s) [${canonical.refundIds.join(', ')}], ` +
    `credit note(s) [${canonical.postedCreditNoteExternalIds.join(', ')}], ` +
    `unrecorded WooCommerce refund(s) [${canonical.unresolvedRefundParkExternalIds.join(', ')}]`
  )
}

/** `SalesOrder.refundStatus` as this backfill reads it. Anything unknown is treated as a refund. */
export function normalizeWcCouponRefundDisposition(value: unknown): WcCouponRefundEvidence['disposition'] {
  if (value === 'FULL') return 'FULL'
  if (value === 'PARTIAL') return 'PARTIAL'
  if (value === 'NONE' || value === null || value === undefined) return 'NONE'
  // A disposition this build does not know about is NOT read as "no refund": that is the one
  // conclusion an unrecognised value must not be able to produce, because it is the conclusion that
  // lets a remedy be prescribed against a refunded customer.
  return 'PARTIAL'
}

function money(value: DecimalInput): number {
  return roundQuantity(toDecimal(value), 4).toNumber()
}

export function sumLineDiscounts(lines: Array<{ discountAmount: DecimalInput }>): number {
  return money(lines.reduce((sum, line) => addMoney(sum, toDecimal(line.discountAmount)), toDecimal(0)))
}

// ---------------------------------------------------------------------------
// Bounding the scan (o3d-y14 r2 finding 3)
// ---------------------------------------------------------------------------

/**
 * How many candidate orders one page of the dry-run scan pulls.
 *
 * The scan is KEYSET-PAGED rather than loaded whole. The report is the step an operator runs first
 * and trusts, and an unbounded `findMany` over every WooCommerce order carrying a discount — with
 * its lines — is a query whose cost is set by the catalogue rather than by the defect. At the volume
 * this actually runs against (a few thousand discounted orders, ~70 of them defective) paging costs
 * a handful of extra round trips and nothing else; at ten times that it is the difference between a
 * report and an out-of-memory process.
 */
export const WC_COUPON_SCAN_PAGE_SIZE = 500

/**
 * How many ids go into one `IN (…)` list.
 *
 * Not a memory concern — a BIND PARAMETER one. The activity-log and sync-log lookups took a single
 * `{ in: orderIds }` over the WHOLE candidate set, and PostgreSQL's protocol caps a statement at
 * 65535 bound parameters. Past that the query does not run slowly, it FAILS — and it fails in the
 * report, which is the one phase an operator has no reason to expect can fail at all.
 */
export const WC_COUPON_ID_CHUNK_SIZE = 500

/**
 * The hard ceiling on candidates in one run.
 *
 * A limit that REFUSES beats a limit that TRUNCATES: a truncated report is a proposal that silently
 * omits orders, and the operator cannot tell an order that was examined and skipped from one that
 * was never looked at. Set far above any plausible real catalogue, so reaching it means the cutoff
 * or the filter is wrong, not that the estate grew.
 */
export const WC_COUPON_MAX_CANDIDATES = 100_000

export type WcCouponScanOutcome<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: 'TOO_MANY_CANDIDATES'; scanned: number }

/**
 * Walk the candidate scan one keyset page at a time, and REFUSE past the ceiling.
 *
 * It lives here rather than inline in the script so the ceiling can be tested at all: the script's
 * page fetcher is a Prisma query against a live database, so a loop written around it can only be
 * asserted by reading the source — and a source assertion cannot see an off-by-one. The first
 * revision of this loop checked the ceiling only BETWEEN full pages, so a final short page could
 * carry the total past it and leave through the exhausted-page break; the report would then look
 * complete while the refusal it was supposed to raise never fired. That is the exact class of bug a
 * grep-shaped test is blind to, which is why the walk is a function with its own cases below.
 *
 * The ceiling doubles as the loop's termination guard: a fetcher that keeps returning full pages
 * (a cursor that stops advancing, say) stops here rather than running forever.
 */
export async function collectWcCouponCandidates<T extends { id: string }>(
  fetchPage: (afterId: string | null) => Promise<T[]>,
  options: { pageSize?: number; max?: number } = {},
): Promise<WcCouponScanOutcome<T>> {
  const pageSize = options.pageSize ?? WC_COUPON_SCAN_PAGE_SIZE
  const max = options.max ?? WC_COUPON_MAX_CANDIDATES
  if (pageSize <= 0) throw new Error('collectWcCouponCandidates needs a positive page size')

  const rows: T[] = []
  let afterId: string | null = null
  for (;;) {
    const page = await fetchPage(afterId)
    rows.push(...page)
    // BEFORE the exhausted-page break, so a short final page cannot carry the total past the
    // ceiling unchallenged.
    if (rows.length > max) return { ok: false, reason: 'TOO_MANY_CANDIDATES', scanned: rows.length }
    if (page.length < pageSize) return { ok: true, rows }
    afterId = page[page.length - 1].id
  }
}

/** Split ids into `IN (…)`-sized batches. Empty in, empty out — never one empty batch. */
export function chunkWcCouponIds(ids: readonly string[], size = WC_COUPON_ID_CHUNK_SIZE): string[][] {
  if (size <= 0) throw new Error('chunkWcCouponIds needs a positive size')
  const batches: string[][] = []
  for (let index = 0; index < ids.length; index += size) {
    batches.push([...ids.slice(index, index + size)])
  }
  return batches
}

// ---------------------------------------------------------------------------
// o3d-9te — provenance
// ---------------------------------------------------------------------------

/** Why the meaning of a row's `discountAmount` could not be established from the evidence. */
export type WcCouponUnprovenReason = 'UNRECOGNISED_DISCOUNT_MODEL' | 'NO_IMPORT_TIMESTAMP' | 'NO_CUTOFF'

export type WcCouponProvenance =
  | { verdict: 'POST_FIX'; reason: 'DISCOUNT_MODEL_RECORDED' | 'IMPORTED_AFTER_CUTOFF'; detail: string }
  | { verdict: 'LEGACY'; reason: 'IMPORTED_BEFORE_CUTOFF'; detail: string }
  | { verdict: 'UNPROVEN'; reason: WcCouponUnprovenReason; detail: string }

/**
 * Which importer wrote this row's `discountAmount` — the ONLY question that decides whether the
 * arithmetic below is valid, because on a post-fix row it subtracts the line discounts a second time.
 *
 * WHAT THE SIGNALS ACTUALLY ARE, and why these and not others:
 *
 *   `discountModel` (o3d-9te) is the importer's own statement, written in the same INSERT that
 *   computed the amount. It is the primary signal because it is a recorded fact rather than an
 *   inference, it needs no operator-supplied cutoff to read, and it stays true if the deployment
 *   history is ever re-derived or the row is re-imported.
 *
 *   `importedAt` must be `ShoppingOrderLink.createdAt`, NOT `SalesOrder.createdAt`. The link row is
 *   created by `@default(now())` inside the same nested `salesOrder.create` as the discount, is never
 *   backdated, and is never rewritten — `updateExistingWcOrderFromPayload` refreshes only its
 *   external number and metadata. And a WooCommerce order's `discountAmount` is write-once: no
 *   update, updateMany, upsert or raw statement in the codebase touches it after the import, and the
 *   re-sync path deliberately leaves discounts and lines alone. So the link's creation time is not a
 *   proxy for when the value was written — it IS when the value was written. `SalesOrder.createdAt`
 *   is the proxy, and it is the one that fails: the initial import overwrites it with the historical
 *   Woo order date.
 *
 *   Deliberately NOT used: the raw WooCommerce payload. Comparing the stored amount against the
 *   source `coupon_lines[].discount` would settle it outright, but that payload is not durably
 *   retained — `shopping_webhook_events.payloadJson` is blanked after ~3 months and never exists for
 *   poll or initial-import orders at all. A discriminator that silently stops discriminating on older
 *   rows is the same mistake as `createdAt` in a new field.
 *
 * WHAT LEGACY DOES NOT MEAN. A `LEGACY` verdict is a CANDIDACY, not a licence. Two things it
 * cannot see: a row corrected by hand outside the application (still unmarked, still pre-cutoff),
 * and the interval in which the fixed importer ran WITHOUT stamping the marker. Both are correct
 * rows that this classifier calls legacy, and no field on the row distinguishes them — which is why
 * apply consumes a reviewed allowlist rather than this verdict.
 *
 * UNPROVEN is a real answer, not a failure. It means the evidence does not establish the meaning of
 * this row's amount, and the caller must report it rather than reinterpret it.
 */
export function classifyWcCouponProvenance(input: {
  /** `SalesOrder.discountModel` as stored. NULL means "not recorded", never "pre-fix". */
  discountModel: string | null
  /** `ShoppingOrderLink.createdAt` — when IMS imported the order. NOT `SalesOrder.createdAt`. */
  importedAt: Date | null
  /** The moment the o3d-y14 importer fix went live on this instance. */
  importedBefore: Date | null
}): WcCouponProvenance {
  if (input.discountModel === WC_COUPON_DISCOUNT_MODEL) {
    return {
      verdict: 'POST_FIX',
      reason: 'DISCOUNT_MODEL_RECORDED',
      detail: `the importer recorded discountModel=${WC_COUPON_DISCOUNT_MODEL}: the amount is already only the residual`,
    }
  }
  if (input.discountModel !== null) {
    // A model this build does not know about. Guessing what it means is exactly the failure mode
    // this whole classifier exists to prevent.
    return {
      verdict: 'UNPROVEN',
      reason: 'UNRECOGNISED_DISCOUNT_MODEL',
      detail: `discountModel=${input.discountModel} is not a model this backfill understands`,
    }
  }
  if (!input.importedAt) {
    return {
      verdict: 'UNPROVEN',
      reason: 'NO_IMPORT_TIMESTAMP',
      detail: 'no WooCommerce ShoppingOrderLink createdAt, so when IMS imported this order is unknown',
    }
  }
  if (!input.importedBefore) {
    return {
      verdict: 'UNPROVEN',
      reason: 'NO_CUTOFF',
      detail: 'no --imported-before cutoff supplied, so an unmarked row cannot be dated against the fix',
    }
  }
  if (input.importedAt.getTime() >= input.importedBefore.getTime()) {
    return {
      verdict: 'POST_FIX',
      reason: 'IMPORTED_AFTER_CUTOFF',
      detail: `imported ${input.importedAt.toISOString()}, at or after the fix went live ${input.importedBefore.toISOString()}`,
    }
  }
  return {
    verdict: 'LEGACY',
    reason: 'IMPORTED_BEFORE_CUTOFF',
    detail: `imported ${input.importedAt.toISOString()}, before the fix went live ${input.importedBefore.toISOString()}`,
  }
}

// ---------------------------------------------------------------------------
// The cutoff itself
// ---------------------------------------------------------------------------

/** No IMS instance existed before this; a cutoff older than it is a typo, not a deployment date. */
export const WC_COUPON_CUTOFF_FLOOR = new Date('2020-01-01T00:00:00.000Z')

/**
 * How close to the cutoff an import has to be for the cutoff CHOICE to be what decides it.
 * Rows inside this window are flagged for individual review: `development` shipped the fixed
 * importer WITHOUT the discountModel marker, so unmarked-but-correct rows exist in the interval
 * between the real rollout and whatever moment the operator can evidence.
 */
export const WC_COUPON_NEAR_CUTOFF_MS = 14 * 24 * 60 * 60 * 1000

export type WcCouponCutoffResult =
  | { ok: true; cutoff: Date }
  | {
      ok: false
      reason: 'AMBIGUOUS_FORMAT' | 'NOT_A_DATE' | 'IN_THE_FUTURE' | 'IMPLAUSIBLY_EARLY'
      detail: string
    }

/**
 * Parse `--imported-before` STRICTLY. Everything downstream of this value is a destructive
 * financial decision, so the only accepted spelling is an unambiguous ISO-8601 instant.
 *
 * `new Date(...)` accepts far too much: `2026-07-25` silently means UTC midnight (a different
 * moment from the local midnight the operator was thinking of, and imports land at all hours),
 * `July 25 2026` is implementation-defined, and a mistyped year parses fine. Every one of those
 * moves the boundary between "legacy" and "already correct" without saying so.
 */
export function parseWcCouponCutoff(raw: string, now: Date): WcCouponCutoffResult {
  const calendar = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw.trim())
  if (!calendar) {
    return {
      ok: false,
      reason: 'AMBIGUOUS_FORMAT',
      detail:
        `"${raw}" is not an unambiguous instant. Use YYYY-MM-DDTHH:MM(:SS)Z or an explicit offset ` +
        '(e.g. 2026-07-25T14:00:00Z). A bare date is read as UTC midnight, which is a different ' +
        'moment from the local midnight you probably mean — and every order imported in between ' +
        'is classified by that difference.',
    }
  }
  // V8 ROLLS OVER out-of-range days rather than rejecting them: `2026-02-31T…` silently becomes
  // 3 March, six days later than written. On this flag that is a moved boundary, so the calendar
  // date is validated by round-trip before the instant is trusted.
  const [, year, month, day] = calendar
  const calendarCheck = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (
    calendarCheck.getUTCFullYear() !== Number(year) ||
    calendarCheck.getUTCMonth() !== Number(month) - 1 ||
    calendarCheck.getUTCDate() !== Number(day)
  ) {
    return { ok: false, reason: 'NOT_A_DATE', detail: `"${raw}" is not a real calendar date` }
  }
  const cutoff = new Date(raw.trim())
  if (Number.isNaN(cutoff.getTime())) {
    return { ok: false, reason: 'NOT_A_DATE', detail: `"${raw}" is not a real date` }
  }
  if (cutoff.getTime() > now.getTime()) {
    return {
      ok: false,
      reason: 'IN_THE_FUTURE',
      detail:
        `${cutoff.toISOString()} is in the future, which would classify EVERY unmarked order as ` +
        'legacy — including everything the fixed importer wrote.',
    }
  }
  if (cutoff.getTime() < WC_COUPON_CUTOFF_FLOOR.getTime()) {
    return {
      ok: false,
      reason: 'IMPLAUSIBLY_EARLY',
      detail: `${cutoff.toISOString()} predates ${WC_COUPON_CUTOFF_FLOOR.toISOString()}, so it is a typo`,
    }
  }
  return { ok: true, cutoff }
}

// ---------------------------------------------------------------------------
// THE COMMAND LINE (o3d-y14 r9 finding 3)
// ---------------------------------------------------------------------------

/**
 * PARSE THIS SCRIPT'S FLAGS STRICTLY, and REFUSE anything not exactly understood.
 *
 * THE DEFECT. The script read its flags with `argv[argv.indexOf('--' + name) + 1] ?? null`, which
 * cannot tell a flag from its own value or a missing value from an absent flag. Every failure it
 * produces is SILENT and lands on the mode selection:
 *
 *   • `--apply --reprint` — `--reprint` has nothing after it, so it reads as absent, the read-only
 *     branch that is deliberately checked FIRST and made mutually exclusive with `--apply` is never
 *     entered, and the run WRITES. The operator asked for the mode that cannot write and got the one
 *     that does.
 *   • `--reprint --apply` — `--reprint`'s "value" is the literal string `--apply`, so the run tries
 *     to open a file called `--apply` and, having consumed it as a value, does not see the apply
 *     flag either.
 *   • `--allowlist-out` with nothing after it — the proposal file the operator believes they just
 *     produced is never written, and the report otherwise looks identical.
 *   • `--imported-before` with nothing after it — the cutoff silently becomes "none", which
 *     classifies every unstamped order as UNPROVEN. A read-only wrong answer, but it is the answer
 *     the whole reviewed allowlist is built from.
 *   • `--csv=out.csv`, `--reprnt list.json`, or a bare path with no flag at all — all ignored in
 *     silence, all leaving the operator with a run that did something other than what they typed.
 *
 * The identical shape was found on a sibling branch this session (`--write-log` with nothing after
 * it), so this parser is deliberately whole-surface rather than a patch to the one flag reported:
 * it validates EVERY flag the script accepts, rejects every token it does not recognise, and refuses
 * duplicates and `--flag=value` (which this script has never supported and silently dropped).
 *
 * REFUSAL IS ALWAYS RECOVERABLE: nothing has run, and the operator retypes the command.
 */
export const WC_COUPON_BOOLEAN_FLAGS = ['apply'] as const
export const WC_COUPON_VALUE_FLAGS = ['imported-before', 'csv', 'allowlist', 'allowlist-out', 'reprint'] as const

export type WcCouponCliFlags = {
  apply: boolean
  'imported-before': string | null
  csv: string | null
  allowlist: string | null
  'allowlist-out': string | null
  reprint: string | null
}

export type WcCouponCliParse = { ok: true; flags: WcCouponCliFlags } | { ok: false; detail: string }

const WC_COUPON_CLI_USAGE =
  'Usage: --imported-before <ISO instant> [--csv <path>] [--allowlist-out <path>] | ' +
  '--allowlist <path> --apply | --reprint <path>'

/**
 * @param argv the arguments AFTER the interpreter and script path (i.e. `process.argv.slice(2)`).
 */
export function parseWcCouponCliFlags(argv: readonly string[]): WcCouponCliParse {
  const booleans = new Set<string>(WC_COUPON_BOOLEAN_FLAGS)
  const values = new Set<string>(WC_COUPON_VALUE_FLAGS)
  const flags: WcCouponCliFlags = {
    apply: false,
    'imported-before': null,
    csv: null,
    allowlist: null,
    'allowlist-out': null,
    reprint: null,
  }
  const seen = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      return {
        ok: false,
        detail:
          `unexpected argument "${token}" — every input to this script is named by a flag, and a bare ` +
          `path is not read as one. ${WC_COUPON_CLI_USAGE}`,
      }
    }
    if (token.includes('=')) {
      return {
        ok: false,
        detail:
          `"${token}" uses --flag=value, which this script does not accept and used to IGNORE in ` +
          `silence. Write the value as the next argument instead. ${WC_COUPON_CLI_USAGE}`,
      }
    }
    const name = token.slice(2)
    if (!booleans.has(name) && !values.has(name)) {
      return {
        ok: false,
        detail: `unknown flag "${token}" — it would otherwise be ignored in silence. ${WC_COUPON_CLI_USAGE}`,
      }
    }
    if (seen.has(name)) {
      return {
        ok: false,
        detail:
          `"${token}" was given more than once, and only the FIRST would have been read — the second ` +
          'value would be dropped without a word',
      }
    }
    seen.add(name)

    if (booleans.has(name)) {
      flags.apply = true
      continue
    }

    const raw = argv[index + 1]
    if (raw === undefined) {
      return {
        ok: false,
        detail:
          `"${token}" needs a value and nothing follows it. It would otherwise read as ABSENT, which ` +
          'silently selects a different mode from the one you typed',
      }
    }
    if (raw.startsWith('--')) {
      return {
        ok: false,
        detail:
          `"${token}" needs a value and the next argument is the flag "${raw}". Reading that as the ` +
          `value would consume "${raw}" as well, so BOTH would be lost`,
      }
    }
    if (!raw.trim()) {
      return { ok: false, detail: `"${token}" was given an empty value` }
    }
    flags[name as (typeof WC_COUPON_VALUE_FLAGS)[number]] = raw
    index += 1
  }

  return { ok: true, flags }
}

/** Was this row's verdict decided by the cutoff choice rather than by a comfortable margin? */
export function isNearWcCouponCutoff(importedAt: Date | null, cutoff: Date | null): boolean {
  if (!importedAt || !cutoff) return false
  const delta = cutoff.getTime() - importedAt.getTime()
  return delta > 0 && delta <= WC_COUPON_NEAR_CUTOFF_MS
}

// ---------------------------------------------------------------------------
// The per-order decision
// ---------------------------------------------------------------------------

export type WcCouponBackfillRow = {
  orderId: string
  orderNumber: string
  externalOrderNumber: string
  currency: string
  /** `SalesOrder.discountAmount` as stored. */
  storedOrderDiscount: number
  /** Sum of `SalesOrderLine.discountAmount` — the coupon money the lines already carry. */
  lineDiscountTotal: number
  accountingInvoiceId: string | null
  /**
   * External ids of SYNCED sales-invoice jobs for this order (o3d-y14 r3 finding 2).
   *
   * NOT redundant with `accountingInvoiceId`, and the difference is the whole point: o3d-9kek is a
   * post that succeeded and then failed to write its id back, leaving a REAL Xero document here and
   * NULL in the column. Apply refuses a row whose posting state moved since review, so if the
   * report did not carry these ids the o3d-9kek shape would be re-proposed with the same evidence
   * forever and refused every time — a row that can never be applied and never be seen to be stuck.
   */
  postedInvoiceExternalIds: string[]
  discountModel: string | null
  importedAt: Date | null
  /** An earlier run already corrected this order (the ActivityLog marker). */
  alreadyBackfilled: boolean
  /** Non-terminal SALES_INVOICE / SALES_INVOICE_UPDATE rows for this order (o3d-5ct). */
  liveInvoiceJobs: number
  /**
   * `SalesOrder.revenueDeferredBatchRef` — the daily-batch Group A1 run that computed this order's
   * revenue deferral FROM the discount below, and stamped the result in `unearnedRevenueAmount`.
   * NULL means no batch has taken this order yet.
   */
  revenueDeferredBatchRef: string | null
  /**
   * Non-terminal DAILY_BATCH_REVENUE_DEFERRAL rows for THAT batch reference (o3d-y14 r2 finding 1).
   *
   * The batch is the second producer of a discount-derived accounting snapshot, and its rows are
   * keyed on the batch, not on the order — so an order-scoped count never sees them. A live one
   * means a worker can still post a GL journal built from the pre-correction amount.
   */
  liveBatchDeferralJobs: number
  /**
   * WHAT HAS ALREADY BEEN CREDITED BACK (o3d-y14 r6 finding 1).
   *
   * It changes no decision about the AMOUNT — the duplicated coupon is duplicated whether or not the
   * order was refunded, and clearing it is right either way — but it decides what the operator may
   * be told to do about the documents, so it is on the row the reviewer sees and in the entry apply
   * re-verifies.
   */
  refunds: WcCouponRefundEvidence
}

export type WcCouponBackfillDecision =
  | {
      action: 'CORRECT'
      /** The full coupon this run read, which the write is compare-and-set against. */
      couponTotal: number
      lineDiscountTotal: number
      /** The genuine order-level residual that must SURVIVE. Normally zero. */
      keptOrderLevel: number
      /** How much of the order-level slot is duplicate and gets cleared. */
      clearedBy: number
      /** keptOrderLevel > 0 — an unmodelled coupon shape worth inspecting individually. */
      partial: boolean
    }
  | { action: 'SKIP'; reason: 'ALREADY_BACKFILLED' | 'POST_FIX_IMPORT' | 'NOTHING_DUPLICATED'; detail: string }
  | { action: 'UNPROVEN'; reason: WcCouponUnprovenReason; detail: string }
  | { action: 'BLOCKED'; reason: 'LIVE_INVOICE_QUEUED' | 'LIVE_BATCH_QUEUED'; detail: string }

/**
 * What to do about ONE order.
 *
 * PROVENANCE IS DECIDED BEFORE THE ARITHMETIC, on purpose. The subtraction below is only meaningful
 * on a pre-fix row: fed a corrected one it reads the residual as though it were the coupon total and
 * eats it (10 -> 6 -> 2 -> 0 over three runs). Running the classifier first is what stops a row that
 * was ALREADY correctly fixed from being "corrected" again.
 */
export function decideWcCouponBackfill(
  row: WcCouponBackfillRow,
  options: { importedBefore: Date | null },
): WcCouponBackfillDecision {
  if (row.alreadyBackfilled) {
    return { action: 'SKIP', reason: 'ALREADY_BACKFILLED', detail: 'corrected by an earlier run' }
  }

  const provenance = classifyWcCouponProvenance({
    discountModel: row.discountModel,
    importedAt: row.importedAt,
    importedBefore: options.importedBefore,
  })
  if (provenance.verdict === 'POST_FIX') {
    return { action: 'SKIP', reason: 'POST_FIX_IMPORT', detail: provenance.detail }
  }
  if (provenance.verdict === 'UNPROVEN') {
    return { action: 'UNPROVEN', reason: provenance.reason, detail: provenance.detail }
  }

  const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
    couponTotalForeign: row.storedOrderDiscount,
    lineDiscountTotalForeign: row.lineDiscountTotal,
  })
  const clearedBy = money(row.storedOrderDiscount - orderLevelDiscount)
  if (clearedBy <= 0) {
    // The lines carry none of it, so nothing is duplicated. This is what a genuine order-level
    // discount looks like and touching it would erase real money.
    return {
      action: 'SKIP',
      reason: 'NOTHING_DUPLICATED',
      detail: `the line items carry ${row.lineDiscountTotal} of the ${row.storedOrderDiscount} order-level amount`,
    }
  }

  if (row.liveInvoiceJobs > 0) {
    // o3d-5ct. The queued payload is a SNAPSHOT the processors post from, and a worker may already
    // hold it. Correcting the order here would record it as fixed while an understated invoice is
    // still on its way to the ledger. Declining is recoverable; that is not.
    return {
      action: 'BLOCKED',
      reason: 'LIVE_INVOICE_QUEUED',
      detail: `${row.liveInvoiceJobs} unposted SALES_INVOICE job(s) still hold the old payload — re-run once the queue drains`,
    }
  }

  if (row.liveBatchDeferralJobs > 0) {
    // o3d-y14 r2 finding 1. Same argument, DIFFERENT producer: a Group A1 revenue-deferral journal
    // is a snapshot of `subtotal + shipping − this discount`, staged as its own DailyBatch-keyed row
    // that no order-scoped count can see. A worker holding it will post the pre-correction figure.
    return {
      action: 'BLOCKED',
      reason: 'LIVE_BATCH_QUEUED',
      detail:
        `${row.liveBatchDeferralJobs} unposted daily revenue-deferral journal(s) in batch ` +
        `${row.revenueDeferredBatchRef} were derived from the old amount — re-run once the batch posts`,
    }
  }

  return {
    action: 'CORRECT',
    couponTotal: row.storedOrderDiscount,
    lineDiscountTotal: row.lineDiscountTotal,
    keptOrderLevel: orderLevelDiscount,
    clearedBy,
    partial: orderLevelDiscount > 0,
  }
}

// ---------------------------------------------------------------------------
// The reviewed allowlist — apply's ONLY input
// ---------------------------------------------------------------------------

/**
 * ONE reviewed order: the identity, the evidence it was listed with, and the plan derived from that
 * evidence. Apply re-verifies every evidence field against the live row and RE-DERIVES the plan, so
 * a hand-edited number is a refusal rather than a silent instruction.
 */
export type WcCouponAllowlistEntry = {
  orderId: string
  orderNumber: string
  externalOrderNumber: string
  currency: string
  /** `SalesOrder.discountAmount` as the dry run read it. */
  storedOrderDiscount: number
  /** Sum of the line discounts as the dry run read it. */
  lineDiscountTotal: number
  /** `ShoppingOrderLink.createdAt` ISO string as the dry run read it. */
  importedAt: string | null
  /** The residual the dry run computed and the reviewer approved. Re-derived at apply time. */
  keptOrderLevel: number
  clearedBy: number
  partial: boolean
  accountingInvoiceId: string | null
  /**
   * The SYNCED sales-invoice external ids the dry run read, sorted (o3d-y14 r3 finding 2).
   *
   * This is what makes the o3d-9kek state REVIEWABLE rather than permanently stuck. The reviewer
   * sees "this order has a posted invoice that the column denies", decides with that in front of
   * them, and apply compares this reviewed set against the live one: unchanged means the reviewer
   * saw what is there and the correction proceeds (reporting the manual ledger adjustment);
   * changed means a document appeared or vanished since, which is a refusal exactly as before.
   */
  postedInvoiceExternalIds: string[]
  /**
   * `SalesOrder.revenueDeferredBatchRef` as the dry run read it. Carried for the SAME reason
   * `accountingInvoiceId` is: it names a second accounting artefact derived from the amount being
   * corrected, and apply refuses if it has moved since the review (o3d-y14 r2).
   */
  revenueDeferredBatchRef: string | null
  /**
   * WHAT WAS ALREADY CREDITED BACK when the reviewer looked (o3d-y14 r6 finding 1).
   *
   * Carried for the same reason `postedInvoiceExternalIds` is, and settling the same kind of
   * question: a refund that appears between the proposal and the run changes what the operator may
   * be told to do about this order's documents — from "raise a further invoice for the difference"
   * to "prescribe nothing, this customer has been refunded". The reviewer signed off on the first
   * of those; apply compares the refund position they saw against the live one and refuses if it
   * moved.
   */
  refunds: WcCouponRefundEvidence
  /** The cutoff CHOICE, not a comfortable margin, is what classified this row. Review each one. */
  nearCutoff: boolean
}

/**
 * The file a human reviews and apply consumes. Two lists, because "leave it alone" is not the only
 * safe answer for a row the arithmetic must not touch:
 *
 *   `clear`     — approved for the destructive correction.
 *   `stampOnly` — the reviewer asserts the amount is ALREADY the residual (a manual correction, or
 *                 an import from the markerless fixed-importer interval). Stamping records that
 *                 assertion durably, so no later run can ever re-derive the row. Nothing monetary
 *                 is written. This is why the workflow stamps BEFORE it clears: once stamped, a row
 *                 is excluded by evidence rather than by anyone remembering to exclude it.
 */
export type WcCouponAllowlist = {
  /**
   * BUMPED TO 2 by o3d-y14 r3 finding 2: entries now carry `postedInvoiceExternalIds`, which apply
   * compares against live state. A version-1 file has no such field, and defaulting it to `[]`
   * would assert on the reviewer's behalf that they saw no unlinked posted invoice — about the one
   * row where that is most likely to be false. So a v1 file is REFUSED with a version message and
   * the operator re-runs the report, which is a dry run and costs nothing.
   *
   * BUMPED TO 3 by o3d-y14 r6 finding 1, on exactly that argument: entries now carry the REFUND
   * position, and a version-2 file has none. Defaulting it to "not refunded" would assert on the
   * reviewer's behalf that no credit note stands against the order — and that is the assertion that
   * lets a remedy re-bill a customer who has already been refunded, so it is the one default this
   * file must never take. A v2 file is refused and the report re-run.
   *
   * BUMPED TO 4 by o3d-y14 r7 finding 1, on the same argument once more: entries now carry the
   * UNRESOLVED REFUND PARKS — WooCommerce refunds that arrived and could not be recorded, which
   * produce no refund row, no status change and no credit note. A version-3 file has none, and
   * defaulting it to "there are no parks" is exactly the assertion that let a parked refund be
   * classified as an unrefunded order and handed the full "raise a further invoice" remedy.
   */
  version: 4
  /** When the dry run produced the proposal. */
  generatedAt: string
  /** The cutoff the proposal was generated under, carried for the audit trail. */
  cutoff: string
  /** Apply refuses anything the reviewer has not explicitly signed. */
  reviewed: boolean
  reviewedBy: string | null
  reviewedAt: string | null
  stampOnly: WcCouponAllowlistEntry[]
  clear: WcCouponAllowlistEntry[]
}

export type WcCouponAllowlistParse =
  | { ok: true; allowlist: WcCouponAllowlist }
  | { ok: false; reason: 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'NOT_REVIEWED' | 'DUPLICATE_ORDER'; detail: string }

function isEntry(value: unknown): value is WcCouponAllowlistEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.orderId === 'string' &&
    entry.orderId.length > 0 &&
    typeof entry.storedOrderDiscount === 'number' &&
    typeof entry.lineDiscountTotal === 'number' &&
    typeof entry.keptOrderLevel === 'number' &&
    (typeof entry.importedAt === 'string' || entry.importedAt === null) &&
    // Required, not defaulted. An absent field would be indistinguishable from "no batch has taken
    // this order", and apply compares it against live state — so a missing one would silently mean
    // "the reviewer saw no deferral" about a row whose deferral was never shown to them.
    (typeof entry.revenueDeferredBatchRef === 'string' || entry.revenueDeferredBatchRef === null) &&
    // Same argument, and the same failure it would hide: an absent list would read as "the reviewer
    // saw no posted-but-unlinked invoice" (o3d-y14 r3 finding 2).
    Array.isArray(entry.postedInvoiceExternalIds) &&
    entry.postedInvoiceExternalIds.every((id) => typeof id === 'string') &&
    // r6 finding 1. Same argument once more, and the most expensive omission of the three: an
    // absent refund position would read as "the reviewer saw an order nobody had been refunded on",
    // and that is what turns an invoice discrepancy into an instruction to bill the customer again.
    isRefundEvidence(entry.refunds)
  )
}

function isRefundEvidence(value: unknown): value is WcCouponRefundEvidence {
  if (!value || typeof value !== 'object') return false
  const refunds = value as Record<string, unknown>
  return (
    (refunds.disposition === 'NONE' || refunds.disposition === 'PARTIAL' || refunds.disposition === 'FULL') &&
    Array.isArray(refunds.refundIds) &&
    refunds.refundIds.every((id) => typeof id === 'string') &&
    Array.isArray(refunds.postedCreditNoteExternalIds) &&
    refunds.postedCreditNoteExternalIds.every((id) => typeof id === 'string') &&
    // r7 finding 1. Required, not defaulted, on the same argument as the other three: an absent list
    // would read as "the reviewer saw no unrecorded refund against this order", and an unrecorded
    // refund is the one whose money has already left the business.
    Array.isArray(refunds.unresolvedRefundParkExternalIds) &&
    refunds.unresolvedRefundParkExternalIds.every((id) => typeof id === 'string')
  )
}

/**
 * Validate a reviewed allowlist. Everything here is a REFUSAL, never a repair: a file this cannot
 * fully understand is one a human's review cannot be trusted to describe.
 */
/**
 * `requireSignature: false` is for the READ-ONLY reprint path only (o3d-y14 r8 finding 4).
 *
 * The signature is what makes a file the ONLY thing that decides which posted invoices get
 * rewritten, so apply requires it and always will. `--reprint` writes nothing and decides nothing —
 * it re-runs a query and prints the answer — and refusing to answer a question until a file is
 * signed would just leave the operator without the position they were told to go and check. The
 * flag is explicit at every call site, so no future caller acquires the relaxation by default.
 */
export function parseWcCouponAllowlist(
  value: unknown,
  options: { requireSignature?: boolean } = {},
): WcCouponAllowlistParse {
  const requireSignature = options.requireSignature ?? true
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'MALFORMED', detail: 'the allowlist is not a JSON object' }
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 4) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_VERSION',
      detail:
        `version ${JSON.stringify(raw.version)} was not written by this build (expected 4). ` +
        'Re-run the dry run to regenerate the proposal — a version-3 file predates the PARKED refund ' +
        'evidence apply now compares against live state (o3d-y14 r7), a version-2 file predates the ' +
        'refund evidence entirely (o3d-y14 r6), and a version-1 file predates the posted-but-unlinked ' +
        'invoice evidence as well (o3d-y14 r3). None of those reviews can describe what apply must check.',
    }
  }
  const clear = raw.clear
  const stampOnly = raw.stampOnly
  if (!Array.isArray(clear) || !Array.isArray(stampOnly)) {
    return { ok: false, reason: 'MALFORMED', detail: 'both `clear` and `stampOnly` must be arrays' }
  }
  const bad = [...stampOnly, ...clear].find((entry) => !isEntry(entry))
  if (bad !== undefined) {
    return { ok: false, reason: 'MALFORMED', detail: `an entry is missing required evidence: ${JSON.stringify(bad)}` }
  }
  const signed = raw.reviewed === true && typeof raw.reviewedBy === 'string' && raw.reviewedBy.trim() !== ''
  if (requireSignature && !signed) {
    return {
      ok: false,
      reason: 'NOT_REVIEWED',
      detail:
        'the allowlist is not signed. Set "reviewed": true and "reviewedBy": "<name>" only after ' +
        'checking every entry against the deployment record and any manual corrections — this file ' +
        'is the ONLY thing that decides which posted invoices get rewritten.',
    }
  }
  const seen = new Set<string>()
  for (const entry of [...stampOnly, ...clear] as WcCouponAllowlistEntry[]) {
    if (seen.has(entry.orderId)) {
      return {
        ok: false,
        reason: 'DUPLICATE_ORDER',
        detail: `order ${entry.orderId} appears twice; which list wins would decide whether its amount changes`,
      }
    }
    seen.add(entry.orderId)
  }
  return {
    ok: true,
    allowlist: {
      version: 4,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      cutoff: typeof raw.cutoff === 'string' ? raw.cutoff : '',
      reviewed: signed,
      reviewedBy: signed ? (raw.reviewedBy as string) : null,
      reviewedAt: typeof raw.reviewedAt === 'string' ? raw.reviewedAt : null,
      stampOnly: stampOnly as WcCouponAllowlistEntry[],
      clear: clear as WcCouponAllowlistEntry[],
    },
  }
}

/** Build the proposal entry for a CORRECT decision — the row the reviewer will see. */
export function buildWcCouponAllowlistEntry(
  row: WcCouponBackfillRow,
  decision: Extract<WcCouponBackfillDecision, { action: 'CORRECT' }>,
  cutoff: Date | null,
): WcCouponAllowlistEntry {
  return {
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    externalOrderNumber: row.externalOrderNumber,
    currency: row.currency,
    storedOrderDiscount: row.storedOrderDiscount,
    lineDiscountTotal: row.lineDiscountTotal,
    importedAt: row.importedAt ? row.importedAt.toISOString() : null,
    keptOrderLevel: decision.keptOrderLevel,
    clearedBy: decision.clearedBy,
    partial: decision.partial,
    accountingInvoiceId: row.accountingInvoiceId,
    postedInvoiceExternalIds: sortedPostedInvoiceIds(row.postedInvoiceExternalIds),
    revenueDeferredBatchRef: row.revenueDeferredBatchRef,
    refunds: sortedWcCouponRefundEvidence(row.refunds),
    nearCutoff: isNearWcCouponCutoff(row.importedAt, cutoff),
  }
}

// ---------------------------------------------------------------------------
// o3d-5ct — the fenced write
// ---------------------------------------------------------------------------

/**
 * What the ACCOUNTING SYSTEM already holds for this order, read LIVE under the correction's own lock
 * (o3d-y14 r2 finding 2).
 *
 * This is the operator's only handoff for the part of the job software cannot do: clearing IMS's
 * field does not reach a document already in Xero, so every one of these needs a manual
 * credit/adjustment. It is therefore read at APPLY time and never taken from the reviewed file. The
 * allowlist decides WHICH ORDERS may be touched; it is not, and must not become, a source of truth
 * about their current state — the same principle that already governs the amount.
 */
export type WcCouponPostedEvidence = {
  /** `SalesOrder.accountingInvoiceId` as it stands at the moment of correction. */
  accountingInvoiceId: string | null
  /**
   * External ids of SYNCED sales-invoice rows for this order. Not redundant with the column above:
   * a post whose back-reference write failed leaves the id HERE and NULL there (o3d-9kek).
   */
  postedInvoiceExternalIds: string[]
  /** The Group A1 batch that deferred this order's revenue from the pre-correction amount. */
  revenueDeferredBatchRef: string | null
  /** What that batch stamped. Not recomputed by this backfill, so it stays stale until adjusted. */
  unearnedRevenueAmount: number | null
  /**
   * What has already been credited back against this order (o3d-y14 r6 finding 1). Read under the
   * SAME lock as everything else here, because the handoff derived from it decides whether an
   * operator is told to bill this customer again.
   */
  refunds: WcCouponRefundEvidence
}

export type WcCouponCorrectionResult =
  | {
      outcome: 'CORRECTED'
      posted: WcCouponPostedEvidence | null
      /**
       * WHAT THE OPERATOR MUST DO IN THE ACCOUNTING SYSTEM, derived per document rather than
       * asserted (o3d-y14 r5 finding 1). NULL when nothing is in the ledger for this order and there
       * is consequently no document to classify. See `coupon-discount-ledger-handoff.ts`.
       */
      handoff: WcCouponLedgerHandoff | null
    }
  | {
      outcome: 'DECLINED'
      reason:
        | 'ORDER_GONE'
        | 'VALUE_CHANGED'
        | 'LINES_CHANGED'
        | 'IMPORT_CHANGED'
        | 'PLAN_MISMATCH'
        | 'ALREADY_MARKED'
        | 'LIVE_INVOICE_QUEUED'
        | 'LIVE_BATCH_QUEUED'
        | 'POSTING_CHANGED'
      detail: string
    }

/**
 * Read the whole evidence set for one order under the lock, in one query.
 *
 * The link rows are ordered and taken exactly as the reporting query takes them, so "the import
 * timestamp" means the same thing in the proposal and in the re-verification.
 */
async function readLockedEvidence(tx: Prisma.TransactionClient, orderId: string) {
  return await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      discountAmount: true,
      discountModel: true,
      accountingInvoiceId: true,
      revenueDeferredBatchRef: true,
      unearnedRevenueAmount: true,
      // r6 finding 1. Both signals, because a SalesOrderRefund row can exist while the order's
      // summary column still reads NONE — the workflow writes the status, the row's existence does
      // not — and either one means a remedy derived from the invoice alone may re-bill a refunded
      // customer.
      refundStatus: true,
      refunds: { select: { id: true, accountingCreditNoteId: true } },
      lines: { select: { discountAmount: true } },
      shoppingLinks: {
        where: { connector: 'woocommerce' },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  })
}

/**
 * Everything the accounting system already holds for this order, read under the correction's lock.
 *
 * `order` is the row this transaction has ALREADY read under that lock — passed in rather than
 * re-read, so the evidence reported and the evidence decided on are literally the same read.
 */
async function readLivePostedEvidence(
  tx: Prisma.TransactionClient,
  orderId: string,
  order: {
    accountingInvoiceId: string | null
    revenueDeferredBatchRef: string | null
    unearnedRevenueAmount: unknown
    // REQUIRED, not optional. An optional refund read is one a caller can omit by accident, and the
    // omission would read as "this order was never refunded" — the assertion r6 finding 1 is about.
    refundStatus: unknown
    refunds: Array<{ id: string; accountingCreditNoteId: string | null }>
  },
): Promise<WcCouponPostedEvidence> {
  const syncedInvoices = await tx.accountingSyncLog.findMany({
    where: {
      referenceType: 'SalesOrder',
      referenceId: orderId,
      type: { in: [...SALES_INVOICE_SYNC_TYPES] },
      status: { in: [...POSTED_SALES_INVOICE_STATUSES] },
      externalTransactionId: { not: null },
    },
    select: { externalTransactionId: true },
  })
  return {
    accountingInvoiceId: order.accountingInvoiceId,
    postedInvoiceExternalIds: syncedInvoices
      .map((row) => row.externalTransactionId)
      .filter((id): id is string => !!id),
    revenueDeferredBatchRef: order.revenueDeferredBatchRef,
    unearnedRevenueAmount:
      order.unearnedRevenueAmount === null || order.unearnedRevenueAmount === undefined
        ? null
        : money(order.unearnedRevenueAmount as DecimalInput),
    refunds: await readLiveRefundEvidence(tx, orderId, order),
  }
}

/**
 * The refund position for one order, read under the same lock (o3d-y14 r6 finding 1).
 *
 * `order` is the row already read under that lock, so the disposition and the refund rows are the
 * same read the correction decides on. Only the CREDIT-NOTE ids cost an extra query, and only when
 * refunds exist at all — an unrefunded order (which is nearly all of them) issues none.
 */
async function readLiveRefundEvidence(
  tx: Prisma.TransactionClient,
  orderId: string,
  order: {
    refundStatus: unknown
    refunds: Array<{ id: string; accountingCreditNoteId: string | null }>
  },
): Promise<WcCouponRefundEvidence> {
  const rows = order.refunds
  const refundIds = [...new Set(rows.map((refund) => refund.id))].sort()
  const disposition = normalizeWcCouponRefundDisposition(order.refundStatus)
  // THE PARKS ARE READ UNCONDITIONALLY (r7 finding 1), and BEFORE the early return below — a park
  // is precisely the shape that exists when there is no SalesOrderRefund row, so short-circuiting on
  // "no refund rows" is what made a parked refund read as an unrefunded order. It is also read under
  // this same lock, which makes it decisive rather than a sample: `upsertRefundPark` takes
  // `SELECT ... FOR UPDATE` on this very order row before it writes, so a park either commits before
  // us and is seen, or after us, against an order whose handoff already records what it was derived
  // from.
  const parks = await readWcCouponRefundParks(tx, orderId)
  if (refundIds.length === 0) {
    return { disposition, refundIds, postedCreditNoteExternalIds: [], unresolvedRefundParkExternalIds: parks }
  }
  // BOTH sources, exactly as the invoice side reads both: the back-reference column can be NULL on
  // a credit note that really did post (o3d-9kek), and a SYNCED row with an external id is that
  // document however the column reads.
  const syncedCreditNotes = await tx.accountingSyncLog.findMany({
    where: {
      referenceType: 'SalesOrderRefund',
      referenceId: { in: refundIds },
      type: { in: [...CREDIT_NOTE_SYNC_TYPES] },
      status: { in: [...POSTED_SALES_INVOICE_STATUSES] },
      externalTransactionId: { not: null },
    },
    select: { externalTransactionId: true },
  })
  return {
    disposition,
    refundIds,
    postedCreditNoteExternalIds: sortedPostedInvoiceIds([
      ...rows.map((refund) => refund.accountingCreditNoteId),
      ...syncedCreditNotes.map((row) => row.externalTransactionId),
    ]),
    unresolvedRefundParkExternalIds: parks,
  }
}

/**
 * WOOCOMMERCE REFUNDS THAT ARRIVED AND COULD NOT BE RECORDED (o3d-y14 r7 finding 1).
 *
 * THE PREDICATE IS THE INDEX'S. `shopping_sync_logs_active_refund_park_uq` (migration
 * 20260721150000) is a partial unique index on exactly `connector = 'woocommerce' AND direction =
 * 'FROM_CONNECTOR' AND entityType = 'SalesOrder' AND status IN (PENDING, FAILED, QUARANTINED) AND
 * externalId IS NOT NULL AND entityId IS NOT NULL`, and `upsertRefundPark` matches it deliberately
 * "EXACTLY so this can never pick up an order-import failure log (same connector/type but no
 * entityId)". Copying that predicate rather than inventing a looser one is what keeps this from
 * counting an unrelated failed order import as a refund.
 *
 * WHY ALL THREE STATUSES, and not just QUARANTINED. Each means the refund is UNRESOLVED, and
 * unresolved is the whole point — the money left WooCommerce and IMS holds no refund row for it:
 *
 *   QUARANTINED  a deliberate refusal (a monetary-only refund on a non-uniformly-taxed order, o3d-iup).
 *                Operator-gated, so it can sit there indefinitely — the longest-lived of the three.
 *   FAILED       a refund whose sync failed and is still being retried.
 *   PENDING      one recorded as parked and not yet resolved.
 *
 * A refund that later LANDS resolves its park to SYNCED (`resolveActionableParks`), and SYNCED is
 * excluded here — so a resolved park correctly stops being a signal, and the SalesOrderRefund row it
 * became is picked up by the signal beside this one instead.
 */
export async function readWcCouponRefundParks(
  client: Pick<Prisma.TransactionClient, 'shoppingSyncLog'>,
  orderId: string,
): Promise<string[]> {
  const parks = await client.shoppingSyncLog.findMany({
    where: { ...WC_COUPON_REFUND_PARK_WHERE, entityId: orderId },
    select: { externalId: true },
  })
  return sortedPostedInvoiceIds(parks.map((park) => park.externalId))
}

/**
 * The park predicate, shared by the report (which reads them in bulk) and the apply-time read above,
 * so the reviewer is shown the same set apply compares against.
 */
export const WC_COUPON_REFUND_PARK_WHERE = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR',
  entityType: 'SalesOrder',
  status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
  externalId: { not: null },
} as const satisfies Prisma.ShoppingSyncLogWhereInput

/**
 * Does this evidence describe ANY accounting document derived from the pre-correction amount?
 *
 * It is the trigger for classifying the handoff, NOT the answer to "does a human have to do
 * something" — that answer is `WcCouponLedgerHandoff.needsAccountingAction`, and for a Xero invoice
 * posted without a discount account code it is NO (o3d-y14 r5 finding 1).
 */
export function wcCouponCorrectionNeedsLedgerAdjustment(posted: WcCouponPostedEvidence | null): boolean {
  if (!posted) return false
  return (
    !!posted.accountingInvoiceId ||
    posted.postedInvoiceExternalIds.length > 0 ||
    !!posted.revenueDeferredBatchRef ||
    // r6 finding 1. A CREDIT NOTE is a document derived from the pre-correction amount too, and an
    // order can carry one with no invoice evidence at all (the invoice's back-reference never
    // written, its sync row pruned). Without this the refunded order the handoff exists to protect
    // would be corrected with nothing said about the ledger at all.
    isWcCouponOrderRefunded(posted.refunds)
  )
}

/**
 * Correct ONE REVIEWED order, inside the caller's transaction, behind the sales-order row lock.
 *
 * THE FENCE (o3d-5ct). `lockSalesOrder` is a `SELECT ... FOR UPDATE` on the order row, and it is the
 * same lock `lockOrderForAccountingEnqueue` takes inside `queueXeroSync` / `queueQuickBooksSync`, and
 * that `queueAccountingSyncTx` refuses to run without. Taking it here serialises this correction
 * against every path that can enqueue a SALES_INVOICE for the order. So an enqueue either commits
 * BEFORE us — and we see its row and decline — or AFTER us, and snapshots the corrected amount.
 *
 * That is not sufficient on its own, and the missing half lives in `findStaleOrderLevelDiscount`:
 * the lock serialises the INSERT of a queue row, not the CONSTRUCTION of its payload, so an enqueue
 * that snapshotted the amount BEFORE we took the lock could still insert it afterwards. The enqueue
 * paths now re-read the order under that same lock and refuse a payload that disagrees with it.
 * Without that, this function's zero-live-jobs count is true and still insufficient.
 *
 * NOTHING IN THE QUEUE IS MUTATED. Patching a queued payload cannot be fenced from here at all,
 * because a worker reads the row before it conditionally claims it: it can be holding the old snapshot
 * while the row still reads PENDING. Re-checking status inside a transaction does not reach that
 * worker's memory. The only safe move is to leave the order alone and say so.
 *
 * RE-VERIFICATION, not re-decision. `entry` is what a human reviewed, so every evidence field on it
 * is compared against the live row and any drift is a REFUSAL — the reviewer approved a row in a
 * particular state, and a row that has moved since is a different row. The amount written is
 * RE-DERIVED from the live evidence rather than read from the file, so a hand-edited `keptOrderLevel`
 * cannot instruct a write; it can only cause a refusal.
 *
 * Every refusal is a REPORTED outcome, never a silent no-op, and every one of them is re-runnable:
 * nothing has been written, so a later dry run re-proposes the row for review.
 */
export async function applyWcCouponCorrection(
  tx: Prisma.TransactionClient,
  entry: WcCouponAllowlistEntry,
): Promise<WcCouponCorrectionResult> {
  await lockSalesOrder(tx, entry.orderId)

  const order = await readLockedEvidence(tx, entry.orderId)
  if (!order) {
    return { outcome: 'DECLINED', reason: 'ORDER_GONE', detail: 'the order was deleted after it was reviewed' }
  }
  if (order.discountModel !== null) {
    // Stamped since the report — by a re-import, by the stamp pass, or by a concurrent run. Either
    // way the amount is now declared to be the residual and re-deriving it would eat the residual.
    return {
      outcome: 'DECLINED',
      reason: 'ALREADY_MARKED',
      detail: `discountModel=${order.discountModel} was recorded after this row was reviewed`,
    }
  }
  const live = money(order.discountAmount)
  if (live !== entry.storedOrderDiscount) {
    return {
      outcome: 'DECLINED',
      reason: 'VALUE_CHANGED',
      detail: `discountAmount is ${live}, not the ${entry.storedOrderDiscount} that was reviewed`,
    }
  }
  const liveLines = sumLineDiscounts(order.lines)
  if (liveLines !== entry.lineDiscountTotal) {
    // The subtraction reads the lines, so a line edit since the review changes what the correction
    // MEANS even when the order-level amount is untouched.
    return {
      outcome: 'DECLINED',
      reason: 'LINES_CHANGED',
      detail: `the line items now carry ${liveLines}, not the ${entry.lineDiscountTotal} that was reviewed`,
    }
  }
  const liveImportedAt = order.shoppingLinks[0]?.createdAt?.toISOString() ?? null
  if (liveImportedAt !== entry.importedAt) {
    // The import timestamp is the provenance evidence itself. If it moved, the row was re-linked or
    // re-imported and the reviewer's dating of it no longer describes this row.
    return {
      outcome: 'DECLINED',
      reason: 'IMPORT_CHANGED',
      detail: `imported ${liveImportedAt ?? 'never'}, not ${entry.importedAt ?? 'never'} as reviewed`,
    }
  }
  const { orderLevelDiscount } = resolveWcOrderLevelDiscount({
    couponTotalForeign: live,
    lineDiscountTotalForeign: liveLines,
  })
  const keptOrderLevel = money(orderLevelDiscount)
  if (keptOrderLevel !== entry.keptOrderLevel) {
    // Only reachable when the file was edited by hand: the inputs matched, so the output must.
    return {
      outcome: 'DECLINED',
      reason: 'PLAN_MISMATCH',
      detail:
        `the reviewed residual ${entry.keptOrderLevel} is not what this evidence produces ` +
        `(${keptOrderLevel}) — the allowlist decides WHICH orders, never WHAT is written`,
    }
  }

  // Re-counted UNDER THE LOCK, so this is the decided state and not a sample: no enqueue can commit
  // between this count and the update below.
  const liveInvoiceJobs = await tx.accountingSyncLog.count({
    where: {
      referenceType: 'SalesOrder',
      referenceId: entry.orderId,
      type: { in: [...SALES_INVOICE_SYNC_TYPES] },
      status: { in: [...LIVE_SALES_INVOICE_STATUSES] },
    },
  })
  if (liveInvoiceJobs > 0) {
    return {
      outcome: 'DECLINED',
      reason: 'LIVE_INVOICE_QUEUED',
      detail: `${liveInvoiceJobs} unposted SALES_INVOICE job(s) hold a payload snapshot built from the old amount`,
    }
  }

  // The OTHER producer (o3d-y14 r2 finding 1). Counted here too, and under the same lock, because a
  // Group A1 journal is keyed on its batch rather than on this order — so the count above is
  // structurally incapable of seeing one, however correct it is about invoices.
  const liveBatchDeferralJobs = order.revenueDeferredBatchRef
    ? await tx.accountingSyncLog.count({ where: liveDailyBatchDeferralWhere([order.revenueDeferredBatchRef]) })
    : 0
  if (liveBatchDeferralJobs > 0) {
    return {
      outcome: 'DECLINED',
      reason: 'LIVE_BATCH_QUEUED',
      detail:
        `${liveBatchDeferralJobs} unposted daily revenue-deferral journal(s) in batch ` +
        `${order.revenueDeferredBatchRef} were derived from the old amount`,
    }
  }

  // POSTING STATE IS READ LIVE, and drift since the review is a REFUSAL (o3d-y14 r2 finding 2).
  //
  // The reviewer's decision was not only "is this amount wrong" — it was "is it worth rewriting a
  // figure whose consequences I can see". An invoice queued after the proposal and posted before
  // this run changes that second half completely: the order acquires a ledger document that will
  // now permanently understate, and a reviewer who approved an UNPOSTED row never agreed to that.
  // Reporting it afterwards is not enough, because by then the correction has happened.
  //
  // Both signals are read, not just the column: o3d-9kek showed a post can succeed and still fail to
  // write its id back, so a SYNCED invoice row with no `accountingInvoiceId` is a real document that
  // the column denies. Refusing is fully recoverable — the next report re-proposes the row WITH the
  // posting evidence attached, and the reviewer decides again knowing what it now costs.
  const posted = await readLivePostedEvidence(tx, entry.orderId, order)
  if (posted.accountingInvoiceId !== entry.accountingInvoiceId) {
    return {
      outcome: 'DECLINED',
      reason: 'POSTING_CHANGED',
      detail:
        `the accounting invoice is now ${posted.accountingInvoiceId ?? 'none'}, not the ` +
        `${entry.accountingInvoiceId ?? 'none'} this row was reviewed with`,
    }
  }
  if (posted.revenueDeferredBatchRef !== entry.revenueDeferredBatchRef) {
    return {
      outcome: 'DECLINED',
      reason: 'POSTING_CHANGED',
      detail:
        `the revenue-deferral batch is now ${posted.revenueDeferredBatchRef ?? 'none'}, not the ` +
        `${entry.revenueDeferredBatchRef ?? 'none'} this row was reviewed with`,
    }
  }
  // THE UNLINKED-INVOICE EVIDENCE IS COMPARED AS A SET, not asserted to be empty (o3d-y14 r3
  // finding 2). The first revision refused whenever an unposted-looking row turned out to have a
  // SYNCED invoice — which is right about the race, and wrong about the o3d-9kek STATE. In that
  // state the invoice posted and its id was never written back, so `accountingInvoiceId` is
  // permanently NULL and the report (which read only that column) re-proposed the row with exactly
  // the evidence that had already been refused. The row could never be applied and never be seen to
  // be stuck; the operator's only route was a separate back-reference repair they had no reason to
  // know was required.
  //
  // Carrying the ids through the proposal makes the state REVIEWABLE instead. The reviewer is shown
  // the posted-but-unlinked document, decides with it in front of them, and this compares the set
  // they saw against the set that exists now: unchanged means their decision still describes this
  // order, and the correction proceeds with the manual ledger adjustment reported. A document that
  // appeared or vanished since is still a refusal, which is what the check was for.
  const livePostedIds = sortedPostedInvoiceIds(posted.postedInvoiceExternalIds)
  const reviewedPostedIds = sortedPostedInvoiceIds(entry.postedInvoiceExternalIds)
  if (livePostedIds.join('|') !== reviewedPostedIds.join('|')) {
    return {
      outcome: 'DECLINED',
      reason: 'POSTING_CHANGED',
      detail:
        `the SYNCED sales invoice(s) for this order are now [${livePostedIds.join(', ')}], not the ` +
        `[${reviewedPostedIds.join(', ')}] this row was reviewed with — a ledger document is real ` +
        'even when accountingInvoiceId denies it (o3d-9kek). Re-run the report to review it again.',
    }
  }

  // THE REFUND POSITION IS COMPARED THE SAME WAY (o3d-y14 r6 finding 1).
  //
  // A refund raised between the proposal and this run does not change whether the amount is wrong —
  // it changes what may be DONE about the documents derived from it. The reviewer approved a row
  // whose invoice discrepancy the operator would be told to invoice for; on the refunded version of
  // that same row the honest instruction is that no remedy may be prescribed at all. Those are
  // different decisions, so the reviewer has to make the second one. Refusing is fully recoverable:
  // the next report re-proposes the row WITH the refund evidence attached.
  //
  // AND THE COMPARISON IS DECISIVE, not a sample, for the same reason the invoice one is: refund
  // creation takes `lockSalesOrder` on this very row before it writes anything
  // (`lib/domain/sales/refund-service.ts`), so a refund either commits BEFORE us — and we see it and
  // refuse — or AFTER us, against an order whose handoff already records the position it was derived
  // from.
  if (!sameWcCouponRefundEvidence(posted.refunds, entry.refunds)) {
    return {
      outcome: 'DECLINED',
      reason: 'POSTING_CHANGED',
      detail:
        `the refund position for this order is now ${describeWcCouponRefundEvidence(posted.refunds)}, ` +
        `not the ${describeWcCouponRefundEvidence(entry.refunds)} this row was reviewed with — a ` +
        'credit note against this order decides whether any invoice remedy may be prescribed at all ' +
        '(o3d-y14 r6). Re-run the report to review it again.',
    }
  }

  // Compare-and-set as well as locked. The lock covers the enqueue paths; this covers anything that
  // reaches the row without taking it, and it stamps the model in the SAME write so a row can never
  // be corrected without also being marked.
  // THE RESTATEMENT RECORD IS WRITTEN IN THIS SAME UPDATE (o3d-y14 r4 finding 1).
  //
  // It is the only durable statement that this row's order-level discount was REWRITTEN, and of what
  // the ledger held when it was. `raiseChargebackForReversedOrder` needs both: a chargeback must
  // reverse what the invoice charged, and for these rows the column deliberately no longer says it.
  //
  // Its ABSENCE has to keep meaning "never restated", which is why it is not a second statement made
  // afterwards: the ActivityLog entry below is pruned at 30 days, and a marker written in a later
  // step would leave a window in which a restated row looks untouched. One UPDATE, or neither.
  //
  // `discountModel: null` in the predicate already excludes an already-restated row (the two columns
  // only ever move together, here), so no JSON predicate is needed to make this write-once.
  const restatement = buildDiscountRestatement({
    reason: 'o3d-y14-wc-coupon',
    at: new Date(),
    from: live,
    to: keptOrderLevel,
    currency: entry.currency,
    ledger: {
      // The evidence read LIVE under this lock, not the reviewed file's copy of it — the same
      // reason the ActivityLog entry below is written from `posted`.
      accountingInvoiceId: posted.accountingInvoiceId,
      postedInvoiceExternalIds: sortedPostedInvoiceIds(posted.postedInvoiceExternalIds),
      revenueDeferredBatchRef: posted.revenueDeferredBatchRef,
    },
  })
  const written = await tx.salesOrder.updateMany({
    where: { id: entry.orderId, discountAmount: entry.storedOrderDiscount, discountModel: null },
    data: {
      discountAmount: keptOrderLevel,
      discountModel: WC_COUPON_DISCOUNT_MODEL,
      discountRestatement: restatement,
    },
  })
  if (written.count !== 1) {
    return {
      outcome: 'DECLINED',
      reason: 'VALUE_CHANGED',
      detail: 'the order changed between the read and the write',
    }
  }

  // THE HANDOFF IS DERIVED, NOT ASSERTED (o3d-y14 r5 finding 1).
  //
  // Read AFTER the update and inside the same transaction, so the restatement record it is written
  // beside is already committed-to and the documents it names are the ones that existed at the
  // moment this amount was rewritten. It replays each connector's own posting rule over the payload
  // that was mirrored, through the SAME function the chargeback path uses, because "this invoice
  // needs a manual adjustment" is false for every Xero invoice enqueued without a discount account
  // code — that document never carried the duplicate, and telling an operator to credit it would
  // put a wrong entry in the ledger.
  const handoff = wcCouponCorrectionNeedsLedgerAdjustment(posted)
    ? await buildWcCouponLedgerHandoff(tx, {
        orderId: entry.orderId,
        currency: entry.currency,
        keptOrderLevel,
        evidence: posted,
      })
    : null

  await tx.activityLog.create({
    data: {
      entityType: 'SYNC',
      entityId: entry.orderId,
      action: WC_COUPON_BACKFILL_ACTION,
      tag: 'sync',
      level: 'INFO',
      description:
        `o3d-y14 backfill: order-level coupon ${entry.storedOrderDiscount} ${entry.currency} reduced to ` +
        `${keptOrderLevel} (${liveLines} already carried by the line items)` +
        // Written from the LIVE evidence, not from the reviewed file. This log is the durable record
        // of what still needs adjusting by hand, and a record of the state at REVIEW time would
        // describe a moment that has already passed. The classification travels with it: the
        // ActivityLog is what anyone reads back months later, and "needs a manual credit" recorded
        // against an invoice that was always correct is the r5 defect made permanent.
        (handoff
          ? ' — in the ledger as ' +
            [
              posted.accountingInvoiceId ? `invoice ${posted.accountingInvoiceId}` : null,
              posted.postedInvoiceExternalIds.length
                ? `unlinked invoice(s) ${posted.postedInvoiceExternalIds.join(', ')}`
                : null,
              posted.revenueDeferredBatchRef
                ? `revenue deferral ${posted.revenueDeferredBatchRef} of ${posted.unearnedRevenueAmount}`
                : null,
              // r6 finding 1: a credit note is a ledger document derived from the same amount, and
              // on this order it is the one that decides no remedy may be named.
              posted.refunds.postedCreditNoteExternalIds.length
                ? `credit note(s) ${posted.refunds.postedCreditNoteExternalIds.join(', ')}`
                : null,
              // r7 finding 1: not a ledger document, but the reason there may not be one — a refund
              // that arrived and could not be recorded. It belongs in the durable record for the
              // same reason the credit notes do: it is why this row carries no remedy.
              posted.refunds.unresolvedRefundParkExternalIds.length
                ? `unrecorded WooCommerce refund(s) ${posted.refunds.unresolvedRefundParkExternalIds.join(', ')}`
                : null,
            ]
              .filter(Boolean)
              .join(', ') +
            `. ${handoff.needsAccountingAction ? 'ACCOUNTING ACTION REQUIRED' : 'NO ACCOUNTING ACTION REQUIRED'} — ` +
            // The HEADLINE only. The full remedy is `metadata.handoffLines`, so this column stays a
            // sentence the activity feed can render while the durable record loses nothing.
            (handoff.lines[0] ?? '')
          : ''),
      metadata: {
        connector: 'woocommerce',
        couponTotal: entry.storedOrderDiscount,
        lineDiscountTotal: liveLines,
        keptOrderLevel,
        clearedBy: money(live - keptOrderLevel),
        posted: wcCouponCorrectionNeedsLedgerAdjustment(posted),
        accountingInvoiceId: posted.accountingInvoiceId,
        postedInvoiceExternalIds: posted.postedInvoiceExternalIds,
        revenueDeferredBatchRef: posted.revenueDeferredBatchRef,
        unearnedRevenueAmount: posted.unearnedRevenueAmount,
        // The DERIVED classification, kept as a field so the handoff can be re-read from the log
        // without re-parsing English.
        ledgerCase: handoff ? handoff.invoice.case : null,
        // r6 finding 1. WHY a row with a real invoice discrepancy carries no remedy is not
        // recoverable from `ledgerCase` alone — the case is the same either way — so the refund
        // position that suppressed it is recorded beside it.
        refundDisposition: posted.refunds.disposition,
        refundIds: posted.refunds.refundIds,
        postedCreditNoteExternalIds: posted.refunds.postedCreditNoteExternalIds,
        unresolvedRefundParkExternalIds: posted.refunds.unresolvedRefundParkExternalIds,
        refunded: handoff ? handoff.refunded : isWcCouponOrderRefunded(posted.refunds),
        // r7 findings 3 and 4. The DIRECTION of what was prescribed, as a field, so "which way did
        // this row point" is answerable from the log without re-reading English — and NULL is the
        // durable statement that nothing was prescribed at all. `creditNoteReversal` records what
        // the credit notes were derived to have reversed, or why that could not be established.
        remedyKind: handoff?.remedy ? handoff.remedy.kind : null,
        remedyAmount: handoff?.remedy ? handoff.remedy.amount : null,
        // r10 finding 1. WAS THE POSITION ACTUALLY NETTED? NULL is the durable statement that the
        // two sides were never compared — which `creditNoteReversal.ok` does NOT answer, because a
        // perfectly derivable credit-note side can still have its subtraction withdrawn (a
        // tax-inclusive invoice, several posted documents, two ledgers). Without this the log cannot
        // distinguish "the errors cancelled" from "nobody could tell".
        netPosition: handoff?.netPosition
          ? {
              postedDiscount: handoff.netPosition.postedDiscount,
              reversedAmount: handoff.netPosition.reversedAmount,
              net: handoff.netPosition.net,
              nettedAgainst: handoff.netPosition.nettedAgainst,
            }
          : null,
        creditNoteReversal: handoff
          ? {
              ok: handoff.reversal.ok,
              amount: handoff.reversal.ok ? handoff.reversal.amount : null,
              detail: handoff.reversal.detail,
              legs: handoff.reversal.legs,
            }
          : null,
        needsAccountingAction: handoff ? handoff.needsAccountingAction : false,
        handoffLines: handoff ? handoff.lines : null,
        discountModel: WC_COUPON_DISCOUNT_MODEL,
        importedAt: entry.importedAt,
        nearCutoff: entry.nearCutoff,
      },
    },
  })

  return { outcome: 'CORRECTED', posted, handoff }
}

/**
 * o3d-y14 r8 finding 4 — RE-DERIVE ONE ORDER'S HANDOFF, READ-ONLY, AFTER IT HAS BEEN CORRECTED.
 *
 * THE CLAIM THIS MAKES TRUE. Every refusal, every withdrawn remedy and the refund-netting fallback
 * all end in "re-run the report and nothing is lost". That was true of a row apply DECLINED — the
 * next scan re-proposes it — and FALSE of a row apply CORRECTED, which is precisely the row that
 * carries a handoff. A corrected order is stamped `discountModel` and marked in the ActivityLog, so
 * `decideWcCouponBackfill` answers SKIP for it and the report builds handoffs only for CORRECT rows.
 * The handoff an operator was told they could reproduce could not be reproduced by ANY invocation.
 *
 * So this is the reproduction path, and `--reprint <allowlist>` is the invocation the operator text
 * now names. It is the SAME derivation apply performs — the same live evidence read, the same
 * `buildWcCouponLedgerHandoff` — with no lock, no write and no allowlist re-verification, because it
 * decides nothing: it only re-answers "what does the ledger hold for this order, and what does that
 * mean now". Running it twice is running a query twice.
 *
 * WHAT `keptOrderLevel` MEANS IN EACH WORLD, and why it is not read from the file. On an order this
 * run already corrected, `discountAmount` IS the residual and the marker says so. On one it has not
 * (a declined entry, or a reprint before apply) the residual is what the correction WOULD keep, so
 * it is re-derived from the live amount and lines exactly as `applyWcCouponCorrection` re-derives
 * it. The file's copy of the figure is never used for either — the allowlist decides WHICH orders,
 * never WHAT is reported, which is the same rule apply follows.
 */
export type WcCouponHandoffReprint =
  | { outcome: 'REPRINTED'; handoff: WcCouponLedgerHandoff | null; corrected: boolean; keptOrderLevel: number; detail: string }
  | { outcome: 'ORDER_GONE' }

export async function reprintWcCouponLedgerHandoff(
  client: Prisma.TransactionClient,
  order: { orderId: string; currency: string },
): Promise<WcCouponHandoffReprint> {
  const row = await readLockedEvidence(client, order.orderId)
  if (!row) return { outcome: 'ORDER_GONE' }

  const live = money(row.discountAmount)
  const liveLines = sumLineDiscounts(row.lines)
  const corrected = row.discountModel === WC_COUPON_DISCOUNT_MODEL
  const keptOrderLevel = corrected
    ? live
    : money(resolveWcOrderLevelDiscount({ couponTotalForeign: live, lineDiscountTotalForeign: liveLines }).orderLevelDiscount)

  const posted = await readLivePostedEvidence(client, order.orderId, row)
  const handoff = wcCouponCorrectionNeedsLedgerAdjustment(posted)
    ? await buildWcCouponLedgerHandoff(client, {
        orderId: order.orderId,
        currency: order.currency,
        keptOrderLevel,
        evidence: posted,
      })
    : null

  return {
    outcome: 'REPRINTED',
    handoff,
    corrected,
    keptOrderLevel,
    detail: corrected
      ? `this order was corrected by an earlier run (discountModel=${row.discountModel}); its ` +
        `discountAmount ${live} IS the residual it retains`
      : `this order has NOT been corrected: it still carries ${live} order-level against ${liveLines} ` +
        `on its lines, so the residual a correction would keep is ${keptOrderLevel}`,
  }
}

/**
 * o3d-y14 r7 finding 2 — A REMEDY THAT WAS TRUE AT COMMIT AND IS NOT TRUE NOW.
 *
 * THE DEFECT. `applyWcCouponCorrection` derives its handoff inside the correction transaction,
 * behind `lockSalesOrder`, and that lock is decisive for the moment the amount is rewritten: a
 * refund either commits before it and is seen, or after it. r6 called that "the best the transaction
 * boundary allows" and shipped it — but what the boundary protects is the RECORD, and what an
 * operator acts on is a LIVE DIRECTIONAL INSTRUCTION printed to a console and worked through by a
 * human minutes or hours later. A refund taking the same lock the instant after our transaction
 * commits leaves "raise a further invoice for 10 GBP" on the screen against a customer who has just
 * been refunded, and nothing revalidates it — not even before it is printed, because every
 * correction runs before anything is printed at all.
 *
 * WHAT THIS DOES, AND WHAT IT HONESTLY CANNOT. It re-reads the refund position OUTSIDE the
 * correction's transaction, immediately before the handoff is shown, and INVALIDATES any remedy
 * whose position has moved. That narrows the window from "the whole run" to "between this read and
 * that line reaching the operator's eye", which is as far as software on this side of a committed
 * transaction can go. The remainder is closed by `WcCouponRemedy`'s own precondition line, which
 * `wcCouponRemedySteps` prints FIRST and which no remedy can be rendered without: the operator is
 * told the exact position the instruction depends on and to re-check it before posting.
 *
 * SUPERSEDING IS NOT A REFUSAL. The amount has already been corrected and that correction is right
 * either way — the coupon was duplicated whatever happened afterwards. What is withdrawn is the
 * REMEDY, and `reprintWcCouponLedgerHandoff` re-derives the whole handoff against the new position.
 * NOT the report: the correction has committed, so every later scan SKIPS this order (o3d-y14 r8
 * finding 4) — that is the whole reason the reprint path exists.
 *
 * WHEN IT RUNS (r8 finding 4). Once per handoff, IMMEDIATELY BEFORE THAT HANDOFF'S OWN LINES ARE
 * PRINTED, not once for the batch before any of them are. The batch shape re-read order 1 and then
 * printed order 70 an unbounded number of queries later, which is the same "narrow the window"
 * argument applied to a window it was leaving open.
 */
export type WcCouponHandoffRevalidation =
  | { outcome: 'CURRENT'; handoff: WcCouponLedgerHandoff }
  | { outcome: 'SUPERSEDED'; handoff: WcCouponLedgerHandoff; detail: string }

export async function revalidateWcCouponHandoff(
  client: Pick<Prisma.TransactionClient, 'salesOrder' | 'accountingSyncLog' | 'shoppingSyncLog'>,
  orderId: string,
  handoff: WcCouponLedgerHandoff,
): Promise<WcCouponHandoffRevalidation> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: { refundStatus: true, refunds: { select: { id: true, accountingCreditNoteId: true } } },
  })
  if (!order) {
    return {
      outcome: 'SUPERSEDED',
      handoff: withdrawRemedy(
        handoff,
        'the order could not be re-read after the correction committed, so the refund position this ' +
          'remedy depends on cannot be confirmed',
      ),
      detail: 'order could not be re-read',
    }
  }

  const live = await readLiveRefundEvidence(client as Prisma.TransactionClient, orderId, order)
  if (sameWcCouponRefundEvidence(live, handoff.refunds)) {
    return { outcome: 'CURRENT', handoff }
  }
  const detail =
    `the refund position for this order is now ${describeWcCouponRefundEvidence(live)}, not the ` +
    `${describeWcCouponRefundEvidence(handoff.refunds)} this handoff was derived from — it moved ` +
    'AFTER the correction committed, so any remedy derived from the earlier position is withdrawn'
  return { outcome: 'SUPERSEDED', handoff: withdrawRemedy(handoff, detail), detail }
}

/**
 * Strip the remedy AND the netting conclusion, say why, and keep every FACT the handoff established.
 *
 * The facts are still true — what the invoice carries is a property of the invoice — and the
 * operator needs them to read the documents at all. Only the instruction is withdrawn, and
 * `needsAccountingAction` is forced TRUE because a position nobody can currently vouch for is
 * exactly a position a human has to look at.
 *
 * THE NETTING CONCLUSION GOES WITH IT (o3d-y14 r10 finding 1). A net is
 * `invoice - credit notes` against the refund position it was derived from; a refund arriving after
 * the correction committed is precisely a change to the credit-note side of that subtraction. The
 * conclusion is therefore no longer a netting that ran against the CURRENT position, and the zero
 * case is the dangerous one — "THE TWO ERRORS CANCEL … there is NO ACCOUNTING ACTION" is the line
 * that takes the order off the operator's list, and it survived every earlier withdrawal because
 * the block that stripped lines only ever stripped a remedy's. `wcCouponNetClaimSteps` is the sole
 * producer of those sentences, so removing its output removes all of them.
 */
function withdrawRemedy(handoff: WcCouponLedgerHandoff, detail: string): WcCouponLedgerHandoff {
  const withdrawn = new Set([
    ...(handoff.remedy ? wcCouponRemedySteps(handoff.remedy) : []),
    ...(handoff.netPosition ? wcCouponNetClaimSteps(handoff.netPosition) : []),
  ])
  if (withdrawn.size === 0) {
    return handoff.needsAccountingAction
      ? handoff
      : { ...handoff, needsAccountingAction: true, lines: [...handoff.lines, `SUPERSEDED: ${detail}.`] }
  }
  const what = handoff.remedy
    ? 'THE REMEDY PRINTED FOR THIS ORDER IS WITHDRAWN'
    : 'THE NETTED CONCLUSION PRINTED FOR THIS ORDER IS WITHDRAWN'
  return {
    ...handoff,
    remedy: null,
    netPosition: null,
    needsAccountingAction: true,
    lines: [
      ...handoff.lines.filter((line) => !withdrawn.has(line)),
      `${what}: ${detail}. Post NOTHING on the strength of it, and do not file this order as ` +
        'settled. Re-derive the position with `--reprint <allowlist>` — the correction has already ' +
        'committed, so a plain report will skip this order and print nothing for it.',
    ],
  }
}

/**
 * Record that an order's amount is ALREADY the residual, WITHOUT changing it.
 *
 * The reviewer asserts this for a row the arithmetic must never touch: one corrected by hand outside
 * the application, or imported by the fixed importer during the interval before it stamped the
 * marker. Stamping converts that assertion into the same durable evidence the importer writes, so
 * every later run reads it from the row instead of depending on anyone remembering — which is why
 * the workflow stamps FIRST and clears second.
 *
 * It is deliberately NOT the same function as the correction: it writes no monetary value, and it is
 * refused just as hard if the amount it was asserted about has since moved.
 */
export async function stampWcCouponDiscountModel(
  tx: Prisma.TransactionClient,
  entry: WcCouponAllowlistEntry,
): Promise<WcCouponCorrectionResult> {
  await lockSalesOrder(tx, entry.orderId)

  const order = await readLockedEvidence(tx, entry.orderId)
  if (!order) {
    return { outcome: 'DECLINED', reason: 'ORDER_GONE', detail: 'the order was deleted after it was reviewed' }
  }
  if (order.discountModel !== null) {
    return {
      outcome: 'DECLINED',
      reason: 'ALREADY_MARKED',
      detail: `discountModel=${order.discountModel} is already recorded`,
    }
  }
  const live = money(order.discountAmount)
  if (live !== entry.storedOrderDiscount) {
    return {
      outcome: 'DECLINED',
      reason: 'VALUE_CHANGED',
      detail: `discountAmount is ${live}, not the ${entry.storedOrderDiscount} that was reviewed as correct`,
    }
  }
  // THE WHOLE EVIDENCE SET, not just the amount (o3d-y14 r3 finding 3).
  //
  // The first revision compared `discountAmount` alone, on the reasoning that a stamp writes no
  // money so there is nothing to get wrong. That is backwards: the stamp is the MOST irreversible
  // write this script makes. A correction leaves the row re-proposable — a later report sees the
  // amount and re-derives it — but a stamp is precisely the evidence that excludes the row from
  // every future run, so a stamp placed on the wrong row can never be undone by re-running.
  //
  // And the reviewer's assertion is "this amount is ALREADY only the residual", which is a
  // statement about the amount RELATIVE TO THE LINES: an order whose lines changed between review
  // and apply can hold the same order-level figure and no longer be residual-only. The import
  // timestamp is the provenance the assertion was dated against. Both are compared here for exactly
  // the reasons `applyWcCouponCorrection` compares them, and a stamp is refused on either drift.
  const liveLines = sumLineDiscounts(order.lines)
  if (liveLines !== entry.lineDiscountTotal) {
    return {
      outcome: 'DECLINED',
      reason: 'LINES_CHANGED',
      detail:
        `the line items now carry ${liveLines}, not the ${entry.lineDiscountTotal} this row was ` +
        'reviewed as already-correct against',
    }
  }
  const liveImportedAt = order.shoppingLinks[0]?.createdAt?.toISOString() ?? null
  if (liveImportedAt !== entry.importedAt) {
    return {
      outcome: 'DECLINED',
      reason: 'IMPORT_CHANGED',
      detail: `imported ${liveImportedAt ?? 'never'}, not ${entry.importedAt ?? 'never'} as reviewed`,
    }
  }

  // NO `discountRestatement` HERE, deliberately (o3d-y14 r4 finding 1). That record means "this
  // row's order-level discount was rewritten"; a stamp rewrites nothing. Writing one would put an
  // untouched order onto the chargeback path's recover-the-posted-figure branch and make its credit
  // note depend on a mirrored event existing — for a row whose column has always been correct.
  const written = await tx.salesOrder.updateMany({
    where: { id: entry.orderId, discountAmount: entry.storedOrderDiscount, discountModel: null },
    data: { discountModel: WC_COUPON_DISCOUNT_MODEL },
  })
  if (written.count !== 1) {
    return {
      outcome: 'DECLINED',
      reason: 'VALUE_CHANGED',
      detail: 'the order changed between the read and the write',
    }
  }

  await tx.activityLog.create({
    data: {
      entityType: 'SYNC',
      entityId: entry.orderId,
      action: WC_COUPON_STAMP_ACTION,
      tag: 'sync',
      level: 'INFO',
      description:
        `o3d-y14 backfill: order-level discount ${live} ${entry.currency} was reviewed as ALREADY ` +
        `correct and stamped discountModel=${WC_COUPON_DISCOUNT_MODEL}. The amount was NOT changed; ` +
        'no later run can re-derive it.',
      metadata: {
        connector: 'woocommerce',
        storedOrderDiscount: live,
        lineDiscountTotal: liveLines,
        discountModel: WC_COUPON_DISCOUNT_MODEL,
        importedAt: entry.importedAt,
        amountChanged: false,
      },
    },
  })

  // `posted: null` — deliberately, and not "no documents exist". Stamping changes NO amount, so
  // nothing in the ledger has been made inconsistent and there is no manual adjustment to report.
  // Reporting posted documents here would put orders on the operator's must-fix list that this run
  // gave them no reason to fix. `handoff: null` follows for the same reason.
  return { outcome: 'CORRECTED', posted: null, handoff: null }
}
