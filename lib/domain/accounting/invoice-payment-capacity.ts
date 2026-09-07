/**
 * OVER-SETTLEMENT REFUSED WHERE IT CANNOT BE BYPASSED (o3d-cjt8, round 2).
 *
 * THE HISTORY. `accounting_sync_logs_followup_live_unique` used to permit exactly ONE live
 * INVOICE_PAYMENT row per ORDER. That key named the wrong artefact — a Xero Payment is per RECEIPT
 * against a DOCUMENT, so a deposit and a balance are two payments, not one — and the migration
 * 20260819120000 rescoped it to (…, accountingInvoiceId, paymentId). Correct, but it also stopped the
 * database preventing an ORDER from being over-settled by several receipts, because "the parts must not
 * exceed the whole" is arithmetic and no unique index can express it.
 *
 * That arithmetic moved into `decideInvoicePaymentRegistration`, re-run under the order row lock at the
 * one enqueue path that takes it. The stated assumption was that EVERY INVOICE_PAYMENT enqueue takes
 * `lockSalesOrder`. It does not, and the counter-example was already in the tree: the imported-order
 * path (`enqueueSalesInvoiceFollowUps`'s `_registerPayment` branch) enqueues a payment straight after a
 * SALES_INVOICE posts, with no order lock and no capacity arithmetic at all. So over-settlement
 * protection ended up WEAKER than the index it replaced (Codex, round 2 #2).
 *
 * THE FIX IS NOT A THIRD CALL SITE. An enqueue-time guard is only as good as the roll-call of enqueue
 * paths, and that roll-call has already been wrong once. What is not a roll-call is the POST:
 *
 *   every INVOICE_PAYMENT that reaches the ledger — from `addPayment`, from the deferred-receipt
 *   re-drive, from the imported-order follow-up, from a repair sweep, from a path written next year —
 *   must pass through its connector's INVOICE_PAYMENT case to make the remote call.
 *
 * So the capacity arithmetic is enforced THERE, immediately before `xeroPost('Payments', …)`. A new
 * enqueue path cannot skip it by forgetting anything, because it is not on the enqueue path at all.
 * The enqueue-time check in `registerInvoicePaymentWithLedger` stays, demoted to what it is actually
 * good at: giving the operator an immediate, actionable message at the moment they record the receipt,
 * rather than a silent refusal minutes later.
 *
 * WHAT COUNTS AS CAPACITY ALREADY USED, AT POST TIME. Only rows that have ACTUALLY POSTED — SYNCED.
 * This is deliberately different from the enqueue-time rule, and the difference is the point:
 *
 *   SYNCED             money moved. It consumes the invoice.
 *   PENDING/PROCESSING queued, not posted. Counting these would refuse the FIRST receipt of a deposit +
 *                      balance pair because its sibling is sitting in the queue behind it — and it is
 *                      safe not to count them, because `findInvoicePaymentsBlockedByEarlierLiveLogs`
 *                      serialises INVOICE_PAYMENT entries per reference: only the earliest live entry
 *                      for an order is ever un-deferred, so no sibling can be posting alongside us. The
 *                      later one re-runs this guard against our SYNCED row when its turn comes.
 *   CANCELLED          frees the capacity again. That USED to rest on "every writer of this status in
 *                      the tree asserts it only where nothing was sent is TRUE" (o3d-sref;
 *                      retireOverSettlingInvoicePayment runs BEFORE the remote call). SINCE o3d-nf9i
 *                      THAT SENTENCE IS FALSE and must not be relied on again: the per-row settlement
 *                      action writes CANCELLED on an OPERATOR'S ASSERTION that nothing posted, with
 *                      settlementBasis='OPERATOR_ASSERTION' and no remote call behind it at all.
 *                      Capacity is still freed, deliberately (o3d-anu8): the FAILED row it replaces
 *                      refuses every later receipt for ever via AMBIGUOUS_FAILED_REGISTRATION, and
 *                      giving that a way out — audited, named, with the operator's identity on it —
 *                      is the whole point of the settlement action. What changes is only that the
 *                      justification is now "a human took responsibility", not "the code can prove
 *                      it", and the next reader must not re-derive a proof from the status.
 *   FAILED             NEITHER. See below — this is the round 3 correction.
 *
 * A FAILED MONEY ROW IS NOT EVIDENCE THAT NOTHING POSTED (Codex round 3 #3).
 *
 * Round 2 put FAILED in the same bucket as CANCELLED, reasoning that counting it would strand every
 * later receipt behind a permanently failed one, and that the residual was covered by the pinned
 * remote idempotency token (o3d-h2wx). Both halves are wrong for THIS guard:
 *
 *  - The token pins a RETRY OF THE SAME follow-up back onto the original request, so the ledger hands
 *    back the payment it already made. It says nothing about a DIFFERENT receipt on the same invoice,
 *    which is exactly what this arithmetic is here to measure. A £100 receipt that timed out after
 *    Xero created the payment lands FAILED; the operator records the receipt again; the replacement is
 *    a different row for a different Payment row, so the token does not dedupe it, and the only thing
 *    standing between it and a second £100 on a £100 invoice is this sum.
 *  - "FAILED did not post" is a GUESS about remote state. o3d-ju8t settled the opposite reading, the
 *    follow-up planner is built on it, and errorMessage carries no provenance (both connectors
 *    overwrite `HTTP nnn` with the remote system's own text), so nothing in the row can tell a
 *    rejection apart from a lost response.
 *
 * So a FAILED row makes remaining capacity UNKNOWABLE, and unknowable must not read as either "free"
 * or "spent" — it must refuse, and say what a human has to do. The exceptions are not guesses but
 * PROOFS, and there are two of them. Both are imported rather than re-derived — two guards with two
 * definitions of "nothing was sent" would disagree about whether an invoice has capacity, which is
 * the whole question:
 *
 *   the BODY   a stored request missing a field the connector rejects before building a request
 *              CANNOT have reached the ledger (`storedBodyMayHaveReachedTheLedger`,
 *              followup-idempotency.ts).
 *   the ROW    a money row held in attempt-stamping custody for its whole life, carrying no
 *              `remoteAttemptedAt`, never made a call at all (`attemptProvenNeverMade`,
 *              money-attempt-provenance.ts). Added in Codex round 2 because the body test can only
 *              clear failures a connector detects by READING the payload, and the connectors also
 *              fail after that and before the send — QuickBooks on a customer reference or a bank
 *              account it resolves from the database, Xero on a lost write lease or a refused money
 *              fence. Those rows have perfect payloads and provably sent nothing, and reading them
 *              as ambiguous terminally refused the next good receipt on the invoice.
 *
 * THE COST, STATED. An unresolved FAILED registration now blocks later receipts on the same invoice
 * instead of silently letting them through. That is the direction this file already chose for
 * LEDGER_AMOUNT_UNKNOWN, and the refusal names the row and tells the operator how to clear it:
 * look the invoice up in the ledger, and either register the balance by hand or resolve the failed
 * entry. Round 2's stranding worry is real but it is a WORKFLOW cost; a duplicate supplier payment is
 * an irreversible one.
 *
 * FAIL CLOSED. An unreadable order, an unreadable amount on a posted row, or a reference this guard
 * cannot measure at all does NOT post. A transient read outage must never become permission to move
 * money, on the same principle as `guardCancelledSalesOrderInvoice`.
 *
 * RESIDUAL, stated rather than hidden. The read is not taken under the order row lock, and it could not
 * usefully be: holding a `SELECT … FOR UPDATE` across an outbound HTTP call to Xero trades a rare race
 * for a routine hang, and `guardCancelledSalesOrderInvoice` already documents the same select-then-post
 * window for the invoice itself. What closes the ordinary race instead is the per-reference
 * serialisation in `findInvoicePaymentsBlockedByEarlierLiveLogs`: only the EARLIEST live INVOICE_PAYMENT
 * for an order is ever un-deferred, so a sibling cannot be posting alongside us. Two independent runners
 * (`processPendingSyncEntries` and the outbox worker) each compute that blocked set from their own
 * snapshot, and a claim gone stale for 15 minutes can be re-taken, so the window is narrow rather than
 * nil — the remaining protection there is the pinned remote idempotency token (o3d-h2wx), which makes a
 * re-post of the SAME entry return the original Xero payment rather than create a second.
 */

import type { Prisma } from '@/app/generated/prisma/client'

import { storedBodyMayHaveReachedTheLedger } from '@/lib/domain/accounting/followup-idempotency'
import { payloadRegisteredAmount } from '@/lib/domain/accounting/registered-amount'
import { attemptProvenNeverMade } from '@/lib/domain/accounting/money-attempt-provenance'
import { heldClaimWhere, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'
import { isOperatorAssertedSettlement } from '@/lib/domain/accounting/sync-row-settlement'
import { ledgerSalesInvoiceTotalForeign } from '@/lib/domain/accounting/settlement-status'
import {
  addMoney,
  compareDecimal,
  ledgerAmountEpsilon,
  subtractMoney,
  toDecimal,
  type Decimal,
} from '@/lib/domain/math/decimal'

/** The only status that asserts the remote call happened. */
export const POSTED_INVOICE_PAYMENT_STATUSES = ['SYNCED'] as const

/**
 * Statuses that assert NOTHING about whether the remote call happened. The processor posts BEFORE it
 * persists the result, so a row can be marked FAILED by a lost response, a timeout, or a crash after
 * Xero created the Payment — indistinguishable from a rejection.
 */
export const AMBIGUOUS_INVOICE_PAYMENT_STATUSES = ['FAILED'] as const

export type PostedInvoicePaymentRegistration = {
  id: string
  status: string
  /**
   * HOW this row reached its status (o3d-anu8). NULL = the connector's own writeback. On an
   * `OPERATOR_ASSERTION` row nothing was sent, so `amount` below is what IMS INTENDED to send and is
   * not a reading of the ledger — see the SYNCED arm of `decideInvoicePaymentPost`.
   */
  settlementBasis: string | null
  /**
   * WHAT THIS ROW REGISTERED, EXACTLY, IN THE DOCUMENT'S CURRENCY (o3d-6abj). `null` = this payload
   * will not say, and the caller must read that as "unknowable", never as zero.
   *
   * A `Decimal`, and read through the ONE reader — `payloadRegisteredAmount` — so the exact decimal
   * string o3d-1xq8 writes beside the JSON number is preferred here as well as on the coverage
   * route. It was not, and that was the defect: this guard summed the doubles while the reader two
   * modules away summed the strings, so one rule had two answers. `null` therefore also covers a
   * PRESENT-BUT-UNREADABLE string and a payload stating a DIFFERENT currency: both are refusals
   * rather than a fall back to the lossy field, which is the whole point of the string existing.
   */
  registeredAmount: Decimal | null
  /** The ledger document it settled. Null on rows queued before the payload recorded it. */
  accountingInvoiceId: string | null
  /**
   * The local receipt this row registered (o3d-ekn8 r4). Null on rows queued before the payload
   * recorded it, which reads as "possibly this one" — an un-attributed row cannot be shown to
   * belong to a DIFFERENT receipt, and for money that is the direction that has to withhold.
   */
  paymentId: string | null
  /**
   * Whether this row's attempt MAY have reached the ledger (`storedBodyMayHaveReachedTheLedger`).
   * Only consulted for the ambiguous statuses, and `false` is the one sound proof that an attempt
   * never reached it: a body that is present, readable, and missing a field the connector rejects
   * before it builds a request. Unknown, unreadable and RETENTION-COMPACTED bodies are all `true` —
   * not knowing what was sent is not evidence that nothing was (o3d-m5qk).
   */
  bodyCouldHavePosted: boolean
  /**
   * THE SECOND — AND STRONGER — PROOF THAT NOTHING WAS SENT (Codex round 2, HIGH).
   *
   * `attemptProvenNeverMade`: this row is stamped as having been in attempt-stamping custody for its
   * whole life and carries NO `remoteAttemptedAt`, so no call ever left it. Unlike
   * `bodyCouldHavePosted` this reads the ROW's own record of what happened rather than inferring it
   * from the shape of the stored request, which is why it can clear a row whose payload is perfectly
   * complete.
   *
   * `false` covers both "it was attempted" and "cannot tell" — custody forfeited, columns not
   * selected — and the caller must treat both as possibly-posted. Only `true` is a proof.
   */
  provenNeverAttempted: boolean
}

export type InvoicePaymentPostRefusal =
  /** A posted registration exists whose amount cannot be read, so remaining capacity is unknowable. */
  | 'LEDGER_AMOUNT_UNKNOWN'
  /**
   * A registration against this invoice is SYNCED because an operator ASSERTED it posted, so the
   * amount IMS holds for it was never sent anywhere and the capacity sum is not a measurement
   * (o3d-anu8).
   */
  | 'ASSERTED_REGISTRATION'
  /**
   * A FAILED registration against this same document may or may not have posted, so how much of the
   * invoice the ledger already holds cannot be determined at all (Codex round 3 #3).
   */
  | 'AMBIGUOUS_FAILED_REGISTRATION'
  /**
   * A LIVE registration for THIS receipt settles a document this order no longer points at
   * (o3d-ekn8 r4) — the invoice was deleted and re-posted. Every document-scoped filter drops that
   * row, including the capacity sum below, and it is the record of a payment that was SENT.
   */
  | 'SETTLED_ON_RETIRED_DOCUMENT'
  /** This payment does not fit in what is left of the invoice after what the ledger already holds. */
  | 'WOULD_OVERPAY'

export type InvoicePaymentPostVerdict =
  | { post: true; alreadyPosted: Decimal; ledgerTotal: Decimal }
  | {
      post: false
      refusal: InvoicePaymentPostRefusal
      alreadyPosted: Decimal | null
      ledgerTotal: Decimal
      /** The rows whose remote outcome is unknown. Empty unless the refusal is the ambiguous one. */
      ambiguousIds: string[]
    }

/**
 * Pure capacity arithmetic for one about-to-post registration. Kept separate from the reads so the rule
 * is testable without a database, and so the two guards (enqueue and post) can be compared side by side.
 */
export function decideInvoicePaymentPost(input: {
  /** THIS entry's sync-log id. Its own row must never count against it. */
  entryId: string
  accountingInvoiceId: string
  /** What this entry is about to send, EXACTLY (o3d-6abj). See `guardInvoicePaymentCapacity`. */
  amount: Decimal
  /** The ledger's copy of the invoice, as the stored `Decimal` and not a conversion of it. */
  ledgerTotal: Decimal
  /**
   * The DOCUMENT'S CURRENCY, and it is here to size the band below (o3d-6yho, 1 of 3) rather than to
   * be compared with anything. `ledgerAmountEpsilon` is half one minor unit of it; the constant this
   * replaced was a flat 0.005, which is half a penny in GBP and FIVE whole minor units of over-
   * payment in a Gulf dinar. This test reads `amount > remaining + band`, so a LARGER band ADMITS
   * more — the one direction that ends in a second payment on the ledger.
   */
  currency: string
  /** Every INVOICE_PAYMENT sync row for this order on this connector, including this entry's own. */
  registrations: PostedInvoicePaymentRegistration[]
}): InvoicePaymentPostVerdict {
  // A PAYMENT ALREADY SENT FOR THIS RECEIPT, AGAINST A DOCUMENT THIS ORDER NO LONGER HAS
  // (o3d-ekn8 r4, Codex HIGH). Asked FIRST, and asked here rather than only at the enqueue, because
  // this guard is the one gate no enqueue path can skip — it sits immediately before the remote
  // call. `againstThisInvoice` below drops the row for naming a different document, which is right
  // for capacity and wrong for evidence: the invoice was deleted and re-posted, and "the old
  // document's payment went away with it" is an assumption about a ledger nothing here has read. On
  // QuickBooks a deleted invoice leaves its payment as an UNAPPLIED CREDIT and the customer is
  // credited twice.
  //
  // Scoped to THIS receipt — a different receipt's retired row is o3d-hbgo's case and stays out of
  // the way — plus rows that name no receipt at all, which cannot be shown to be someone else's.
  // What clears it is the row ceasing to be live: an operator cancelling it is a statement that they
  // read the ledger, which is the fact this code cannot establish for itself.
  const entryPaymentId = input.registrations.find((row) => row.id === input.entryId)?.paymentId ?? null
  const retired = input.registrations.filter(
    (row) =>
      row.id !== input.entryId
      // POSTED, i.e. SYNCED: money the ledger acknowledged. A FAILED row on a retired document is
      // the ambiguity rule's business and a PENDING one is the enqueue gate's — this arm is about a
      // payment that demonstrably went.
      && (POSTED_INVOICE_PAYMENT_STATUSES as readonly string[]).includes(row.status)
      && row.accountingInvoiceId != null
      && row.accountingInvoiceId !== input.accountingInvoiceId
      && (row.paymentId == null || entryPaymentId == null || row.paymentId === entryPaymentId),
  )
  if (retired.length > 0) {
    return {
      post: false,
      refusal: 'SETTLED_ON_RETIRED_DOCUMENT',
      alreadyPosted: null,
      ledgerTotal: input.ledgerTotal,
      ambiguousIds: retired.map((row) => row.id),
    }
  }

  const againstThisInvoice = input.registrations.filter(
    (row) =>
      row.id !== input.entryId
      // o3d-hbgo: a row that settled a DIFFERENT ledger document paid an invoice this order no longer
      // has (deleted and re-posted). It consumes none of the CURRENT invoice's capacity. A row that
      // names NO document stays counted: for money, unknown reads as "possibly this one".
      && (row.accountingInvoiceId == null || row.accountingInvoiceId === input.accountingInvoiceId),
  )

  // UNKNOWN BEFORE ARITHMETIC (Codex round 3 #3). A FAILED row that could have been sent leaves the
  // ledger's balance on this invoice undetermined, so there is no sum to compute — not a sum that
  // happens to come out favourable. Checked first because it is the stronger fact: a row whose
  // outcome is unknown makes an unreadable amount on some OTHER row beside the point.
  // TWO INDEPENDENT PROOFS CLEAR A FAILED ROW, AND EITHER IS ENOUGH (Codex round 2, HIGH).
  //
  // THE GAP THIS CLOSES was only VISIBLE on QuickBooks, but it was never a QuickBooks bug. The
  // ambiguity rule above rests on "a FAILED money row might have posted", and its one exception was
  // the SHAPE of the stored request: a body missing a field the connector rejects before it builds a
  // request cannot have been sent. That test is about the payload, so it can only clear the failures
  // a connector detects by reading the payload.
  //
  // QuickBooks fails LATER than that and EARLIER than Xero does. Its INVOICE_PAYMENT case resolves a
  // customer reference and a bank account against the database after the payload validation and
  // before this guard, and either can be missing — `Missing customer reference for INVOICE_PAYMENT`
  // is a row with a complete, readable payload whose attempt provably never left the process. The
  // guard read every one of those as "might have posted" and TERMINALLY REFUSED the next perfectly
  // good receipt on the invoice. Xero has the same shape in its own post-guard, pre-send window (a
  // lost write lease, a refused money fence), so the fix belongs to the shared guard, not to a port.
  //
  // `attemptProvenNeverMade` is the proof, and it is the one the ROW carries: custody held for the
  // row's whole life plus no `remoteAttemptedAt` means no call left it, whatever its payload looks
  // like. It cannot wrongly clear an attempted row, because `authoriseMoneyPost` stamps
  // `remoteAttemptedAt` as its FIRST act — before it decides anything, and before the send — so any
  // row that reached the fence is stamped, and any row outside custody has been stamped by
  // `repairMoneyAttemptsOutsideStampingCustody` before either processor claims anything.
  //
  // Everything undetermined still fails closed: `bodyCouldHavePosted` stays `true` for unknown and
  // compacted bodies, `provenNeverAttempted` stays `false` for a forfeited custody or an unselected
  // column, and a row that satisfies neither proof is still ambiguous.
  const ambiguous = againstThisInvoice.filter(
    (row) =>
      (AMBIGUOUS_INVOICE_PAYMENT_STATUSES as readonly string[]).includes(row.status)
      && row.bodyCouldHavePosted
      && !row.provenNeverAttempted,
  )
  if (ambiguous.length > 0) {
    return {
      post: false,
      refusal: 'AMBIGUOUS_FAILED_REGISTRATION',
      alreadyPosted: null,
      ledgerTotal: input.ledgerTotal,
      ambiguousIds: ambiguous.map((row) => row.id),
    }
  }

  const posted = againstThisInvoice.filter(
    (row) => (POSTED_INVOICE_PAYMENT_STATUSES as readonly string[]).includes(row.status),
  )

  // A SYNCED ROW AN OPERATOR ASSERTED IS NOT A POSTED AMOUNT (o3d-anu8). SYNCED is the one status
  // this guard reads as "money moved", and that reading is sound only for the connector's own
  // writeback, which happens after the ledger answered. The settlement action writes the same
  // status from a document id a human typed, and `amount` still comes out of the payload IMS built
  // — so the sum below would subtract a figure nothing ever sent from the invoice total and call
  // the remainder capacity. Xero accepts a payment smaller than the invoice as a PART payment, so
  // the error runs in the direction that lets a second payment out.
  //
  // Checked after the ambiguous-FAILED gate (that one is the stronger fact) and before the
  // unreadable-amount gate, because a readable-but-unverified amount is the more misleading of the
  // two: it produces a confident number.
  const assertedPosted = posted.filter((row) => isOperatorAssertedSettlement(row.settlementBasis))
  if (assertedPosted.length > 0) {
    return {
      post: false,
      refusal: 'ASSERTED_REGISTRATION',
      alreadyPosted: null,
      ledgerTotal: input.ledgerTotal,
      ambiguousIds: assertedPosted.map((row) => row.id),
    }
  }

  // o3d-6abj: `registeredAmount` is `payloadRegisteredAmount`'s answer, so `null` here now covers
  // three things and all three are the same refusal — the payload records no amount, it records an
  // exact decimal string that will not parse, or it states a currency that is not this document's.
  // The last two used to fall back to the JSON number, which is precisely the "reverting to the
  // double" the string exists to remove.
  if (posted.some((row) => row.registeredAmount == null)) {
    return {
      post: false,
      refusal: 'LEDGER_AMOUNT_UNKNOWN',
      alreadyPosted: null,
      ledgerTotal: input.ledgerTotal,
      ambiguousIds: [],
    }
  }

  // ARITHMETIC IN DECIMAL, END TO END (o3d-6abj, Codex HIGH).
  //
  // Every term here used to be a double: `Number(order.totalForeign)` for the whole, a `+` reduce
  // over the payload numbers for the parts, and the entry's own JSON number for the receipt. Above
  // about 4.5e13 the spacing between neighbouring doubles exceeds the band this test allows, and the
  // conversion is not one-directional — Codex's reproduction is a stored total of
  // 35184372088832.0040 against a receipt of 35184372088832.01, which are 0.006 apart and MUST
  // refuse, converting to the SAME double. `alreadyPosted` is 0, both operands are equal, the test
  // reads `x > x + band`, and the guard approves an over-settlement of a whole minor unit.
  //
  // Money that cannot be stated cannot be measured, so nothing is converted: the total arrives as
  // the stored `Decimal`, each part as the exact decimal its payload states, and the receipt as the
  // figure the entry's own payload states — see `guardInvoicePaymentCapacity`, which also refuses
  // unless that figure is the one the connector is about to put on the wire.
  const alreadyPosted = posted.reduce(
    (sum, row) => addMoney(sum, row.registeredAmount as Decimal),
    toDecimal(0),
  )
  const remaining = subtractMoney(input.ledgerTotal, alreadyPosted)
  if (compareDecimal(input.amount, addMoney(remaining, ledgerAmountEpsilon(input.currency))) > 0) {
    return {
      post: false,
      refusal: 'WOULD_OVERPAY',
      alreadyPosted,
      ledgerTotal: input.ledgerTotal,
      ambiguousIds: [],
    }
  }
  return { post: true, alreadyPosted, ledgerTotal: input.ledgerTotal }
}

export type InvoicePaymentPostGuardResult =
  | { post: true }
  /**
   * Refused on what the rows say. Terminal: nothing was sent for THIS entry and nothing should be.
   * Covers both "measured, and it does not fit" and "cannot be measured because an earlier row's
   * remote outcome is unknown" — the second is terminal for the same reason as the first, since
   * retrying cannot resolve it and a FAILED retry would only add another ambiguous row.
   */
  | {
      post: false
      kind: 'refused'
      refusal: InvoicePaymentPostRefusal
      message: string
      alreadyPosted: Decimal | null
      ledgerTotal: Decimal
      ambiguousIds: string[]
    }
  /** Could not be measured. Retryable, and NOT posted — fail closed. */
  | { post: false; kind: 'unmeasurable'; message: string }

type CapacityClient = Pick<Prisma.TransactionClient, 'salesOrder' | 'accountingSyncLog'>

function payloadString(payload: unknown, field: string): string | null {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const value = record[field]
  return typeof value === 'string' ? value : null
}

/**
 * Read the ledger's copy of the invoice and everything already registered against it, and decide
 * whether this entry may post. Called from the connector's INVOICE_PAYMENT case, which is the one
 * place no enqueue path can route around.
 */
export async function guardInvoicePaymentCapacity(
  client: CapacityClient,
  params: {
    connector: string
    entryId: string
    referenceType: string
    referenceId: string
    accountingInvoiceId: string
    /** The JSON number the connector is about to put in the request body. */
    amount: number
    /**
     * THE STORED PAYLOAD THE CONNECTOR IS BUILDING THAT REQUEST FROM (o3d-6abj).
     *
     * Passed in rather than re-read here, and that is the point: the figure this guard measures has
     * to be the figure that goes on the wire, and the only object that can establish that is the one
     * the caller is reading `amount` out of. A re-read could hand back a row someone has since
     * rewritten, and the guard would then have measured a different payment from the one it
     * authorises.
     */
    payload: unknown
  },
): Promise<InvoicePaymentPostGuardResult> {
  // An INVOICE_PAYMENT is always order-scoped today. If one ever is not, its capacity cannot be
  // measured — and "cannot measure" must not read as "go ahead".
  if (params.referenceType !== 'SalesOrder') {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Refusing to register an invoice payment for ${params.referenceType} ${params.referenceId}: `
        + `invoice capacity can only be measured against a SalesOrder, so IMS cannot tell whether this `
        + `payment would over-settle the invoice.`,
    }
  }

  let order: {
    currency: string
    totalForeign: Prisma.Decimal
    taxForeign: Prisma.Decimal
    pricesIncludeVat: boolean
    shoppingLinks: { connector: string }[]
  } | null
  let registrations: {
    id: string
    status: string
    payload: unknown
    settlementBasis: string | null
    remoteAttemptedAt: Date | null
    attemptStampingCustodyAt: Date | null
  }[]
  try {
    ;[order, registrations] = await Promise.all([
      client.salesOrder.findUnique({
        where: { id: params.referenceId },
        select: {
          // o3d-6abj / o3d-6yho: the ORDER'S CURRENCY, asked for explicitly. Two things below need
          // it and neither can guess: `payloadRegisteredAmount` will not read a row's amount without
          // knowing what unit the sum is in, and `ledgerAmountEpsilon` sizes the over-payment band
          // from this document's minor unit rather than from a hard-coded half-penny.
          currency: true,
          totalForeign: true,
          taxForeign: true,
          pricesIncludeVat: true,
          shoppingLinks: { select: { connector: true }, take: 1 },
        },
      }),
      client.accountingSyncLog.findMany({
        where: {
          connector: params.connector,
          type: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          referenceId: params.referenceId,
        },
        // o3d-anu8: settlementBasis is asked for EXPLICITLY. It is what separates a SYNCED row the
        // connector wrote back from one an operator asserted, and without it the second reads as
        // the first.
        //
        // And the attempt-provenance pair with it (Codex round 2, HIGH), for the same kind of
        // reason: without them a FAILED row that provably never made a call is indistinguishable
        // from one that may have, and every later receipt on the invoice is refused for ever. They
        // are read as a PAIR because neither proves anything alone — see `attemptProvenNeverMade`.
        select: {
          id: true,
          status: true,
          payload: true,
          settlementBasis: true,
          remoteAttemptedAt: true,
          attemptStampingCustodyAt: true,
        },
      }),
    ])
  } catch (error) {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Could not read sales order ${params.referenceId} or its payment registrations before posting `
        + `an invoice payment: ${String(error)}`,
    }
  }

  if (!order) {
    return {
      post: false,
      kind: 'unmeasurable',
      message: `Sales order ${params.referenceId} not found before posting an invoice payment.`,
    }
  }

  // o3d-6abj: the STORED `Decimal`, handed straight to a function that now takes one. The
  // `Number(order.totalForeign)` that used to be written here is the first half of Codex's
  // reproduction — see the arithmetic in `decideInvoicePaymentPost`.
  const ledgerTotal = ledgerSalesInvoiceTotalForeign({
    totalForeign: order.totalForeign,
    taxForeign: order.taxForeign,
    pricesIncludeVat: order.pricesIncludeVat,
    // Only an IMPORTED tax-inclusive invoice posts at NET (o3d-cyn); an order raised in IMS posts gross.
    importedFromShop: order.shoppingLinks.length > 0,
  })
  if (!ledgerTotal.isFinite()) {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Sales order ${params.referenceId} has no readable invoice total, so IMS cannot tell whether `
        + `this payment would over-settle the invoice.`,
    }
  }

  // WHAT THIS ENTRY IS ABOUT TO SEND, EXACTLY — AND A PROOF THAT IT IS WHAT WILL GO ON THE WIRE
  // (o3d-6abj).
  //
  // `params.amount` is the JSON number the connector read out of `params.payload` and will put in the
  // request body. The exact figure is in the SAME payload, in the field o3d-1xq8 added, and this
  // guard reads it through the one reader every other consumer of that field uses — so a
  // present-but-unreadable string refuses HERE too rather than quietly falling back to the double.
  // A payload that names no currency, or names another one, also refuses: an amount whose unit is
  // unknown cannot be subtracted from a total stated in the order's.
  //
  // The equality test is not ceremony. A guard that measures one figure while the connector sends
  // another has measured nothing, and the two payload fields are only guaranteed to agree by the
  // writer's round-trip refusal — which says nothing about a row whose payload was written by
  // something else, edited by hand, or produced by a build that predates the guarantee. If they
  // disagree, the honest answer is that this entry's size is not established, which is the existing
  // `unmeasurable` arm: retryable, and nothing is sent.
  const amount = payloadRegisteredAmount(params.payload, order.currency)
  if (amount == null || !amount.eq(toDecimal(params.amount))) {
    return {
      post: false,
      kind: 'unmeasurable',
      message:
        `Sync entry ${params.entryId} does not state the amount it is about to register against `
        + `invoice ${params.accountingInvoiceId} in ${order.currency} exactly — `
        + `${amount == null ? 'its payload records no readable amount in that currency' : `its payload says ${amount.toFixed()} while the request carries ${params.amount}`}`
        + `. IMS cannot tell whether this payment would over-settle the invoice, so nothing was sent.`,
    }
  }

  const verdict = decideInvoicePaymentPost({
    entryId: params.entryId,
    accountingInvoiceId: params.accountingInvoiceId,
    amount,
    ledgerTotal,
    currency: order.currency,
    registrations: registrations.map((row) => ({
      id: row.id,
      status: row.status,
      settlementBasis: row.settlementBasis,
      // o3d-6abj: the exact decimal string in preference to the JSON number, through the SAME reader
      // the coverage route uses. `null` when the payload will not say — never the double instead.
      registeredAmount: payloadRegisteredAmount(row.payload, order.currency),
      accountingInvoiceId: payloadString(row.payload, 'accountingInvoiceId'),
      paymentId: payloadString(row.payload, 'paymentId'),
      bodyCouldHavePosted: storedBodyMayHaveReachedTheLedger('INVOICE_PAYMENT', row.payload),
      provenNeverAttempted: attemptProvenNeverMade(row),
    })),
  })
  if (verdict.post) return { post: true }

  // Every refusal message ends with what a HUMAN must do, because each of these is a state the code
  // has decided it cannot resolve — and an operator who is only told "refused" will re-record the
  // receipt, which is the one action that can turn an ambiguity into a duplicate payment.
  const message = ((): string => {
    // o3d-6abj: the EXACT digits, not `toFixed(2)`. The whole reason this refusal now fires is that
    // two figures a penny-rounded rendering shows as identical are not, and an operator sent to
    // reconcile against the ledger needs the numbers that actually differ.
    const head = `Refused to register a payment of ${amount.toFixed()} against invoice `
      + `${params.accountingInvoiceId}: `
    switch (verdict.refusal) {
      case 'LEDGER_AMOUNT_UNKNOWN':
        return head
          + `a payment already posted for this invoice does not record its amount, so IMS cannot tell `
          + `how much of the invoice is still outstanding. Nothing was sent — reconcile the invoice in `
          + `the ledger and register the payment there by hand.`
      case 'ASSERTED_REGISTRATION':
        return head
          + `a payment already registered against this invoice (sync ${verdict.ambiguousIds.join(', ')}) was `
          + `recorded on an OPERATOR'S ASSERTION, not confirmed by the accounting connector: IMS never made `
          + `that call, never read the document and never compared the amount, so the figure it holds for it `
          + `is what it MEANT to send. How much of this invoice is already settled therefore cannot be `
          + `measured, and IMS will not guess with money. Nothing was sent. Open that payment in the ledger, `
          + `confirm what it actually settled, and register any balance genuinely owed there by hand.`
      case 'SETTLED_ON_RETIRED_DOCUMENT':
        return head
          + `this receipt is ALREADY REGISTERED in the accounting connector against a different document `
          + `(sync ${verdict.ambiguousIds.join(', ')}) — the invoice it settled was deleted and re-posted, `
          + `so this order now points somewhere else. That earlier payment was actually SENT, and nothing `
          + `here has read the ledger to see whether deleting the old invoice took it with it: on some `
          + `connectors a deleted invoice leaves its payment behind as an unapplied credit, and sending `
          + `this one would credit the customer twice. Nothing was sent. Open that payment in the `
          + `accounting system; if it is genuinely gone, cancel the earlier sync row and re-run this one, `
          + `and if it is still there, apply it to the new invoice by hand.`
      case 'AMBIGUOUS_FAILED_REGISTRATION':
        return head
          + `an earlier registration against this same invoice FAILED `
          + `(sync ${verdict.ambiguousIds.join(', ')}), and a failed registration is NOT proof that `
          + `nothing reached the ledger — the payment may have been created and the response lost. IMS `
          + `therefore cannot tell how much of this invoice is already settled, and will not guess with `
          + `money. Nothing was sent. Open this invoice in the ledger: if the failed payment is not `
          + `there, resolve that sync entry and record the receipt again; if it IS there, the invoice `
          + `is already settled by it and no further payment should be registered.`
      case 'WOULD_OVERPAY':
        return head
          + `the ledger's copy of this invoice is for ${verdict.ledgerTotal.toFixed()} with `
          + `${(verdict.alreadyPosted ?? toDecimal(0)).toFixed()} already registered against it, so this payment `
          + `would over-settle it. Nothing was sent — reconcile the invoice in the ledger and register `
          + `the balance there by hand if it is genuinely owed.`
    }
  })()

  return {
    post: false,
    kind: 'refused',
    refusal: verdict.refusal,
    message,
    alreadyPosted: verdict.alreadyPosted,
    ledgerTotal: verdict.ledgerTotal,
    ambiguousIds: verdict.ambiguousIds,
  }
}

/**
 * Retire an entry the capacity guard refused, CLAIM-FENCED (same shape as
 * `retireSalesInvoiceForCancelledOrder`).
 *
 * CANCELLED is the honest status here and, unusually, provably so: the guard runs BEFORE the remote
 * call, so this row demonstrably never reached the ledger. That is exactly the distinction o3d-sref
 * drew — CANCELLED must only ever be asserted where "nothing was sent" is TRUE.
 *
 * Fenced on `heldClaimWhere` — `status: 'PROCESSING'` + the instant the caller's claim holds RIGHT NOW
 * — plus `externalTransactionId: null`, so a stale reclaim by a newer worker is not clobbered and a
 * row that already posted is never rewritten as if it had not.
 *
 * THE CLAIM, NOT A `Date` (o3d-550x / o3d-xl63, merged). This used to spell the ownership predicate out
 * inline over a captured `claimedAt`, which is a SECOND DEFINITION of "who owns this row" and one that
 * silently fails closed the moment the caller's claim is renewed: the remote-write lease moves
 * `processingStartedAt` before every send, so a fence on the captured instant matches nothing, the
 * retirement never happens, and the refusal is invisible. Taking `HeldClaim` makes that a compile error
 * at the call site instead of a no-op at runtime, and the instant is read here, as the statement is
 * built.
 *
 * NOT routed through `releaseClaimForRetry`: this is a TERMINAL transition with a precondition of its
 * own (`externalTransactionId: null`), which that helper deliberately does not carry.
 */
export async function retireOverSettlingInvoicePayment(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  params: { entryId: string; claim: HeldClaim; reason: string },
): Promise<boolean> {
  const retired = await client.accountingSyncLog.updateMany({
    where: {
      ...heldClaimWhere(params.entryId, params.claim),
      externalTransactionId: null,
    },
    data: { status: 'CANCELLED', errorMessage: params.reason, processingStartedAt: null },
  })
  return retired.count > 0
}
