// ---------------------------------------------------------------------------
// Payment-reversal detection (audit-M-acct #3)
//
// The Xero payment poller is forward-only: it queries Status=="PAID" invoices
// modified since the last poll and sets paidAt on the matching IMS document. If a
// payment is later reversed/deleted in Xero, the invoice regresses to AUTHORISED
// but the poller never clears paidAt — IMS keeps showing the document as paid.
// This pairs the forward poll with a reversal pass: of the documents IMS thinks
// are paid, which now have a non-paid (AUTHORISED) Xero invoice in the polled
// window? Those get paidAt rolled back. Pure set intersection, unit-tested.
// ---------------------------------------------------------------------------

export type ReversalCandidate = { accountingInvoiceId: string | null }

/**
 * Documents IMS currently marks paid whose linked external invoice appears in
 * the set of invoices that have regressed out of the PAID state. These should
 * have their paidAt cleared.
 */
export function detectPaymentReversals<T extends ReversalCandidate>(
  paidDocuments: T[],
  reversedExternalInvoiceIds: ReadonlySet<string>,
): T[] {
  return paidDocuments.filter(
    (doc) => doc.accountingInvoiceId != null && reversedExternalInvoiceIds.has(doc.accountingInvoiceId),
  )
}

/**
 * WHICH BILL_PAYMENT SYNC ROWS ARE SUPERSEDED WHEN A BILL IS (RE-)MARKED PAID (o3d-a3wx).
 *
 * markBillPaid only wins the `paidAt: null -> paid` transition when IMS currently holds the bill as
 * UNSETTLED. If a live BILL_PAYMENT row exists at that moment, the two statements contradict each other,
 * and the reason is known: the payment poller's reversal pass clears paidAt when the payment is no
 * longer present in the ledger (detectPaymentReversals above). The row is stale evidence — it describes
 * a payment the ledger has given up.
 *
 * This matters because BILL_PAYMENT joined accounting_sync_logs_followup_live_unique, keyed by
 * (connector, type, reference, accountingInvoiceId). Left in place, that stale row would occupy the slot
 * and REFUSE the legitimate re-payment: the bill would be marked paid in IMS with nothing queued, and
 * the constraint meant to stop a double payment would instead be stranding a real one. Retiring the row
 * as CANCELLED frees the slot without destroying the record that it was once posted.
 *
 * FAILED and CANCELLED rows are left exactly as they are. They are already outside the live predicate,
 * so they block nothing, and rewriting a FAILED row as CANCELLED would erase the fact that the ledger
 * rejected it — which is the evidence an operator needs, and which o3d-ju8t's "FAILED does not prove
 * nothing posted" reading depends on.
 */
export const SUPERSEDABLE_BILL_PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const

export function supersededBillPaymentRows<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((row) => (SUPERSEDABLE_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status))
}
