/**
 * THE INVOICE HELD BACK FOR A NUMBER, AND HOW IT GETS OUT AGAIN (o3d-k26m.6).
 *
 * o3d-k26m.1 established that a WooCommerce order with no `_wcpdf_invoice_number` must NOT be
 * posted: the sales-invoice create is update-or-create on the invoice number, so a stand-in number
 * cannot be corrected later — a second post under the real number creates a SECOND invoice rather
 * than replacing the first. That refusal is right and it stays.
 *
 * WHAT IT LEFT UNFINISHED. Holding back is only recoverable if something actually recovers. The
 * warning told an operator to "re-import the order once WooCommerce has numbered it", and the
 * re-import — a webhook redelivery, or the modified_after order poll, which sees the order again
 * precisely because writing the meta touches it — did capture the number onto the SalesOrder. But
 * nothing then queued the invoice. The order sat numbered, PROCESSING, and permanently
 * un-invoiced: the advertised remedy ran to completion and produced no invoice.
 *
 * HOW IT COMPLETES NOW. The importer builds the accounting payload exactly as it would have sent
 * it and PARKS it instead of discarding it, on a ShoppingSyncLog row keyed to the order — the same
 * shape the pending-FX queue already uses for orders held back for a missing exchange rate. When
 * the number arrives, the parked payload is stamped with it and enqueued.
 *
 * WHY PARK THE PAYLOAD RATHER THAN REBUILD IT. The payload is not a projection of the SalesOrder;
 * it carries the import's own decisions — the WooCommerce order's creation date as the invoice
 * date, reverse-charge tax-type swaps resolved per line, the coupon split between per-line and
 * order-level discount, and the payment-registration block (`_registerPayment`, method, date,
 * amount) that only the WooCommerce payload knows. Rebuilding it later from the order row would
 * post a DIFFERENT invoice from the one the import would have posted — a different date, and no
 * payment registered — which is a silent divergence between "imported before the number arrived"
 * and "imported after". Parking makes the two identical by construction.
 *
 * ONLY THE NUMBER IS ADDED ON RELEASE. Nothing else in the parked payload is recomputed, so a
 * settings change between hold and release cannot quietly alter what posts.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR } from '@/lib/domain/accounting/prior-posting-evidence'

/** Marks a ShoppingSyncLog row as a held sales invoice. Lives at `payload.reason`. */
export const MISSING_INVOICE_NUMBER_QUEUE_REASON = 'missing_wc_invoice_number'

/**
 * WHAT THIS ROW IS, in a column (o3d-xnwu r8, Codex HIGH).
 *
 * A hold shares connector, direction, `SalesOrder`, PENDING and a non-null `entityId` with a
 * WooCommerce refund park, so until r8 the two families were indistinguishable to any predicate
 * built out of this table's scalars — and both predicates were built out of them. The park's
 * inbox admitted holds, and this queue selected parks.
 *
 * THIS SIDE IS THE ONE THAT WRITES, so it is the more dangerous half.
 * `holdWcSalesInvoiceForMissingNumber` does a findFirst on {@link heldSalesInvoiceQueueWhere} and
 * UPDATES whatever it finds; `retryHeldWcSalesInvoiceReleases` rewrites the `errorMessage` of what
 * it finds. A refund park matched, because the only thing separating the two was
 * `payload.reason` — and a park's payload is the RAW WOOCOMMERCE REFUND, whose `reason` is free
 * text a human types when issuing it. So an operator who wrote `missing_wc_invoice_number` had
 * their park silently overwritten with an invoice payload, or its own error text replaced. That is
 * the o3d-xnwu r7 defect with the destination and the source swapped.
 */
export const HELD_SALES_INVOICE_RECORD_KIND = 'WC_HELD_SALES_INVOICE'

/**
 * THE THREE SENTENCES THE RELEASE SWEEP SETTLES A HOLD WITH (o3d-xnwu r9, Codex MEDIUM).
 *
 * Named here rather than typed inline at the three `update` calls, because verify.sql check 6
 * MATCHES ON THEM: a row that is not a hold carrying one of these messages was settled by a
 * predecessor whose queue predicate had no `recordKind` clause, and that has no legitimate
 * producer. A check that keys on a string literal and a writer that types one are two copies of the
 * same fact, and the copy in the migration cannot be recompiled — so the test asserts verify.sql
 * against THESE, and drifting the writer's wording turns it red rather than turning the check off.
 *
 * Every one of them is written ONLY to a row selected by {@link heldSalesInvoiceQueueWhere}, which
 * requires {@link HELD_SALES_INVOICE_RECORD_KIND}. That is the whole of check 6's forgery argument.
 */
export const HELD_SALES_INVOICE_ORDER_MISSING_MESSAGE =
  'The sales order this invoice was held for cannot be found, so it can never be released. Nothing was posted.'

/** The prefix — the rest names the ledger document, so the check matches on this much. */
export const HELD_SALES_INVOICE_SUPERSEDED_PREFIX = 'Superseded: this order already carries ledger document '

export const HELD_SALES_INVOICE_UNREADABLE_MESSAGE =
  'The held sales-invoice payload is unreadable, so the invoice cannot be released automatically — queue it from the order.'

export type HeldSalesInvoicePayload = {
  reason: typeof MISSING_INVOICE_NUMBER_QUEUE_REASON
  connector: 'woocommerce'
  externalOrderId: string
  externalOrderNumber: string
  salesOrderId: string
  orderNumber: string
  /** The meta key that was absent — so the row says what it is waiting for. */
  metaKey: string
  /** Everything the accounting connector needs EXCEPT `invoiceNumber`. */
  accountingPayload: Record<string, unknown>
}

/**
 * Select the held rows.
 *
 * PENDING, not FAILED: this is work waiting on an external event, not work that went wrong, and
 * FAILED-error dashboards must not treat a normal "not numbered yet" order as a fault. The same
 * distinction the pending-FX queue and the QUARANTINED refund status already draw.
 *
 * THE COLUMN IS WHAT SELECTS, THE PAYLOAD MARKER ONLY CONFIRMS (o3d-xnwu r8). `recordKind` is
 * written by this queue's own writer and by nothing else, so it is the clause a refund park cannot
 * satisfy however its `reason` happens to read. The `payload.reason` clause stays beside it, as the
 * pending-FX queue keeps its own: it is a POSITIVE assertion about a payload IMS built, and the
 * release still validates the whole shape with `isHeldSalesInvoicePayload` before touching it. What
 * it is no longer is the only thing standing between an operator's refund reason and a destructive
 * update.
 */
export function heldSalesInvoiceQueueWhere(params?: { salesOrderId?: string; externalOrderId?: string }): Prisma.ShoppingSyncLogWhereInput {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    recordKind: HELD_SALES_INVOICE_RECORD_KIND,
    ...(params?.salesOrderId ? { entityId: params.salesOrderId } : {}),
    ...(params?.externalOrderId ? { externalId: params.externalOrderId } : {}),
    payload: {
      path: ['reason'],
      equals: MISSING_INVOICE_NUMBER_QUEUE_REASON,
    },
  }
}

/**
 * The accounting sync row the release must actually SEE before it may call the invoice released
 * (o3d-k26m.6, Codex round 3).
 *
 * `queueAccountingSync` returns void and returns early — silently — when no accounting connector is
 * active, when the connector's sync is off, when this type's posting mode is off, or when the sales
 * order was deleted under it. Treating "it did not throw" as "it queued" marked the hold SYNCED for
 * an invoice that will never post, which is the very defect the hold exists to prevent.
 *
 * THE PREDICATE IS NOT A CHOICE. It is exactly what `queueAccountingSync`/`queueXeroSync` short-
 * circuit their idempotency key against, so "no row matches this" means "the next release would
 * create one". Widen it and a row nothing will retry reads as work in flight, closing the hold on an
 * invoice that will never post; narrow it and every poll would enqueue a duplicate.
 *
 * o3d-d0pd MOVED THAT PREDICATE, so this moved with it. The enqueue used to dedupe on three statuses
 * and now decides from the row's own posting EVIDENCE — a row in any status carrying an
 * `externalTransactionId` is a document that exists, and the enqueue reports it as already queued. A
 * confirmation still asking only about the three statuses would answer "nothing was queued" about
 * exactly that row and strand the hold for ever, so both read the one shared definition
 * (`PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR`).
 *
 * The enqueue's THIRD answer — a failed attempt that may have landed, which it refuses — needs no arm
 * here: it writes no row, so nothing matches, and 'not-queued' is the truth.
 */
export function releasedSalesInvoiceQueueWhere(params: {
  salesOrderId: string
  idempotencyKey: string
}): Prisma.AccountingSyncLogWhereInput {
  return {
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: params.salesOrderId,
    OR: PRIOR_ATTEMPT_COUNTERPART_EXISTS_OR,
    payload: { path: ['_idempotencyKey'], equals: params.idempotencyKey },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a stored payload is a held sales invoice we can actually release.
 *
 * Every field the release USES is checked. A row that does not validate is not released and not
 * silently dropped — the caller reports it, because a held invoice that cannot be read is an order
 * that will never be invoiced, which is the failure this whole module exists to end.
 */
export function isHeldSalesInvoicePayload(value: unknown): value is HeldSalesInvoicePayload {
  if (!isRecord(value)) return false
  return value.reason === MISSING_INVOICE_NUMBER_QUEUE_REASON
    && value.connector === 'woocommerce'
    && typeof value.externalOrderId === 'string'
    && typeof value.externalOrderNumber === 'string'
    && typeof value.salesOrderId === 'string'
    && typeof value.orderNumber === 'string'
    && typeof value.metaKey === 'string'
    && isRecord(value.accountingPayload)
    // The number is what the row is WAITING for. A parked payload that already carries one was
    // built by something that did not go through the hold, and stamping over it would post a
    // number nobody chose.
    && value.accountingPayload.invoiceNumber === undefined
}

export function buildHeldSalesInvoicePayload(params: {
  externalOrderId: string
  externalOrderNumber: string
  salesOrderId: string
  orderNumber: string
  metaKey: string
  accountingPayload: Record<string, unknown>
}): HeldSalesInvoicePayload {
  // Defensive: never park a payload that already carries a number (see isHeldSalesInvoicePayload).
  const { invoiceNumber: _discarded, ...rest } = params.accountingPayload
  return {
    reason: MISSING_INVOICE_NUMBER_QUEUE_REASON,
    connector: 'woocommerce',
    externalOrderId: params.externalOrderId,
    externalOrderNumber: params.externalOrderNumber,
    salesOrderId: params.salesOrderId,
    orderNumber: params.orderNumber,
    metaKey: params.metaKey,
    accountingPayload: rest,
  }
}

/** The payload to enqueue, once the number is known. Nothing but the number is added. */
export function buildReleasedSalesInvoicePayload(
  held: HeldSalesInvoicePayload,
  invoiceNumber: string,
): Record<string, unknown> {
  return { invoiceNumber, ...held.accountingPayload }
}
