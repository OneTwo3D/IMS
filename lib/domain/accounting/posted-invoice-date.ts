import type { db } from '@/lib/db'
import { recoverPostedBusinessDate } from '@/lib/domain/accounting/back-reference'

/**
 * The date (UTC midnight of the payload day) a sales invoice's `invoicedAt` is stamped with when the post succeeds: the date the document was SENT with, not the instant the
 * post succeeded (a post delayed past London midnight keeps its document day). Only a SALES_INVOICE of a SalesOrder carries one; any other type, a missing payload, or a
 * payload with no readable date gives undefined, and the caller keeps its own `now`.
 */
export function postedInvoicedAt(type: string, referenceType: string, payload: unknown): Date | undefined {
  if (type !== 'SALES_INVOICE' || referenceType !== 'SalesOrder') return undefined
  if (typeof payload !== 'object' || payload === null) return undefined
  return recoverPostedBusinessDate(payload as Record<string, unknown>) ?? undefined
}

/**
 * The date the posted sales invoice of an order was SENT with, read from the payload of the SALES_INVOICE sync row that carries the order's accounting invoice id
 * (`externalTransactionId`). Null when no such row exists (a Xeroom-posted or hand-linked invoice) or none carries a readable date. A shadow row is CANCELLED and carries
 * no document id, so it can never match: this reads only what was really posted.
 */
export async function readPostedSalesInvoiceDate(
  client: Pick<typeof db, 'accountingSyncLog'>,
  orderId: string,
  accountingInvoiceId: string,
): Promise<Date | null> {
  const rows = await client.accountingSyncLog.findMany({
    where: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: orderId, externalTransactionId: accountingInvoiceId },
    orderBy: { createdAt: 'asc' },
    select: { payload: true },
    take: 5,
  })
  for (const row of rows) {
    const date = recoverPostedBusinessDate((row.payload ?? {}) as Record<string, unknown>)
    if (date) return date
  }
  return null
}
