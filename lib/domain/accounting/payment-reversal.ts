import type { Prisma } from '@/app/generated/prisma/client'

import { db } from '@/lib/db'
import {
  classifyRegisteredPaymentAgainstListing,
  databaseLedgerFence,
  databaseStampedCompletion,
  unregisteredLocalReceipts,
  type LedgerReadFence,
  type RegisteredPaymentRow,
  type RegisteredPaymentVerdict,
} from '@/lib/connectors/xero/invoice-delta'
import { storedBodyMayHaveReachedTheLedger } from '@/lib/domain/accounting/followup-idempotency'
import { payloadAccountingInvoiceId, payloadPaymentId, payloadRegisteredAmount } from '@/lib/domain/accounting/invoice-payment-enqueue'

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

// ---------------------------------------------------------------------------
// THE EVIDENCE EVERY CONNECTOR'S REVERSAL READER MUST CONSULT (o3d-psrx r3, Codex HIGH)
//
// r2 gave `SalesOrder.paidAt` a provenance column and taught the XERO poller to read it. Codex found
// the SAME rule wide open one connector over: the QuickBooks reversal candidate query selected
// neither `unregisteredPaidAt` nor any registration/receipt evidence, so every recently modified
// balance-due invoice walked straight into reversal handling — and a sale an operator marked paid by
// hand, which by design has no ledger receipt at all, satisfied that query exactly. The branch that
// exists to close "one rule, several writers, one fixed" would have shipped "one rule, two readers,
// one fixed".
//
// So the reader is written ONCE, here, and both pollers call it. What differs between Xero and
// QuickBooks is only how each ledger states its payments, and that difference is a single argument
// (`ledgerListedPaymentIds`) rather than a second implementation of the decision.
// ---------------------------------------------------------------------------

/**
 * The one instant a reversal verdict may be ordered against, measured by the DATABASE.
 *
 * MUST be read BEFORE the ledger request goes out. That ordering is this function returning before
 * the connector's HTTP call is made — program order inside one process — not a comparison of any two
 * clock values. The other end is `accounting_sync_logs."syncedAt"`, stamped by
 * `stampSyncedAtFromDatabaseClock` with the SAME expression on the SAME server; an ordering that
 * rests on two machines agreeing is not an ordering at all (o3d-clxw round 4, #634).
 *
 * NULL ON FAILURE, and null means NOTHING IS DECIDED (see classifyRegisteredPaymentAgainstListing):
 * with no fence every registration might have landed after the snapshot, so every document with one
 * withholds. Fail-closed also keeps the o3d-batch-payidx algebra: the decided set only ever shrinks.
 *
 * Shared rather than re-declared per connector for the same reason the classifier is: a fence a
 * second poller mints from `new Date()` is the defect this type is branded to prevent, and the only
 * reliable way to stop a caller reaching for `new Date()` is for there to be a correct one to import.
 */
export async function readDatabaseLedgerFence(): Promise<LedgerReadFence | null> {
  try {
    const rows = await db.$queryRaw<Array<{ fence: Date | string | null }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS fence`
    const fence = rows?.[0]?.fence
    // Normalised rather than `instanceof`-checked: a raw query can hand back a driver Date, a Date
    // from another realm, or a string, and none of those is a reason to lose the ordering. An
    // unreadable value still is.
    if (fence == null) return null
    const at = new Date(fence as string | Date).getTime()
    if (!Number.isFinite(at)) return null
    return databaseLedgerFence(new Date(at))
  } catch {
    return null
  }
}

/** A document whose paid flag is up for reversal, reduced to what the evidence read needs. */
export type PaidProvenanceDoc = {
  id: string
  accountingInvoiceId: string | null
  /**
   * o3d-psrx — present on SALES documents only. A bill has no such column, so this is `undefined` for
   * every `PurchaseInvoice` and the arm it feeds is unreachable from the bill pass, which is correct:
   * markBillPaid queues its BILL_PAYMENT registration INSIDE the paid transaction (o3d-a3wx), so a
   * bill IMS holds as paid always has a registration to be judged by.
   *
   * OPTIONAL IN THE TYPE, NEVER OPTIONAL IN THE QUERY. `undefined` here reads as "not a sales
   * document", not as "sales document we forgot to select" — those are the same value and opposite
   * facts, which is why the select itself is policed by a census
   * (tests/accounting/paid-provenance-readers.test.ts) rather than by this type.
   */
  unregisteredPaidAt?: Date | null
}

/**
 * WHAT IMS'S OWN RECORDS SAY ABOUT EACH DOCUMENT'S PAID FLAG, as a verdict per document.
 *
 * Three sources, read in an order that is deliberate and is the safe one:
 *
 *   1. the INVOICE_PAYMENT / BILL_PAYMENT registrations — what IMS has told the ledger, and whether
 *      this read can speak for the outcome (the fence).
 *   2. the local `Payment` receipts (sales only) — what IMS has RECORDED. Read AFTER the
 *      registrations, because `addPayment` commits the receipt with `paidAt` and queues the
 *      registration afterwards: reading receipts last can only ever find MORE than the registration
 *      read accounted for, which withholds. Reading them first could miss a receipt whose
 *      registration then appeared, and that answer is a reversal admitted over a receipt this poll
 *      never saw.
 *   3. `unregisteredPaidAt` on the row itself — whether the paid flag was ever going to have a ledger
 *      receipt at all. "No Payment row" is true of a WooCommerce-paid order AND of an order the
 *      ledger's own forward pass marked paid, and those need OPPOSITE answers; only the recorded
 *      provenance separates them.
 *
 * AND EVERY REGISTRATION IS WEIGHED AGAINST THE PAID STATE IT IS SUPPOSED TO BE ABOUT (r4, Codex
 * HIGH). `referenceId` groups every registration this document has ever had. Two of them are not
 * about the flag being decided: one raised against an `accountingInvoiceId` the document no longer
 * has (deleted and re-posted — o3d-hbgo's rule, on the reversal side), and one that completed before
 * the current paid episode began (paid, registered, reversed, paid again — the stale row then made
 * `posted` non-empty, which under r4's reader was precisely what stopped `unregisteredPaidAt` being
 * consulted). Both facts are already recorded, on the registration's payload and on the row; see
 * `PaidStateBinding`.
 *
 * AND WHAT POSTED IS WEIGHED AGAINST WHAT THE FLAG IS FOR (r7, Codex HIGH 1). A bound registration no
 * longer silences the marker merely by existing: while the marker stands, the classifier asks whether
 * the bound registrations COVER the document's total, which is why this reader fetches that total and
 * each registration's own recorded amount. A part-covering registration's absence is an account of
 * part of the balance, and reversing the whole of it is a chargeback credit note over money no ledger
 * ever held.
 *
 * AND THE PAYLOAD IS NOT THE ONLY WITNESS TO THE FIRST OF THEM (r5, Codex HIGH 3). A row from before
 * that field existed, or one an older release compacted to `{}`, names no document — and r4 read that
 * as "cannot be tied to any document", permanently. When the LEDGER's own listing names such a row's
 * payment on the document being examined, the ledger has answered the question directly; see
 * `registrationBindsToPaidState`. What stays unprovable is a payload-less row the ledger does NOT
 * list, because absence cannot identify a document (o3d-g7jk).
 *
 * Documents with no `accountingInvoiceId` get no verdict — there is no ledger document to disagree
 * with. A caller that finds no entry for a document must WITHHOLD, never admit: this map's absences
 * are "nothing was decided", which is the same fail-closed reading a null fence gets.
 */
export async function readPaidProvenanceVerdicts<T extends PaidProvenanceDoc>(
  docs: readonly T[],
  params: {
    /** Whose registrations these are. A reversal seen by one connector says nothing about another's rows. */
    connector: string
    registrationType: 'BILL_PAYMENT' | 'INVOICE_PAYMENT'
    referenceType: 'PurchaseInvoice' | 'SalesOrder'
    /** Database-measured instant the ledger was asked; null = nothing this read can decide. */
    ledgerObservedBefore: LedgerReadFence | null
    /**
     * The payment ids this ledger states on the document, lowercased, or NULL when the read did not
     * enumerate them. See classifyRegisteredPaymentAgainstListing — null is not emptiness.
     */
    ledgerListedPaymentIds: (doc: T) => ReadonlySet<string> | null
  },
): Promise<Map<string, RegisteredPaymentVerdict>> {
  const out = new Map<string, RegisteredPaymentVerdict>()
  const scoped = docs.filter((doc) => doc.accountingInvoiceId != null)
  if (scoped.length === 0) return out

  const rows = await db.accountingSyncLog.findMany({
    where: {
      connector: params.connector,
      type: params.registrationType,
      referenceType: params.referenceType,
      referenceId: { in: scoped.map((d) => d.id) },
    },
    // `syncedAtDatabaseClock` is selected WITH `syncedAt` and never instead of it: the fence is the
    // two agreeing, which is what makes a stamp written by an old build's host clock visible as one
    // (o3d-clxw round 5, finding 1 — see databaseStampedCompletion).
    select: {
      id: true, referenceId: true, status: true, externalTransactionId: true,
      syncedAt: true, syncedAtDatabaseClock: true,
      // o3d-psrx: the receipt this registration NAMES, so a local receipt no registration names can
      // be told from one that is already spoken for. Read through the same `payloadPaymentId` the
      // enqueue writes it with, never re-spelt here.
      payload: true,
    },
  })
  // o3d-psrx r7 (Codex HIGH 1) — WHAT EACH DOCUMENT'S PAID FLAG IS FOR, AND IN WHICH CURRENCY.
  //
  // READ HERE RATHER THAN TAKEN FROM THE CALLER'S `docs`, and that is the point. The r3 defect was a
  // poller asking a question the row could answer and never selecting the column that answers it, and
  // the reader census (tests/accounting/paid-provenance-readers.test.ts) polices exactly one column
  // against exactly one shape of query. A second connector added next month gets this for free
  // because the shared reader fetches it, where a new field on `PaidProvenanceDoc` would be one more
  // thing every poller's select has to remember.
  //
  // SALES ONLY. A `PurchaseInvoice` carries no off-ledger marker (o3d-a3wx), so the coverage guard
  // this feeds is unreachable from the bill pass and there is nothing for a total to decide.
  const documentTotals = new Map<string, { total: number; currency: string }>()
  if (params.referenceType === 'SalesOrder') {
    const orders = await db.salesOrder.findMany({
      where: { id: { in: scoped.map((d) => d.id) } },
      // `totalForeign` and NOT `totalBase`: the receipts and the registrations are both recorded in
      // the order's own currency, and this is the number `addPayment`'s coverage test compares
      // against. Comparing against a base-currency total would put an FX rate inside a reversal
      // decision. `currency` comes with it because a sum across two of them is not a sum.
      select: { id: true, totalForeign: true, currency: true },
    })
    for (const order of orders) {
      const total = Number(order.totalForeign)
      // An unreadable total is NOT zero and not "no opinion about coverage": leaving it out of the map
      // makes `documentTotal` null below, which turns the guard off — the round-6 behaviour — and that
      // is the only honest thing to do with a number that cannot be read.
      if (Number.isFinite(total)) documentTotals.set(order.id, { total, currency: order.currency })
    }
  }

  const byDocument = new Map<string, RegisteredPaymentRow[]>()
  const receiptsNamedByDocument = new Map<string, { status: string; paymentId: string | null }[]>()
  for (const row of rows) {
    const list = byDocument.get(row.referenceId) ?? []
    const documentCurrency = documentTotals.get(row.referenceId)?.currency ?? null
    list.push({
      id: row.id,
      status: row.status,
      externalTransactionId: row.externalTransactionId,
      syncedAt: row.syncedAt,
      syncedAtDatabaseClock: row.syncedAtDatabaseClock,
      // o3d-psrx r4 (Codex HIGH): WHICH LEDGER DOCUMENT this registration was raised against, read
      // through the same helper the enqueue writes it with and never re-spelt here. Selected because
      // `referenceId` alone groups every registration this order has EVER had — including one against
      // an invoice that was deleted and re-posted, which then answered for its replacement.
      //
      // r5: NULL here is "the payload cannot say", not "nothing can" — the classifier falls back to
      // the ledger's own payment listing for such a row.
      registeredAgainstInvoiceId: payloadAccountingInvoiceId(row.payload),
      // o3d-psrx r7 (Codex HIGH 1): HOW MUCH this registration told the ledger about, read through
      // the same helper the enqueue writes it with and in the DOCUMENT's currency — so a registration
      // raised in another one, or a payload that names no amount, answers null and the coverage guard
      // withholds rather than guesses. Null for a bill: no currency is resolved for one, and its
      // classifier arm never asks.
      registeredAmount: documentCurrency == null ? null : payloadRegisteredAmount(row.payload, documentCurrency),
    })
    byDocument.set(row.referenceId, list)
    const named = receiptsNamedByDocument.get(row.referenceId) ?? []
    named.push({ status: row.status, paymentId: payloadPaymentId(row.payload) })
    receiptsNamedByDocument.set(row.referenceId, named)
  }

  const receiptsByDocument = new Map<string, string[]>()
  if (params.referenceType === 'SalesOrder') {
    const payments = await db.payment.findMany({
      // `refundId: null` — a refund receipt settles a credit note, not the invoice this poll is
      // reading, so it neither owes an INVOICE_PAYMENT nor bears on the invoice's residual.
      where: { orderId: { in: scoped.map((d) => d.id) }, refundId: null },
      select: { id: true, orderId: true },
    })
    for (const payment of payments) {
      const list = receiptsByDocument.get(payment.orderId) ?? []
      list.push(payment.id)
      receiptsByDocument.set(payment.orderId, list)
    }
  }

  for (const doc of scoped) {
    out.set(doc.id, classifyRegisteredPaymentAgainstListing(
      params.ledgerListedPaymentIds(doc),
      byDocument.get(doc.id) ?? [],
      params.ledgerObservedBefore,
      unregisteredLocalReceipts(
        receiptsByDocument.get(doc.id) ?? [],
        receiptsNamedByDocument.get(doc.id) ?? [],
      ),
      // READ FROM THE ROW, not inferred from the absence of a receipt.
      doc.unregisteredPaidAt != null,
      // o3d-psrx r4 (Codex HIGH): and WHICH paid state the evidence has to be about. Both fields come
      // off the document itself — the invoice it points at now, and (for a sales order) the instant
      // this paid episode was entered with nothing to register. A registration that predates the
      // marker, or names a document this one replaced, is no longer allowed to discharge it.
      {
        accountingInvoiceId: doc.accountingInvoiceId,
        unregisteredPaidAt: doc.unregisteredPaidAt ?? null,
      },
      // o3d-psrx r7 (Codex HIGH 1): and WHAT THAT PAID FLAG IS FOR. Null for a bill and for any order
      // whose total could not be read, which leaves the verdict exactly as round 6 reached it.
      documentTotals.get(doc.id)?.total ?? null,
    ))
  }
  return out
}

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
 *   FAILED      attempted, outcome unknown (round 4 #5).            -> PAYMENT_MAY_HAVE_POSTED
 *
 * The refusals are kept apart because they ask the operator for different things: waiting, versus
 * looking the bill up in Xero, versus reconciling a failed attempt. None is a guess in either
 * direction — IMS says it does not know, and names the entry, which is the whole of the round-3 rule
 * for unknowable remote state.
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
 * FAILED and CANCELLED are never REWRITTEN. Rewriting a FAILED row as CANCELLED would erase the fact
 * that an attempt was made — the evidence an operator needs, and which o3d-ju8t's "FAILED does not
 * prove nothing posted" reading depends on.
 *
 * ROUND 4 SEPARATES "NOT REWRITTEN" FROM "HARMLESS", which round 3 ran together. Being outside the
 * live predicate means a FAILED row blocks no unique-index SLOT; it does not mean it holds no PAYMENT.
 * A FAILED row now REFUSES (PAYMENT_MAY_HAVE_POSTED) exactly as its sales-side counterpart does in
 * `invoice-payment-capacity.ts`, and is still left byte-for-byte alone. CANCELLED remains harmless:
 * every writer of that status in this tree asserts it only where "nothing was sent" is TRUE.
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

/**
 * THE STATE THAT ASSERTS NOTHING AT ALL (Codex round 4 #5).
 *
 * Round 3 established this for the SALES side and stopped there: `invoice-payment-capacity.ts` reads a
 * FAILED INVOICE_PAYMENT as making the invoice's remaining capacity UNKNOWABLE, because the processor
 * posts BEFORE it persists the result — a timeout, a lost response or a crash after the ledger created
 * the payment is written down identically to a rejection, and `errorMessage` carries no provenance
 * (both connectors overwrite `HTTP nnn` with the remote system's own text).
 *
 * NONE OF THAT REASONING IS ABOUT SALES. It is about how this system records the outcome of a money
 * call, and BILL_PAYMENT is recorded by the same processor in the same order. Yet this planner let a
 * FAILED row fall past every branch into `proceed: true` — not even counted, simply not mentioned —
 * so a bill whose payment attempt failed after Xero created the Payment was free capacity, and Mark
 * Paid queued a second supplier payment under a fresh entry id and therefore a fresh
 * Idempotency-Key. The sales side refuses that; the supplier side, where the money leaves, did not.
 *
 * The one sound exception is not a guess but a proof: a stored body missing a field the connector
 * rejects BEFORE building a request cannot have reached the ledger. That test is imported from
 * `followup-idempotency.ts` rather than re-derived, for the reason the capacity guard already gives —
 * two definitions of "nothing was sent" would disagree about whether a bill is settled, which is the
 * whole question.
 */
export const AMBIGUOUS_BILL_PAYMENT_STATUSES = ['FAILED'] as const

/**
 * Whether a registration's attempt MAY have reached the ledger. Only ever consulted for the ambiguous
 * statuses, and `false` is the one sound proof that it did not: a body that is present, readable, and
 * missing a field the connector rejects before it builds a request.
 *
 * An unreadable, absent or RETENTION-COMPACTED payload answers TRUE: not knowing what was sent is not
 * evidence that nothing was (o3d-m5qk — the compacted `{}` case is why this delegates to
 * `storedBodyMayHaveReachedTheLedger` and not to a "could this body be sent?" test).
 */
export function billPaymentBodyCouldHavePosted(payload: unknown): boolean {
  return storedBodyMayHaveReachedTheLedger('BILL_PAYMENT', payload)
}

export const BILL_PAYMENT_SUPERSEDED_REASON =
  'Superseded: the bill was marked unpaid (payment no longer present in the accounting connector) and ' +
  'has been paid again. This registration had not been sent, so nothing reached the ledger.'

export const BILL_PAYMENT_LEDGER_REVERSED_REASON =
  'Retired: the payment this registration created is no longer present on the bill in the accounting ' +
  'connector (detected by the payment reversal poller), so the row no longer describes the ledger. ' +
  'The entry posted — its external id records what it created — and is retired rather than deleted.'

// ---------------------------------------------------------------------------
// WHAT THE LEDGER CAN SETTLE ON ITS OWN (Codex round 8)
// ---------------------------------------------------------------------------
//
// The reversal pass reaches this module with a bill whose Xero invoice is no longer PAID, and rounds
// 3 and 4 built the whole retirement on the phrase "the poller has just read the bill back and found
// it no longer PAID". THAT PHRASE IS NOT A REVERSAL. Xero's ACCPAY statuses are PAID, AUTHORISED and
// VOIDED, and AUTHORISED means APPROVED AND NOT FULLY PAID — which includes a bill carrying a real
// PART payment, because Xero only moves an invoice to PAID once the outstanding amount reaches zero.
//
// So the caller's reversal set (`AUTHORISED` ∪ `VOIDED`) contains three populations that look
// identical from a status alone:
//
//   the payment was REMOVED          a genuine reversal.
//   the payment was a PART payment   money HAS left the bank. The ordinary cause is not exotic: the
//                                    bill was edited upward in Xero after IMS posted it, so the
//                                    full-total payment IMS sent leaves a balance.
//   the payment HAS NOT LANDED YET   Mark Paid set paidAt locally and queued a BILL_PAYMENT; until
//                                    the worker posts it the ledger holds nothing.
//
// AND RETIREMENT IS DESTRUCTIVE. It CANCELs the SYNCED rows that are the only record that a supplier
// payment was registered, and — in the same transaction — clears `paidAt`, which re-arms Mark Paid.
// On either of the last two populations that is a second supplier payment: markBillPaid sends no
// idempotency key, BILL_PAYMENT sits outside every live-row dedupe, and the operator is looking at an
// IMS bill that says unpaid and an activity log that says the payment is gone. Nothing downstream
// refuses them. State a destructive write clears is state a later correct answer cannot rebuild, so
// gating it on a classification known to be wrong is the wrong direction: the gate must be a PROOF.
//
// EXACTLY ONE LEDGER STATUS IS A PROOF ON ITS OWN, and it is the one o3d-batch-billpay's partition
// also settles without consulting anything else: VOIDED. Xero requires every payment to be removed
// before an invoice can be voided and refuses a payment against a voided one, so a voided invoice
// demonstrably holds no payment, and re-arming Mark Paid against it cannot move money twice (the
// re-payment is rejected by Xero, which is noise, not a supplier paid again).
//
// AUTHORISED IS NOT DECIDABLE FROM ANYTHING THIS BRANCH READS. Telling the three populations apart
// needs `AmountPaid` and the `Payments[]` list off the invoice payload, weighed against IMS's own
// registration rows — that is o3d-batch-billpay's classifier, and it is deliberately NOT re-derived
// here. Two answers to one question is the defect, not the fix. Until that classifier arrives, an
// AUTHORISED bill is WITHHELD: nothing retired, `paidAt` left set, and the disagreement reported.
//
// What withholding costs is a bill IMS keeps showing as paid, warned about on every read that sees
// it, which a human corrects in a minute. The other direction costs a supplier payment nobody can
// take back. See BillPaymentRetirementOutcome for what the caller does with each answer.
export const LEDGER_SETTLED_REVERSAL_STATUSES = ['VOIDED'] as const

/**
 * Does the ledger's own status, with no further evidence, PROVE the payment is gone?
 *
 * The single definition of that question in this tree, and deliberately the narrowest one that is
 * sound. It is the same rule as `partitionPaymentReversals`'s `voided` bucket on the sibling branch —
 * when that lands, the widening (a stated zero paid whose registrations the read can account for, or
 * a registered PaymentID proved absent from the invoice's own list) belongs to ITS classifier, handed
 * in here as further admissible proofs. It must never be re-derived at a call site.
 *
 * Null/undefined answers FALSE: a status nobody could read is not a status that proves anything.
 */
export function ledgerAloneProvesTheReversal(ledgerStatus: string | null | undefined): boolean {
  return (
    typeof ledgerStatus === 'string'
    && (LEDGER_SETTLED_REVERSAL_STATUSES as readonly string[]).includes(ledgerStatus)
  )
}

/**
 * THE FURTHER ADMISSIBLE PROOFS, NOW THAT THE CLASSIFIER HAS LANDED (o3d-m5qk; o3d-clxw merged as #634).
 *
 * Round 8 wrote that AUTHORISED "is not decidable from anything this branch reads", and that the
 * widening "belongs to ITS classifier, handed in here as further admissible proofs — it must never be
 * re-derived at a call site". Both halves are now true at once, so this is that hand-in: the caller
 * names WHICH of the classifier's buckets the document came out of, and nothing about the ledger is
 * re-read or re-judged here.
 *
 * Each value is a verdict `partitionPaymentReversals` + `classifyRegisteredPayment` +
 * `zeroPaidIsProvenReversal` already reached, and each is at least as strong as the status rule:
 *
 *   ZERO_PAID_REGISTRATIONS_ACCOUNTED  the ledger STATED it holds nothing, and this read could account
 *                                      for every registration IMS has — so the zero is not a payment of
 *                                      ours that has yet to land. (A zero with an in-flight or
 *                                      unstamped registration is in NO bucket; it is withheld.)
 *   REGISTERED_PAYMENT_ABSENT          the ledger listed its payments and the PaymentID IMS registered
 *                                      is not among them. It holds money, but not ours.
 *
 * `null` = the caller has no classifier verdict, and then only the status decides. That is the state
 * this branch shipped in, so nothing gets weaker by a caller staying silent.
 */
export type LedgerClassifierProof =
  | 'ZERO_PAID_REGISTRATIONS_ACCOUNTED'
  | 'REGISTERED_PAYMENT_ABSENT'

/**
 * The ONE place that decides whether a reversal is proved, over everything the caller has.
 *
 * Still one definition, still applied at the destructive write so no caller can skip it — the change
 * is what counts as evidence, not who weighs it.
 */
export function reversalIsProven(evidence: {
  ledgerStatus: string | null
  classifierProof: LedgerClassifierProof | null
}): boolean {
  return ledgerAloneProvesTheReversal(evidence.ledgerStatus) || evidence.classifierProof != null
}

/**
 * RETIRE THE REGISTRATIONS A LEDGER READ HAS JUST DISPROVED (Codex round 3 #1).
 *
 * Called from the payment poller's reversal pass, in the SAME transaction that clears the bill's
 * paidAt, at the one moment in the system where "the ledger no longer holds this payment" is an
 * observation rather than an inference. Retiring here is what lets markBillPaid refuse everything it
 * cannot prove: the ordinary reversal-then-re-pay flow arrives with no live row at all, so the refusal
 * only ever fires on the cases nobody has looked at.
 *
 * FENCED FOUR WAYS, AND THE FIRST ONE IS NEW (Codex round 8):
 *
 *  - `reversalIsProven` — the reversal itself has to be PROVED before anything is read, let alone
 *    written. Rounds 3–7 took "the caller selected this bill into its reversal set" as the
 *    observation, and the caller's set was `AUTHORISED` ∪ `VOIDED` — which is "not fully paid", not
 *    "the payment is gone". A part-paid bill therefore walked into the destructive path. The proof is
 *    now either the ledger's own status (`LEDGER_SETTLED_REVERSAL_STATUSES`, i.e. VOIDED) or a verdict
 *    the merged classifier reached (`LedgerClassifierProof`); anything else is WITHHELD, and it is
 *    checked FIRST so an unproven bill never even reaches the registration query.
 *  - `status: 'SYNCED'` — only a row that finished. A PENDING row is a re-payment somebody has already
 *    queued and a PROCESSING row may be posting this instant; neither is the payment the poller just
 *    failed to find, and cancelling either is round 1's defect over again.
 *  - `databaseStampedCompletion(row) < ledgerObservedBefore.databaseClock` — only a row that had
 *    already posted when the ledger snapshot this verdict came from was taken. A row that synced
 *    afterwards may have created a payment the snapshot never saw, so "not present" says nothing
 *    about it. Such a row is REPORTED as undecided (round 4 #2) rather than filtered away, and the
 *    whole verdict is withheld: see the note in the body for why abandoning it was worse than
 *    refusing to decide.
 *  - `connector` — a reversal seen by one connector says nothing about another's rows.
 *
 * CANCELLED, not deleted, and the errorMessage says the row DID post: o3d-sref's rule is that
 * CANCELLED must never be asserted where "nothing was sent" would be false, and it is the reason
 * string that carries which of the two happened.
 */
export type BillPaymentRetirementOutcome =
  /** The observation covered every posted registration on this bill. `retired` may be 0: there were none. */
  | { decided: true; retired: number }
  /**
   * At least one posted registration finished AFTER the ledger was read, so this observation cannot
   * speak for it. NOTHING is retired and the caller must NOT clear paidAt — see the note below.
   */
  | { decided: false; withheld: 'REGISTRATION_UNDECIDED'; undecided: string[] }
  /**
   * The ledger status does not prove a reversal AT ALL (Codex round 8) — an AUTHORISED bill is
   * "approved and not fully paid", which a part payment and an unposted registration of ours both
   * produce. NOTHING is retired, NOTHING is read, and the caller must NOT clear paidAt.
   *
   * A distinct answer from REGISTRATION_UNDECIDED because it asks the operator for something else:
   * that one resolves itself once a later read covers the registrations, this one needs somebody to
   * look at the bill in Xero (or the sibling's amount/identity classifier to land).
   */
  | { decided: false; withheld: 'REVERSAL_UNPROVEN'; ledgerStatus: string | null }

export async function retireBillPaymentRegistrationsReversedInLedger(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  params: {
    connector: string
    invoiceId: string
    /**
     * The status the LEDGER reports for this invoice on the read that produced this verdict, verbatim
     * — a fact, not a judgement. The caller must not pre-classify it: `ledgerAloneProvesTheReversal`
     * is the one place that decides what a status proves, and it is applied here, at the destructive
     * write, so no caller can skip it.
     */
    ledgerStatus: string | null
    /**
     * Which of the merged classifier's proved-reversal buckets this document came from, or null when
     * the caller has no such verdict and only the status may decide. Never re-derived here — see
     * `reversalIsProven`.
     */
    classifierProof: LedgerClassifierProof | null
    /**
     * The instant the ledger was asked, AS THE DATABASE MEASURED IT — never a host `Date`, which is
     * why this is the branded `LedgerReadFence` and not a plain one (o3d-clxw round 4, #634). NULL
     * means the database clock could not be read at all, and then this observation can be ordered
     * against nothing: every registration is undecidable and the verdict is withheld.
     */
    ledgerObservedBefore: LedgerReadFence | null
  },
): Promise<BillPaymentRetirementOutcome> {
  // PROVE THE REVERSAL BEFORE READING ANYTHING (Codex round 8). Ordered first on purpose: an
  // unproven bill must not reach the registration query, so there is no path on which an AUTHORISED
  // bill's rows are surveyed, let alone cancelled.
  //
  // The caller's own selection is deliberately NOT the proof (that was the defect), but the caller's
  // CLASSIFIER VERDICT is admissible and is named here rather than inferred — see reversalIsProven.
  if (!reversalIsProven({ ledgerStatus: params.ledgerStatus, classifierProof: params.classifierProof })) {
    return { decided: false, withheld: 'REVERSAL_UNPROVEN', ledgerStatus: params.ledgerStatus ?? null }
  }

  const scope = {
    connector: params.connector,
    type: 'BILL_PAYMENT' as const,
    referenceType: 'PurchaseInvoice',
    referenceId: params.invoiceId,
    status: { in: [...POSTED_BILL_PAYMENT_STATUSES] },
  }

  // ASK WHAT THIS OBSERVATION CANNOT SPEAK FOR, BEFORE ACTING ON WHAT IT CAN (Codex round 4 #2).
  //
  // Round 3 expressed the fence as a filter — `syncedAt < ledgerObservedBefore` inside the update —
  // so a row outside it was not merely skipped, it was INVISIBLE. The poller cleared paidAt anyway,
  // the bill dropped out of `paidAt: { not: null }`, and with it out of the ONLY query that ever
  // produces another reversal observation for that document. The row then refused every future Mark
  // Paid, forever, with nothing anywhere recording why. A registration was retired or it was
  // silently abandoned, and the two were indistinguishable from the outside.
  //
  // `syncedAt: null` is undecidable deliberately: a posted row with no timestamp cannot be placed
  // relative to the read at all, which is the same answer, not a lesser one.
  //
  // THE ALGEBRA WITH o3d-batch-billpay, WHICH MERGED AS #634. That branch admits a bill only when
  // `classifyRegisteredPayment` returned GONE, NOTHING_REGISTERED or LEDGER_DID_NOT_LIST_PAYMENTS, and
  // all three require its `undecided` list to be empty — i.e. every non-CANCELLED registration is
  // SYNCED, carries an external id, and has a DATABASE-STAMPED completion strictly below the fence.
  // This predicate is now the exact complement over the same rows, judged by the same reader, so when
  // the sibling admits, this set is NECESSARILY EMPTY and the two cannot disagree in the unsafe
  // direction. The remaining disagreement runs the other way — this branch withholds on a VOIDED bill
  // whose registration is undecidable while the sibling's voided bucket admits it — and shrinking the
  // decided set is the direction both branches allow.
  //
  // ONE ANSWER TO "DID THIS REACH THE LEDGER", NOT TWO (o3d-m5qk). This used to be a Prisma predicate
  // — `OR: [{ syncedAt: null }, { syncedAt: { gte: fence } }]` — reading `syncedAt` ALONE. The sibling
  // o3d-clxw (#634) proved that column cannot answer the question by itself: an old build writes its
  // own host's `new Date()` into it, and comparing that against a database fence is the cross-host
  // comparison that clears paidAt over a payment still in flight and pays the supplier twice. Its
  // answer is `databaseStampedCompletion`, which accepts a completion instant only while
  // `syncedAtDatabaseClock` still equals `syncedAt` — an equality the trigger in migration
  // 20260821090000 maintains by CLEARING the marker whenever a statement changes status / syncedAt /
  // externalTransactionId / processingStartedAt without minting a new one. A legacy write therefore
  // loses provenance because of WHAT IT TOUCHED, not because of the value it happened to write.
  //
  // The old predicate treated such a row as DECIDABLE where the merged branch withholds. That
  // direction was safe under the round-8 proof gate above — only a VOIDED bill reaches here, and the
  // ledger has already proved a voided bill holds no payment — but it was WEAKER, and two guards
  // answering one money question differently is the defect this branch spent eight rounds removing
  // everywhere else. So the rows are read and judged by the SAME function that decides it on the
  // sibling, and the decided set can only shrink.
  const posted = await client.accountingSyncLog.findMany({
    where: scope,
    select: { id: true, syncedAt: true, syncedAtDatabaseClock: true },
  })
  const fence = params.ledgerObservedBefore
  const undecidable = posted.filter((row) => {
    // NULL FENCE = NOTHING IS DECIDED, exactly as classifyRegisteredPayment reads it.
    if (fence == null) return true
    const completedAt = databaseStampedCompletion(row)
    // STRICTLY before, matching the sibling's comparison at the tie as well as away from it.
    return completedAt == null || completedAt.getTime() >= fence.databaseClock.getTime()
  })
  if (undecidable.length > 0) {
    // ALL OR NOTHING, per BILL. Retiring the decidable siblings and abandoning the rest would leave
    // the bill in a state that reads as fully reconciled while one registration's payment may be
    // sitting in the ledger unaccounted for. When a later observation arrives — one taken after every
    // one of these rows finished — it decides them together.
    return {
      decided: false,
      withheld: 'REGISTRATION_UNDECIDED',
      undecided: undecidable.map((row) => row.id),
    }
  }

  // By id, and STILL SCOPED: `scope` pins the status, so a row that changed underneath the read is
  // not retired on the strength of a survey that no longer describes it. Re-expressing the fence as a
  // second `syncedAt` predicate here would be the second answer this function just deleted.
  const retired = await client.accountingSyncLog.updateMany({
    where: { ...scope, id: { in: posted.map((row) => row.id) } },
    data: { status: 'CANCELLED', errorMessage: BILL_PAYMENT_LEDGER_REVERSED_REASON },
  })
  return { decided: true, retired: retired.count }
}

export type BillPaymentSupersessionRefusal =
  /** A registration is CLAIMED — its remote call may be happening right now. */
  | 'PAYMENT_IN_FLIGHT'
  /** A registration has POSTED and no ledger observation has retired it. */
  | 'PAYMENT_ALREADY_POSTED'
  /**
   * A registration FAILED, and a failed money call is not evidence that nothing reached the ledger
   * (Codex round 4 #5). Whether this bill is already settled cannot be determined from here at all.
   */
  | 'PAYMENT_MAY_HAVE_POSTED'
  /** A registration changed status between the survey and the fenced write, so its outcome is open. */
  | 'PAYMENT_STATE_CHANGED'

/** What the planner needs to know about one registration. */
export type BillPaymentSupersessionRow = {
  status: string
  /**
   * Only consulted for AMBIGUOUS_BILL_PAYMENT_STATUSES. `false` is the one sound proof that an attempt
   * never reached the ledger; produced by `billPaymentBodyCouldHavePosted`, never hand-rolled.
   */
  bodyCouldHavePosted: boolean
}

export type BillPaymentSupersessionPlan<T> =
  /** Nothing may be retired and nothing may be queued. */
  | {
      proceed: false
      refusal: 'PAYMENT_IN_FLIGHT' | 'PAYMENT_ALREADY_POSTED' | 'PAYMENT_MAY_HAVE_POSTED'
      blocking: T[]
    }
  | { proceed: true; supersede: T[] }

/**
 * ORDER OF REPORTING, and why it does not change the outcome. All three refusals do the identical
 * thing — nothing retired, nothing queued — so the order is purely about what the operator is told
 * first. IN-FLIGHT leads because it is the only one that resolves on its own (wait, then look).
 * ALREADY-POSTED next: look in the ledger, the payment is probably there. MAY-HAVE-POSTED last
 * because it is the most static and the most work to clear.
 *
 * A FAILED row whose stored body could NOT have been sent blocks nothing — that is a proof, not a
 * guess, and it is the only exemption this planner grants.
 */
export function planBillPaymentSupersession<T extends BillPaymentSupersessionRow>(
  rows: T[],
): BillPaymentSupersessionPlan<T> {
  const inFlight = rows.filter((row) => (IN_FLIGHT_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status))
  if (inFlight.length > 0) return { proceed: false, refusal: 'PAYMENT_IN_FLIGHT', blocking: inFlight }
  const posted = rows.filter((row) => (POSTED_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status))
  if (posted.length > 0) return { proceed: false, refusal: 'PAYMENT_ALREADY_POSTED', blocking: posted }
  const ambiguous = rows.filter(
    (row) =>
      (AMBIGUOUS_BILL_PAYMENT_STATUSES as readonly string[]).includes(row.status)
      && row.bodyCouldHavePosted,
  )
  if (ambiguous.length > 0) return { proceed: false, refusal: 'PAYMENT_MAY_HAVE_POSTED', blocking: ambiguous }
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

/**
 * Thrown by the caller when the accounting queue DECLINES to write a BILL_PAYMENT row for a bill that
 * the ledger already holds (Codex round 4 #4). Carries the ledger id because that — not the bill's IMS
 * id — is what an operator looks the document up by when they go to settle it there.
 *
 * A separate class from `BillPaymentSupersessionRollback` because it is a different kind of event: not
 * a refusal derived from the registrations, but a queue that would not accept the work. It rolls the
 * transaction back for the same reason all the same.
 */
export class BillPaymentEnqueueDeclined extends Error {
  constructor(readonly accountingInvoiceId: string) {
    super(`The accounting queue declined a BILL_PAYMENT for ledger invoice ${accountingInvoiceId}`)
    this.name = 'BillPaymentEnqueueDeclined'
  }
}

export const BILL_PAYMENT_ENQUEUE_DECLINED_MESSAGE =
  'This bill has already been posted to the accounting connector, but the connector would not accept '
  + 'a payment for it — accounting sync, or bill-payment posting specifically, is switched off. '
  + 'Marking the bill paid now would leave the ledger showing it outstanding with nothing queued to '
  + 'correct that, so nothing was changed. Turn bill-payment posting back on and try again, or record '
  + 'the payment in the ledger by hand.'

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
    case 'PAYMENT_MAY_HAVE_POSTED':
      return 'A payment registration for this bill FAILED, and a failed registration is NOT proof '
        + 'that nothing reached the accounting connector — the payment may have been created and the '
        + 'response lost. IMS therefore cannot tell whether this bill is already settled, and will '
        + 'not guess with a supplier payment. Nothing was changed. Open the bill in the connector: if '
        + 'the failed payment is there, the bill is settled and nothing more is needed; if it is not, '
        + 'cancel that sync entry and mark the bill paid again.'
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
  const surveyed = await client.accountingSyncLog.findMany({
    where: { type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: params.invoiceId },
    // The payload is read for ONE purpose: to ask whether a FAILED row's stored body was complete
    // enough for its connector to have sent it. That is the only exemption the planner grants, and
    // it is answered by the shared definition, never by re-reading fields here.
    select: { id: true, status: true, payload: true },
  })
  const rows = surveyed.map((row) => ({
    id: row.id,
    status: row.status,
    bodyCouldHavePosted: billPaymentBodyCouldHavePosted(row.payload),
  }))
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
