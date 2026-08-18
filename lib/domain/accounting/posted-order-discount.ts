import type { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-y14 r3 finding 1 — WHAT THE INVOICE POSTED, for a chargeback that must mirror it.
 *
 * THE DEFECT. `raiseChargebackForReversedOrder` builds the credit note's order-discount leg from
 * `SalesOrder.discountAmount`, live. That is right for every order whose column still says what its
 * invoice said, and wrong for exactly the orders the o3d-y14 backfill corrects: the invoice posted
 * the duplicated coupon as a negative "Order discount" line, the backfill then cleared that column,
 * and a chargeback raised afterwards omits the leg entirely — crediting the full goods against an
 * invoice that never charged them, and over-reversing AR and revenue by the cleared amount.
 *
 * WHY A FRESHNESS CHECK IS THE WRONG SHAPE. An earlier round proposed comparing the column against
 * the queued payload and refusing on drift. On a corrected order that drift is PERMANENT and
 * intended — the column is supposed to disagree with a document posted before the correction — so
 * the check would report the same "staleness" forever, on every corrected order, while never
 * producing a correct credit note for any of them. The problem is not that the two disagree; it is
 * that the chargeback reads the wrong one of them.
 *
 * WHERE THE POSTED FIGURE IS RECOVERED FROM, and why this source and not the obvious ones:
 *
 *   `AccountingEvent` — the internal mirror of the document that was actually sent. Every
 *   SALES_INVOICE / SALES_INVOICE_UPDATE enqueue mirrors its payload here through
 *   `mirrorAccountingSyncLogToEvent` (both connectors), and the processor flips it to POSTED on a
 *   successful post. Its `linesJson` is the document payload verbatim, so `discount.amount` is
 *   literally the number the negative "Order discount" line carried — in the order's currency and
 *   the order's tax-inclusive/exclusive convention, i.e. exactly the basis `SalesOrder.discountAmount`
 *   uses, so the caller's net/base conversion is unchanged by switching source.
 *
 *   NOT `AccountingSyncLog.payload`, though it holds the same payload: data retention DELETES
 *   resolved sync rows past the horizon and COMPACTS unresolved ones to an attribution-only
 *   tombstone with the payload blanked. A chargeback follows a payment dispute, which routinely
 *   arrives months after the invoice — squarely past that horizon. A source that stops answering
 *   for old orders is no source at all for this question.
 *
 *   NOT the ActivityLog marker the backfill writes: it is INFO, and `purgeExpiredActivityLogs`
 *   deletes INFO after 30 days by default. Same objection, sooner.
 *
 *   NOT `unearnedRevenueAmount` / the Group A1 batch stamp: that is a deferral total
 *   (subtotal + shipping − discount), not the discount, and it exists only for orders a daily batch
 *   has taken.
 *
 * WHEN IT IS CONSULTED AT ALL. Only for orders carrying a `discountModel` stamp. That stamp is
 * written in the SAME `UPDATE` as the backfill's correction, so `discountModel === null` proves the
 * backfill never restated this row and the live column IS what posted — which keeps every native
 * and pre-column order on exactly today's behaviour, and keeps the blast radius of this change to
 * the WooCommerce orders the backfill can have touched.
 *
 * WHEN IT CANNOT BE RECOVERED. A stamped order that has a posted invoice but no readable mirrored
 * document leaves the question genuinely unanswerable, and a chargeback is a real credit note
 * against a real ledger. So it reports UNRECOVERABLE, and the caller refuses and surfaces — which is
 * what that path already does for the other cases where the remaining balance is ambiguous (prior
 * refunds, no discount account configured).
 *
 * WHAT THE CALLER DOES WITH A RECOVERED FIGURE THAT DISAGREES. It refuses too, and that is a
 * deliberate limit on this function rather than a failure of it. Recovering the posted figure is
 * what makes the disagreement VISIBLE and quantifiable at all — without it the over-reversal is
 * silent. But a disagreement means the ledger document understates and the backfill has already
 * asked an operator to correct it by hand, in the accounting system, where IMS cannot see whether
 * they have. Before that adjustment the posted figure is the one to reverse; after it, the order's.
 * Both are wrong in one of the two worlds, so the caller names both and hands it to a human. See
 * `raiseChargebackForReversedOrder`.
 */

/** The sync/document types whose mirrored event describes the sales invoice for an order. */
export const POSTED_SALES_INVOICE_EVENT_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

/** The mirrored-event status that means the document reached the ledger. */
export const POSTED_ACCOUNTING_EVENT_STATUS = 'POSTED'

export type PostedOrderDiscount =
  /**
   * The order's own `discountAmount` is what posted (or nothing has posted at all, so there is no
   * earlier document to mirror and a future one would carry this figure).
   */
  | { source: 'ORDER'; amount: number; detail: string }
  /** Read from the mirrored document that was actually sent. */
  | {
      source: 'POSTED_DOCUMENT'
      amount: number
      detail: string
      documentType: string
      externalId: string | null
    }
  /** A document exists and what it posted cannot be established. The caller must NOT guess. */
  | { source: 'UNRECOVERABLE'; detail: string }

type MirroredDocument = {
  type: string
  status: string
  currency: string
  externalId: string | null
  linesJson: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pull the order-level discount out of ONE mirrored document payload.
 *
 * Every branch that cannot answer says so rather than returning 0. A missing `discount` key means
 * "the document posted no discount leg", which is a real answer and genuinely 0; a payload this
 * cannot parse, or one denominated in a different currency from the order, is NOT — reading 0 out
 * of either would omit a discount leg that exists, which is the very defect being fixed.
 */
export function readPostedDocumentDiscount(
  document: { currency: string; linesJson: unknown },
  expectedCurrency: string,
): { ok: true; amount: number } | { ok: false; detail: string } {
  const payload = document.linesJson
  if (!isRecord(payload) || payload.kind !== 'accounting-document') {
    return { ok: false, detail: 'the mirrored event does not carry a document payload' }
  }
  const documentCurrency = typeof payload.currency === 'string' ? payload.currency : document.currency
  if (documentCurrency.toUpperCase() !== expectedCurrency.toUpperCase()) {
    // The discount is a bare number in the document's own currency. Reversing it into an order of a
    // different currency would silently mix units.
    return {
      ok: false,
      detail: `the posted document is in ${documentCurrency} but the order is in ${expectedCurrency}`,
    }
  }
  if (payload.discount === undefined || payload.discount === null) {
    return { ok: true, amount: 0 }
  }
  if (!isRecord(payload.discount)) {
    return { ok: false, detail: 'the posted document carries an unreadable discount adjustment' }
  }
  const amount = payload.discount.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return {
      ok: false,
      detail: `the posted document's discount amount ${JSON.stringify(amount)} is not a usable number`,
    }
  }
  return { ok: true, amount }
}

export type PostedOrderDiscountClient = Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingSyncLog'>

/**
 * What order-level discount the ledger document for this order actually carries.
 *
 * The three outcomes are the caller's three obligations: mirror the order (nothing was restated, or
 * nothing has posted), mirror the document (the two disagree and the document is what the credit
 * note reverses), or refuse and hand it to a human.
 */
export async function resolvePostedOrderDiscount(
  client: PostedOrderDiscountClient,
  order: {
    id: string
    currency: string
    /** `SalesOrder.discountAmount`, in the order's own currency and tax convention. */
    discountAmount: number
    /** `SalesOrder.discountModel`. NULL proves the backfill never restated this row. */
    discountModel: string | null
    accountingInvoiceId: string | null
  },
): Promise<PostedOrderDiscount> {
  if (order.discountModel === null) {
    // Not "no discount model exists for WooCommerce orders" — the backfill's correction and its
    // stamp are ONE update, so an unstamped row is one the backfill has never written.
    return {
      source: 'ORDER',
      amount: order.discountAmount,
      detail: 'the order carries no discount-model stamp, so nothing has restated its order-level discount',
    }
  }

  const document = (await client.accountingEvent.findFirst({
    where: {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: order.id,
      type: { in: [...POSTED_SALES_INVOICE_EVENT_TYPES] },
      status: POSTED_ACCOUNTING_EVENT_STATUS,
    },
    // The LATEST posted document wins. A SALES_INVOICE_UPDATE posted after a correction carries the
    // corrected figure and supersedes the original invoice, so the credit note must mirror it and
    // not the document it replaced.
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
    select: { type: true, status: true, currency: true, externalId: true, linesJson: true },
  })) as MirroredDocument | null

  if (document) {
    const read = readPostedDocumentDiscount(document, order.currency)
    if (!read.ok) {
      return {
        source: 'UNRECOVERABLE',
        detail: `a ${document.type} was posted for this order but ${read.detail}`,
      }
    }
    return {
      source: 'POSTED_DOCUMENT',
      amount: read.amount,
      detail:
        `the posted ${document.type}${document.externalId ? ` ${document.externalId}` : ''} carries an ` +
        `order-level discount of ${read.amount} ${order.currency}`,
      documentType: document.type,
      externalId: document.externalId,
    }
  }

  // No mirrored document. Either nothing has posted — in which case the live column is both what a
  // future invoice would carry and what there is nothing to contradict — or something posted before
  // the mirror could record it, and then the figure is genuinely unrecoverable.
  if (order.accountingInvoiceId) {
    return {
      source: 'UNRECOVERABLE',
      detail:
        `this order is linked to invoice ${order.accountingInvoiceId} but no posted accounting event ` +
        'records what that document charged',
    }
  }
  // o3d-9kek: a post can succeed and never write its id back, so the column alone under-reports.
  const postedButUnlinked = await client.accountingSyncLog.count({
    where: {
      referenceType: 'SalesOrder',
      referenceId: order.id,
      type: { in: [...POSTED_SALES_INVOICE_EVENT_TYPES] },
      status: { in: ['SYNCED'] },
      externalTransactionId: { not: null },
    },
  })
  if (postedButUnlinked > 0) {
    return {
      source: 'UNRECOVERABLE',
      detail:
        `${postedButUnlinked} posted sales invoice(s) exist for this order with no accountingInvoiceId ` +
        'written back, and no posted accounting event records what they charged',
    }
  }

  return {
    source: 'ORDER',
    amount: order.discountAmount,
    detail: 'no sales invoice has posted for this order, so there is no earlier document to mirror',
  }
}

/**
 * What a chargeback may do with a resolved posted discount.
 *
 * Split out of `raiseChargebackForReversedOrder` so the rule is testable without standing up a
 * server action, a permission check and the whole refund service — the same reason
 * `buildChargebackRefundLines` and `handleDetectedReversal` are pure.
 */
export type ChargebackOrderDiscountDecision =
  /** Safe to auto-raise: the order and the posted document say the same thing (or nothing posted). */
  | { action: 'MIRROR'; amount: number; source: PostedOrderDiscount['source']; detail: string }
  /** A human must raise this credit note. Both figures are carried so the alert can name them. */
  | {
      action: 'MANUAL'
      reason: 'POSTED_FIGURE_UNRECOVERABLE' | 'RESTATED_AFTER_POSTING'
      detail: string
      orderAmount: number
      postedAmount: number | null
      documentType: string | null
      externalId: string | null
    }

export function decideChargebackOrderDiscount(input: {
  posted: PostedOrderDiscount
  /** `SalesOrder.discountAmount`, the figure the chargeback used to mirror unconditionally. */
  orderDiscountAmount: number
}): ChargebackOrderDiscountDecision {
  const { posted, orderDiscountAmount } = input

  if (posted.source === 'UNRECOVERABLE') {
    return {
      action: 'MANUAL',
      reason: 'POSTED_FIGURE_UNRECOVERABLE',
      detail: posted.detail,
      orderAmount: orderDiscountAmount,
      postedAmount: null,
      documentType: null,
      externalId: null,
    }
  }

  if (posted.source === 'POSTED_DOCUMENT' && posted.amount !== orderDiscountAmount) {
    // The o3d-y14-corrected legacy order. Reversing `orderDiscountAmount` omits a discount leg the
    // invoice charged and over-credits by the difference; reversing `posted.amount` under-credits by
    // the same difference if the manual ledger adjustment the backfill asked for has already been
    // made — and which of those two worlds this is happens in the accounting system, not here.
    return {
      action: 'MANUAL',
      reason: 'RESTATED_AFTER_POSTING',
      detail: posted.detail,
      orderAmount: orderDiscountAmount,
      postedAmount: posted.amount,
      documentType: posted.documentType,
      externalId: posted.externalId,
    }
  }

  return { action: 'MIRROR', amount: posted.amount, source: posted.source, detail: posted.detail }
}
