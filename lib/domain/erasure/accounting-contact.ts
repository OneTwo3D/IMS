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
export async function resolveSalesPostContact(
  referenceType: string,
  referenceId: string,
  payload: { contactName?: unknown; contactEmail?: unknown },
): Promise<{ contactName: string; contactEmail: string | undefined }> {
  const stored = { contactName: payload.contactName as string, contactEmail: payload.contactEmail as string | undefined }
  let orderId: string | null = null
  if (referenceType === 'SalesOrder') orderId = referenceId
  else if (referenceType === 'SalesOrderRefund') {
    orderId = (await db.salesOrderRefund.findUnique({ where: { id: referenceId }, select: { orderId: true } }).catch(() => null))?.orderId ?? null
  }
  if (!orderId) return stored
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } },
  })
  if (order?.erasedAt || order?.customer?.gdprAnonymisedAt) return { contactName: ERASURE_PLACEHOLDER_NAME, contactEmail: undefined }
  return stored
}
