import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { heldClaimWhere, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'

/**
 * WHAT HAPPENS TO AN INVOICE'S ORDER-SCOPED FOLLOW-UPS WHEN THE ORDER IS CANCELLED.
 *
 * The invoice types (SALES_INVOICE, SALES_INVOICE_UPDATE) are retired by the cancellation itself and guarded again at post time. The four follow-ups of a POSTED invoice are
 * the rest of the order-scoped census, and each has its own answer, stated here once and read by the enqueue site and by the processor:
 *
 *   INVOICE_PAYMENT   'timing'  - decided by WHEN the money arrived, not by the order's status. A receipt dated after the cancellation is held at the enqueue
 *                                 (registration decision) and again at the post (`guardInvoicePaymentCapacity`, PAID_AFTER_CANCELLATION), because the ledger books it as
 *                                 an overpayment, which IMS does not create. A receipt that predates the cancellation, or whose instants are unknown, takes the credit-note
 *                                 path and registers as ever (owner ruling).
 *   INVOICE_PDF       'allow'   - saves a copy of a document the ledger still holds; nothing leaves IMS and nothing is posted.
 *   INVOICE_EMAIL     'refuse'  - would send the customer an invoice for an order that no longer stands.
 *   WC_INVOICE_NOTE   'refuse'  - would tell the shop an invoice exists for a cancelled order.
 *
 * A 'refuse' follow-up is not queued at the enqueue, and one already queued is retired CANCELLED at the drain, UNDER THE ORDER ROW LOCK (the lock cancellation takes first), with
 * a finding naming the reason. Nothing is dropped silently: the retired row carries the reason and an activity record is written.
 */
export const ORDER_SCOPED_FOLLOW_UP_DISPOSITION = {
  INVOICE_PAYMENT: 'timing',
  INVOICE_PDF: 'allow',
  INVOICE_EMAIL: 'refuse',
  WC_INVOICE_NOTE: 'refuse',
} as const

export type OrderScopedFollowUpType = keyof typeof ORDER_SCOPED_FOLLOW_UP_DISPOSITION
export type CancelledOrderRefusedType = { [K in OrderScopedFollowUpType]: (typeof ORDER_SCOPED_FOLLOW_UP_DISPOSITION)[K] extends 'refuse' ? K : never }[OrderScopedFollowUpType]

export const CANCELLED_ORDER_REFUSED_FOLLOW_UP_TYPES = (Object.keys(ORDER_SCOPED_FOLLOW_UP_DISPOSITION) as OrderScopedFollowUpType[])
  .filter((t): t is CancelledOrderRefusedType => ORDER_SCOPED_FOLLOW_UP_DISPOSITION[t] === 'refuse')

export function cancelledOrderFollowUpReason(type: CancelledOrderRefusedType): string {
  const what = type === 'INVOICE_EMAIL' ? 'emailing the invoice to the customer' : 'writing the invoice note on the WooCommerce order'
  return `Refused: the sales order is cancelled, so ${what} was not done. Nothing was sent. If the invoice genuinely needs to go out, re-queue it by hand after reinstating the order.`
}

/** Is the order cancelled? An unreadable order throws (the caller must not read a failure as "not cancelled"). Without a lock this is the enqueue-time read; the drain below is the binding check. */
export async function orderIsCancelled(orderId: string, client: Pick<Prisma.TransactionClient, 'salesOrder'> = db): Promise<boolean> {
  const so = await client.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
  return so?.status === 'CANCELLED'
}

export type CancelledFollowUpDecision =
  | { refused: false }
  | { refused: true; reason: string; retired: boolean }

/**
 * THE DRAIN-TIME GUARD. Takes the order row lock (the same one cancellation takes first), reads the status, and when the order is CANCELLED retires THIS claimed row CANCELLED with
 * the reason, claim-fenced like every other terminal write. Throws on an unreadable order, which the caller reports as a failure: a read outage is not permission to send.
 */
export async function guardCancelledOrderFollowUp(params: {
  entryId: string
  claim: HeldClaim
  type: CancelledOrderRefusedType
  orderId: string
}): Promise<CancelledFollowUpDecision> {
  return db.$transaction(async (tx) => {
    await lockSalesOrder(tx, params.orderId)
    if (!(await orderIsCancelled(params.orderId, tx))) return { refused: false } as const
    const reason = cancelledOrderFollowUpReason(params.type)
    const retired = await tx.accountingSyncLog.updateMany({
      where: { ...heldClaimWhere(params.entryId, params.claim), externalTransactionId: null },
      data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null },
    })
    return { refused: true, reason, retired: retired.count > 0 } as const
  })
}

/**
 * THE ENQUEUE-TIME PLAN for the customer-facing follow-ups of a posted invoice: which of the email and the WooCommerce note are queued. A CANCELLED order queues neither (the drain
 * re-checks under the order lock for a row that was queued before the cancellation). Pure, so the decision is testable apart from the queue.
 */
export function planInvoiceCustomerFollowUps(order: { status: string; customerEmail: string | null; hasWooCommerceLink: boolean }): { email: boolean; note: boolean; suppressedForCancellation: boolean } {
  if (order.status === 'CANCELLED') return { email: false, note: false, suppressedForCancellation: true }
  return { email: Boolean(order.customerEmail), note: order.hasWooCommerceLink, suppressedForCancellation: false }
}
