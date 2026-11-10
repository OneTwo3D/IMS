import type { PurchaseOrderStatus } from '@/app/generated/prisma/client'

// Cancellation gates. The stock-reversing cancellation that used to live here (reverse every remaining cost layer of a
// part-received order) is gone: cancelling a part-received order now closes it short and keeps the received stock
// (lib/domain/purchasing/po-close-short.ts); taking received goods back out is the supplier-return flow's job.

export function assertPurchaseOrderCancellationHasNoInvoices(invoiceCount: number): void {
  if (invoiceCount > 0) {
    throw new Error('Cannot cancel a purchase order after supplier invoices have been recorded. Create a supplier credit or bill reversal instead.')
  }
}

/**
 * audit-g5u2.4: decide whether an invoiced PO may still be cancelled.
 *
 * An uninvoiced PO is always cancellable. Once a supplier invoice is recorded,
 * cancellation is normally blocked (the GL would be left unbalanced). The one
 * exception is a FREIGHT PO where EVERY bill is fully offset by POSTED supplier
 * credit notes attributed to that bill (e.g. a duplicate freight bill credited
 * back): the credit note keeps the GL balanced, so the cancel — which reverts the
 * freight's landed-cost uplift on linked primaries — is safe.
 *
 * Comparison is in BASE currency (the GL predicate) and PER-BILL: a credit note
 * is only counted against the specific invoice it is linked to (unattributed
 * credits don't offset any bill), so a credit for one bill can't satisfy another
 * (Codex review). A non-freight PO, or a freight PO with any under-offset bill,
 * stays blocked.
 */
export function evaluatePurchaseOrderCancellationInvoiceGate(params: {
  isFreight: boolean
  /** Per supplier bill: its base-currency total and the POSTED credit base attributed to it. */
  invoices: Array<{ totalBase: number; creditedBase: number }>
}): { allowed: boolean; reason: string | null } {
  if (params.invoices.length === 0) return { allowed: true, reason: null }
  if (!params.isFreight) {
    return {
      allowed: false,
      reason: 'Cannot cancel a purchase order after supplier invoices have been recorded. Create a supplier credit or bill reversal instead.',
    }
  }
  // Half-cent tolerance (DECIMAL(18,4) base amounts) so exact full offsets pass.
  const TOLERANCE = 0.005
  const underOffset = params.invoices.filter((inv) => inv.creditedBase < inv.totalBase - TOLERANCE)
  if (underOffset.length === 0) return { allowed: true, reason: null }
  const shortfall = underOffset.reduce((sum, inv) => sum + (inv.totalBase - inv.creditedBase), 0)
  return {
    allowed: false,
    reason: `Cannot cancel this freight PO: ${underOffset.length} supplier bill(s) not fully offset by posted credit notes (shortfall ${shortfall.toFixed(2)}). Post a covering supplier credit note for each bill first.`,
  }
}

export function isPurchaseOrderCancellationNoop(status: PurchaseOrderStatus): boolean {
  return status === 'CANCELLED'
}
