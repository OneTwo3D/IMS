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
 */
import type { Prisma } from '@/app/generated/prisma/client'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { addMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'

import { resolveWcOrderLevelDiscount } from './field-mapping'

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

function money(value: DecimalInput): number {
  return roundQuantity(toDecimal(value), 4).toNumber()
}

export function sumLineDiscounts(lines: Array<{ discountAmount: DecimalInput }>): number {
  return money(lines.reduce((sum, line) => addMoney(sum, toDecimal(line.discountAmount)), toDecimal(0)))
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
  discountModel: string | null
  importedAt: Date | null
  /** An earlier run already corrected this order (the ActivityLog marker). */
  alreadyBackfilled: boolean
  /** Non-terminal SALES_INVOICE / SALES_INVOICE_UPDATE rows for this order (o3d-5ct). */
  liveInvoiceJobs: number
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
  | { action: 'BLOCKED'; reason: 'LIVE_INVOICE_QUEUED'; detail: string }

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
  version: 1
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
    (typeof entry.importedAt === 'string' || entry.importedAt === null)
  )
}

/**
 * Validate a reviewed allowlist. Everything here is a REFUSAL, never a repair: a file this cannot
 * fully understand is one a human's review cannot be trusted to describe.
 */
export function parseWcCouponAllowlist(value: unknown): WcCouponAllowlistParse {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'MALFORMED', detail: 'the allowlist is not a JSON object' }
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_VERSION',
      detail: `version ${JSON.stringify(raw.version)} was not written by this build`,
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
  if (raw.reviewed !== true || typeof raw.reviewedBy !== 'string' || raw.reviewedBy.trim() === '') {
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
      version: 1,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      cutoff: typeof raw.cutoff === 'string' ? raw.cutoff : '',
      reviewed: true,
      reviewedBy: raw.reviewedBy as string,
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
    nearCutoff: isNearWcCouponCutoff(row.importedAt, cutoff),
  }
}

// ---------------------------------------------------------------------------
// o3d-5ct — the fenced write
// ---------------------------------------------------------------------------

export type WcCouponCorrectionResult =
  | { outcome: 'CORRECTED' }
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

  // Compare-and-set as well as locked. The lock covers the enqueue paths; this covers anything that
  // reaches the row without taking it, and it stamps the model in the SAME write so a row can never
  // be corrected without also being marked.
  const written = await tx.salesOrder.updateMany({
    where: { id: entry.orderId, discountAmount: entry.storedOrderDiscount, discountModel: null },
    data: { discountAmount: keptOrderLevel, discountModel: WC_COUPON_DISCOUNT_MODEL },
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
      action: WC_COUPON_BACKFILL_ACTION,
      tag: 'sync',
      level: 'INFO',
      description:
        `o3d-y14 backfill: order-level coupon ${entry.storedOrderDiscount} ${entry.currency} reduced to ` +
        `${keptOrderLevel} (${liveLines} already carried by the line items)` +
        (entry.accountingInvoiceId
          ? ` — WARNING: already posted as ${entry.accountingInvoiceId}; the ledger document still understates.`
          : ''),
      metadata: {
        connector: 'woocommerce',
        couponTotal: entry.storedOrderDiscount,
        lineDiscountTotal: liveLines,
        keptOrderLevel,
        clearedBy: money(live - keptOrderLevel),
        posted: !!entry.accountingInvoiceId,
        accountingInvoiceId: entry.accountingInvoiceId,
        discountModel: WC_COUPON_DISCOUNT_MODEL,
        importedAt: entry.importedAt,
        nearCutoff: entry.nearCutoff,
      },
    },
  })

  return { outcome: 'CORRECTED' }
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
        lineDiscountTotal: sumLineDiscounts(order.lines),
        discountModel: WC_COUPON_DISCOUNT_MODEL,
        importedAt: entry.importedAt,
        amountChanged: false,
      },
    },
  })

  return { outcome: 'CORRECTED' }
}
