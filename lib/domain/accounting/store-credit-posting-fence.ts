import type { Prisma } from '@/app/generated/prisma/client'
import { STALE_PROCESSING_MS } from './cancel-order-invoice-sync'

/**
 * THE POSTING-TIME ORDER-STATE FENCE for store-credit review.
 *
 * An order-scoped accounting posting (sales invoice create / update, credit note, payment registration, invoice
 * email, WooCommerce invoice note) decides under the order's row lock whether the order is held for store-credit
 * review, then releases the lock and goes on to the remote call. A later WooCommerce delivery that flags the order
 * REVIEW_REQUIRED could commit in that gap. The protocol that closes it is the one cancellation uses against an
 * invoice in flight:
 *
 *   1. THE INTENT IS DURABLE AND EARLIER THAN THE DECISION: the processor's own PROCESSING claim, committed by the
 *      runner before the entry is processed.
 *   2. THE DECIDING READS SERIALISE ON THE ORDER ROW: every posting guard reads the store-credit state under
 *      `lockSalesOrder`, and the review transition takes the same lock before it looks for a live claim.
 *
 * So for any pair: either the review commits first and the guard reads REVIEW_REQUIRED and refuses, or the guard
 * holds the lock first and the review transition then finds the live claim and DEFERS (this error rolls the whole
 * update back; WooCommerce redelivers, and the transition is taken once the posting has settled). No posting can
 * be authorised on a state the order has already left, and no review can land between authorisation and dispatch.
 *
 * Lock ordering: the order lock first, then accounting_sync_logs reads. Nothing here takes any other lock.
 * The bound is the same 15 minutes the claim / reclaim scheme rests on.
 */
export class StoreCreditReviewDeferredError extends Error {
  readonly postingInFlight = true as const

  constructor(message: string) {
    super(message)
    this.name = 'StoreCreditReviewDeferredError'
  }
}

/** Sync types that post, or act on, an order's invoice and so must see a settled store-credit state. */
export const ORDER_SCOPED_POSTING_TYPES = [
  'SALES_INVOICE', 'SALES_INVOICE_UPDATE', 'INVOICE_PAYMENT', 'INVOICE_EMAIL', 'WC_INVOICE_NOTE',
] as const

/** A fresh PROCESSING claim of an order-scoped posting for this order (directly, via a follow-up payload, or via one of its refunds). */
export async function findLiveOrderPostingClaim(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'salesOrderRefund'>,
  orderId: string,
  now: Date,
): Promise<{ id: string; connector: string; type: string; processingStartedAt: Date | null } | null> {
  const cutoff = new Date(now.getTime() - STALE_PROCESSING_MS)
  const refunds = await tx.salesOrderRefund.findMany({ where: { orderId }, select: { id: true } })
  return tx.accountingSyncLog.findFirst({
    where: {
      status: 'PROCESSING',
      processingStartedAt: { gte: cutoff },
      OR: [
        { referenceId: orderId, type: { in: [...ORDER_SCOPED_POSTING_TYPES] } },
        { type: { in: [...ORDER_SCOPED_POSTING_TYPES] }, payload: { path: ['referenceId'], equals: orderId } },
        ...(refunds.length ? [{ type: 'CREDIT_NOTE' as const, referenceType: 'SalesOrderRefund', referenceId: { in: refunds.map((r) => r.id) } }] : []),
      ],
    },
    select: { id: true, connector: true, type: true, processingStartedAt: true },
  })
}

/** MUST run inside the transaction holding the order's row lock. Throws {@link StoreCreditReviewDeferredError}. */
export async function assertNoOrderPostingInFlightForReview(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'salesOrderRefund'>,
  orderId: string,
  now: Date,
): Promise<void> {
  const claim = await findLiveOrderPostingClaim(tx, orderId, now)
  if (!claim) return
  throw new StoreCreditReviewDeferredError(
    `Deferred: the ${claim.connector} ${claim.type} for this order is being posted (sync log ${claim.id}, claimed `
    + `${claim.processingStartedAt?.toISOString() ?? 'unknown'}), so it is not put in store-credit review in the middle of that posting. `
    + 'The WooCommerce delivery is retried and the review is recorded once the posting has settled (at most 15 minutes).',
  )
}
