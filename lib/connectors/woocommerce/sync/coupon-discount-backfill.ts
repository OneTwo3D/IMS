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
 * TWO SAFETY PROPERTIES, ONE PER BLOCKING BUG:
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

import { resolveWcOrderLevelDiscount } from './field-mapping'

/** ActivityLog action written for every corrected order — the audit trail, not the guard. */
export const WC_COUPON_BACKFILL_ACTION = 'wc_coupon_order_discount_backfilled'

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
 */
export const LIVE_SALES_INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'FAILED'] as const
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
// o3d-5ct — the fenced write
// ---------------------------------------------------------------------------

export type WcCouponCorrectionResult =
  | { outcome: 'CORRECTED' }
  | {
      outcome: 'DECLINED'
      reason: 'ORDER_GONE' | 'VALUE_CHANGED' | 'ALREADY_MARKED' | 'LIVE_INVOICE_QUEUED'
      detail: string
    }

export type WcCouponCorrectionInput = {
  orderId: string
  currency: string
  /** The value this run planned against; the write is compare-and-set on it. */
  couponTotal: number
  lineDiscountTotal: number
  keptOrderLevel: number
  clearedBy: number
  accountingInvoiceId: string | null
}

/**
 * Correct ONE order, inside the caller's transaction, behind the sales-order row lock.
 *
 * THE FENCE (o3d-5ct). `lockSalesOrder` is a `SELECT ... FOR UPDATE` on the order row, and it is the
 * same lock `lockOrderForAccountingEnqueue` takes inside `queueXeroSync` / `queueQuickBooksSync`, and
 * that `queueAccountingSyncTx` refuses to run without. Taking it here serialises this correction
 * against every path that can enqueue a SALES_INVOICE for the order. So an enqueue either commits
 * BEFORE us — and we see its row and decline — or AFTER us, and snapshots the corrected amount. There
 * is no window in which a payload is built from the pre-correction value while we record the order as
 * fixed.
 *
 * NOTHING IN THE QUEUE IS MUTATED. Patching a queued payload cannot be fenced from here at all,
 * because a worker reads the row before it conditionally claims it: it can be holding the old snapshot
 * while the row still reads PENDING. Re-checking status inside a transaction does not reach that
 * worker's memory. The only safe move is to leave the order alone and say so.
 *
 * Every refusal is a REPORTED outcome, never a silent no-op, and every one of them is re-runnable:
 * nothing has been written, so a later run re-evaluates the row from scratch.
 */
export async function applyWcCouponCorrection(
  tx: Prisma.TransactionClient,
  input: WcCouponCorrectionInput,
): Promise<WcCouponCorrectionResult> {
  await lockSalesOrder(tx, input.orderId)

  const order = await tx.salesOrder.findUnique({
    where: { id: input.orderId },
    select: { id: true, discountAmount: true, discountModel: true },
  })
  if (!order) {
    return { outcome: 'DECLINED', reason: 'ORDER_GONE', detail: 'the order was deleted after it was reported' }
  }
  if (order.discountModel !== null) {
    // Stamped since the report — by a re-import, or by a concurrent run of this backfill. Either way
    // the amount is now declared to be the residual and re-deriving it would eat the residual.
    return {
      outcome: 'DECLINED',
      reason: 'ALREADY_MARKED',
      detail: `discountModel=${order.discountModel} was recorded after this run read the order`,
    }
  }
  const live = money(order.discountAmount)
  if (live !== input.couponTotal) {
    return {
      outcome: 'DECLINED',
      reason: 'VALUE_CHANGED',
      detail: `discountAmount is ${live}, not the ${input.couponTotal} this run planned against`,
    }
  }

  // Re-counted UNDER THE LOCK, so this is the decided state and not a sample: no enqueue can commit
  // between this count and the update below.
  const liveInvoiceJobs = await tx.accountingSyncLog.count({
    where: {
      referenceType: 'SalesOrder',
      referenceId: input.orderId,
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
    where: { id: input.orderId, discountAmount: input.couponTotal, discountModel: null },
    data: { discountAmount: input.keptOrderLevel, discountModel: WC_COUPON_DISCOUNT_MODEL },
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
      entityId: input.orderId,
      action: WC_COUPON_BACKFILL_ACTION,
      tag: 'sync',
      level: 'INFO',
      description:
        `o3d-y14 backfill: order-level coupon ${input.couponTotal} ${input.currency} reduced to ` +
        `${input.keptOrderLevel} (${input.lineDiscountTotal} already carried by the line items)` +
        (input.accountingInvoiceId
          ? ` — WARNING: already posted as ${input.accountingInvoiceId}; the ledger document still understates.`
          : ''),
      metadata: {
        connector: 'woocommerce',
        couponTotal: input.couponTotal,
        lineDiscountTotal: input.lineDiscountTotal,
        keptOrderLevel: input.keptOrderLevel,
        clearedBy: input.clearedBy,
        posted: !!input.accountingInvoiceId,
        accountingInvoiceId: input.accountingInvoiceId,
        discountModel: WC_COUPON_DISCOUNT_MODEL,
      },
    },
  })

  return { outcome: 'CORRECTED' }
}
