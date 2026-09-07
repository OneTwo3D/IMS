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
  classifyLedgerSettlement,
  type LedgerSettlementRecord,
} from './ledger-settlement-evidence'
import {
  exactAmountReadingOrLegacy,
  statedAmountOnly,
  type ExactAmountReading,
} from '@/lib/domain/accounting/registered-amount'
import { isOperatorAssertedSettlement } from './sync-row-settlement'
import { accountingIdProvenanceMatches } from '@/lib/connectors/accounting-id-provenance'
import type { AccountingConnectionStamp } from '@/lib/connectors/accounting-connection-provenance'
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
   * A LIVE row for THIS receipt settles a ledger document this order no longer points at
   * (o3d-ekn8 r4). The invoice was deleted and re-posted, so the row is dropped by every
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

/** One INVOICE_PAYMENT sync row, reduced to what the decision depends on. */
export type ExistingInvoicePaymentSync = {
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
  /**
   * HOW this row reached its status (o3d-anu8). NULL / absent = the connector's own writeback, so a
   * real call was made and the ledger answered. `OPERATOR_ASSERTION` = a human typed the outcome and
   * the document id in, and IMS verified nothing — see lib/domain/accounting/sync-row-settlement.ts.
   *
   * Read from the COLUMN. `loadInvoicePaymentSyncRows` already selects it; it is declared here so
   * the capacity arithmetic below can see it rather than receiving a row that merely happens to
   * carry it.
   */
  settlementBasis?: string | null
  /**
   * The ledger document this row's settlement is recorded under. Carried only so a refusal can NAME
   * the payment an operator has to go and read (o3d-anu8).
   */
  externalTransactionId?: string | null
  /**
   * o3d-r948 r5 (Codex HIGH) — WHICH ACCOUNTING ORGANISATION THIS ROW WAS RAISED AGAINST, as
   * `readAccountingOriginRecord` reads it from the row's durable column AND its payload stamp.
   *
   * `loadInvoicePaymentSyncRows` fills it on every row. It is OPTIONAL here for the same reason
   * every other field on this type is: a caller that cannot supply it passes nothing, and absent
   * is UNKNOWN — which grants no exclusion below. The cost of an unplumbed caller is therefore a
   * refusal, not a permission, which is the only direction a money guard may default in.
   *
   * The four-state stamp is kept whole rather than flattened to a string, because "raised while
   * nothing was connected", "queued before the stamp shipped" and "the two halves disagree" are
   * three different sentences to an operator, and collapsing them is the defect
   * `readAccountingOriginRecord` was written to remove. Only `stamped` can ever match.
   */
  origin?: AccountingConnectionStamp
}

/**
 * o3d-r948 r5 (Codex HIGH) — IS THIS ROW'S RECORDED ID AN ID IN THE LEDGER THE PROBE JUST READ?
 *
 * BOTH SIDES, OR NEITHER. Excluding a probe record because some row of ours names its id is only
 * sound when that row was raised against the SAME organisation the probe answered from — so this
 * takes both, and a missing answer on EITHER side excludes nothing. Scoping only the row would
 * compare a realm-stamped id against records of unknown origin, which is a different unproved
 * claim, not half of a proof.
 *
 * `accountingIdProvenanceMatches` is the repository's one comparison of two provenance strings, not
 * a second spelling of it here — the same reason `isOperatorAssertedSettlement` is used above rather
 * than a fresh basis test. It requires an exact match and treats null on either side as no match.
 *
 * WHAT COUNTS AS UNKNOWN, and every one of them refuses:
 *
 *   • `absent`   — the row predates the stamp, or the probe's caller does not plumb the provenance.
 *   • `unreadable` — the payload and the column describe two different moments, or something we do
 *     not recognise wrote one of them. "I cannot tell" is never "the same" (the rule
 *     `accountingOriginRecordsMatch` already states).
 *   • `raised-disconnected` — the row was raised while nothing was connected, so nothing can vouch
 *     for the id it carries at all. Flattened to a sentinel that cannot equal any real provenance.
 *
 * THE COST IS PAID IN THE SAFE DIRECTION AND IT IS REAL. Every INVOICE_PAYMENT row queued before
 * `_connectionProvenance` shipped answers `absent`, so it can no longer release a sibling's
 * unmeasurable settlement, and a receipt behind one is refused with UNRESOLVED_PAYMENT_ATTEMPT —
 * visibly, with a nameable remedy. That is the same trade `classifyLedgerSettlement` already states
 * for a caller that can supply no set at all: "the cost of holding a genuine payment back is a
 * visible refusal, and the cost of the alternative is a second payment."
 */
export function excludingRowIsFromTheProbedLedger(
  origin: AccountingConnectionStamp | undefined,
  probedConnectionProvenance: string | null | undefined,
): boolean {
  const probed = typeof probedConnectionProvenance === 'string' ? probedConnectionProvenance.trim() : ''
  return accountingIdProvenanceMatches(
    origin?.state === 'stamped' ? origin.provenance : null,
    probed === '' ? null : probed,
  )
}

/**
 * Attempts whose outcome is not established: FAILED or CANCELLED, not this receipt's own row, and
 * structurally complete enough that the connector would have made the call.
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
    && r.couldHaveReachedLedger !== false)
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
 * So a live row naming a retired document REFUSES, at both the enqueue gate and the post-site guard,
 * which is what keeps the two from disagreeing. What clears it is the one thing that is actual
 * evidence: the row stops being live. Cancelling it is an operator saying "I looked, and the ledger
 * does not hold this payment" — and that is exactly the fact the code cannot establish for itself.
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
    r.status !== 'FAILED'
    && r.status !== 'CANCELLED'
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
   */
  ledgerSettlements: LedgerSettlementRecord[] | null
  /**
   * o3d-r948 r5 (Codex HIGH) — THE ORGANISATION THOSE SETTLEMENTS CAME FROM, as
   * `"<connector>:<tenantId>"`, straight off the probe (`LedgerSettlementProbe.connectionProvenance`).
   *
   * The OTHER half of the scoping, and it is not optional to the argument even though it is optional
   * to the type. `ledgerSettlements` is a list of ids in ONE ledger's namespace and says nowhere
   * which; without knowing that, "a row of ours records this id" cannot establish that the row and
   * the record are the same object, only that two namespaces used the same string.
   *
   * NULL / ABSENT = the probe could not say which organisation answered — including the case where
   * the connection MOVED across the read, which `probeLedgerSettlement` deliberately reports as
   * null. Nothing is then excluded, and every unmeasurable record withholds.
   */
  ledgerConnectionProvenance?: string | null
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
        { ok: true, records: input.ledgerSettlements },
        // o3d-r948 r3 (Codex HIGH) — THE ONE EXCLUSION THAT IS NOT A MUTABLE FIELD.
        //
        // A settlement the ledger holds may be unmeasurable — an amount this code will not read, or a
        // date it cannot normalise — and `classifyLedgerSettlement` then withholds on it, correctly,
        // because an unmeasurable record cannot be ruled out as this attempt by anything the record
        // itself says. That is a permanent hold when the record belongs to a DIFFERENT row that
        // already posted: `unresolvedInvoicePaymentAttempts` only judges FAILED and CANCELLED rows,
        // so a SYNCED row's payment is never matched to its own attempt here — it can only ever
        // block, and it blocks every future receipt on this order for good.
        //
        // What clears it is the only fact strong enough to: IMS RECORDED that settlement's own id
        // when that other row posted it. `externalTransactionId` is the ledger's `PaymentID` /
        // `Payment.Id`, which the ledger assigns and cannot re-assign, so a record carrying it was
        // created by that row and not by this attempt — whatever has since been done to its amount,
        // its date or its reference.
        //
        // BY REFERENCE, NOT BY A FIELD. `unresolved` is a filtered view of `input.existing`, so the
        // row under judgement is the same object; removing it by identity is what guarantees this
        // attempt's OWN recorded settlement is never excluded from its own match. Excluding that one
        // would skip the record that proves this attempt already posted, which is precisely the
        // `clear` this module exists to prevent.
        //
        // o3d-r948 r4 (Codex HIGH) — AND OUR OWN RECORD IS NOT ALWAYS EVIDENCE.
        //
        // The paragraph above is right about the LEDGER's half and stopped one step short on OURS.
        // The id is immutable and the ledger cannot re-assign it, so a record carrying it was made
        // by whoever really obtained it — but "that row obtained it" is a claim this table makes,
        // and on an `OPERATOR_ASSERTION` row that claim is a human typing a document id into a form
        // with no call made and no document read (see sync-row-settlement.ts, which defines the
        // basis as exactly that). An asserted row can therefore name a payment it never created,
        // and this is the one site on the branch where naming one REMOVES evidence rather than
        // adding a refusal. So the chain of custody has to run back to CONNECTOR EVIDENCE, not
        // merely to a row in our own table.
        //
        // THE REACHABLE SHAPE, and it is reachable precisely because every other gate lets it past.
        // An asserted SYNCED row that names the RETIRED invoice and a DIFFERENT receipt is dropped
        // by `retiredDocumentInvoicePaymentAttempts` (its `paymentId` is neither null nor this
        // receipt's), dropped by the `live` document filter (it names another document) and so never
        // reaches the LEDGER_AMOUNT_ASSERTED gate that reads that filter's output. The exclusion set
        // was the only place it was still consulted — and there it did the one thing an unverified
        // claim must never do: if the typed id happens to equal the id of the unresolved attempt's
        // OWN unmeasurable settlement, the record proving that attempt posted is skipped, the verdict
        // is `clear`, and the receipt registers a second payment.
        //
        // FILTERED THROUGH THE MODULE'S OWN PREDICATE, not a second spelling of it:
        // `isOperatorAssertedSettlement` is the same reader `settlement-status.ts`, the delete guard
        // and the capacity guard below already fail closed on, and reconciliation.ts already uses to
        // deny an asserted row the standing of evidence.
        //
        // WHAT STILL COUNTS AS CONNECTOR-BACKED, deliberately, because narrowing this further would
        // strand the receipts the exclusion exists to release:
        //
        //   • `CONNECTOR_CONFIRMED` (the NULL basis) — the processor's own writeback, made after the
        //     ledger answered with the id. This is the ordinary case and the whole point.
        //   • `OPERATOR_RELEASE` — the row's STATUS was reached by a human, but its DOCUMENT ID is
        //     the connector's own: `describeCancelledSaleRelease` refuses an asserted row outright,
        //     so that basis can only ever sit on connector-issued evidence. `isOperatorAssertedSettlement`
        //     is FALSE for it by design, and using the predicate rather than "basis is not null" is
        //     what preserves it. Folding it in would re-strand every released row's siblings.
        // o3d-r948 r5 (Codex HIGH) — AND A CONNECTOR IS NOT A NAMESPACE.
        //
        // r4's note ended by clearing the last question with the wrong answer, and the answer was
        // wrong in the permissive direction:
        //
        //     "THE CONNECTOR ITSELF is already pinned upstream... every row in `input.existing` was
        //      written for the same ledger the probe read — the ids cannot come from another
        //      connector's namespace. There is no per-realm `provenance` column to check beyond
        //      that: that work was tried and REVERTED (o3d-gt8r / o3d-s36z), and the schema comment
        //      on `backReferenceEvidenceCompactedAt` records it."
        //
        // BOTH SENTENCES ARE FALSE, and the second is the reason the first went unchecked.
        // `loadInvoicePaymentSyncRows` filters on `connector`, which is `'quickbooks'` — a ledger
        // TYPE. An operator can disconnect from realm A and reconnect to realm B, and every row
        // raised against A stays in this table under that same string. QuickBooks mints short
        // numeric payment ids, so A's `123` and B's `123` are two different payments spelt the same.
        // A confirmed A row recording `123`, against a receipt and a document that make it invisible
        // to the retired-document gate and the `live` filter alike, then excludes B's OWN record
        // `123` — the unresolved attempt's unmeasurable settlement is skipped, the verdict is
        // `clear`, and a second payment posts. That is precisely the route r4's own test walks.
        //
        // AND THE COLUMN EXISTS. `AccountingSyncLog.connectionProvenance` (o3d-dzip) holds
        // `"<connector>:<tenantId>"` in a place retention cannot reach, beside the payload stamp
        // o3d-s36z writes, and `readAccountingOriginRecord` is the reader that weighs the two. What
        // o3d-gt8r / o3d-s36z reverted was ONE DESIGN for per-realm namespacing, not the capability
        // — a reverted attempt is not an absence, and the schema comment recording the revert sits
        // directly above the column that shipped instead.
        //
        // SO BOTH SIDES ARE SCOPED, by `excludingRowIsFromTheProbedLedger`: the row must positively
        // record the organisation the probe answered from, and the probe must positively say which
        // that was. Unknown on either side excludes nothing — see that function for why each flavour
        // of unknown refuses, and for the rollout cost, which falls on the refusing side.
        {
          settlementsOfOtherAttempts: input.existing
            .filter((row) => row !== attempt
              && !isOperatorAssertedSettlement(row.settlementBasis)
              && excludingRowIsFromTheProbedLedger(row.origin, input.ledgerConnectionProvenance))
            .map((row) => row.externalTransactionId),
        },
      )
      if (verdict.outcome === 'clear') continue
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

  // FAILED and CANCELLED rows hold nothing — the ledger rejected them or never saw them — so they free
  // the capacity again, exactly as the index's live-status predicate does.
  const live = input.existing.filter(
    (r) => r.status !== 'FAILED' && r.status !== 'CANCELLED'
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
  const unattributedLive = aboutThisDocument.some(
    (r) => r.status !== 'FAILED' && r.status !== 'CANCELLED' && r.paymentId == null,
  )
  if (unattributedLive) return []
  const spokenFor = new Set(
    aboutThisDocument.map((r) => r.paymentId).filter((id): id is string => typeof id === 'string'),
  )
  return input.receipts.filter((receipt) => !spokenFor.has(receipt.id))
}
