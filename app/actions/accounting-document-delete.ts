'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/server'
import { getActiveAccountingConnectorId } from '@/lib/accounting'
import { lookupXeroInvoiceNumberClaim } from '@/lib/connectors/xero/invoice-number-claim'
import { requestAccountingDocumentDelete } from '@/lib/domain/accounting/document-delete-service'

// ---------------------------------------------------------------------------
// o3d-ngmt.21 — delete a synced sales invoice or supplier bill in IMS and Xero together.
//
// The permission is the one that EDITS the document today: `purchasing.invoice` for a bill (updateInvoice, markBillPaid) and
// `sales.process` for a sales invoice (generateInvoiceNumber). The rule lives in lib/domain/accounting/document-delete-service.ts and
// document-delete-eligibility.ts; this module is only the two authenticated entry points. A 'use server' module exports async functions only.
// ---------------------------------------------------------------------------

export type DeleteSyncedDocumentResult = { success: boolean; error?: string; notice?: string; held?: boolean }

/** Delete a synced sales invoice, named by its order. Queues the Xero delete; IMS is updated when Xero confirms. */
export async function deleteSyncedSalesInvoice(orderId: string): Promise<DeleteSyncedDocumentResult> {
  const session = await requirePermission('sales.process')
  if (typeof orderId !== 'string' || orderId.trim() === '') return { success: false, error: 'No invoice was named.' }
  const result = await requestAccountingDocumentDelete(
    { kind: 'SALES_INVOICE', documentId: orderId, requestedById: session.user.id ?? null },
    { lookupInvoiceNumber: (number) => lookupXeroInvoiceNumberClaim(number), activeConnector: () => getActiveAccountingConnectorId() },
  )
  revalidatePath(`/sales/${orderId}`)
  if (!result.ok) return { success: false, error: result.error, held: result.held }
  return { success: true, notice: queuedNotice(result.releasedNumber) }
}

/** Delete a synced supplier bill, named by the bill. Queues the Xero delete; IMS is updated when Xero confirms. */
export async function deleteSyncedPurchaseBill(billId: string): Promise<DeleteSyncedDocumentResult> {
  const session = await requirePermission('purchasing.invoice')
  if (typeof billId !== 'string' || billId.trim() === '') return { success: false, error: 'No bill was named.' }
  const result = await requestAccountingDocumentDelete(
    { kind: 'PURCHASE_BILL', documentId: billId, requestedById: session.user.id ?? null },
    {
      // Bill numbers are the supplier's and are not unique in the ledger, so there is no number lookup: IMS ownership rests on its own create row.
      lookupInvoiceNumber: async () => ({ ok: false, error: 'bills are not looked up by number' }),
      activeConnector: () => getActiveAccountingConnectorId(),
    },
  )
  revalidatePath('/purchase-orders')
  if (!result.ok) return { success: false, error: result.error, held: result.held }
  return { success: true, notice: queuedNotice(result.releasedNumber) }
}

function queuedNotice(releasedNumber: string): string {
  return releasedNumber
    ? `Delete queued. Xero will first rename the document to ${releasedNumber} so the original number is free, then delete or void it; IMS is updated when Xero confirms. Follow it in Sync.`
    : 'Delete queued. Xero will delete or void the document; IMS is updated when Xero confirms. Follow it in Sync.'
}
