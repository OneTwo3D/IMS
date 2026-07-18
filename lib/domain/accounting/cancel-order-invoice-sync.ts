import type { Prisma } from '@/app/generated/prisma/client'
import { voidMirroredAccountingEventsForOrder } from './accounting-event-mirror'

/** SALES_INVOICE sync types that recognise revenue for a sales order. */
const SALES_INVOICE_SYNC_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

/**
 * A PROCESSING row younger than this is treated as actively in-flight and left alone (audit-H4): the
 * worker may be mid-post, and clobbering it would race the external call. It leaves the live set on its
 * own once it finishes. Matches ORPHAN_CANCEL_STALE_PROCESSING_MS in app/actions/accounting-sync.ts.
 */
const STALE_PROCESSING_MS = 15 * 60 * 1000

/**
 * When a sales order is cancelled, retire its still-pending SALES_INVOICE accounting work so the
 * real-time sync drain does not post an ACCREC invoice for a sale that never happened (o3d-5rs). A
 * cancel is only permitted pre-dispatch, so there is genuinely no revenue to recognise.
 *
 * Must run INSIDE the cancellation transaction, so the order reaching CANCELLED and its queued invoice
 * being retired commit atomically — a drain cannot slip between them. Uses the existing terminal states
 * the reconciliation/backfill sweeps already exclude: AccountingSyncStatus.CANCELLED for the sync log
 * (audit-46ry: distinct from FAILED so it is not re-queued or dashboarded as an error) and VOID for the
 * mirrored event. PENDING and stale-PROCESSING rows only — an actively-claimed post is left to finish.
 */
export async function cancelPendingSalesInvoiceSyncForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date,
): Promise<number> {
  const staleProcessingCutoff = new Date(now.getTime() - STALE_PROCESSING_MS)
  const reason = 'Cancelled: sales order cancelled before the invoice posted (no revenue to recognise).'

  const result = await tx.accountingSyncLog.updateMany({
    where: {
      referenceId: orderId,
      type: { in: [...SALES_INVOICE_SYNC_TYPES] },
      // Only retire rows that never reached the ledger. A row that posted and then reverted to
      // PENDING/FAILED on a follow-up failure keeps its externalTransactionId; cancelling it would
      // falsely record that a real Xero receivable never posted and hide it from recovery.
      externalTransactionId: null,
      OR: [
        { status: 'PENDING' },
        // FAILED rows stay eligible for the "Retry All" actions, so a cancelled order's failed invoice
        // would otherwise still post on a retry — retire it too.
        { status: 'FAILED' },
        { status: 'PROCESSING', processingStartedAt: null },
        { status: 'PROCESSING', processingStartedAt: { lt: staleProcessingCutoff } },
      ],
    },
    // CANCELLED (not FAILED) so reconciliation/backfill sweeps and error dashboards ignore it. A freshly
    // claimed PROCESSING row (recent processingStartedAt) is intentionally NOT matched — it is left to
    // finish; SYNCED rows are already posted and out of scope for retirement (a cancel-after-post needs
    // an explicit reversal, tracked separately).
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null },
  })

  // Terminalise the mirrored events too, or a dangling PENDING mirror reads as work still owed.
  await voidMirroredAccountingEventsForOrder(tx, {
    types: [...SALES_INVOICE_SYNC_TYPES],
    referenceType: 'SalesOrder',
    referenceId: orderId,
    reason,
  })

  return result.count
}

/**
 * Post-time backstop for the sweep above: retire ONE specific SALES_INVOICE sync log (already claimed by
 * the caller) when its order is found cancelled just before posting. Covers the races the cancel-time
 * sweep cannot — an invoice enqueued (Woo import) or a claimed attempt re-queued (rate-limit/defer/fail)
 * AFTER the order was cancelled and its then-pending rows swept. Sets this row to CANCELLED and voids the
 * order's not-yet-posted mirrored events (idempotent — a no-op if the sweep already ran).
 */
export async function retireSalesInvoiceForCancelledOrder(
  client: Prisma.TransactionClient,
  syncLogId: string,
  orderId: string,
  claimedAt: Date,
): Promise<boolean> {
  const reason = 'Cancelled: order cancelled before this invoice posted (no revenue to recognise).'
  // Claim-fenced compare-and-swap: retire the row ONLY if it is still the exact PROCESSING claim THIS
  // worker holds (same processingStartedAt) AND has no external id. A stale reclaim refreshes
  // processingStartedAt, so keying on it stops an old worker cancelling a row a newer worker now owns;
  // requiring externalTransactionId: null stops cancelling a row that already posted (which would hide a
  // real Xero receivable). If the CAS matches nothing, leave the row and the mirror untouched.
  const retired = await client.accountingSyncLog.updateMany({
    where: { id: syncLogId, status: 'PROCESSING', processingStartedAt: claimedAt, externalTransactionId: null },
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null },
  })
  if (retired.count === 0) return false
  await voidMirroredAccountingEventsForOrder(client, {
    types: [...SALES_INVOICE_SYNC_TYPES],
    referenceType: 'SalesOrder',
    referenceId: orderId,
    reason,
  })
  return true
}
