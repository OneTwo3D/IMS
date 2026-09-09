/**
 * Should a manually-recorded sales receipt be registered against the ledger invoice? (o3d-lgo.15)
 *
 * An IMPORTED paid order registers its payment through the SALES_INVOICE follow-up (`_registerPayment`
 * in order-import). A receipt entered in IMS had no such path at all: the Payment row was created, the
 * order went green, and the ledger was never told — so it went on showing the invoice fully outstanding,
 * for ever. addPayment now queues an INVOICE_PAYMENT on the same principle as markBillPaid: an operator
 * recording a payment against a posted document is an instruction to settle it in the ledger too.
 *
 * The decision is GUARDED and lives here, pure, because every refusal is a judgement about money in a
 * system IMS cannot undo — a second payment registered in the ledger has to be reversed there by hand.
 * Refusing leaves the receipt recorded and the settlement verdict visibly unsettled, which is the safe
 * end: someone can act on a warning, but nobody goes looking for a payment they were never told about.
 */

import {
  mayHaveReachedLedger,
  type LedgerStandingRow,
} from './cancelled-row-evidence'
import {
  classifyLedgerSettlement,
  type LedgerSettlementProbe,
} from './ledger-settlement-evidence'
import { LEDGER_HELD_REGISTRATION_STATUSES } from './payment-ledger-hold'
import {
  exactAmountReadingOrLegacy,
  statedAmountOnly,
  type ExactAmountReading,
} from '@/lib/domain/accounting/registered-amount'
import { isOperatorAssertedSettlement } from './sync-row-settlement'
import {
  addMoney,
  compareDecimal,
  ledgerAmountEpsilon,
  subtractMoney,
  toDecimal,
  type Decimal,
} from '@/lib/domain/math/decimal'

export type InvoicePaymentRegistrationRefusal =
  /** Nothing is expected to post: the connector is off. Not a fault, and not worth a warning. */
  | 'SYNC_DISABLED'
  /** The invoice has not reached the ledger, so a payment has nothing to attach to. */
  | 'DOCUMENT_NOT_POSTED'
  /** The receipt is in a different currency from the order it settles. */
  | 'CURRENCY_MISMATCH'
  /** No bank account is mapped for this payment method/currency. */
  | 'NO_BANK_ACCOUNT'
  /**
   * An earlier attempt for this order is FAILED or CANCELLED and cannot be shown to be absent from
   * the ledger, so a second receipt could settle the same invoice twice (o3d-0m56).
   */
  | 'UNRESOLVED_PAYMENT_ATTEMPT'
  /**
   * A live registration exists whose AMOUNT cannot be read, so the remaining capacity on the invoice
   * cannot be computed. Refusing is the only sound answer: unknown must not read as zero (o3d-cjt8).
   */
  | 'LEDGER_AMOUNT_UNKNOWN'
  /**
   * A live registration exists that an OPERATOR asserted, so its amount is what IMS INTENDED to send
   * rather than anything the ledger reported — and the remaining capacity computed from it is not a
   * measurement (o3d-anu8). Kept apart from LEDGER_AMOUNT_UNKNOWN because the remedy differs: there
   * is a document id to go and read, and reading it is what resolves this.
   */
  | 'LEDGER_AMOUNT_ASSERTED'
  /**
   * A row for THIS receipt that may be holding a payment settles a ledger document this order no
   * longer points at (o3d-ekn8 r4; o3d-kof8 for what "may be holding" replaced — see
   * {@link mayHoldLedgerPayment}, and note that a CANCELLED row is one of these, not an exit from
   * them). The invoice was deleted and re-posted, so the row is dropped by every
   * document-scoped filter — and it is the record of a payment that was actually SENT. Registering
   * the receipt again against the replacement pays it twice. See the gate for why this is a refusal
   * rather than a silent pass, and what clears it.
   */
  | 'SETTLED_ON_RETIRED_DOCUMENT'
  /** This receipt does not fit in what is left of the invoice after what the ledger already holds. */
  | 'WOULD_OVERPAY'

export type InvoicePaymentRegistrationDecision =
  | { register: true; bankAccountId: string }
  | {
      register: false
      refusal: InvoicePaymentRegistrationRefusal
      alreadyRegistered?: Decimal
      ledgerTotal?: Decimal
      /** Why an unresolved attempt could not be cleared, for the operator warning. */
      detail?: string
    }

/**
 * One INVOICE_PAYMENT sync row, reduced to what the decision depends on.
 *
 * o3d-kof8 / o3d-f709 r3 (Codex HIGH) — IT CARRIES THE WHOLE {@link LedgerStandingRow}, REQUIRED.
 *
 * The four gates below used to ask `status !== 'CANCELLED'` and `couldHaveReachedLedger !== false`,
 * which is this tree's oldest hand-written claim — "an abandoned row committed nothing" — and it is
 * FALSE for the majority of cancelled rows (cancelled-row-evidence.ts states why, once). The gates
 * now ask {@link mayHaveReachedLedger}, and that reading needs three columns beyond the status.
 *
 * THEY ARE REQUIRED RATHER THAN OPTIONAL, AND THAT IS THE FIX RATHER THAN A DETAIL OF IT. Two of
 * them were already declared here as OPTIONAL — `settlementBasis` and `externalTransactionId` —
 * and an absent optional field reads, in `cancelledClaimIsResolved`, as the PERMISSIVE answer: a
 * loader that forgot to select `abandonedBeforeRemoteCall` would have got a silently weaker verdict
 * on the money path instead of a compile error. Requiring them makes that omission unrepresentable:
 * `loadInvoicePaymentSyncRows` cannot drop a column without failing `tsc`, which is strictly better
 * than a fifth guard that checks the loader remembered.
 */
export type ExistingInvoicePaymentSync = LedgerStandingRow & {
  status: 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'CANCELLED'
  /**
   * WHAT WAS SENT, as the JSON number the connector put on the wire and the ledger therefore holds.
   *
   * Kept, and NOT the field the capacity arithmetic reads (o3d-6abj). It is the right figure for
   * the one question that compares against the LEDGER's own reply — `classifyLedgerSettlement`
   * matches a probe record's amount to the attempt that may have created it — and the wrong one for
   * summing parts against a stored `Decimal` total. See `registeredAmount`.
   */
  amount?: number | null
  /**
   * WHAT WAS REGISTERED, EXACTLY, in the ORDER's currency — `payloadRegisteredAmount`'s answer, and
   * the only field the capacity sum below reads (o3d-6abj).
   *
   * Anything but `stated` = this payload will not say, which the sum must read as UNKNOWABLE and
   * never as zero. It covers a payload with no amount, one whose exact decimal string does not parse,
   * and one stating a different currency — all three refuse rather than fall back to the double.
   *
   * o3d-r948 r2 (Codex HIGH 2): and it is a READING, because the unresolved-attempt description
   * below DOES hold a lossy number beside it and was falling back to it for the last two.
   */
  registeredAmount?: ExactAmountReading
  /** The date that attempt sent, `YYYY-MM-DD`. Null when the payload did not pin one. */
  paymentDate?: string | null
  /** The local Payment row it was queued for; null on rows queued before that was recorded. */
  paymentId?: string | null
  /**
   * The mark this attempt would have written into the ledger, derived from its own idempotency
   * token (o3d-0m56 round 3). Null when the caller cannot derive one — the amount-and-date match
   * is then the only evidence available, and it is weaker.
   */
  settlementMarker?: string | null
  /**
   * False when the stored body was missing a field the connector requires, which PROVES the attempt
   * was rejected before any HTTP call. Undefined means unknown, which reads as "it could have".
   */
  couldHaveReachedLedger?: boolean
  /**
   * The LEDGER DOCUMENT this row settles (o3d-hbgo). A row that names a different invoice paid an
   * invoice this order no longer has — deleted and re-posted — so it says nothing about how much of
   * the CURRENT invoice is outstanding. Null on rows queued before the payload recorded it, which
   * has to read as "possibly this one": for money, unknown is not the same as irrelevant.
   */
  accountingInvoiceId?: string | null
  /*
   * AND FROM {@link LedgerStandingRow}, ALL REQUIRED — `status` (narrowed above),
   * `settlementBasis`, `externalTransactionId` and `abandonedBeforeRemoteCall`.
   *
   * `settlementBasis` (o3d-anu8): HOW this row reached its status. NULL = the connector's own
   * writeback, so a real call was made and the ledger answered; `OPERATOR_ASSERTION` = a human
   * typed the outcome and the document id in, and IMS verified nothing.
   * `externalTransactionId` (o3d-anu8): the ledger document this row's settlement is recorded
   * under — the payment a refusal has to NAME so an operator can go and read it, and the veto
   * `cancelledClaimIsResolved` applies to every cancellation claim.
   * `abandonedBeforeRemoteCall` (o3d-f709): whether the canceller CLAIMED the row was pre-call.
   * Only the cross-connector orphan sweep writes `true`, and it infers it from `status = PENDING`
   * alone — which a POSTED row is put back to whenever follow-up work fails.
   *
   * They are NOT restated as fields here on purpose: a second declaration is a place for the two to
   * disagree, and this file's own history is a catalogue of exactly that.
   */
}

/**
 * o3d-kof8 — COULD THIS ROW BE HOLDING A PAYMENT IN THE LEDGER? THE ONE READING, FOR ALL FOUR GATES.
 *
 * Two independent proofs of absence exist for an INVOICE_PAYMENT row, and a gate that consults one
 * and not the other answers the wrong question:
 *
 *   `couldHaveReachedLedger === false` — the PAYLOAD proof. The stored body was missing a field the
 *   connector requires, so the call was rejected before any HTTP request. Derived by
 *   `attemptCouldHaveReachedTheLedger` from the payload, and this file has always asked it.
 *
 *   `mayHaveReachedLedger(row) === false` — the COLUMN proof, and the one that was missing. A
 *   cancellation resolves only when nothing local contradicts it; a CANCELLED row that still names
 *   the document the ledger issued resolves NOTHING, whatever the sweep stamped on it. The rule is
 *   `cancelledClaimIsResolved`, stated once in cancelled-row-evidence.ts.
 *
 * Either proof is sufficient. Neither is available from the STATUS, which is what the four gates
 * used to read, and what let a swept CANCELLED receipt be registered a second time against a
 * replacement invoice (Codex, o3d-f709 round 3 HIGH).
 *
 * AND THE PAYLOAD PROOF IS ASKED ONLY OF A ROW WITH NO LIVE WORK ON IT, which is not a hedge: it is
 * what that proof means. `attemptCouldHaveReachedTheLedger` reads the STORED BODY and reports that
 * the connector's own guard would have rejected it before the call — an argument about an attempt
 * whose outcome was never recorded. A row that is SYNCED says the call happened AND succeeded, and a
 * PENDING or PROCESSING one has not been decided yet; letting a body-completeness heuristic overrule
 * a recorded success would have been a new fail-open, and the redrive fixtures found it immediately.
 */
function mayHoldLedgerPayment(row: ExistingInvoicePaymentSync): boolean {
  if (!mayHaveReachedLedger(row)) return false
  if (hasLiveRegistrationWork(row)) return true
  return row.couldHaveReachedLedger !== false
}

/**
 * Is there LIVE WORK on this row — a registration queued, in flight, or recorded as done?
 *
 * A DIFFERENT QUESTION FROM {@link mayHoldLedgerPayment}, and deliberately still a status test. It
 * asks what the follow-up machinery is doing, not what the ledger received; the shared set is
 * payment-ledger-hold's, so the two files cannot drift, and it omits FAILED as well as CANCELLED —
 * which is why it is not a spelling of "an abandoned row committed nothing" (see the census header
 * in scripts/check-accounting-cancelled-row-predicates.mjs on why a set that drops FAILED too is a
 * different claim).
 */
function hasLiveRegistrationWork(row: ExistingInvoicePaymentSync): boolean {
  return (LEDGER_HELD_REGISTRATION_STATUSES as readonly string[]).includes(row.status)
}

/**
 * Attempts whose outcome is not established: FAILED or CANCELLED, not this receipt's own row, and
 * not proved — by payload or by column — to be absent from the ledger.
 *
 * Exported because the caller needs to know whether to ASK the ledger at all — the probe is a
 * network read and must not run on every receipt, only on the ones with a history.
 *
 * DELIBERATELY NOT DOCUMENT-SCOPED, unlike the capacity filter below. o3d-hbgo drops a row naming a
 * different invoice because it consumes none of THIS invoice's capacity — a statement about
 * arithmetic. This question is not about capacity: an attempt whose response was lost may hold a
 * payment in the ledger under whatever document it named, and a re-posted invoice does not make that
 * payment go away. Narrowing this by document would discard exactly the evidence it exists to weigh.
 */
export function unresolvedInvoicePaymentAttempts(
  existing: ExistingInvoicePaymentSync[],
  paymentId: string,
): ExistingInvoicePaymentSync[] {
  return existing.filter((r) =>
    (r.status === 'FAILED' || r.status === 'CANCELLED')
    && (r.paymentId == null || r.paymentId !== paymentId)
    // o3d-kof8: BOTH proofs, through the one reading. `couldHaveReachedLedger !== false` alone let
    // a CANCELLED row whose payload was complete count as unresolved for ever — right — and let a
    // CANCELLED row an operator had signed NOT_POSTED count too, which is the resolution this
    // system records precisely so a stranded receipt has a way out.
    && mayHoldLedgerPayment(r))
}

/**
 * o3d-ekn8 r4 (Codex HIGH) — A ROW NAMING A RETIRED DOCUMENT IS EVIDENCE, NOT NOISE.
 *
 * o3d-hbgo taught four gates that a sync row naming a DIFFERENT ledger document says nothing about
 * the CURRENT invoice's capacity, and for capacity that is right: a payment against a document this
 * order no longer has consumes none of the replacement's total. o3d-ekn8 r3 then anchored the
 * write-side gates on the document for the same reason.
 *
 * That is sound as arithmetic and unsound as evidence, and this branch traded one silent loss for a
 * worse one. Receipt P is SYNCED against invoice A; the order's invoice id moves to B — reachable,
 * because the delete guard swallows the failure of the back-reference write. Every gate then
 * discards that row: the selector, the `live` filter, the anchored idempotency key and the post-site
 * capacity guard are narrowed identically, and the row is SYNCED so the unresolved-attempt probe
 * never consults the ledger at all. Nothing between the selector and the remote payment POST can
 * catch it, and a SECOND payment posts for the same receipt.
 *
 * THE SAFETY ARGUMENT WAS AN ASSUMPTION ABOUT THE LEDGER THIS CODE NEVER CHECKS — "the old document
 * has been deleted, so its payment is gone with it". IMS never read that document. On QuickBooks a
 * deleted invoice leaves its payment behind as an UNAPPLIED CREDIT, so the customer is credited
 * twice. And it inverts this module's own stated rule: for money, unknown must read as "possibly
 * this one".
 *
 * So a row naming a retired document REFUSES, at both the enqueue gate and the post-site guard,
 * which is what keeps the two from disagreeing. What clears it is the one thing that is actual
 * evidence, and o3d-kof8 corrected what that is: NOT "the row stops being live". Cancelling a row
 * is three different writers' act in this system and only one of them looked at a ledger, so the
 * clearing fact is a RESOLVED cancellation as `cancelledClaimIsResolved` defines it — an operator's
 * audited NOT_POSTED assertion, or a sweep's pre-call proof, and in neither case may the row still
 * name a document the ledger issued. See {@link mayHoldLedgerPayment}.
 *
 * NOT SILENT, which is what o3d-ekn8 exists to prevent. `selectReceiptsAwaitingRegistration` still
 * SELECTS the receipt, so the guarded decision runs and its refusal is warned about with a nameable
 * remedy. The replacement invoice is left unsettled — visibly, and with the reason recorded — rather
 * than settled twice.
 *
 * `paymentId == null` counts: an un-attributed row cannot be shown to be some OTHER receipt's, and
 * unknown reads as "possibly this one".
 */
export function retiredDocumentInvoicePaymentAttempts(
  existing: ExistingInvoicePaymentSync[],
  paymentId: string,
  accountingInvoiceId: string,
): ExistingInvoicePaymentSync[] {
  return existing.filter((r) =>
    // o3d-kof8 / o3d-f709 r3 (Codex HIGH) — WHAT "LIVE" HAD TO BECOME, AND WHY THE STATUS COULD NOT
    // SAY IT.
    //
    // This read `status !== 'FAILED' && status !== 'CANCELLED'`, and the sentence above — "what
    // clears it is the one thing that is actual evidence: the row stops being live" — was written
    // believing a CANCELLED row IS that evidence. It is not, and this file already knew: an orphan
    // sweep, a post-time retirement and an operator's cancelled-sale settlement all reach CANCELLED
    // knowing nothing, and the first two do it to rows that may already have posted.
    //
    // THE PATH THAT MADE IT MONEY. Receipt P registers against invoice A and the ledger issues a
    // payment id. Follow-up work fails, so the row goes BACK to PENDING keeping that id; the
    // cross-connector orphan sweep then retires it — CANCELLED, `abandonedBeforeRemoteCall: true`
    // on the strength of `status = PENDING` alone, id untouched. The order's invoice moves to B.
    // Every gate then let it through: the selector scopes A away, the unresolved-attempt probe
    // skips the receipt's OWN row, this filter dropped it for being CANCELLED, and the capacity sum
    // drops it for naming another document. B's enqueue key is different — the key names the
    // invoice — so a SECOND payment posts against a real customer invoice.
    //
    // Asking `mayHoldLedgerPayment` closes it at the type level as well as here: the row's own
    // `externalTransactionId` vetoes its cancellation claim (`cancelledClaimIsResolved`), and
    // `ExistingInvoicePaymentSync` now REQUIRES that column, so no loader can answer this question
    // without having loaded the evidence for it.
    //
    // A FAILED row naming another document is caught here now too, and that is the same correction:
    // o3d-ju8t settled that a failure recorded after the call is not proof of a non-call, and the
    // unresolved-attempt probe above deliberately skips this receipt's own rows.
    mayHoldLedgerPayment(r)
    && r.accountingInvoiceId != null
    && r.accountingInvoiceId !== accountingInvoiceId
    && (r.paymentId == null || r.paymentId === paymentId))
}

/**
 * `CAPACITY_EPSILON` WAS HERE, AND IS GONE (o3d-6yho, 1 of 3).
 *
 * It was a flat `0.005`, exported so the POST-SITE guard would apply the IDENTICAL tolerance — the
 * right instinct, and the wrong shape for it. Half a penny is half one minor unit in GBP and FIVE
 * whole minor units in a Gulf dinar, fifty in CLF, and this test reads
 * `paymentAmount > remaining + band`: a larger band ADMITS more over-registration, which is the one
 * direction that ends in a second payment on a supplier's ledger.
 *
 * The tolerance is now `ledgerAmountEpsilon(orderCurrency)` — half one minor unit of THIS document's
 * currency — and both guards derive it from that one function rather than from a shared constant. So
 * they still cannot round differently, and they are now right in every currency instead of in one.
 */

export function decideInvoicePaymentRegistration(input: {
  syncEnabled: boolean
  /** The ledger's id for the invoice, or null if it has not posted. */
  accountingInvoiceId: string | null
  orderCurrency: string
  paymentCurrency: string
  /** The receipt being registered, as the stored `Decimal` and never a conversion of it (o3d-6abj). */
  paymentAmount: Decimal
  /** The local Payment row being registered — its own sync row must not count against it. */
  paymentId: string
  /** The bank account mapped for this method/currency, or null when none is. */
  bankAccountId: string | null
  /** Every INVOICE_PAYMENT sync row already on this order. */
  existing: ExistingInvoicePaymentSync[]
  /**
   * What the ledger holds against this invoice, or null when it could not be established (o3d-0m56).
   *
   * Only consulted when an unresolved earlier attempt exists, and null then means REFUSE: an
   * unanswered question about money that may already be in the ledger is not permission to send
   * more. Callers with no unresolved attempts may pass null freely.
   *
   * o3d-obyd r31 (Codex HIGH 1) — THE WHOLE PROBE, NOT THE RECORDS PULLED OUT OF IT.
   *
   * This was `LedgerSettlementRecord[] | null`, and the enqueue path filled it with
   * `probe.ok ? probe.records : null` — which drops everything the probe knows EXCEPT the list. That
   * was harmless while the list was the whole answer. It stopped being harmless the moment the probe
   * started reporting whether its collection is proved complete: this site would have had to
   * reconstruct a probe to call the classifier, and the only value it could have put in
   * `provedComplete` is a guess. Guessing `true` re-opens, one layer up, exactly the fail-open Codex
   * found — a truncated ledger response authorising a second payment — with the added vice that the
   * probe had the right answer and this boundary threw it away.
   *
   * So the boundary carries the answer intact. A field that is a flattened copy of a richer value is
   * a place for the two to disagree, and this one is on the path that decides whether money moves.
   */
  ledgerSettlements: LedgerSettlementProbe | null
  /**
   * What the ledger's copy of the invoice was built at (see ledgerSalesInvoiceTotalForeign), as the
   * stored `Decimal` (o3d-6abj). `Number(order.totalForeign)` is one of the two operands Codex's
   * reproduction collapses; the other is the sum below.
   */
  ledgerTotal: Decimal
}): InvoicePaymentRegistrationDecision {
  if (!input.syncEnabled) return { register: false, refusal: 'SYNC_DISABLED' }
  if (!input.accountingInvoiceId) return { register: false, refusal: 'DOCUMENT_NOT_POSTED' }
  if (input.orderCurrency !== input.paymentCurrency) return { register: false, refusal: 'CURRENCY_MISMATCH' }
  if (!input.bankAccountId) return { register: false, refusal: 'NO_BANK_ACCOUNT' }

  // CAPACITY, NOT OCCUPANCY (o3d-cjt8). This used to refuse whenever ANY live INVOICE_PAYMENT row
  // existed, because accounting_sync_logs_followup_live_unique permitted exactly one live row per ORDER
  // — so a second receipt did not merely risk double-paying, it violated the constraint. That key named
  // the wrong thing: a Xero Payment is per RECEIPT against a DOCUMENT, not per order, and an order can
  // legitimately receive a deposit and a balance. The index is now scoped to
  // (…, accountingInvoiceId, paymentId), so the database no longer stands in the way — and it no longer
  // stands in the way of an OVERPAYMENT either, because "the parts must not exceed the whole" is
  // arithmetic and no unique index can express it. That arithmetic is done here.
  //
  // BOTH RULES SURVIVE THE o3d-cjt8 / o3d-0m56 MERGE, and they are different questions.
  //
  // o3d-cjt8 made the live-follow-up index RECEIPT-scoped, so "one live registration per order" is
  // gone: a deposit and a balance may each register, and what stops an overpayment is arithmetic
  // below. That retired this branch's LEDGER_HAS_LIVE_PAYMENT refusal, exactly as this file's own
  // comment predicted it would ("Making the index receipt-scoped ... is o3d-cjt8").
  //
  // WHAT IT DID NOT RETIRE is o3d-0m56's question, and reading it as retired would be the whole
  // defect. Capacity is measured from rows that are LIVE. A FAILED or CANCELLED attempt is not live
  // and consumes no capacity — correctly, for arithmetic — but it is also not proof that the ledger
  // is clear: a call that committed before its response was lost is FAILED (o3d-ju8t), and deleting
  // a receipt CANCELS a row that may already have settled. Recording another receipt beside one
  // queues a fresh row under a NEW idempotency token, which posts a second payment without ever
  // touching the retry guard — and the capacity sum, having ignored the failed row, sees room for it.
  //
  // So the unresolved-attempt question is asked FIRST, before any arithmetic, because the arithmetic
  // cannot see it.
  /**
   * o3d-kof8 — ROWS THIS DECISION HAS ESTABLISHED HOLD NOTHING, carried to the capacity sum.
   *
   * The sum below has to know which rows consume capacity, and it used to answer that from the
   * STATUS: FAILED and CANCELLED "hold nothing — the ledger rejected them or never saw them". That
   * is the same false claim the retired-document gate above was making, and the sum could not stop
   * making it because the fact that clears a terminal row is not on the row at all — it is the
   * LEDGER PROBE's answer, computed here and then thrown away.
   *
   * So it is kept. A terminal row leaves the sum when something PROVED it absent: its payload or
   * its columns (`mayHoldLedgerPayment`), or this probe. Anything else is counted.
   */
  const provedAbsent = new Set<ExistingInvoicePaymentSync>()
  const unresolved = unresolvedInvoicePaymentAttempts(input.existing, input.paymentId)
  if (unresolved.length > 0) {
    if (input.ledgerSettlements === null) {
      return {
        register: false,
        refusal: 'UNRESOLVED_PAYMENT_ATTEMPT',
        ledgerTotal: input.ledgerTotal,
        detail: 'the accounting connector could not be asked what it already holds',
      }
    }
    for (const attempt of unresolved) {
      const verdict = classifyLedgerSettlement(
        // o3d-78rq — `registeredAmount` NOW, AND THE NUMBER'S OWN DECIMAL READING WHERE THERE IS NONE.
        //
        // o3d-6abj chose `amount` here with the reason "this compares against a figure the LEDGER
        // reported, which is the JSON number that went on the wire". That reason held while the ledger
        // side was a wire number too. It no longer is: the probe now reads each settlement through
        // `readLedgerStatedAmount` and the record carries the ledger's exact stated figure, so the
        // operand that meets it must be exact as well or the band is spent on a double subtraction
        // again. The fallback is the same one `payloadExactAmount` takes for a row written before
        // `amountDecimal` existed — `toDecimal(theNumber)`, the number's own decimal reading — so this
        // site describes no attempt it could not describe before and withholds nothing extra.
        //
        // o3d-6yho: and the ORDER's currency, which is the currency this attempt was raised in — the
        // decision has already refused a receipt whose currency differs from the order's, so there is
        // no second answer to give here.
        {
          // o3d-r948 r2 (Codex HIGH 2) — AND THE FALLBACK IS THE TRI-STATE'S, NOT `??`'s. `??` reads
          // "no exact figure was stated" out of a value that also means "one was and IMS refused it",
          // and then spends the very number the refusal is about. `exactAmountReadingOrLegacy` is the
          // one place allowed to substitute the number, and it substitutes for a silence only — a
          // refused attempt describes itself as undescribable, which withholds.
          amount: statedAmountOnly(exactAmountReadingOrLegacy(attempt.registeredAmount, attempt.amount)),
          currency: input.orderCurrency,
          date: attempt.paymentDate ?? null,
          marker: attempt.settlementMarker ?? null,
        },
        // o3d-obyd r31: the probe AS THE PROBE ANSWERED IT. This used to rebuild one around the
        // records, which is where the collection's proved-completeness would have been invented
        // rather than carried — see the `ledgerSettlements` field.
        input.ledgerSettlements,
        // o3d-r948 r6 — THE EXCLUSION SET WAS THE THIRD ARGUMENT HERE, AND IS GONE.
        //
        // WHAT IT DID AND WHY IT WAS BUILT. `classifyLedgerSettlement` withholds on a settlement it
        // cannot measure, and when that settlement belongs to a DIFFERENT row that already posted
        // the withhold is PERMANENT: `unresolvedInvoicePaymentAttempts` judges only FAILED and
        // CANCELLED rows, so a SYNCED row's payment is never matched to its own attempt here — it
        // can only block, and it blocks every future receipt on the order for good. The set handed
        // over the ledger ids IMS had recorded against this order's OTHER rows so those records
        // could be skipped, and the permanent hold lifted.
        //
        // WHY IT IS NOT HERE ANY MORE. Four rounds narrowed it — immutable ids only (r3), never an
        // operator-asserted id (r4), and only from a row raised against the organisation the probe
        // answered from (r5) — and the fifth found two gaps that are not looseness in the reasoning
        // but FACTS NOTHING IN THIS SYSTEM RECORDS:
        //
        //   • `row.origin` is stamped at ENQUEUE and `externalTransactionId` is minted at POST. A
        //     reconnect between them detaches one from the other, and on QuickBooks nothing stops
        //     it: that connector has no post-time realm enforcement at all (o3d-8prh, OPEN), and
        //     `QboResponse` discards the `realmId` its own request resolved, so there is no issuer
        //     to record even if this branch wanted to.
        //   • The probe's organisation was read from two token snapshots either side of the fetch,
        //     which cannot see an A→B→A reconnect across it.
        //
        // AND A THIRD, FOUND WHILE WEIGHING THOSE TWO, WHICH SHOWS THE SHAPE IS NOT QUICKBOOKS-ONLY:
        // `buildAssertedReversalData` (payment-ledger-hold.ts, called from app/actions/sales.ts)
        // writes an operator-supplied `externalTransactionId` onto an undecided row and leaves
        // `settlementBasis` NULL — so r4's `isOperatorAssertedSettlement` filter reads it as
        // connector-backed. That id IS verified against the ledger by a live read, but against
        // whatever tenant is connected at VERIFICATION time, while the row's origin still names
        // enqueue time. Same detachment, a Xero door, and one that landing o3d-8prh would not shut.
        //
        // SO THE ROUND-2 BEHAVIOUR IS RESTORED: AN UNMEASURABLE SETTLEMENT WITHHOLDS, WHATEVER ID
        // ANY ROW OF OURS RECORDS. The permanent hold is real and is now tracked as its own problem
        // (bd o3d-llyw) with the full cost of a sound exclusion written down. The trade is the one
        // `classifyLedgerSettlement` has always stated: the cost of holding a genuine payment back
        // is a visible refusal with a nameable remedy, and the cost of the alternative is a second
        // payment on somebody's ledger, which is neither visible nor remediable.
      )
      if (verdict.outcome === 'clear') {
        // The ledger was asked and does not hold this attempt. That — and not its status — is what
        // frees the capacity it would otherwise consume.
        provedAbsent.add(attempt)
        continue
      }
      return {
        register: false,
        refusal: 'UNRESOLVED_PAYMENT_ATTEMPT',
        ledgerTotal: input.ledgerTotal,
        detail: verdict.outcome === 'present'
          ? `the ledger already holds ${verdict.detail}, which matches an earlier ${attempt.status} attempt`
          : verdict.reason,
      }
    }
  }

  // A PAYMENT THAT WAS SENT AGAINST A DOCUMENT THIS ORDER NO LONGER HAS (o3d-ekn8 r4, Codex HIGH).
  //
  // Asked HERE — after the unresolved-attempt probe, before any arithmetic — because the arithmetic
  // below cannot see it: the `live` filter drops the row for naming a different document, which is
  // correct for capacity and wrong for evidence. The row is SYNCED, so the FAILED/CANCELLED probe
  // above never looks at it either. See `retiredDocumentInvoicePaymentAttempts` for why "the old
  // document was deleted, so its payment is gone" is an assumption about a ledger nothing read, and
  // for what clears this.
  const retired = retiredDocumentInvoicePaymentAttempts(
    input.existing,
    input.paymentId,
    input.accountingInvoiceId,
  )
  if (retired.length > 0) {
    return {
      register: false,
      refusal: 'SETTLED_ON_RETIRED_DOCUMENT',
      ledgerTotal: input.ledgerTotal,
      detail: retired
        .map((r) => `${r.accountingInvoiceId}${r.externalTransactionId ? ` (payment ${r.externalTransactionId})` : ''}`)
        .join(', '),
    }
  }

  // WHAT CONSUMES THE INVOICE'S CAPACITY (o3d-kof8 — the fourth gate).
  //
  // This said "FAILED and CANCELLED rows hold nothing — the ledger rejected them or never saw them
  // — so they free the capacity again, exactly as the index's live-status predicate does". The
  // index's predicate is about SLOTS and is right about them; this sum is about MONEY IN A LEDGER,
  // and for that the sentence is the branch's whole subject: a failure is recorded after the call
  // (o3d-ju8t) and a cancellation is written by three writers that know nothing.
  //
  // A row is counted unless it may not be holding anything. `hasLiveRegistrationWork` keeps every
  // queued, in-flight or recorded registration counted exactly as before — including one whose
  // payload is too incomplete to post, which is the one case where the two readings differ and the
  // conservative answer is to keep counting it. Everything else must have been PROVED absent, by
  // the row's own evidence or by the ledger probe above.
  //
  // ON TODAY'S PATHS THIS SELECTS THE SAME ROWS THE STATUS TEST DID, and that is checked rather
  // than assumed: every terminal row that is not this receipt's own has already been through the
  // probe, so it is either in `provedAbsent` or the decision returned before reaching here. The
  // difference is what happens when that stops being true — a gate reordered, a caller that skips
  // the probe, a fourth writer of CANCELLED. Then this counts the row and refuses, where the status
  // test freed the capacity and let a second payment out.
  const live = input.existing.filter(
    (r) => mayHoldLedgerPayment(r) && !provedAbsent.has(r)
    // Our OWN row, if this ever runs twice for one receipt: the idempotency key already makes the second
    // queue a no-op, so treating it as an obstacle would refuse the retry for its own success.
    && (r.paymentId == null || r.paymentId !== input.paymentId)
    // o3d-hbgo, read side: a row that settled a DIFFERENT ledger document paid an invoice this order no
    // longer has (deleted and re-posted). It consumes none of the current invoice's capacity, and
    // counting it would strand every payment on the replacement — silently, and for ever. A row that
    // names NO document stays counted: unknown has to read as "possibly this one".
    && (r.accountingInvoiceId == null || r.accountingInvoiceId === input.accountingInvoiceId),
  )

  // AN ASSERTED AMOUNT IS NOT A MEASUREMENT (o3d-anu8; the same rule settlement-status.ts applies on
  // the verdict side, o3d-nf9i r3).
  //
  // A row an operator settled as POSTED is SYNCED with a document id — live, and therefore counted
  // against the invoice by the sum below. But `r.amount` on that row is read out of the payload IMS
  // BUILT: it is what IMS meant to send, and nothing sent it. The ledger's copy can be any figure at
  // all, and Xero specifically will accept a payment SMALLER than the invoice as a part payment and
  // hand back a perfectly valid payment id — so an asserted row can name a real payment of £10
  // against an invoice IMS thinks it settled for £1,000. `ledgerTotal - alreadyRegistered` then
  // OVERSTATES what is left by however much the assertion was wrong by, in the one direction that
  // ends in a second payment on the ledger.
  //
  // FAIL CLOSED, before the sum and before the unknown-amount test: the amount here is not merely
  // unreadable, it is readable and unverified, which is worse because it looks like an answer. The
  // remedy is nameable and an operator can perform it — open the asserted payment in the accounting
  // system, confirm what it really settled, and register the balance there.
  const asserted = live.filter((r) => isOperatorAssertedSettlement(r.settlementBasis))
  if (asserted.length > 0) {
    return {
      register: false,
      refusal: 'LEDGER_AMOUNT_ASSERTED',
      ledgerTotal: input.ledgerTotal,
      detail: asserted
        .map((r) => r.externalTransactionId ?? 'an unnamed payment')
        .join(', '),
    }
  }

  // An unreadable amount cannot be arithmetic. Treating it as zero would let this receipt through on the
  // assumption that the ledger holds nothing, which is precisely what is not known.
  //
  // o3d-6abj: asked of `registeredAmount`, so a row whose exact decimal string is present but will
  // not parse, or which states a currency that is not this order's, refuses here rather than being
  // read from the lossy JSON number beside it.
  // o3d-r948 r2: anything but `stated` — the same two facts the null covered, and both still refuse.
  if (live.some((r) => r.registeredAmount?.kind !== 'stated')) {
    return { register: false, refusal: 'LEDGER_AMOUNT_UNKNOWN', ledgerTotal: input.ledgerTotal }
  }

  const alreadyRegistered = live.reduce(
    (sum, r) => addMoney(sum, (r.registeredAmount as { kind: 'stated'; amount: Decimal }).amount),
    toDecimal(0),
  )
  // What is LEFT of the invoice. With no live rows this is the whole invoice, which is exactly the
  // single-receipt rule this replaced — so the case that rule was written for still refuses, and now
  // the part-payment case does too. Refusing here names the numbers, where letting it through produces
  // a Xero rejection an operator has to decode.
  //
  // The case originally in view — a gross receipt against an imported tax-inclusive invoice, which
  // posted at NET — is gone since o3d-cyn: both construction paths now post at the order's gross. What
  // is left is every OTHER way a receipt can exceed its document (a credited or part-refunded invoice, a
  // mistyped amount), the invoices imported and posted before that fix, and now the deposit-plus-balance
  // case the receipt-scoped index deliberately admits.
  //
  // o3d-6abj: IN DECIMAL, ON EVERY TERM. The same collapse Codex found at the post site is reachable
  // here — a stored total of 35184372088832.0040 and a receipt of 35184372088832.01 are 0.006 apart
  // and become the SAME double — and the two guards have to agree, so they now do the same
  // arithmetic on the same kind of value rather than the same arithmetic on two roundings.
  const remaining = subtractMoney(input.ledgerTotal, alreadyRegistered)
  if (compareDecimal(input.paymentAmount, addMoney(remaining, ledgerAmountEpsilon(input.orderCurrency))) > 0) {
    return { register: false, refusal: 'WOULD_OVERPAY', alreadyRegistered, ledgerTotal: input.ledgerTotal }
  }
  return { register: true, bankAccountId: input.bankAccountId }
}

/**
 * `invoicePaymentRowSetBlocker` WAS HERE, AND IS GONE (o3d-0m56 rebased onto o3d-cjt8).
 *
 * It existed to split the two rules that depend on the order's other sync rows out of the decision,
 * so the caller could re-run just those inside the transaction that writes — the amount checks were
 * excluded because the caller "has the row set and nothing else", and re-running them there would
 * have refused every receipt.
 *
 * Both halves of that premise are now false, and in the direction that makes the split unsafe rather
 * than merely redundant:
 *
 *   • o3d-cjt8 made the double-registration protection ARITHMETIC. Once the live-follow-up index is
 *     receipt-scoped, two racing receipts both insert cleanly and the invoice is over-settled, so the
 *     capacity sum is precisely the thing that must be re-run under the lock. A re-check that
 *     deliberately does not judge size would have re-opened the race it was written to close.
 *   • The caller no longer has only the row set: `registerInvoicePaymentWithLedger` hoists its whole
 *     `decisionInput` and re-runs `decideInvoicePaymentRegistration` under the lock with `existing`
 *     refreshed and nothing else changed.
 *
 * So there is ONE decision function, evaluated twice, rather than a decision and a partial copy of
 * it that could drift. See invoice-payment-enqueue.ts for the re-run.
 */

/**
 * WHICH LOCAL RECEIPTS ARE STILL WAITING TO BE REGISTERED (o3d-ekn8).
 *
 * `decideInvoicePaymentRegistration` refuses a receipt recorded BEFORE its invoice posts with
 * DOCUMENT_NOT_POSTED — correctly, since a payment cannot attach to a document the ledger has never
 * seen. The defect was that nothing re-visited it once the SALES_INVOICE finally landed: the receipt
 * stayed recorded, the ledger stayed unsettled, and only the red settlement verdict said so.
 *
 * That is an ORDERING problem, not a uniqueness one — no key was wrong, a moment was missed. So the fix
 * is not a key change but a re-drive at the moment the refusal stops applying (the CREATE posting and
 * writing back accountingInvoiceId), running the SAME guarded decision rather than a second, laxer copy
 * of it.
 *
 * This picks the receipts to re-drive, and is deliberately timid, because the caller's re-drive path
 * does NOT go through planFollowUpEnqueue and so cannot pin a remote idempotency token:
 *
 *  - A receipt with ANY sync row of its own is left alone. A live row is already on its way; a FAILED
 *    row may have committed remotely before failing (o3d-ju8t), and re-driving it would post under a
 *    token the ledger has never seen — the o3d-h2wx double-payment. Those belong to the retry path,
 *    which is built to pin the token, and to the operator, who can see them.
 *  - An UNATTRIBUTED live row (paymentId null) suppresses EVERY receipt on the order. That is the
 *    imported-order shape: the SALES_INVOICE follow-up registers the receipt with no local Payment row
 *    at all, so it cannot be matched to one, and for money "which receipt is this?" unanswered has to
 *    read as "possibly that one".
 *
 * BOTH RULES ARE ASKED OF THE DOCUMENT, NOT ONLY OF THE ORDER (o3d-ekn8 r3). Every row above is first
 * narrowed to those that can speak about the invoice being registered against, by the same test
 * `decideInvoicePaymentRegistration` applies on the read side. Keying this on the receipt alone left
 * one write-side gate document-blind while the read side was not, and a deleted-and-re-posted invoice
 * walked straight through the gap: the retired document's row spoke for the receipt, nothing was
 * awaiting, and the replacement was never settled — with no refusal recorded, because a gate that
 * returns an empty list has nothing to report.
 *
 * AND IT STILL SELECTS A RECEIPT WHOSE ONLY ROW NAMES A RETIRED DOCUMENT (o3d-ekn8 r4). That is
 * deliberate, and it is not the same as licensing the registration: the guarded decision runs and
 * REFUSES with SETTLED_ON_RETIRED_DOCUMENT, which is warned about and names its remedy. Dropping the
 * receipt here instead would return this path to silence — the exact failure o3d-ekn8 exists to end
 * — while the refusal keeps the replacement visibly unsettled rather than settled twice.
 *
 * Refunds are the caller's business to exclude: they settle a credit note, not this invoice.
 */
export function selectReceiptsAwaitingRegistration<T extends { id: string }>(input: {
  receipts: T[]
  existing: ExistingInvoicePaymentSync[]
  /**
   * o3d-ekn8 r3 (Codex HIGH) — THE DOCUMENT THESE RECEIPTS WOULD BE REGISTERED AGAINST.
   *
   * Without it this gate was keyed on the RECEIPT alone, and that made it blind to the exact case
   * o3d-hbgo taught the read side to see: an invoice deleted in the ledger and re-posted as a new
   * document. The receipt's old row still names it, so the receipt read as spoken for, nothing was
   * awaiting, and this function returned an empty list — SILENTLY. The replacement invoice then
   * stayed unsettled for ever with no log line anywhere, which is the same loss o3d-ekn8 exists to
   * close, arriving through a different door.
   */
  accountingInvoiceId: string
}): T[] {
  // SCOPED TO THE DOCUMENT, mirroring `decideInvoicePaymentRegistration`'s `live` filter exactly
  // rather than restating a second opinion about it: a row that settled a DIFFERENT ledger document
  // paid an invoice this order no longer has, so it says nothing about what the CURRENT invoice is
  // still owed. A row that names NO document keeps speaking — for money, unknown must read as
  // "possibly this one" — which is the direction that can only ever withhold work, never duplicate it.
  const aboutThisDocument = input.existing.filter(
    (r) => r.accountingInvoiceId == null || r.accountingInvoiceId === input.accountingInvoiceId,
  )
  // o3d-kof8 — THE ONE GATE HERE THAT IS NOT A LEDGER QUESTION, AND IT IS NOT WIDENED.
  //
  // The other three gates now ask `mayHoldLedgerPayment`, because they decide whether money may
  // move. This one decides whether a receipt is even OFFERED to that decision, and the two point in
  // opposite directions: returning `[]` here is the SILENT end — no refusal is raised, no warning is
  // logged, the replacement invoice is simply never settled — which is the loss o3d-ekn8 exists to
  // prevent. So it must not fire more often than it has to, and a CANCELLED row that may be holding
  // a payment must reach `decideInvoicePaymentRegistration`, which refuses it out loud.
  //
  // What it asks instead is "is there live WORK on an unattributable row", through the same set
  // payment-ledger-hold's classifier reads — a set that omits FAILED as well as CANCELLED, which is
  // a question about the follow-up queue and not a claim about what the ledger received. Identical
  // rows to the pair of status comparisons it replaces, without restating what a cancelled row
  // proves.
  const unattributedLive = aboutThisDocument.some(
    (r) => hasLiveRegistrationWork(r) && r.paymentId == null,
  )
  if (unattributedLive) return []
  const spokenFor = new Set(
    aboutThisDocument.map((r) => r.paymentId).filter((id): id is string => typeof id === 'string'),
  )
  return input.receipts.filter((receipt) => !spokenFor.has(receipt.id))
}
