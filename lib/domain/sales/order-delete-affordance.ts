/**
 * o3d-0zy — WHY THE DELETE BUTTON GOES QUIET ON A NON-DRAFT ORDER.
 *
 * Since o3d-5r8, `deleteSalesOrder` refuses whenever a live PENDING/PROCESSING/SYNCED/FAILED
 * `AccountingSyncLog` references the order. `queueSalesInvoiceForOrder` runs for EVERY non-draft
 * order — on create when `isDraft` is false, and again on draft finalisation — so with accounting
 * sync enabled essentially every PENDING_PAYMENT order now carries a live SALES_INVOICE row and can
 * no longer be hard-deleted. That is the intended safety outcome, and Cancel is the correct path
 * (it retires the queued invoice via `cancelPendingSalesInvoiceSyncForOrder` and propagates a WMS
 * cancel) — but the button still looked available and answered with a refusal.
 *
 * This resolves the refusal the operator WOULD hit, from data the order page already holds, so the
 * control can be disabled with the reason and the remedy attached instead. It deliberately does NOT
 * decide visibility: an order outside the deletable statuses has no Delete button at all, which is a
 * separate rule the page already applies.
 *
 * DRAFT is exempt because a draft never queues an accounting invoice, so it stays freely deletable.
 * When accounting sync is OFF and nothing was ever posted, nothing is queued either and delete keeps
 * working on a non-draft order — so this must not block on status alone.
 *
 * The server remains the authority: this only predicts the refusal, it never grants a delete. Other
 * blockers the page cannot see (a WMS push link, a daily accounting batch, refunds/payments) still
 * surface as a server refusal, which is why the button is disabled rather than removed — the
 * operator can still see what the action was and read why it is unavailable.
 */

export type SalesOrderDeleteBlock = {
  /** Operator-facing sentence: what stops the delete. */
  reason: string
  /** Where the operator should go instead — mirrors help-docs/sales.md's blocker table. */
  remedy: 'cancel' | 'finance'
}

export function resolveSalesOrderDeleteBlock(input: {
  status: string
  /** Set once an invoice has actually been posted for the order in the accounting system. */
  accountingInvoiceId: string | null
  /** Whether sales invoices are queued to the accounting connector at all. */
  accountingSyncEnabled: boolean
}): SalesOrderDeleteBlock | null {
  if (input.status === 'DRAFT') return null

  if (input.accountingInvoiceId) {
    return {
      remedy: 'finance',
      reason: 'An accounting invoice has already been posted for this order, so it can no longer be deleted. '
        + 'Cancelling would not reverse it either — finance has to raise a credit note or reversal in the accounting system.',
    }
  }

  if (input.accountingSyncEnabled) {
    return {
      remedy: 'cancel',
      reason: 'An accounting invoice is queued for this order, so it can no longer be deleted. '
        + 'Cancel the order instead: that retires the queued invoice before it posts and withdraws the order from the WMS.',
    }
  }

  return null
}
