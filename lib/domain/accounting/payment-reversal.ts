import type { Prisma } from '@/app/generated/prisma/client'

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
 * WHICH BILL_PAYMENT SYNC ROWS MAY BE RETIRED WHEN A BILL IS (RE-)MARKED PAID (o3d-a3wx).
 *
 * markBillPaid only wins the `paidAt: null -> paid` transition when IMS currently holds the bill as
 * UNSETTLED. If a BILL_PAYMENT row exists at that moment, the two statements contradict each other, and
 * the reason is known: the payment poller's reversal pass clears paidAt when the payment is no longer
 * present in the ledger (detectPaymentReversals above). The row is stale evidence — it describes a
 * payment the ledger has given up.
 *
 * This matters because BILL_PAYMENT joined accounting_sync_logs_followup_live_unique, keyed by
 * (connector, type, reference, accountingInvoiceId). Left in place, a stale live row would occupy the
 * slot and REFUSE the legitimate re-payment: the bill marked paid in IMS with nothing queued, and the
 * constraint meant to stop a double payment stranding a real one instead.
 *
 * WHAT THE FIRST VERSION OF THIS GOT WRONG, AND WHY IT WAS WORSE THAN THE BUG IT CLOSED.
 *
 * It retired PENDING, PROCESSING and SYNCED alike, on the reasoning that FAILED/CANCELLED are the
 * ledger's evidence and everything else is stale. That line is drawn in the wrong place. The dangerous
 * state is not FAILED, it is IN FLIGHT:
 *
 *   PENDING     nothing has been sent. No worker owns the row, so cancelling it stops the call from
 *               ever being made — the cancellation is the whole event.
 *   PROCESSING  the claim was TAKEN. A worker may be inside `xeroPost('Payments', …)` at this instant,
 *               or may already have posted and died before writing SYNCED. Cancelling the ROW does
 *               nothing whatever to the REQUEST: it frees the unique-index slot, the replacement is
 *               queued under a different row (and so a different Idempotency-Key), and Xero receives a
 *               SECOND supplier payment. In a real ledger that is not recoverable by anything IMS does.
 *   SYNCED      the call completed. Nothing is in flight, and the poller has since told us the payment
 *               is gone from the ledger, so the row genuinely no longer describes it.
 *
 * So PROCESSING is not superseded — it is a REFUSAL. The caller must abandon the whole `mark paid`
 * (rolling back the paidAt write with it) and tell the operator to wait, exactly as deletePayment
 * already does on the sales side: it retires only PENDING rows, fenced on that status, and treats a row
 * a worker took first as one to reverse in the ledger rather than one to erase. Waiting is cheap — a
 * claim goes stale and is reclaimed, or the row lands SYNCED/FAILED — and a duplicate supplier payment
 * is not.
 *
 * FAILED and CANCELLED are still left exactly as they are. They are already outside the live predicate,
 * so they block nothing, and rewriting a FAILED row as CANCELLED would erase the fact that the ledger
 * rejected it — the evidence an operator needs, and which o3d-ju8t's "FAILED does not prove nothing
 * posted" reading depends on.
 */
export const SUPERSEDABLE_BILL_PAYMENT_STATUSES = ['PENDING', 'SYNCED'] as const

/**
 * The states in which a registration's remote call may be happening RIGHT NOW, or may have happened
 * without its result being recorded. Nothing local can recall such a request, so the only safe response
 * is to refuse to queue another one.
 */
export const IN_FLIGHT_BILL_PAYMENT_STATUSES = ['PROCESSING'] as const

export const BILL_PAYMENT_SUPERSEDED_REASON =
  'Superseded: the bill was marked unpaid (payment no longer present in the accounting connector) and ' +
  'has been paid again, so this registration no longer describes the ledger.'

export type BillPaymentSupersessionPlan<T> =
  /** At least one registration may be on the wire. Nothing may be retired and nothing may be queued. */
  | { proceed: false; refusal: 'PAYMENT_IN_FLIGHT'; inFlight: T[] }
  | { proceed: true; supersede: T[] }

export function planBillPaymentSupersession<T extends { status: string }>(
  rows: T[],
): BillPaymentSupersessionPlan<T> {
  const inFlight = rows.filter((row) => (IN_FLIGHT_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status))
  if (inFlight.length > 0) return { proceed: false, refusal: 'PAYMENT_IN_FLIGHT', inFlight }
  return {
    proceed: true,
    supersede: rows.filter((row) => (SUPERSEDABLE_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status)),
  }
}

export type BillPaymentSupersessionOutcome =
  | { outcome: 'paid'; requestedIds: string[]; retiredCount: number }
  | { outcome: 'already-paid' }
  | { outcome: 'payment-in-flight'; inFlightIds: string[] }

/**
 * Thrown by the caller to roll the enclosing transaction back when the outcome is not `paid`.
 * `payment-in-flight` can only be discovered AFTER the paidAt write (a worker can claim a row between
 * the read and the fenced retire), so the refusal has to be able to undo it — a bill left PAID in IMS
 * with its registration abandoned is the stranding this whole issue exists to prevent.
 */
export class BillPaymentSupersessionRollback extends Error {
  constructor(readonly result: BillPaymentSupersessionOutcome) {
    super(`markBillPaid rolled back: ${result.outcome}`)
    this.name = 'BillPaymentSupersessionRollback'
  }
}

/**
 * Win the `paidAt: null -> paid` transition AND retire the stale registrations in ONE transaction, or
 * do neither (o3d-a3wx round 2).
 *
 * The caller MUST roll the transaction back on any outcome other than `paid`. Splitting the two writes
 * across separate transactions is what made the first version unsafe in both directions: a bill could
 * end up paid with an in-flight registration cancelled underneath it, or paid with nothing queued.
 */
export async function markBillPaidSupersedingStaleRegistrations(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'purchaseInvoice'>,
  params: {
    invoiceId: string
    paidAt: Date
    paymentAccountId: string
    paymentAccountName: string
    paymentReference: string | null
  },
): Promise<BillPaymentSupersessionOutcome> {
  const rows = await client.accountingSyncLog.findMany({
    where: { type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: params.invoiceId },
    select: { id: true, status: true },
  })
  const plan = planBillPaymentSupersession(rows)
  if (!plan.proceed) return { outcome: 'payment-in-flight', inFlightIds: plan.inFlight.map((row) => row.id) }

  const paid = await client.purchaseInvoice.updateMany({
    where: { id: params.invoiceId, paidAt: null },
    data: {
      paidAt: params.paidAt,
      paymentAccountId: params.paymentAccountId,
      paymentAccountName: params.paymentAccountName,
      paymentReference: params.paymentReference,
    },
  })
  if (paid.count === 0) return { outcome: 'already-paid' }

  const requestedIds = plan.supersede.map((row) => row.id)
  if (requestedIds.length === 0) return { outcome: 'paid', requestedIds, retiredCount: 0 }

  // FENCED on the statuses that were read. A worker can claim a PENDING row between the findMany above
  // and this write; keying the update on the retirable statuses means such a row is NOT retired, and
  // the shortfall in `count` is how we find out.
  const retired = await client.accountingSyncLog.updateMany({
    where: { id: { in: requestedIds }, status: { in: [...SUPERSEDABLE_BILL_PAYMENT_STATUSES] } },
    data: { status: 'CANCELLED', errorMessage: BILL_PAYMENT_SUPERSEDED_REASON },
  })
  if (retired.count !== requestedIds.length) {
    // Some row moved. Only an IN-FLIGHT destination is a refusal: a row that went FAILED or CANCELLED on
    // its own has left the live predicate by itself and holds nothing, so re-payment may proceed.
    const claimed = await client.accountingSyncLog.findMany({
      where: { id: { in: requestedIds }, status: { in: [...IN_FLIGHT_BILL_PAYMENT_STATUSES] } },
      select: { id: true },
    })
    if (claimed.length > 0) return { outcome: 'payment-in-flight', inFlightIds: claimed.map((row) => row.id) }
  }
  return { outcome: 'paid', requestedIds, retiredCount: retired.count }
}
