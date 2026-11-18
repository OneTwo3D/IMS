import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

type Client = Pick<Prisma.TransactionClient, 'accountingDocumentDeletion'>

/**
 * THE FENCE FOR NEW ACTIVITY ON A DOCUMENT WHOSE DELETE IS PENDING. A payment, supplier credit note, refund or edit recorded now would attach
 * to a document Xero is about to remove, so each of those actions asks this first and refuses with the returned sentence. `documentId` is the
 * order id (sales invoice) or the bill's id. Called under the document's row lock where the action holds one, so a request that committed first
 * is seen; the unwind's own re-check (below) is the second half for anything that slipped in the other way round.
 */
export async function pendingDeletionError(documentId: string, client: Client = db): Promise<string | null> {
  const pending = await client.accountingDocumentDeletion.findFirst({ where: { documentId, state: { in: ['PENDING', 'NEEDS_REVIEW'] } }, select: { kind: true, originalNumber: true, state: true } })
  if (!pending) return null
  const what = pending.kind === 'SALES_INVOICE' ? 'invoice' : 'bill'
  if (pending.state === 'NEEDS_REVIEW') {
    return `Xero has already removed this ${what}, but IMS has not finished unwinding it because activity was recorded against it. Resolve it from the ${what}'s page first. Nothing was changed.`
  }
  return `${pending.originalNumber ? `The ${what} ${pending.originalNumber}` : `This ${what}`} is being deleted in IMS and Xero, so payments, credit notes, refunds and edits are refused until the delete finishes. Nothing was changed. Follow the delete in Sync.`
}

