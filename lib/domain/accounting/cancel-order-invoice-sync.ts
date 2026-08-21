import type { Prisma } from '@/app/generated/prisma/client'
import { voidMirroredAccountingEventsForOrder } from './accounting-event-mirror'
import { heldClaimWhere, type HeldClaim } from './sync-claim-fence'

/** SALES_INVOICE sync types that recognise revenue for a sales order. */
const SALES_INVOICE_SYNC_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

/**
 * A PROCESSING row younger than this is treated as actively in-flight and left alone (audit-H4): the
 * worker may be mid-post, and clobbering it would race the external call. It leaves the live set on its
 * own once it finishes. Matches ORPHAN_CANCEL_STALE_PROCESSING_MS in app/actions/accounting-sync.ts.
 */
const STALE_PROCESSING_MS = 15 * 60 * 1000

/**
 * A cancellation arrived while an invoice post for this order is ON THE WIRE (o3d-7o0).
 *
 * TRANSIENT on purpose — it is NOT a PermanentStatusTransitionError. The claim it names clears within
 * {@link STALE_PROCESSING_MS} whatever the worker does, so the identical request succeeds moments
 * later; marking it permanent would drop a real cancellation. See status-transition-errors.ts for why
 * the bar for permanent is a conflict with an irreversible PHYSICAL fact, which this is not.
 */
export class SalesInvoicePostingInFlightError extends Error {
  readonly postingInFlight = true as const

  constructor(message: string) {
    super(message)
    this.name = 'SalesInvoicePostingInFlightError'
  }
}

/**
 * THE POSTING INTENT, and the half of the cancel/invoice protocol that used to be missing (o3d-7o0).
 *
 * o3d-5rs closed the enqueue-side race: a cancellation retires the order's PENDING/FAILED/stale
 * SALES_INVOICE rows in its own transaction, and {@link retireSalesInvoiceForCancelledOrder} is a
 * post-time backstop for rows enqueued after that sweep. What neither closed is the window BETWEEN a
 * worker deciding to post and the external call landing: `guardCancelledSalesOrderInvoice` reads the
 * order, the transaction commits, and only THEN does the ACCREC invoice go to Xero. A cancellation
 * committing in that gap produces a real receivable for a sale that never happened, and no local
 * write can take it back.
 *
 * The protocol that closes it is the one o3d-5r8 used for the hard DELETE, with the same two halves:
 *
 *   1. THE INTENT IS DURABLE AND EARLIER THAN THE DECISION. The processor's own PROCESSING claim is
 *      it — `{ status: 'PROCESSING', processingStartedAt: <claim instant> }`, committed by the runner
 *      BEFORE processEntry does anything. Nothing new is written; what changed is that it is now read.
 *   2. THE DECIDING READS SERIALISE ON THE ORDER ROW. `cancelSalesOrderFulfillmentState` opens with
 *      `lockSalesOrder`, and `guardCancelledSalesOrderInvoice` now takes the SAME lock around its
 *      status read. So for any pair: either the cancellation commits first and the guard reads
 *      CANCELLED and retires instead of posting, or the guard holds the lock and the cancellation
 *      waits — and then finds the live claim below and REFUSES.
 *
 * LOCK ORDERING. Both sides take `lockSalesOrder` FIRST and only then touch accounting_sync_logs; the
 * cancellation additionally takes `lockStockLevels` after the order lock, which is the ordering
 * allocation-service establishes. No new lock is introduced and no cycle is possible: the order row is
 * the only lock both paths hold, and both acquire it before anything else.
 *
 * THE BOUND. A claim older than {@link STALE_PROCESSING_MS} is NOT treated as live — the same cutoff
 * the retirement sweep below already uses. A request still on the wire after fifteen minutes can
 * therefore still slip through. That is a narrowing, not a hole in the protocol: it is the same
 * assumption the whole claim/reclaim scheme rests on, and making it stricter here without also
 * changing the reclaim cutoff would refuse cancellations forever on a row nothing will ever finish.
 */
export async function findLiveSalesInvoicePostingClaim(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  orderId: string,
  now: Date,
): Promise<{ id: string; connector: string; type: string; processingStartedAt: Date | null } | null> {
  const staleProcessingCutoff = new Date(now.getTime() - STALE_PROCESSING_MS)
  return tx.accountingSyncLog.findFirst({
    where: {
      referenceId: orderId,
      type: { in: [...SALES_INVOICE_SYNC_TYPES] },
      status: 'PROCESSING',
      processingStartedAt: { gte: staleProcessingCutoff },
    },
    select: { id: true, connector: true, type: true, processingStartedAt: true },
  })
}

/**
 * Refuse a cancellation while an invoice post for this order is in flight (o3d-7o0).
 *
 * MUST be called inside the transaction that holds the order's row lock — that is what makes the
 * answer binding rather than a snapshot. Throws {@link SalesInvoicePostingInFlightError}; the caller
 * should let it propagate so the whole cancellation rolls back.
 */
export async function assertNoSalesInvoicePostingInFlight(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  orderId: string,
  now: Date,
): Promise<void> {
  const claim = await findLiveSalesInvoicePostingClaim(tx, orderId, now)
  if (!claim) return
  throw new SalesInvoicePostingInFlightError(
    `Cannot cancel this order while its ${claim.connector} ${claim.type} is being posted `
    + `(sync log ${claim.id}, claimed ${claim.processingStartedAt?.toISOString() ?? 'unknown'}). The invoice request may `
    + 'already be on the wire, and cancelling now would leave a receivable in the ledger for a sale that never '
    + 'happened. Wait for the post to settle — at most 15 minutes — then cancel: if it posted, the cancellation '
    + 'will need an explicit credit note.',
  )
}

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
  // o3d-7o0: refuse before retiring anything. A FRESH PROCESSING claim means a worker is (or is about
  // to be) mid-post; the sweep below deliberately leaves such a row alone, which used to mean the
  // cancellation simply proceeded and the invoice landed anyway. This is the invariant that stops it,
  // placed HERE so no caller of this module can skip it.
  await assertNoSalesInvoicePostingInFlight(tx, orderId, now)

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
  held: HeldClaim,
): Promise<boolean> {
  const reason = 'Cancelled: order cancelled before this invoice posted (no revenue to recognise).'
  // Claim-fenced compare-and-swap: retire the row ONLY if it is still the exact PROCESSING claim THIS
  // worker holds AND has no external id. A stale reclaim refreshes processingStartedAt, so keying on it
  // stops an old worker cancelling a row a newer worker now owns; requiring externalTransactionId: null
  // stops cancelling a row that already posted (which would hide a real Xero receivable). If the CAS
  // matches nothing, leave the row and the mirror untouched.
  //
  // THE OWNERSHIP HALF IS COMPOSED FROM heldClaimWhere, NOT SPELT OUT AGAIN (Codex r1, medium 1). The
  // inline copy happened to match, which is the dangerous case: a change to what "I still hold this
  // claim" means would silently apply to the connector's releases and not to this retirement, and this
  // one is a RETRACTION — a displaced worker terminalising a row a live worker owns. The extra
  // `externalTransactionId: null` arm stays this call site's own, because it guards a different fact.
  const retired = await client.accountingSyncLog.updateMany({
    where: { ...heldClaimWhere(syncLogId, held), externalTransactionId: null },
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
