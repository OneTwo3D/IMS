import { db } from '@/lib/db'
import { ERASURE_PLACEHOLDER_NAME } from './erasure-record'

/**
 * THE POSTING GATE: what contact identity an accounting post for a sales document may carry.
 *
 * If the order (or the customer it belongs to) is erased, the post carries the PLACEHOLDER name and NO email, whatever the
 * stored payload says. The alternative, refusing the post, would leave a real sale permanently missing from the ledger and
 * IMS's revenue and Xero's books disagreeing; posting under the placeholder keeps them consistent and puts no identity in
 * Xero. The caller still passes the customer id, so a contact already bound to that customer (the one the original invoice
 * used) is reused by id, which transmits no new identity at all.
 */
export type SalesPostContact =
  | { ok: true; contactName: string; contactEmail: string | undefined }
  | { ok: false; error: string }

/**
 * FAIL CLOSED. If the erasure state cannot be read (the refund lookup or the order read fails), the answer is `ok: false`, never
 * the stored contact: the caller returns a retryable failure and posts nothing until the state is known. An unreadable state
 * must not be read as "not erased".
 */
export async function resolveSalesPostContact(
  referenceType: string,
  referenceId: string,
  payload: { contactName?: unknown; contactEmail?: unknown },
): Promise<SalesPostContact> {
  const stored = { ok: true as const, contactName: payload.contactName as string, contactEmail: payload.contactEmail as string | undefined }
  try {
    let orderId: string | null = null
    if (referenceType === 'SalesOrder') orderId = referenceId
    else if (referenceType === 'SalesOrderRefund') {
      orderId = (await db.salesOrderRefund.findUnique({ where: { id: referenceId }, select: { orderId: true } }))?.orderId ?? null
    }
    if (!orderId) return stored
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } },
    })
    if (order?.erasedAt || order?.customer?.gdprAnonymisedAt) return { ok: true, contactName: ERASURE_PLACEHOLDER_NAME, contactEmail: undefined }
    return stored
  } catch (error) {
    return { ok: false, error: `Could not read the erasure state of ${referenceType} ${referenceId} before posting its contact; nothing was sent and the post will be retried (${error instanceof Error ? error.name : typeof error})` }
  }
}
