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
 * UNSETTLED. If a BILL_PAYMENT row exists at that moment, the two statements contradict each other.
 * The row joined accounting_sync_logs_followup_live_unique, keyed by (connector, type, reference,
 * accountingInvoiceId), so left in place a stale live row occupies the slot and REFUSES the legitimate
 * re-payment: the bill marked paid in IMS with nothing queued, and the constraint meant to stop a
 * double payment stranding a real one instead.
 *
 * ROUND 1 retired PENDING, PROCESSING and SYNCED alike, on the reasoning that FAILED/CANCELLED are the
 * ledger's evidence and everything else is stale. ROUND 2 pulled PROCESSING out: a claimed row is not
 * stale evidence, it is a REQUEST THAT MAY BE ON THE WIRE, and cancelling the ROW does nothing
 * whatever to the REQUEST — it frees the unique-index slot, the replacement is queued under a
 * different row (and so a different Idempotency-Key, since BILL_PAYMENT derives its token from the
 * entry id), and Xero receives a SECOND supplier payment.
 *
 * ROUND 3: SYNCED WAS THE SAME MISTAKE, ONE STEP LATER (Codex round 3 #1).
 *
 * Round 2 left SYNCED in the retirable set, on the reading that "the call completed, and the poller
 * has since told us the payment is gone from the ledger, so the row genuinely no longer describes it".
 * The first half is a fact about the ROW. The second half is an ASSUMPTION about a poller run that
 * may never have happened — and the refusal round 2 wrote leads an operator straight into it:
 *
 *     markBillPaid refuses on PROCESSING and says "wait for that sync entry to finish (it will end up
 *     synced or failed), then try again". The worker was slow, not dead. It posts, and writes SYNCED.
 *     The operator does exactly as instructed and tries again. Now the row is SYNCED, round 2 calls it
 *     stale, cancels it, and queues a replacement under a fresh token — a SECOND supplier payment,
 *     against a bill that was correctly paid ninety seconds ago.
 *
 * A CLAIM CUTOFF CANNOT TELL "DEAD" FROM "SLOW THEN FINISHED", because it measures elapsed time and
 * the difference is not a duration. Nothing local can tell them apart, and this module must stop
 * trying. What CAN tell them apart is a look at the ledger — and exactly one component ever takes
 * one: the payment poller. So the retirement moves to the poller, where it is a RECORD OF AN
 * OBSERVATION rather than an inference from a status:
 *
 *   retireBillPaymentRegistrationsReversedInLedger  runs in the reversal pass, in the same
 *                                                   transaction that clears paidAt, having just read
 *                                                   the invoice back from Xero as no longer paid.
 *
 * and markBillPaid is left with only what it can prove on its own:
 *
 *   PENDING   provably PRE-CALL. No worker has claimed it, so nothing was sent, and cancelling it IS
 *             the whole event. This is the same line deletePayment and the o3d-sref orphan sweep draw.
 *   PROCESSING  may be on the wire RIGHT NOW.                       -> PAYMENT_IN_FLIGHT
 *   SYNCED      posted, and no ledger observation has retired it.   -> PAYMENT_ALREADY_POSTED
 *
 * The two refusals are kept apart because they ask the operator for different things: waiting, versus
 * looking the bill up in Xero. Neither is a guess in either direction — IMS says it does not know, and
 * names the entry, which is the whole of the round-3 rule for unknowable remote state.
 *
 * WHAT THIS COSTS, PLAINLY. A SYNCED registration that IS genuinely stale but whose retirement the
 * poller never made — a reversal detected by a connector whose poller does not do this, a poll cycle
 * that errored, a row synced after the ledger snapshot was taken — now refuses instead of quietly
 * re-paying. Clearing it needs a human: reconcile the bill in Xero, then CANCEL that sync entry, which
 * takes it out of the live predicate without destroying the evidence that it posted. That is verbatim
 * the resolution protocol migration 20260819120000 already prescribes for a live-row collision, for
 * the same reason: these are rows recording money that may already have moved, and picking a survivor
 * for the operator is a guess about which payment is real.
 *
 * FAILED and CANCELLED are still left exactly as they are. They are already outside the live
 * predicate, so they block nothing, and rewriting a FAILED row as CANCELLED would erase the fact that
 * the ledger rejected it — the evidence an operator needs, and which o3d-ju8t's "FAILED does not prove
 * nothing posted" reading depends on.
 */
export const SUPERSEDABLE_BILL_PAYMENT_STATUSES = ['PENDING'] as const

/**
 * The states in which a registration's remote call may be happening RIGHT NOW. Nothing local can
 * recall such a request, so the only safe response is to refuse to queue another one.
 */
export const IN_FLIGHT_BILL_PAYMENT_STATUSES = ['PROCESSING'] as const

/**
 * The state in which a registration's remote call HAS happened. Whether the ledger still holds what it
 * created is a question only a ledger read can answer, and this module never takes one.
 */
export const POSTED_BILL_PAYMENT_STATUSES = ['SYNCED'] as const

export const BILL_PAYMENT_SUPERSEDED_REASON =
  'Superseded: the bill was marked unpaid (payment no longer present in the accounting connector) and ' +
  'has been paid again. This registration had not been sent, so nothing reached the ledger.'

export const BILL_PAYMENT_LEDGER_REVERSED_REASON =
  'Retired: the payment this registration created is no longer present on the bill in the accounting ' +
  'connector (detected by the payment reversal poller), so the row no longer describes the ledger. ' +
  'The entry posted — its external id records what it created — and is retired rather than deleted.'

/**
 * RETIRE THE REGISTRATIONS A LEDGER READ HAS JUST DISPROVED (Codex round 3 #1).
 *
 * Called from the payment poller's reversal pass, in the SAME transaction that clears the bill's
 * paidAt, at the one moment in the system where "the ledger no longer holds this payment" is an
 * observation rather than an inference. Retiring here is what lets markBillPaid refuse everything it
 * cannot prove: the ordinary reversal-then-re-pay flow arrives with no live row at all, so the refusal
 * only ever fires on the cases nobody has looked at.
 *
 * FENCED THREE WAYS:
 *
 *  - `status: 'SYNCED'` — only a row that finished. A PENDING row is a re-payment somebody has already
 *    queued and a PROCESSING row may be posting this instant; neither is the payment the poller just
 *    failed to find, and cancelling either is round 1's defect over again.
 *  - `syncedAt < ledgerObservedBefore` — only a row that had already posted when the ledger snapshot
 *    this verdict came from was taken. A row that synced afterwards may have created a payment the
 *    snapshot never saw, so "not present" says nothing about it. A row with no syncedAt at all is
 *    excluded by the comparison, which is the safe direction: it falls through to markBillPaid's
 *    refusal and a human, rather than being retired on an unknown timestamp.
 *  - `connector` — a reversal seen by one connector says nothing about another's rows.
 *
 * CANCELLED, not deleted, and the errorMessage says the row DID post: o3d-sref's rule is that
 * CANCELLED must never be asserted where "nothing was sent" would be false, and it is the reason
 * string that carries which of the two happened.
 */
export async function retireBillPaymentRegistrationsReversedInLedger(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  params: { connector: string; invoiceId: string; ledgerObservedBefore: Date },
): Promise<number> {
  const retired = await client.accountingSyncLog.updateMany({
    where: {
      connector: params.connector,
      type: 'BILL_PAYMENT',
      referenceType: 'PurchaseInvoice',
      referenceId: params.invoiceId,
      status: { in: [...POSTED_BILL_PAYMENT_STATUSES] },
      syncedAt: { lt: params.ledgerObservedBefore },
    },
    data: { status: 'CANCELLED', errorMessage: BILL_PAYMENT_LEDGER_REVERSED_REASON },
  })
  return retired.count
}

export type BillPaymentSupersessionRefusal =
  /** A registration is CLAIMED — its remote call may be happening right now. */
  | 'PAYMENT_IN_FLIGHT'
  /** A registration has POSTED and no ledger observation has retired it. */
  | 'PAYMENT_ALREADY_POSTED'
  /** A registration changed status between the survey and the fenced write, so its outcome is open. */
  | 'PAYMENT_STATE_CHANGED'

export type BillPaymentSupersessionPlan<T> =
  /** Nothing may be retired and nothing may be queued. */
  | { proceed: false; refusal: 'PAYMENT_IN_FLIGHT' | 'PAYMENT_ALREADY_POSTED'; blocking: T[] }
  | { proceed: true; supersede: T[] }

/**
 * IN-FLIGHT IS REPORTED AHEAD OF POSTED when both are present, because it is the more urgent thing for
 * an operator to know and the only one that changes on its own. It makes no difference to the outcome:
 * either way nothing is retired and nothing is queued.
 */
export function planBillPaymentSupersession<T extends { status: string }>(
  rows: T[],
): BillPaymentSupersessionPlan<T> {
  const inFlight = rows.filter((row) => (IN_FLIGHT_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status))
  if (inFlight.length > 0) return { proceed: false, refusal: 'PAYMENT_IN_FLIGHT', blocking: inFlight }
  const posted = rows.filter((row) => (POSTED_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status))
  if (posted.length > 0) return { proceed: false, refusal: 'PAYMENT_ALREADY_POSTED', blocking: posted }
  return {
    proceed: true,
    supersede: rows.filter((row) => (SUPERSEDABLE_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status)),
  }
}

export type BillPaymentSupersessionOutcome =
  | { outcome: 'paid'; requestedIds: string[]; retiredCount: number }
  | { outcome: 'already-paid' }
  | { outcome: 'refused'; refusal: BillPaymentSupersessionRefusal; blockingIds: string[] }

/**
 * Thrown by the caller to roll the enclosing transaction back when the outcome is not `paid`.
 * A refusal can only be discovered AFTER the paidAt write in the PAYMENT_STATE_CHANGED case (a worker
 * can claim a row between the read and the fenced retire), so the refusal has to be able to undo it —
 * a bill left PAID in IMS with its registration abandoned is the stranding this whole issue exists to
 * prevent.
 */
export class BillPaymentSupersessionRollback extends Error {
  constructor(readonly result: BillPaymentSupersessionOutcome) {
    super(`markBillPaid rolled back: ${result.outcome}`)
    this.name = 'BillPaymentSupersessionRollback'
  }
}

/** What an operator has to do about each refusal, in the words they will see. */
export function billPaymentRefusalMessage(refusal: BillPaymentSupersessionRefusal): string {
  switch (refusal) {
    case 'PAYMENT_IN_FLIGHT':
      return 'A payment registration for this bill is still being sent to the accounting connector, '
        + 'and IMS cannot recall a request already in flight. Marking the bill paid now could register '
        + 'the payment twice. Wait for that sync entry to finish, then check the bill in the '
        + 'connector before trying again — if the payment is there, the bill is already settled.'
    case 'PAYMENT_ALREADY_POSTED':
      return 'A payment for this bill has already been registered with the accounting connector, and '
        + 'IMS has no evidence that the connector has since lost it. Registering another one would pay '
        + 'the supplier twice, and that cannot be undone from IMS. Open the bill in the connector: if '
        + 'the payment is there, the bill is settled and nothing more is needed; if it is genuinely '
        + 'gone, cancel that sync entry and mark the bill paid again.'
    case 'PAYMENT_STATE_CHANGED':
      return 'A payment registration for this bill was picked up by the sync worker while this bill '
        + 'was being marked paid, so IMS cannot tell whether it reached the accounting connector. '
        + 'Nothing was changed. Check that sync entry, then try again.'
  }
}

/**
 * Win the `paidAt: null -> paid` transition AND retire the pre-call registrations in ONE transaction,
 * or do neither (o3d-a3wx round 2).
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
  if (!plan.proceed) {
    return { outcome: 'refused', refusal: plan.refusal, blockingIds: plan.blocking.map((row) => row.id) }
  }

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

  // FENCED on PENDING, the status these rows were READ at. The read is not FOR UPDATE, so a worker can
  // claim one between the findMany above and this write; naming the read status means such a row is
  // NOT retired, and the shortfall in `count` is how we find out.
  const retired = await client.accountingSyncLog.updateMany({
    where: { id: { in: requestedIds }, status: { in: [...SUPERSEDABLE_BILL_PAYMENT_STATUSES] } },
    data: { status: 'CANCELLED', errorMessage: BILL_PAYMENT_SUPERSEDED_REASON },
  })
  if (retired.count !== requestedIds.length) {
    // SOME ROW MOVED, AND EVERY DESTINATION IS A REFUSAL (Codex round 3 #1 and #3).
    //
    // Round 2 asked only whether the row had gone IN-FLIGHT, and let FAILED through on the reasoning
    // that a row which left the live predicate by itself "holds nothing". It does not hold a live
    // slot; that is not the same as holding no payment. A PENDING row only reaches FAILED by being
    // claimed and attempted, and an attempt that failed is exactly the state o3d-ju8t established
    // proves nothing about the ledger — the payment may have been created and the response lost.
    // SYNCED is worse still. So the question is not WHERE it went but THAT it went: a row that
    // changed under us was acted on by a worker, and what that worker sent is not knowable from here.
    //
    // The only destination that is not a refusal is CANCELLED (someone else retired it pre-call, so
    // nothing was sent) and disappearance (retention deleted a row that had never been claimed).
    // Refusing costs one attempt: the row now records its own outcome, and the next try sees it in the
    // survey where it is judged on what it says.
    const moved = await client.accountingSyncLog.findMany({
      where: { id: { in: requestedIds }, status: { not: 'CANCELLED' } },
      select: { id: true },
    })
    if (moved.length > 0) {
      return { outcome: 'refused', refusal: 'PAYMENT_STATE_CHANGED', blockingIds: moved.map((row) => row.id) }
    }
  }
  return { outcome: 'paid', requestedIds, retiredCount: retired.count }
}
