import {
  readPostedInvoiceOrderDiscount,
  type PostedInvoiceEventClient,
  type PostedInvoiceOrderDiscount,
  type PostedInvoiceTaxBasis,
} from '@/lib/domain/accounting/posted-order-discount'
import {
  readCreditNoteOrderDiscount,
  type CreditNoteOrderDiscountClient,
  type CreditNoteOrderDiscountReversal,
} from '@/lib/domain/accounting/credit-note-order-discount'

/**
 * o3d-y14 r5 finding 1 — WHAT THE OPERATOR IS ACTUALLY TOLD TO DO IN THE ACCOUNTING SYSTEM.
 *
 * THE DEFECT THIS REPLACES. Every revision up to r5 printed ONE sentence for every corrected order
 * that had any accounting document: "those documents still understate and need a manual
 * credit/adjustment." r4 then established the derivation that proves the sentence false for a whole
 * class of them — the Xero adapter appends its negative "Order discount" line only when a discount
 * ACCOUNT CODE came with the payload (`lib/connectors/xero/invoices.ts:76`), so an invoice enqueued
 * without one posted the full goods less the per-line coupon and carries NO order-level discount at
 * all. For those orders the duplicate never reached the ledger; clearing the IMS column is the whole
 * fix, and following the old instruction would post an erroneous credit against a correct invoice.
 *
 * It was wrong in a second way even where a document DID carry the duplicate. Such an invoice
 * discounts MORE than the corrected order, so it charged the customer too LITTLE — its balance has
 * to go UP. A credit note moves it DOWN. The named instrument was the wrong one in the one case the
 * sentence was written for.
 *
 * SO EACH ORDER IS CLASSIFIED BY WHAT ITS DOCUMENT CARRIES, using
 * `readPostedInvoiceOrderDiscount` — literally the function `resolvePostedOrderDiscount` uses for
 * the chargeback path, not a second copy of its rules. Four answers, four different jobs:
 *
 *   DOCUMENT_AGREES          the document already carries the corrected residual. NOTHING to do in
 *                            the accounting system, and saying otherwise is the r5 defect.
 *   DOCUMENT_DISCOUNTS_MORE  the document discounts more than the order now retains: it charged too
 *                            little. Raise the invoice, or invoice the difference. NOT a credit note.
 *   DOCUMENT_DISCOUNTS_LESS  the document discounts less: it charged too much. Credit the difference.
 *   DOCUMENT_UNVERIFIED      the derivation refused. NO remedy is prescribed — the operator is told
 *                            how to read the answer off the document instead. An assumption here is
 *                            precisely what produces a wrong ledger entry.
 *
 * AND NONE OF THAT MAY BE PRESCRIBED ON A REFUNDED ORDER (o3d-y14 r6 finding 1).
 *
 * Every case above compares ONE document against the corrected order and prescribes from the
 * difference. That is a statement about the invoice, and on an order with credit notes against it
 * the invoice is only half of the position. A fully refunded order's invoice and credit note can
 * already net to nothing — the invoice charged the customer too little, the credit note that
 * reversed it credited them too little by the same amount, and the two errors cancel. Telling the
 * operator to "raise a further invoice for the difference" there RE-BILLS A CUSTOMER WHO HAS
 * ALREADY BEEN REFUNDED, which is exactly the shape of error `decideChargebackOrderDiscount`
 * already refuses to make (it returns MANUAL rather than mirroring a figure it cannot place).
 * DOCUMENT_DISCOUNTS_LESS fails the same way in the other direction: crediting an invoice that has
 * already been credited away refunds the same money twice. DOCUMENT_AGREES is not safe either — it
 * says the INVOICE is right, and then asserts the LEDGER is, which on a refunded order is a claim
 * about credit notes nobody has read. DOCUMENT_UNVERIFIED's read-it-off-the-document ladder ends in
 * conditional instruments ("raise a further invoice for it", "credit the difference"), so it
 * prescribes too. Only NO_INVOICE_IN_LEDGER survives contact with a refund unchanged, and only
 * because it prescribes nothing to begin with.
 *
 * SO WHY NOT JUST NET THEM AND PRESCRIBE THE REMAINDER? For most of these orders the net genuinely
 * cannot be established — but r6 said so for the WRONG REASON, and the wrong reason suppressed a
 * class of orders where the answer IS available (r7 finding 4).
 *
 * r6's ground was that the credit note's discount leg cannot be identified because "the refund
 * service mirrors the invoice's discount line as an ordinary NEGATIVE LINE whose kind is not
 * preserved in what IMS recorded". The first half is true; the second is false. It conflated the
 * enqueued PAYLOAD — where `normalizeDocumentLine` really does drop the kind — with the ROW IMS
 * stored. `SalesOrderRefundLine.lineKind` is a persisted column, written `'discount'` at refund
 * creation by `buildChargebackRefundLines`, and read back by both replay paths; legacy NULLs are
 * reconstructed deterministically by production's own retry loader. Neither credit-note adapter has
 * an omission rule to replay either — both map every stored line to a document line one-for-one —
 * so the persisted rows ARE what the credit note carried. See
 * `lib/domain/accounting/credit-note-order-discount.ts`, which is that derivation and shares its
 * kind rule with `reconstructReplayLine` so the two cannot drift.
 *
 * SO THE NET IS DERIVED WHERE IT IS SOUND, AND ONLY THERE. When the posted credit notes REVERSE THE
 * WHOLE ORDER by mirroring its invoice — a FULL disposition, every refund a `chargeback`, every one
 * of them named by a credit note that is in the ledger and by no other, NET totals, and no
 * unrecorded refund park — the net is exactly
 *
 *     net = (what the invoice's order-discount line posted) - (what the credit notes reversed of it)
 *
 * and the corrected residual does not enter it at all: both documents are wrong by the same
 * mis-stated figure, so what survives is the difference between them. Positive means the customer
 * still owes that much; negative means they are owed it; zero means the two errors cancelled and
 * there is nothing to do — which is the case r6 could only reach by asking a human to check.
 *
 * EVERY OTHER SHAPE STILL REFUSES, and now says WHICH condition failed rather than asserting a
 * blanket impossibility: a WooCommerce-mirrored refund (`refund-sync.ts` emits only `'sale'` and
 * `'shipping'` kinds, because it reverses what WooCommerce refunded rather than what the invoice
 * charged, so the ABSENCE of a discount leg there is not a zero); a PARTIAL position, which needs an
 * apportionment nothing recorded provides; legacy GROSS totals; a leg whose currency cannot be
 * pinned; a credit note in the ledger that no refund row accounts for; and a refund that arrived and
 * could not be recorded at all. In every one of those the invoice finding is still reported — it is
 * a fact, and the operator needs it — the per-credit-note legs that COULD be derived are printed
 * beside it, and NO REMEDY IS PRESCRIBED.
 *
 * AND NO NETTING CLAIM REACHES AN OPERATOR EXCEPT FROM A NETTING THAT RAN (r10 finding 1).
 *
 * The refusals above are the paths taken when the subtraction could NOT be performed — and two of
 * them went on stating, in prose, the conclusion the subtraction would have reached: "so on a full
 * refund the two errors cancel and the net owed is nothing", and "crediting an invoice that has
 * already been credited away refunds the same money a second time". Both are netting results,
 * asserted in exactly the cases where no netting was possible, and an operator who reads "the two
 * errors cancel" on a suppressed order files it as square — the outcome the suppression exists to
 * prevent. So the netting's conclusion is now a VALUE (`WcCouponNetPosition`) constructed only by
 * the branch that performs the subtraction, `wcCouponNetClaimSteps` is its only renderer, and every
 * suppressed path carries `netPosition === null` and states the two sides' FACTS and the reason the
 * subtraction was withdrawn instead. Same shape as the remedy property below, and asserted the same
 * way: over the whole case x refund-shape x suppression-reason matrix.
 *
 * AND EVERY POSTED DOCUMENT IS NAMED, NOT THE NEWEST (r10 finding 2).
 *
 * `readPostedInvoiceOrderDiscount` returns ONE amount when every posted document AGREES on it, and
 * r8 established that agreement is not singularity: two POSTED events are two DISTINCT documents,
 * each holding that discount. It withdrew the NETTING on that ground while the non-netted remedy
 * went on naming `externalId` — the newest — so an operator told to correct "invoice INV-778"
 * corrected one of two documents that each carry the duplicate. The document REFERENCE is now
 * plural (`describePostedDocuments`), so every sentence that names the document names all of them,
 * and with more than one document NO REMEDY IS PRESCRIBED AT ALL: the per-document difference is
 * not what the ledger is out by, and multiplying it is equally unfounded, because nothing IMS
 * records says whether those documents each bill the whole order or divide it. The same withholds
 * the READ_THEN_CHOOSE ladder where the derivation refused BECAUSE several posted documents
 * DISAGREE — its branches end in instruments and it is written against "the document", of which
 * there is then no such thing.
 *
 * AND NO REMEDY REACHES AN OPERATOR EXCEPT AS A `WcCouponRemedy` (r7 finding 3). Three consecutive
 * rounds shipped a remedy pointing the wrong way, each time in prose that a case-by-case reading had
 * missed — r6's own refusal text still ended "settle THAT figure as an ordinary receivable", which
 * is a direction, and the wrong one whenever the customer is the party owed. So the instrument
 * sentences are no longer written in the case renderers at all: `wcCouponRemedySteps` is their only
 * producer, it is reachable only from a `WcCouponRemedy` value the classifier returned, and
 * `WcCouponLedgerHandoff.remedy` is NULL for every suppressed case. The property that no other line
 * carries an instruction is asserted over the whole case x refund-shape matrix rather than case by
 * case, which is what the last three rounds' review-by-inspection kept missing.
 *
 * AND EVERY REMEDY NAMES EVERY POSITION IT DEPENDS ON (r12 finding 2). The precondition
 * `wcCouponPreconditionSteps` prints first — the one defence over the residual window between the
 * last re-validation and the line reaching a human's eye — named the REFUND position only, because
 * that is the side r7 finding 2 was about. r11 finding 1 then established that the INVOICE side
 * moves in the same window by the same mechanism and made the re-validation watch it, which closes
 * the window up to the last check and not the residual one this line exists for. So the invoice-side
 * position (`WcCouponDocumentPosition`, the same value the re-validation compares) travels on the
 * remedy and on the net position, and the line names both and tells the operator to re-check both.
 *
 * THE REVENUE-DEFERRAL JOURNAL IS A SEPARATE DOCUMENT WITH A SEPARATE — AND EMPTY — REMEDY.
 * Group A1 posts a manual journal deferring `subtotalBase + shippingBase − discountBase`, stamps the
 * result on `SalesOrder.unearnedRevenueAmount`, and the daily batch later RECOGNISES that same
 * stamped figure back out (`deferredBase = order.unearnedRevenueAmount`, xero/quickbooks
 * daily-sync). Deferral and recognition are one timing pair keyed on one number. Adjusting the
 * journal by hand while IMS goes on reversing what it originally deferred would strand the
 * difference in the unearned-revenue account permanently — so the honest instruction is to leave it
 * alone and to say why, which is what `deferralLines` below does. There is no third option to
 * invent: IMS does not recompute the stamp, and this backfill deliberately does not either.
 *
 * EVERY REMEDY NAMED BELOW IS PERFORMABLE IN THE SYSTEM IT NAMES:
 *   • Xero lets you edit an AUTHORISED invoice, provided no payment or credit note is allocated to
 *     it and its date is not inside a locked period; Invoice ▸ Options ▸ Remove & Redo takes a paid
 *     invoice back to draft and releases the payment when one is.
 *   • Where it cannot be edited, a further ACCREC invoice to the same contact is always available,
 *     and is the only instrument that moves a receivable UP.
 *   • Invoice ▸ Options ▸ Add Credit Note raises an ACCRECCREDIT pre-filled against that invoice and
 *     allocates it, which is the instrument that moves one DOWN.
 *   • QuickBooks Online allows a posted invoice to be edited directly (unlink the payment on the
 *     Receive Payment screen first), and a credit memo applied to the invoice for the reverse.
 * Nothing here asks for an operation the UI does not have, and nothing here asks for one whose
 * direction contradicts the discrepancy it is meant to settle.
 */

/**
 * WHAT HAS ALREADY BEEN CREDITED BACK TO THIS CUSTOMER (o3d-y14 r6 finding 1, r7 finding 1).
 *
 * FOUR signals, taken as a UNION rather than one preferred field, because each can be true while
 * the others are silent:
 *
 *   `disposition`  `SalesOrder.refundStatus`. The order's own summary of its refund position, and
 *                  the only one that distinguishes a FULL refund (where the invoice may be credited
 *                  away entirely) from a PARTIAL one.
 *   `refundIds`    `SalesOrderRefund` rows. A refund can exist while the disposition still reads
 *                  NONE — the status is written by the refund workflow, not by the row's existence.
 *   `postedCreditNoteExternalIds`
 *                  credit notes that reached the ledger: `SalesOrderRefund.accountingCreditNoteId`
 *                  UNION the SYNCED CREDIT_NOTE sync rows, for the same o3d-9kek reason the invoice
 *                  side reads both — a post can succeed and never write its id back.
 *   `unresolvedRefundParkExternalIds`
 *                  r7 finding 1, and the signal whose ABSENCE was the worst of the four. A
 *                  WooCommerce refund that arrived and could NOT be recorded is durably PARKED as a
 *                  `ShoppingSyncLog` row (`refund-sync.ts`: connector woocommerce, FROM_CONNECTOR,
 *                  entityType SalesOrder, an entityId, and status PENDING / FAILED / QUARANTINED —
 *                  exactly the predicate of the `shopping_sync_logs_active_refund_park_uq` index).
 *                  It creates NO refund row, NO status change and NO credit note, so all three
 *                  signals above read "not refunded" for it — while the money has already left the
 *                  business. A monetary-only refund on a non-uniformly-taxed order is quarantined
 *                  precisely because IMS could not post it safely; those are the orders where a
 *                  wrong remedy is MOST likely, and the union used to hand them the full
 *                  "raise a further invoice" text.
 *
 * Absence of all four is read as "no refund", which is the same standard the invoice side applies
 * to its own evidence. It is not proof — but every branch that acts on it prescribes LESS, never
 * more, than the unrefunded case.
 */
export type WcCouponRefundEvidence = {
  /** `SalesOrder.refundStatus`. */
  disposition: 'NONE' | 'PARTIAL' | 'FULL'
  /** `SalesOrderRefund.id` for every refund against this order, sorted. */
  refundIds: string[]
  /** Credit notes for those refunds that are in the ledger, sorted. */
  postedCreditNoteExternalIds: string[]
  /**
   * External WooCommerce refund ids that are PARKED unresolved against this order (r7 finding 1):
   * refunds that arrived and could not be recorded. Sorted.
   */
  unresolvedRefundParkExternalIds: string[]
}

/** The ledger evidence the backfill reads live under the correction's lock. */
export type WcCouponLedgerEvidence = {
  accountingInvoiceId: string | null
  postedInvoiceExternalIds: string[]
  revenueDeferredBatchRef: string | null
  unearnedRevenueAmount?: number | null
  /**
   * REQUIRED, never defaulted. An optional field would let a caller that simply forgot to read the
   * refunds assert on the operator's behalf that there are none — about the one class of order
   * where that mistake re-bills someone (r6 finding 1).
   */
  refunds: WcCouponRefundEvidence
}

/** No refund evidence at all — the shape a caller passes for an order it has PROVEN is unrefunded. */
export const WC_COUPON_NO_REFUNDS: WcCouponRefundEvidence = {
  disposition: 'NONE',
  refundIds: [],
  postedCreditNoteExternalIds: [],
  unresolvedRefundParkExternalIds: [],
}

/** Has ANY value been credited back against this order? Any one signal is enough. */
export function isWcCouponOrderRefunded(refunds: WcCouponRefundEvidence): boolean {
  return (
    refunds.disposition !== 'NONE' ||
    refunds.refundIds.length > 0 ||
    refunds.postedCreditNoteExternalIds.length > 0 ||
    // r7 finding 1. A parked refund is a refund that HAPPENED — the money left — and produced none
    // of the three signals above. Reading it as "not refunded" is the assertion that hands an
    // already-refunded customer a further invoice.
    refunds.unresolvedRefundParkExternalIds.length > 0
  )
}

/**
 * THE INVOICE SIDE OF THE LEDGER AS IT STOOD WHEN THIS HANDOFF WAS DERIVED (o3d-y14 r11 finding 1).
 *
 * THE DEFECT IT CLOSES. r7 finding 2 established that a remedy printed to a console is a LIVE
 * directional instruction, worked through by a human minutes or hours after the transaction that
 * produced it committed — so it is re-validated immediately before it is printed and withdrawn if
 * the position it rests on has moved. That re-validation only ever watched the REFUND side, because
 * that is what r7's finding named. The invoice side moves too, and by exactly the same mechanism:
 * a document voided in Xero and re-posted, a second invoice raised for the order, a back-reference
 * repair (o3d-9kek) attaching an id nobody had — any of which lands after the correction commits and
 * leaves "edit invoice INV-778 down to 0" describing a ledger that no longer holds INV-778 in that
 * shape.
 *
 * The property is one property, not two: A REMEDY MUST DESCRIBE THE LEDGER AS IT IS WHEN THE
 * OPERATOR READS IT, OR WITHDRAW. So the whole invoice-side position travels on the handoff, in
 * canonical form, and the re-validation compares it as a VALUE — the same shape `WcCouponRefundEvidence`
 * already has for the other side, for the same reason.
 *
 * WHAT IS IN IT, and why each field:
 *
 *   the order's own back-references (`accountingInvoiceId`, the SYNCED sync-log ids, the deferral
 *   batch and its stamp) — these are what `describeLedgerReference` names, what the ActivityLog
 *   records, and what the deferral paragraph quotes;
 *
 *   the MIRRORED DOCUMENT DERIVATION — the answer `readPostedInvoiceOrderDiscount` gave, reduced to
 *   the fields every downstream claim is built from: the amount, how many documents carried it,
 *   which ones, which ledger, and which tax basis. A document that was voided, re-posted or joined
 *   by a second one changes at least one of them.
 *
 *   AND THE DOCUMENT SET ITSELF (r12 finding 1). The fields above are what a SUCCESSFUL derivation
 *   claims; a REFUSAL claims none of them, and carries only the sentence saying why it failed. That
 *   sentence is not a description of the rows it failed over — "2 SALES_INVOICE_UPDATE event(s)
 *   never reached POSTED" is reached before the posted documents are read at all, and "a
 *   SALES_INVOICE was posted but the mirrored event does not carry a document payload" names a type
 *   and a reason, never a document. So the derivation's own `documentSet` fingerprint travels here
 *   and is compared, on every variant. See `posted-order-discount.ts` for what is in it and why.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not a hash: a withdrawal has to be able to SAY what moved, and
 * an operator who is told only that "something changed" learns to re-run rather than to look. That
 * governs the fingerprint too — every one of its entries is a sentence, and
 * `describeWcCouponDocumentPosition` prints them.
 */
export type WcCouponMirroredDocumentPosition =
  | {
      ok: true
      amount: number
      documentType: string
      documentCount: number
      /** Newest first, as the derivation reported them. COMPARED as a set; PRINTED in this order. */
      externalIds: string[]
      externalSystem: string | null
      taxBasis: PostedInvoiceTaxBasis
      /** The rows the derivation was computed over, sorted (r12 finding 1). */
      documentSet: string[]
    }
  | {
      ok: false
      reason: 'NO_POSTED_EVENT' | 'UNRECOVERABLE'
      /** The refusal's own words. NULL for NO_POSTED_EVENT, which has none. */
      detail: string | null
      documentCount: number | null
      externalIds: string[]
      /**
       * The rows the refusal was derived over, sorted (r12 finding 1). Unlike `documentCount` and
       * `externalIds` — which the derivation sets only where it ESTABLISHED which documents disagree,
       * so that a caller can name them — this is present on every refusal, because it is evidence
       * rather than a claim and prescribes nothing.
       */
      documentSet: string[]
    }

export type WcCouponDocumentPosition = {
  currency: string
  accountingInvoiceId: string | null
  postedInvoiceExternalIds: string[]
  revenueDeferredBatchRef: string | null
  unearnedRevenueAmount: number | null
  document: WcCouponMirroredDocumentPosition
}

/** The canonical invoice-side position, from the two reads a handoff is derived from. */
export function buildWcCouponDocumentPosition(
  document: PostedInvoiceOrderDiscount,
  input: { currency: string; evidence: WcCouponLedgerEvidence },
): WcCouponDocumentPosition {
  return {
    currency: input.currency,
    accountingInvoiceId: input.evidence.accountingInvoiceId,
    postedInvoiceExternalIds: [...input.evidence.postedInvoiceExternalIds],
    revenueDeferredBatchRef: input.evidence.revenueDeferredBatchRef,
    unearnedRevenueAmount: input.evidence.unearnedRevenueAmount ?? null,
    document: document.ok
      ? {
          ok: true,
          amount: document.amount,
          documentType: document.documentType,
          documentCount: document.documentCount,
          externalIds: [...document.externalIds],
          externalSystem: document.externalSystem,
          taxBasis: document.taxBasis,
          documentSet: [...document.documentSet],
        }
      : {
          ok: false,
          reason: document.reason,
          detail: document.reason === 'UNRECOVERABLE' ? document.detail : null,
          documentCount: document.reason === 'UNRECOVERABLE' ? (document.documentCount ?? null) : null,
          externalIds: document.reason === 'UNRECOVERABLE' ? [...(document.externalIds ?? [])] : [],
          // Carried on BOTH refusal reasons, unlike the two fields above: NO_POSTED_EVENT's set is
          // empty because there is nothing to fingerprint, not because nothing was looked at.
          documentSet: [...document.documentSet],
        },
  }
}

/**
 * Sorted and de-duplicated, for the same reason `sortedPostedInvoiceIds` is: the two sides of this
 * comparison are read at different times by different queries, and neither Prisma nor PostgreSQL
 * promises a stable order for either. A comparison that refused on row order would withdraw remedies
 * at random, which teaches an operator to ignore the withdrawal that matters.
 */
function idSet(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('|')
}

/**
 * The document-set fingerprint in canonical form (r12 finding 1).
 *
 * Sorted for the same reason `idSet` is, and NOT de-duplicated for the opposite one: two documents
 * identical in every field are two documents, and collapsing them would hide exactly the duplication
 * r8 finding 2 refuses the netting over.
 */
function documentSetKey(entries: readonly string[]): string {
  return [...entries].sort().join('\n')
}

/** Is this the SAME invoice-side position the handoff was derived from? Field by field. */
export function sameWcCouponDocumentPosition(left: WcCouponDocumentPosition, right: WcCouponDocumentPosition): boolean {
  if (left.currency.toUpperCase() !== right.currency.toUpperCase()) return false
  if (left.accountingInvoiceId !== right.accountingInvoiceId) return false
  if (idSet(left.postedInvoiceExternalIds) !== idSet(right.postedInvoiceExternalIds)) return false
  if (left.revenueDeferredBatchRef !== right.revenueDeferredBatchRef) return false
  if (left.unearnedRevenueAmount !== right.unearnedRevenueAmount) return false
  const a = left.document
  const b = right.document
  if (a.ok && b.ok) {
    return (
      a.amount === b.amount &&
      a.documentType === b.documentType &&
      a.documentCount === b.documentCount &&
      a.externalSystem === b.externalSystem &&
      a.taxBasis === b.taxBasis &&
      idSet(a.externalIds) === idSet(b.externalIds) &&
      // r12 finding 1. Two POSTED documents that both record NO external id agree on the amount, the
      // count and the (empty) id list, so swapping one for another moves nothing above this line.
      documentSetKey(a.documentSet) === documentSetKey(b.documentSet)
    )
  }
  if (!a.ok && !b.ok) {
    // The REFUSAL's own words are compared too: an unverified document whose refusal changed from
    // "an update never settled" to "two documents disagree" is a different ledger, and the sentence
    // printed for it names the old reason.
    return (
      a.reason === b.reason &&
      a.detail === b.detail &&
      a.documentCount === b.documentCount &&
      idSet(a.externalIds) === idSet(b.externalIds) &&
      // r12 finding 1 — AND THE WORDS ARE NOT THE ROWS. Everything above this line is what the
      // refusal SAYS, and a refusal says why the derivation failed, not which documents it failed
      // over: the unsettled-update refusal is reached before the posted set is read at all, and the
      // unreadable-payload one names a TYPE and a reason. The rows themselves are compared here.
      documentSetKey(a.documentSet) === documentSetKey(b.documentSet)
    )
  }
  return false
}

/**
 * Render an invoice-side position for an operator message. Says WHAT it is, never just "changed".
 *
 * THE FINGERPRINT IS PRINTED, NOT JUST COMPARED (r12 finding 1). A position can move on the document
 * set ALONE — an unreadable payload behind the one the refusal names, a re-mirrored event, an
 * unsettled update swapped for another — and a withdrawal that read "the position is now X, not the
 * X it was derived from" is the "something changed" message this whole type was built to avoid. It
 * is one line per row and it is what an operator opens the accounting system with.
 */
export function describeWcCouponDocumentPosition(position: WcCouponDocumentPosition): string {
  const document = position.document
  const documentPart = document.ok
    ? `${document.documentCount} posted document(s) [${document.externalIds.join(', ') || 'none nameable'}] ` +
      `carrying ${document.amount} ${position.currency} of order-level discount, ` +
      `${document.taxBasis}, in ${systemName(document.externalSystem)}`
    : document.reason === 'NO_POSTED_EVENT'
      ? 'NO posted sales-invoice event'
      : `an UNRECOVERABLE posted-document read${
          document.documentCount !== null ? ` over ${document.documentCount} document(s)` : ''
        }${document.externalIds.length ? ` [${document.externalIds.join(', ')}]` : ''} (${document.detail ?? 'no detail'})`
  const set = [...position.document.documentSet].sort()
  return (
    `accountingInvoiceId=${position.accountingInvoiceId ?? 'none'}, ` +
    `SYNCED sales invoice(s) [${[...position.postedInvoiceExternalIds].sort().join(', ')}], ` +
    `revenue-deferral batch ${position.revenueDeferredBatchRef ?? 'none'} of ` +
    `${position.unearnedRevenueAmount ?? 'nothing'}, and ${documentPart}` +
    `, over the mirrored event(s) {${set.length ? set.join(' | ') : 'none'}}`
  )
}

/**
 * MAY `postedDiscount` BE SUBTRACTED FROM WHAT THE CREDIT NOTES REVERSED (o3d-y14 r8 findings 1, 2)?
 *
 * `postedDiscount` is a correct, useful fact about the invoice in every case — it is what the
 * document carries, and the whole r5 classification is built on it. It is a different question
 * whether it may be one side of a SUBTRACTION against the credit-note total, and two conditions the
 * invoice-side classification does not care about decide it:
 *
 *   THE TAX BASIS. The invoice is enqueued in the ORDER's convention, so on a tax-inclusive order
 *   its order-discount line is GROSS. Every credit-note refund line IMS stores is NET — the
 *   chargeback divides by (1 + taxRatePercent) before storing the mirrored leg, and the credit-note
 *   payload posts `lineAmountsIncludeTax: false`. Subtracting one from the other is not arithmetic
 *   over one quantity, and nothing IMS persists inverts the division: the refund line records a tax
 *   TYPE, not a rate, and the order's live `taxRatePercent` is not evidence of what it was when the
 *   refund was created. So an INCLUSIVE (or UNKNOWN, or MIXED) basis withdraws the netting.
 *
 *   THE LEDGER (r9 finding 1). Both figures have to be balances in the SAME set of books. The
 *   active accounting connector can be SWITCHED (see `connector-orphans.ts`, which exists for that
 *   event), and IMS keeps every historical document under the connector that posted it — so an order
 *   invoiced in Xero and credited in QuickBooks has an ACCREC invoice standing at full value that
 *   the credit memo reduces by nothing. `wcCouponLedgerMembership` requires the invoice's
 *   `externalSystem` and the credit notes' to be the SAME non-null value, and withdraws the net
 *   otherwise.
 *
 *   HOW MANY DOCUMENTS. `readPostedInvoiceOrderDiscount` returns one amount when every posted
 *   document AGREES on it — which is exactly what a mirroring credit note needs, and is NOT a claim
 *   that there is one document. Two agreeing invoices charged that discount twice, and netting one
 *   credit-note total against one of them is arithmetic over a set that is not the ledger's.
 *
 * Both withdraw the NET only. The invoice finding, the credit-note legs and the refusal reason are
 * all still reported — which is r6's design, and the safe fallback the whole backfill falls back to.
 */
export type WcCouponNettingBasis = { ok: true } | { ok: false; detail: string }

export type WcCouponInvoiceHandoff =
  /** No sales-invoice document is recorded for this order at all. */
  | { case: 'NO_INVOICE_IN_LEDGER' }
  /** The document carries exactly the residual the order retains after the correction. */
  | {
      case: 'DOCUMENT_AGREES'
      postedDiscount: number
      documentRef: string
      /**
       * HOW MANY POSTED DOCUMENTS `documentRef` NAMES (o3d-y14 r10 finding 2). Anything above 1
       * means each of them carries `postedDiscount`, so the ledger holds it that many times over —
       * and no remedy computed from ONE difference describes what the ledger needs.
       */
      documentCount: number
      externalSystem: string | null
      netting: WcCouponNettingBasis
    }
  /** The document discounts MORE than the corrected order: it charged `difference` too little. */
  | {
      case: 'DOCUMENT_DISCOUNTS_MORE'
      postedDiscount: number
      /** PER DOCUMENT. With `documentCount > 1` the ledger's total mis-statement is not this figure. */
      difference: number
      documentRef: string
      documentCount: number
      externalSystem: string | null
      netting: WcCouponNettingBasis
    }
  /** The document discounts LESS than the corrected order: it charged `difference` too much. */
  | {
      case: 'DOCUMENT_DISCOUNTS_LESS'
      postedDiscount: number
      /** PER DOCUMENT. With `documentCount > 1` the ledger's total mis-statement is not this figure. */
      difference: number
      documentRef: string
      documentCount: number
      externalSystem: string | null
      netting: WcCouponNettingBasis
    }
  /** A document exists (or may) and what it carries could not be established. */
  | {
      case: 'DOCUMENT_UNVERIFIED'
      detail: string
      documentRef: string | null
      /**
       * How many posted documents the refusal is about, where the derivation established it — which
       * is only the several-documents-disagree refusal (r10 finding 2). NULL everywhere else, and
       * NULL is "not established", never "one".
       */
      documentCount: number | null
      /**
       * THE IDENTIFIERS OF THOSE DOCUMENTS (o3d-y14 r11 finding 3).
       *
       * r10 made the refusal say HOW MANY documents disagree and drop WHICH — on the one case whose
       * entire instruction to the operator is "open them and establish what the ledger holds". They
       * travel here, and `documentRef` names them, so the sentence an operator reads is actionable.
       *
       * EMPTY where the derivation never established a document set (every other refusal), and
       * SHORTER than `documentCount` where a posted document records no external id at all
       * (o3d-9kek) — the difference is the number that exist and cannot be named.
       */
      externalIds: string[]
    }

export type WcCouponLedgerHandoff = {
  invoice: WcCouponInvoiceHandoff
  deferral: { batchRef: string; unearnedRevenueAmount: number | null } | null
  /**
   * THE INVOICE-SIDE POSITION THE FINDING WAS DERIVED FROM (r11 finding 1).
   *
   * Carried for exactly the reason `refunds` is: a handoff is re-validated against the live position
   * immediately before it is printed, and a comparison needs both sides. Without it the
   * re-validation could only watch the refunds, so a document voided, re-posted or joined by a
   * second one between the commit and the print left the printed remedy standing.
   */
  documents: WcCouponDocumentPosition
  /**
   * The refund position the invoice finding was judged against (r6 finding 1). Carried on the result
   * — not just consumed while rendering — so the durable ActivityLog record says WHY a corrected
   * order carries a finding and no remedy, months after the run.
   */
  refunds: WcCouponRefundEvidence
  /** True when the order's documents were credited against. */
  refunded: boolean
  /**
   * WHAT THE POSTED CREDIT NOTES REVERSED of the order-level discount (r7 finding 4). `ok` only
   * where the whole position nets; the per-credit-note legs are carried either way, because a leg
   * IMS could derive is a fact the operator would otherwise have to go and find.
   */
  reversal: CreditNoteOrderDiscountReversal
  /**
   * THE ONE THING AN OPERATOR IS TO PERFORM, or NULL (r7 finding 3).
   *
   * Every instrument sentence in `lines` comes from `wcCouponRemedySteps(remedy)`; when this is
   * NULL no such sentence is in there. That is the property, and it is asserted over the whole
   * matrix rather than case by case — three rounds of case-by-case review each let one through.
   */
  remedy: WcCouponRemedy | null
  /**
   * WHAT THE NETTING ESTABLISHED, or NULL (r10 finding 1).
   *
   * NULL for every order whose netting was SUPPRESSED — a tax-inclusive or MIXED invoice basis,
   * several posted documents, two ledgers, or a credit-note side that never derived — and for every
   * unrefunded order, which nets nothing. Every sentence in `lines` that says how the invoice and
   * the credit notes RELATE comes from `wcCouponNetClaimSteps(netPosition)`; when this is NULL no
   * such sentence is in there, which is the property, asserted over the whole matrix.
   *
   * Carried on the result, like `refunds` and `remedy`, so the durable ActivityLog record says
   * whether the two sides were ever actually compared.
   */
  netPosition: WcCouponNetPosition | null
  /** True when SOMETHING has to be done in the accounting system for this order. */
  needsAccountingAction: boolean
  /** Operator-facing text, one entry per line, already ordered. */
  lines: string[]
}

/** 2dp, because every figure here is money the operator will key into another system. */
function money(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * NAME EVERY POSTED DOCUMENT, not the newest one (o3d-y14 r10 finding 2).
 *
 * THE DEFECT THIS REPLACES. `documentRef` was `invoice ${document.externalId}` — the NEWEST
 * document's id, which `readPostedInvoiceOrderDiscount` returns for presentation. r8 had already
 * established that two POSTED events are two DISTINCT documents (the `@@unique([externalSystem,
 * externalId])` constraint makes a revision of one impossible) and that two agreeing invoices hold
 * the discount TWICE — and refused the NETTING on that ground. The NON-netted remedy went on naming
 * one of them, so an operator told to correct "invoice INV-778" corrected one of two documents that
 * each carry the duplicate and left the other exactly as it was.
 *
 * Fixing the remedy's sentence would have left every other sentence naming one document, so the
 * REFERENCE itself is plural: every line that names the document now names all of them, and no call
 * site can reintroduce the singular by writing its own prose.
 *
 * THE UNNAMEABLE ONES ARE COUNTED, not dropped. A POSTED event can carry no external id (the
 * write-back can fail after the post succeeds, o3d-9kek), and "2 documents, 1 of which cannot be
 * named" is the fact — silently naming one of two would be the defect again.
 */
function describePostedDocuments(
  document: Extract<PostedInvoiceOrderDiscount, { ok: true }>,
  evidence: WcCouponLedgerEvidence,
): string {
  if (document.documentCount <= 1) {
    return document.externalId
      ? `invoice ${document.externalId}`
      : (describeLedgerReference(evidence) ?? `the posted ${document.documentType}`)
  }
  return (
    `EACH of the ${document.documentCount} posted sales-invoice documents for this order ` +
    `(${listPostedDocuments(document.documentCount, document.externalIds)})`
  )
}

/**
 * "invoice(s) INV-778, INV-779, and 1 further posted document(s) that record NO external id".
 *
 * The naming half of the plural reference, shared by the AGREEING reference above and the
 * DISAGREEING one below (r11 finding 3). One producer, so a refusal cannot name its documents on
 * different terms from a finding — and the unnameable ones are counted in both, never dropped.
 */
function listPostedDocuments(documentCount: number, externalIds: readonly string[]): string {
  const unnamed = documentCount - externalIds.length
  const parts = [
    externalIds.length ? `invoice(s) ${externalIds.join(', ')}` : null,
    unnamed > 0
      ? `${unnamed} further posted document(s) that record NO external id and cannot be named from here`
      : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', and ') : 'none of which this run could enumerate'
}

/**
 * NAME THE DOCUMENTS A REFUSAL IS ABOUT (o3d-y14 r11 finding 3).
 *
 * r10 fixed the reference for documents that AGREE, on the argument that a refusal prescribes
 * nothing so naming the newest was harmless. That argument does not survive the DISAGREEING case:
 * the whole of what the operator is told is "open them, establish what the ledger holds in total,
 * and act on that", and a count alone leaves them with no way to begin. So the refusal names them
 * on exactly the same terms as the finding does.
 */
function describeDisagreeingDocuments(documentCount: number, externalIds: readonly string[]): string {
  return (
    `the ${documentCount} DISAGREEING posted sales-invoice documents for this order ` +
    `(${listPostedDocuments(documentCount, externalIds)})`
  )
}

/**
 * The UNVERIFIED facts sentence, in whichever number the refusal is about (r11 finding 3).
 *
 * One producer for both the refunded and the unrefunded render, because the two used to write the
 * same sentence twice and a plural reference dropped into a singular sentence reads as a document
 * that does not exist.
 */
function unverifiedDocumentSentence(invoice: Extract<WcCouponInvoiceHandoff, { case: 'DOCUMENT_UNVERIFIED' }>): string {
  if (invoice.documentCount !== null && invoice.documentCount > 1) {
    return (
      `${invoice.documentRef ?? `${invoice.documentCount} posted documents`} are in the ledger and ` +
      `IMS CANNOT establish what order-level discount they carry: ${invoice.detail}.`
    )
  }
  return (
    `${invoice.documentRef ?? 'a document'} may exist for this order and IMS CANNOT establish what ` +
    `order-level discount it carries: ${invoice.detail}.`
  )
}

/** "that document", or "EACH of those documents" when the reference above named more than one. */
function documentNoun(documentCount: number): string {
  return documentCount > 1 ? 'EACH of those documents' : 'that document'
}

/**
 * Say that a difference is PER DOCUMENT, where more than one document carries it (r10 finding 2).
 *
 * The difference is computed by comparing ONE document's order-level discount against the corrected
 * order. With several documents each carrying that discount, the figure is right about each of them
 * and is NOT what the ledger is out by — and the total is not a multiplication either, because
 * nothing IMS holds says whether those documents each bill the whole order or divide it.
 */
function perDocument(documentCount: number): string {
  return documentCount > 1
    ? ` — the ledger holds ${documentCount} of them, so that figure is per document, not the ` +
      "ledger's total"
    : ''
}

function describeLedgerReference(evidence: WcCouponLedgerEvidence): string | null {
  if (evidence.accountingInvoiceId) return `invoice ${evidence.accountingInvoiceId}`
  if (evidence.postedInvoiceExternalIds.length) {
    return `posted-but-unlinked invoice(s) ${evidence.postedInvoiceExternalIds.join(', ')}`
  }
  return null
}

/**
 * Is the posted invoice figure on the SAME footing as the credit-note total (r8 findings 1 and 2)?
 *
 * PURE, and separate from the case classification on purpose: the case is a statement about the
 * invoice and is true whatever the answer here, while this decides only whether a SUBTRACTION is
 * defined. Both refusals name the condition that failed, because "IMS cannot net this for you" with
 * no reason is the sentence r6 shipped and r7 had to take apart.
 */
export function wcCouponNettingBasis(document: Extract<PostedInvoiceOrderDiscount, { ok: true }>): WcCouponNettingBasis {
  if (document.documentCount !== 1) {
    return {
      ok: false,
      detail:
        `${document.documentCount} posted sales-invoice documents exist for this order and they AGREE ` +
        `on an order-level discount of ${document.amount} each — agreement is what lets a mirroring ` +
        'credit note reverse any one of them, and it is NOT a statement that there is only one. The ' +
        `ledger therefore holds that discount ${document.documentCount} times over, and subtracting ` +
        'one credit-note total from one of them is arithmetic over a set of documents that is not the ' +
        "ledger's",
    }
  }
  if (document.taxBasis !== 'EXCLUSIVE') {
    return {
      ok: false,
      detail:
        document.taxBasis === 'INCLUSIVE'
          ? 'that invoice was enqueued TAX-INCLUSIVE, so its order-level discount is a GROSS figure, ' +
            'while every credit-note refund line IMS stores is NET (the chargeback divides the ' +
            'mirrored discount by 1 + the tax rate before storing it, and the credit note posts ' +
            'lineAmountsIncludeTax: false). The two are not the same unit, and nothing IMS persists ' +
            'inverts that division — a refund line records a tax TYPE, never a rate'
          : `the tax basis of that invoice's order-level discount is ${document.taxBasis}, so whether ` +
            'it is on the same NET footing as the credit-note lines cannot be established, and a ' +
            'subtraction across two possibly-different bases is not a figure',
    }
  }
  return { ok: true }
}

/**
 * DO THE TWO SIDES LIVE IN THE SAME SET OF BOOKS (o3d-y14 r9 finding 1)?
 *
 * `wcCouponNettingBasis` above asks whether the invoice figure is the right KIND of number. This
 * asks the question that needs BOTH documents, and it is the one the netting was missing entirely:
 * `postedDiscount - reversal.amount` was subtracting a figure off a Xero invoice from a figure off a
 * QuickBooks credit memo whenever the accounting connector had been switched between the two
 * postings — an event this codebase already has a module for (`connector-orphans.ts`: "when the
 * active accounting connector is switched (e.g. Xero → QuickBooks) ... rows for the OUTGOING
 * connector become invisible to both processors"). The Xero invoice in that position is outstanding
 * at its full posted value, and a net of 0 declares the customer square against it.
 *
 * SEPARATE from the case classification, and PURE, for the same reason the tax-basis check is: the
 * invoice case is a true statement about the invoice whatever the answer here, and only the
 * SUBTRACTION depends on it.
 *
 * WHAT IT CANNOT ESTABLISH — the organisation/realm inside one connector. Nothing IMS stores records
 * it per document: `AccountingToken` is one row per connector, overwritten on reconnect, and the
 * per-realm provenance column on `AccountingSyncLog` was tried and reverted (o3d-gt8r/o3d-s36z).
 * That residual travels in the netted precondition rather than being assumed away.
 */
export function wcCouponLedgerMembership(
  invoiceExternalSystem: string | null,
  reversal: CreditNoteOrderDiscountReversal,
): WcCouponNettingBasis {
  if (!reversal.ok) {
    return {
      ok: false,
      detail: 'the credit-note side established no posted document, so there is no ledger to compare against',
    }
  }
  if (!invoiceExternalSystem) {
    return {
      ok: false,
      detail:
        "the mirrored event for that invoice records NO accounting system, so which set of books it " +
        `was posted to is not established — and the credit note(s) are in ${systemName(reversal.externalSystem)}. ` +
        'A subtraction between a figure in an unidentified ledger and one in a named ledger is not a net',
    }
  }
  if (invoiceExternalSystem !== reversal.externalSystem) {
    return {
      ok: false,
      detail:
        `that invoice was posted to ${systemName(invoiceExternalSystem)} and this order's credit ` +
        `note(s) to ${systemName(reversal.externalSystem)} — TWO SEPARATE LEDGERS. The active ` +
        'accounting connector can be switched, and IMS keeps every historical document under the ' +
        `connector that posted it, so the invoice is still outstanding at its full posted value in ` +
        `${systemName(invoiceExternalSystem)} and nothing in ${systemName(reversal.externalSystem)} ` +
        'reduces it. Their difference describes no balance that exists',
    }
  }
  return { ok: true }
}

/**
 * Decide the invoice-side job from the derived posted figure. PURE — the read is done by the caller,
 * so every case below is reachable in a test from a plain value.
 */
export function classifyWcCouponInvoiceHandoff(input: {
  document: PostedInvoiceOrderDiscount
  evidence: WcCouponLedgerEvidence
  /** What the order retains after the correction, in the order's own currency. */
  keptOrderLevel: number
}): WcCouponInvoiceHandoff {
  const { document, evidence, keptOrderLevel } = input

  if (document.ok) {
    const posted = money(document.amount)
    const kept = money(keptOrderLevel)
    const netting = wcCouponNettingBasis(document)
    // r10 finding 2. Names EVERY posted document, so no sentence below can name one of two.
    const documentRef = describePostedDocuments(document, evidence)
    const documentCount = document.documentCount
    if (posted === kept) {
      return {
        case: 'DOCUMENT_AGREES',
        postedDiscount: posted,
        documentRef,
        documentCount,
        externalSystem: document.externalSystem,
        netting,
      }
    }
    if (posted > kept) {
      return {
        case: 'DOCUMENT_DISCOUNTS_MORE',
        postedDiscount: posted,
        difference: money(posted - kept),
        documentRef,
        documentCount,
        externalSystem: document.externalSystem,
        netting,
      }
    }
    return {
      case: 'DOCUMENT_DISCOUNTS_LESS',
      postedDiscount: posted,
      difference: money(kept - posted),
      documentRef,
      documentCount,
      externalSystem: document.externalSystem,
      netting,
    }
  }

  if (document.reason === 'UNRECOVERABLE') {
    const documentCount = document.documentCount ?? null
    const externalIds = document.externalIds ?? []
    return {
      case: 'DOCUMENT_UNVERIFIED',
      detail: document.detail,
      // r11 finding 3. Where the derivation established WHICH documents disagree, they are the
      // reference — the order's own back-reference columns are not, because those name at most the
      // one document IMS happened to link and this refusal is about all of them.
      documentRef:
        documentCount !== null && documentCount > 1
          ? describeDisagreeingDocuments(documentCount, externalIds)
          : describeLedgerReference(evidence),
      documentCount,
      externalIds,
    }
  }

  // NO_POSTED_EVENT. The mirror is best-effort and retention deletes the SYNCED sync log, so its
  // silence is not a statement that no document exists — only the evidence read under the lock is.
  const reference = describeLedgerReference(evidence)
  if (reference) {
    return {
      case: 'DOCUMENT_UNVERIFIED',
      detail: `the ledger holds ${reference} for this order but no posted accounting event records what it charged`,
      documentRef: reference,
      documentCount: null,
      externalIds: [],
    }
  }
  return { case: 'NO_INVOICE_IN_LEDGER' }
}

/** Xero's UI, or QuickBooks', or neither when the derivation never named a system. */
function systemName(externalSystem: string | null): string {
  if (externalSystem === 'xero') return 'Xero'
  if (externalSystem === 'quickbooks') return 'QuickBooks Online'
  return 'the accounting system'
}

// ---------------------------------------------------------------------------
// THE REMEDY — the ONE place an instrument may be named (o3d-y14 r7 finding 3)
// ---------------------------------------------------------------------------

/**
 * A remedy an operator is to PERFORM, as a value rather than as prose.
 *
 * WHY IT IS A VALUE. Rounds 4, 5 and 6 each shipped a remedy that pointed the wrong way, and each
 * time the wrong direction was written into one case's paragraph, in a file where five cases each
 * wrote their own. Review by inspection kept catching four of the five. Making the remedy a value
 * moves the question from "does this paragraph say the right thing" — asked once per case, per
 * round — to "did the classifier return a remedy, and does its direction match its case" — which is
 * asked over the whole matrix by one test.
 *
 * WHAT IT BUYS, concretely: `WcCouponLedgerHandoff.remedy` is NULL for every suppressed case, and
 * `wcCouponRemedySteps` is the only function in this module that emits an instrument sentence. A
 * refusal path therefore CANNOT prescribe by accident — it has nothing to prescribe with. That is
 * the property r6's refusal text violated when it ended "settle THAT figure as an ordinary
 * receivable" while declaring that no remedy was prescribed.
 */
export type WcCouponRemedy = {
  /**
   * `INCREASE_RECEIVABLE`  the customer was charged too little and still owes it. Instruments that
   *                        move a balance UP only: edit the invoice up, or raise a further invoice.
   * `DECREASE_RECEIVABLE`  the customer was charged too much. Instruments that move it DOWN only.
   * `READ_THEN_CHOOSE`     the document cannot be read from here, so the operator reads it and the
   *                        instrument follows from what they find. Still a remedy — it names
   *                        instruments — so it travels as one rather than as loose prose.
   */
  kind: 'INCREASE_RECEIVABLE' | 'DECREASE_RECEIVABLE' | 'READ_THEN_CHOOSE'
  /** The figure to act on. NULL for READ_THEN_CHOOSE, whose figure is what the operator reads. */
  amount: number | null
  currency: string
  externalSystem: string | null
  documentRef: string | null
  /** What the corrected order retains — the edit target, and the figure the ladder branches on. */
  keptOrderLevel: number
  /**
   * ONLY the further-instrument option, never "edit the existing document" (r7 finding 3). Set on a
   * netted refunded position: that invoice has a credit note allocated to it, so Xero will not let
   * it be edited and QuickBooks' edit would silently unbalance the allocation.
   */
  documentIsAllocated: boolean
  /**
   * THE CREDIT NOTES THIS FIGURE WAS NETTED AGAINST, or empty (r8 finding 3).
   *
   * A netted remedy is not a statement about one document; it is the DIFFERENCE between an invoice
   * and these credit notes. IMS can see a credit note it never posted, one it re-posted and one it
   * retired — all of those refuse upstream — but it CANNOT see one voided or edited by hand in Xero
   * or QuickBooks: nothing writes that back, and the payment poller reads ACCREC invoice statuses,
   * never ACCRECCREDIT. So the documents the figure rests on are named in the instruction itself,
   * and the operator is told to confirm they still stand. Empty for every non-netted remedy, whose
   * figure depends on no credit note at all.
   */
  nettedAgainst: string[]
  /**
   * THE REFUND POSITION THIS REMEDY IS ONLY VALID AGAINST (r7 finding 2).
   *
   * Carried on the remedy itself, and printed by `wcCouponRemedySteps` as its first line, because
   * the thing that invalidates a remedy here is a refund arriving AFTER the correction committed —
   * after every lock this backfill can take has been released, and possibly after the run has
   * exited. Nothing in software can hold that window shut; what it can do is make the precondition
   * travel with the instruction, so no operator can read the instruction without it.
   */
  validAgainst: WcCouponRefundEvidence
  /**
   * THE INVOICE-SIDE POSITION THIS REMEDY IS ONLY VALID AGAINST (o3d-y14 r12 finding 2).
   *
   * The same argument as `validAgainst`, one layer in. r11 finding 1 established that the invoice
   * side moves in exactly the same window as the refund side and by the same mechanism — a document
   * voided and re-posted in Xero, a second invoice raised, a back-reference repair (o3d-9kek) — and
   * made the RE-VALIDATION watch both. That closes the window up to the last check. The RESIDUAL
   * window, between that check and the line reaching the operator's eye, is closed by nothing but
   * this precondition, and it named the refund position alone: an operator was told to re-check
   * whether a refund had landed, and told nothing about the document their instruction names.
   *
   * The property is one property: A REMEDY NAMES EVERY POSITION IT DEPENDS ON. It depends on both,
   * so it carries both, and `wcCouponPreconditionSteps` prints both before any instrument.
   */
  validAgainstDocuments: WcCouponDocumentPosition
  /** When the positions above were read. */
  derivedAt: string
}

function editTarget(kept: number, currency: string, lineName: string): string {
  return kept === 0
    ? `delete its ${lineName} line outright`
    : `set its ${lineName} line to ${kept} ${currency}`
}

function editInvoiceStep(externalSystem: string | null, documentRef: string, kept: number, currency: string): string {
  if (externalSystem === 'quickbooks') {
    return (
      `• Edit ${documentRef} — ${editTarget(kept, currency, 'discount')} — and save. Unlink any payment ` +
      'on the Receive Payment screen first.'
    )
  }
  return (
    `• If ${documentRef} can still be edited — nothing allocated to it, and its date outside any locked ` +
    `period — open it, ${editTarget(kept, currency, '"Order discount"')} and re-approve. ` +
    'Invoice ▸ Options ▸ Remove & Redo releases an allocated payment and returns the invoice to draft.'
  )
}

function extraInvoiceStep(externalSystem: string | null, amount: number, currency: string, first: boolean): string {
  const coding =
    externalSystem === 'quickbooks'
      ? 'the income account and tax code the original used'
      : 'the revenue account and tax rate the original used'
  return (
    `• ${first ? 'Raise' : 'Otherwise raise'} a further invoice to the same contact for ${amount} ` +
    `${currency}, on ${coding}, dated in an open period.`
  )
}

function creditNoteStep(externalSystem: string | null, documentRef: string | null, amount: number, currency: string): string {
  const against = documentRef ? ` and apply it to ${documentRef}` : ''
  if (externalSystem === 'quickbooks') {
    return (
      `• Raise a credit memo for ${amount} ${currency} on the income account and tax code that ` +
      `invoice used${against}.`
    )
  }
  return documentRef
    ? `• Raise a credit note for ${amount} ${currency} on the revenue account and tax rate that invoice ` +
        `used and allocate it to ${documentRef} — Invoice ▸ Options ▸ Add Credit Note pre-fills it.`
    : `• Raise a credit note for ${amount} ${currency} on the revenue account and tax rate that invoice used.`
}

/** Describe a refund position compactly, for the precondition line on a remedy. */
function describeRefundPrecondition(refunds: WcCouponRefundEvidence): string {
  if (!isWcCouponOrderRefunded(refunds)) return 'NOTHING refunded against this order'
  const parts = [
    `refundStatus ${refunds.disposition}`,
    refunds.refundIds.length ? `refund(s) ${refunds.refundIds.join(', ')}` : null,
    refunds.postedCreditNoteExternalIds.length
      ? `credit note(s) ${refunds.postedCreditNoteExternalIds.join(', ')}`
      : null,
    refunds.unresolvedRefundParkExternalIds.length
      ? `unrecorded WooCommerce refund(s) ${refunds.unresolvedRefundParkExternalIds.join(', ')}`
      : null,
  ].filter(Boolean)
  return parts.join(', ')
}

/**
 * RENDER A REMEDY. The only producer of an instrument sentence in this module.
 *
 * The precondition comes FIRST and is not optional, for r7 finding 2: this backfill's lock proves
 * the refund position at the moment the amount was rewritten and cannot prove anything about the
 * moment a human reads the console. A refund committed a minute after the correction leaves a live
 * instruction to bill a customer who has just been refunded, and the only defence available on the
 * far side of a committed transaction is to tell the operator what the instruction depends on.
 *
 * AND IT NAMES EVERY POSITION THE INSTRUCTION DEPENDS ON, NOT ONLY THE REFUNDS (o3d-y14 r12
 * finding 2).
 *
 * THE DEFECT THIS REPLACES. r11 finding 1 established that the invoice side moves in the same window
 * and by the same mechanism as the refund side — a document voided and re-posted in the accounting
 * system, a second invoice raised for the order, a back-reference repair (o3d-9kek) — and made the
 * re-validation re-read BOTH before printing. That narrows the window to "between this read and that
 * line reaching the operator's eye". The residual is closed by this line and by nothing else, and it
 * was still written as though the refunds were the only thing that could move: an operator was told
 * to re-check whether a refund had landed, and told nothing whatever about the DOCUMENT their
 * instruction names — the one thing they are about to open, in the system where it moves.
 *
 * Both positions are therefore stated, both as read at the same instant, and the re-check covers
 * both. The document half is rendered by `describeWcCouponDocumentPosition`, the same function the
 * WITHDRAWAL uses, so the sentence an operator re-checks against is the sentence a withdrawal would
 * contradict — and its document-set fingerprint (r12 finding 1) is in there, because "the ledger
 * holds these two documents carrying these two figures" is precisely what they are re-checking.
 */
export function wcCouponPreconditionSteps(input: {
  /** How the block opens — "REMEDY (Xero)" for an instruction, its own heading for a bare finding. */
  heading: string
  /** The act the re-check must happen before. "POSTING" for a remedy; a zero net posts nothing. */
  beforeWhat: string
  externalSystem: string | null
  validAgainst: WcCouponRefundEvidence
  /** r12 finding 2. The invoice-side half of the same precondition — never defaulted, never omitted. */
  validAgainstDocuments: WcCouponDocumentPosition
  derivedAt: string
  /** The credit notes the figure was NETTED against, or empty when it depends on none. */
  nettedAgainst: string[]
  /** What is void if the position has moved — "this remedy", "this conclusion". */
  whatIsVoid: string
}): string[] {
  const steps = [
    `${input.heading} — VALID ONLY WHILE this order's refund position is ` +
      `${describeRefundPrecondition(input.validAgainst)}, AND its INVOICE-SIDE ledger position is ` +
      `${describeWcCouponDocumentPosition(input.validAgainstDocuments)} — both as read ` +
      `${input.derivedAt}. RE-CHECK BOTH IMMEDIATELY BEFORE ${input.beforeWhat}: a refund recorded ` +
      'since, OR a sales-invoice document voided, re-posted, added or newly linked since, voids ' +
      `${input.whatIsVoid}. IMS is as blind to the second as to the first once this run has exited, ` +
      'and the document half is the half you are about to open. ' +
      'Re-derive it with `--reprint <allowlist>`, which rebuilds this handoff from live state for an ' +
      'order that has ALREADY been corrected (a plain report will not — a corrected order is skipped ' +
      'by every later scan).',
  ]
  if (input.nettedAgainst.length) {
    // r8 finding 3 and r9 finding 1. This figure is a DIFFERENCE between two documents, and IMS can
    // watch NEITHER of the two things that would invalidate it: a credit note voided or edited by
    // hand writes nothing back (the payment poller reads ACCREC invoice statuses, never ACCRECCREDIT),
    // and no row IMS keeps records WHICH ORGANISATION inside the connector a document was posted to
    // (AccountingToken is one row per connector, overwritten on reconnect; the per-realm provenance
    // column was tried and reverted, o3d-gt8r/o3d-s36z). Both are one glance for the operator, who is
    // being sent to open both documents anyway.
    steps.push(
      `THIS FIGURE IS THE INVOICE NETTED AGAINST CREDIT NOTE(S) ${input.nettedAgainst.join(', ')}. ` +
        `CONFIRM IN ${systemName(input.externalSystem)} THAT THEY ARE STILL POSTED AND UNCHANGED, AND ` +
        'THAT THEY AND THE INVOICE ARE IN THE SAME ORGANISATION: a credit note voided or edited by ' +
        'hand writes nothing back to IMS, and IMS records which CONNECTOR posted each document but ' +
        'never which organisation inside it. The net above is wrong by exactly whatever was changed, ' +
        'and means nothing at all if the two documents are in different books.',
    )
  }
  return steps
}

export function wcCouponRemedySteps(remedy: WcCouponRemedy): string[] {
  const { currency, amount, keptOrderLevel: kept } = remedy
  const steps: string[] = wcCouponPreconditionSteps({
    heading: `REMEDY (${systemName(remedy.externalSystem)})`,
    beforeWhat: 'POSTING',
    externalSystem: remedy.externalSystem,
    validAgainst: remedy.validAgainst,
    validAgainstDocuments: remedy.validAgainstDocuments,
    derivedAt: remedy.derivedAt,
    nettedAgainst: remedy.nettedAgainst,
    whatIsVoid: 'this remedy',
  })

  switch (remedy.kind) {
    case 'INCREASE_RECEIVABLE':
      steps.push(
        `The balance has to go UP by ${amount} ${currency}, so a credit note is the wrong instrument. ` +
          (remedy.documentIsAllocated ? 'A credit note is allocated to that invoice, so it cannot be edited:' : 'Do ONE of:'),
      )
      if (!remedy.documentIsAllocated && remedy.documentRef) {
        steps.push(editInvoiceStep(remedy.externalSystem, remedy.documentRef, kept, currency))
      }
      steps.push(extraInvoiceStep(remedy.externalSystem, amount ?? 0, currency, remedy.documentIsAllocated))
      return steps

    case 'DECREASE_RECEIVABLE':
      steps.push(
        `The balance has to come DOWN by ${amount} ${currency}. ` +
          (remedy.documentIsAllocated ? 'Do:' : 'Do ONE of:'),
      )
      steps.push(creditNoteStep(remedy.externalSystem, remedy.documentRef, amount ?? 0, currency))
      if (!remedy.documentIsAllocated && remedy.documentRef) {
        steps.push(editInvoiceStep(remedy.externalSystem, remedy.documentRef, kept, currency))
      }
      return steps

    case 'READ_THEN_CHOOSE':
      steps.push(
        'Open the document and read its order-level discount line, then:',
        // Branched on the residual, because with a residual of 0 "it discounts LESS than that" names
        // a state that cannot exist, and an instruction for an impossible case teaches the operator
        // to skim the ones that can.
        ...(kept === 0
          ? [
              '• it carries no order-level discount line at all — nothing to do;',
              '• it carries one — the document charged that much too little: delete that line, or ' +
                'raise a further invoice for it. Never a credit note.',
            ]
          : [
              `• it reads ${kept} ${currency} — nothing to do;`,
              `• it discounts MORE than ${kept} ${currency} — the document charged the difference too ` +
                'little: edit it down to that figure, or raise a further invoice for the difference. ' +
                'Never a credit note;',
              `• it discounts LESS than ${kept} ${currency} — the document charged the difference too ` +
                'much: credit the difference.',
            ]),
      )
      return steps
  }
}

// ---------------------------------------------------------------------------
// THE NET CLAIM — the ONE place the two sides may be said to relate (r10 finding 1)
// ---------------------------------------------------------------------------

/**
 * WHAT A NETTING THAT RAN ESTABLISHED, as a value rather than as prose (o3d-y14 r10 finding 1).
 *
 * THE DEFECT THIS REPLACES. `wcCouponNettingBasis` and `wcCouponLedgerMembership` withdraw the
 * SUBTRACTION on four grounds — a tax-INCLUSIVE (or UNKNOWN, or MIXED) invoice basis, more than one
 * posted document, two different ledgers, and a credit-note side that never derived — and every one
 * of those falls through to the refusal renderers below. Those renderers went on saying, in prose,
 * the very thing the netting would have concluded: "the credit note that reversed this invoice was
 * computed from the same pre-correction figure, so on a full refund the two errors cancel and the
 * net owed is nothing", and "crediting an invoice that has already been credited away refunds the
 * same money a second time". Both are the RESULT of a netting, asserted in exactly the cases where
 * no netting could be performed.
 *
 * That is worse than a stale sentence. The suppression exists because the two figures could not be
 * compared; an operator reading "the two errors cancel" concludes there is nothing to do and files
 * the order — which is the outcome the suppression was put there to prevent, and it lands on the
 * orders IMS understands LEAST.
 *
 * WHY A VALUE, AND NOT TWO REWRITTEN SENTENCES. This is r7 finding 3 again, one layer up. Three
 * rounds of case-by-case review each missed one wrong-direction instrument, and the fix was to make
 * the instrument a value with a single renderer so a refusal path has nothing to prescribe WITH.
 * A netting conclusion is the same shape of claim and needs the same shape of guarantee:
 *
 *     NO NETTING CLAIM REACHES AN OPERATOR EXCEPT FROM A NETTING THAT RAN.
 *
 * `WcCouponNetPosition` is constructed by the ONE branch that performs the subtraction — the branch
 * that has already passed `reversal.ok`, `netting.ok` and `membership.ok` — and
 * `wcCouponNetClaimSteps` is the only function in this module that states the relationship between
 * the invoice and the credit notes. Every suppressed path carries `netPosition === null` and so has
 * no conclusion to state; what it prints instead is the two sides' FACTS and the reason the
 * subtraction was withdrawn. The property is asserted over the whole case x refund-shape x
 * suppression-reason matrix, because a case-by-case reading is what shipped both defects.
 */
export type WcCouponNetPosition = {
  /** What the invoice's order-discount line posted. */
  postedDiscount: number
  /** What the posted credit notes reversed of it. */
  reversedAmount: number
  /** `postedDiscount - reversedAmount`. Positive: the customer still owes it. */
  net: number
  currency: string
  externalSystem: string | null
  /** Every posted document the invoice side was read from (r10 finding 2). */
  documentRef: string
  /** The credit notes the subtraction rests on — named in the conclusion, per r8 finding 3. */
  nettedAgainst: string[]
  /** The refund position the netting was performed against (r7 finding 2). */
  validAgainst: WcCouponRefundEvidence
  /**
   * The INVOICE-SIDE position it was performed against (r12 finding 2). A net is
   * `invoice − credit notes`, so a document voided, re-posted or joined by a second one between the
   * check and the operator's eye invalidates it exactly as a refund does — and a net of ZERO, whose
   * whole message is that there is nothing to look at, is the outcome that most needs saying so.
   */
  validAgainstDocuments: WcCouponDocumentPosition
  derivedAt: string
}

/**
 * STATE WHAT THE NETTING CONCLUDED. The only producer of a netting claim in this module.
 *
 * It names no instrument — the remedy that may follow a non-zero net is still a `WcCouponRemedy`
 * rendered by `wcCouponRemedySteps` — so r7 finding 3's property is untouched by this one.
 */
export function wcCouponNetClaimSteps(position: WcCouponNetPosition): string[] {
  const { currency, net } = position
  // THE ARITHMETIC IS ITSELF A NETTING STATEMENT, so it is produced here and not with the two
  // documents' facts: "THE POSITION NETS: 10 - 10 = 0" is the subtraction, and a suppressed path
  // must no more be able to print it than to print its conclusion.
  const arithmetic =
    `${describeRefundEvidence(position.validAgainst)}, and THE POSITION NETS: ` +
    `${position.postedDiscount} - ${position.reversedAmount} = ${net} ${currency}.`
  if (net === 0) {
    // r9 finding 2 — A ZERO NET CARRIES THE SAME PRECONDITION AS A NON-ZERO ONE, AND NEEDS IT MORE.
    //
    // r8 gave the netted REMEDY a precondition naming the credit notes it rests on, because IMS
    // cannot see one voided or edited by hand in Xero or QuickBooks — the pollers read ACCREC
    // invoice statuses, never ACCRECCREDIT. A hand-voided credit note does not merely change this
    // figure: it means the reversal never happened, the invoice stands at its full posted value and
    // the customer still owes it — while this order is the ONE outcome that tells the operator there
    // is nothing to look at. So the precondition is printed BEFORE the conclusion it governs, and
    // the conclusion is stated as the CONDITIONAL it actually is.
    return [
      arithmetic,
      ...wcCouponPreconditionSteps({
        heading: `THIS "NOTHING TO DO" IS CONDITIONAL (${systemName(position.externalSystem)})`,
        beforeWhat: 'FILING THIS ORDER AS SETTLED',
        externalSystem: position.externalSystem,
        validAgainst: position.validAgainst,
        validAgainstDocuments: position.validAgainstDocuments,
        derivedAt: position.derivedAt,
        nettedAgainst: position.nettedAgainst,
        whatIsVoid: 'this conclusion',
      }),
      'THE TWO ERRORS CANCEL, PROVIDED THOSE CREDIT NOTES STILL STAND: the credit note reversed ' +
        'the same mis-stated discount the invoice charged, so on the documents IMS can see this ' +
        'customer is square, and there is NO ACCOUNTING ACTION for this order — this run only ' +
        'removed the duplicate from IMS. If any of the credit notes named above has been voided ' +
        'or edited by hand, or turns out to sit in a different organisation from the invoice, ' +
        `then that reversal did not happen: ${position.documentRef} stands at its full posted ` +
        'value and this order is NOT settled. Re-derive it with `--reprint <allowlist>` and ' +
        'escalate rather than acting on this line.',
    ]
  }
  return [
    arithmetic,
    net > 0
      ? `THE CUSTOMER STILL OWES ${net} ${currency}: the invoice under-charged them by more than ` +
        'the credit note gave back.'
      : `THE CUSTOMER IS OWED ${Math.abs(net)} ${currency}: the credit note gave back more than ` +
        'the invoice charged them.',
  ]
}

/** "3 refunds, credit notes CN-1, CN-2" — the evidence the refusal below rests on, named. */
function describeRefundEvidence(refunds: WcCouponRefundEvidence): string {
  const disposition =
    refunds.disposition === 'FULL'
      ? 'FULLY REFUNDED'
      : refunds.disposition === 'PARTIAL'
        ? 'PARTLY REFUNDED'
        : 'REFUNDED (SalesOrder.refundStatus still reads NONE)'
  const parts = [
    refunds.refundIds.length
      ? `${refunds.refundIds.length} refund(s) recorded in IMS`
      : 'no refund row recorded in IMS',
    refunds.postedCreditNoteExternalIds.length
      ? `credit note(s) ${refunds.postedCreditNoteExternalIds.join(', ')} in the ledger`
      : 'no credit note of theirs recorded in the ledger',
  ]
  // r7 finding 1. Named SEPARATELY and last, because it is the one signal that is not a statement
  // about IMS's records at all: it says money left the business and IMS could not record it.
  if (refunds.unresolvedRefundParkExternalIds.length) {
    parts.push(
      `and WooCommerce refund(s) ${refunds.unresolvedRefundParkExternalIds.join(', ')} ARRIVED AND ` +
        'COULD NOT BE RECORDED (parked unresolved) — that money has already left the business and no ' +
        'refund row or credit note here accounts for it',
    )
  }
  return `this order is ${disposition} (${parts.join(', ')})`
}

/**
 * WHAT THE OPERATOR DOES INSTEAD, when the net could not be established (r7 finding 3).
 *
 * NOT A REMEDY, and now it contains nothing that could be mistaken for one. The previous revision
 * ended "if something is genuinely outstanding, settle THAT figure as an ordinary receivable" — a
 * DIRECTION, and the wrong one for an over-refund or any net balance owed TO the customer, in the
 * middle of a paragraph headed "NO REMEDY IS PRESCRIBED". It also told the operator to open "every
 * credit note above" in the case where there is no posted credit note at all, which names a document
 * that does not exist and leaves the actual refund unestablishable from the ones it does name.
 */
function refundNetPositionSteps(
  documentRef: string | null,
  refunds: WcCouponRefundEvidence,
  reversal: CreditNoteOrderDiscountReversal,
  /**
   * Why the NET was withdrawn even though the credit-note side derived (r8 findings 1 and 2). Empty
   * when the credit-note side is itself the reason. Both are printed, because "the credit notes are
   * readable and the net is still not available" is a sentence the operator will otherwise read as a
   * contradiction and resolve in whichever direction is convenient.
   */
  extraRefusals: string[] = [],
): string[] {
  const steps: string[] = []

  // The per-credit-note legs that COULD be derived, printed as facts. r6 said this was impossible;
  // it is not, and where it is available it is exactly the number the operator was being sent to
  // find by hand.
  for (const leg of reversal.legs) {
    steps.push(`• ${leg.detail}.`)
  }
  const reasons = [...(reversal.ok ? [] : [reversal.detail]), ...extraRefusals]
  steps.push(`IMS CANNOT NET THE TWO FOR YOU here: ${reasons.join('; ')}.`)
  steps.push('ESTABLISH THE NET BY HAND before anything is posted:')

  if (refunds.postedCreditNoteExternalIds.length) {
    steps.push(
      `• open ${documentRef ?? 'the sales invoice'} and credit note(s) ` +
        `${refunds.postedCreditNoteExternalIds.join(', ')}, and read what this customer was actually ` +
        'charged and actually refunded;',
    )
  } else {
    steps.push(
      '• THERE IS NO POSTED CREDIT NOTE TO OPEN. IMS records ' +
        (refunds.refundIds.length ? `refund(s) ${refunds.refundIds.join(', ')}` : 'a refund position') +
        (refunds.unresolvedRefundParkExternalIds.length
          ? ` and unrecorded WooCommerce refund(s) ${refunds.unresolvedRefundParkExternalIds.join(', ')}`
          : '') +
        ' against this order, and no credit note of theirs is in the ledger — so what was refunded ' +
        'CANNOT be established from the accounting system. Establish it from the WooCommerce order ' +
        'and the payment provider first, and only then compare it against ' +
        `${documentRef ?? 'the sales invoice'};`,
    )
  }

  steps.push(
    '• if the two already net to nothing, there is NOTHING TO DO — this run only removed the ' +
      'duplicate from IMS;',
    '• if they do not, record WHICH WAY the difference goes — whether this customer still owes ' +
      'money or is owed it — before anything else. IMS is deliberately naming no instrument for ' +
      'either direction: the figure reported above is the invoice side ALONE, and the direction is ' +
      'exactly what it cannot tell you;',
    '• if the two cannot be reconciled, leave the ledger alone and escalate. Nothing is lost by ' +
      'stopping here: `--reprint <allowlist>` rebuilds this handoff from live state at any time, ' +
      'including for an order that has ALREADY been corrected — which a plain report will NOT do, ' +
      'because a corrected order is skipped by every later scan.',
  )
  return steps
}

/**
 * What a case renders: its facts, AT MOST one remedy, and AT MOST one net position.
 *
 * `netPosition` is non-null ONLY where the subtraction was actually performed (r10 finding 1), and
 * it is the only thing any renderer may state a netting conclusion from. "Netted to nothing" is read
 * off it — `netPosition !== null && netPosition.net === 0` — rather than reconstructed by the caller
 * from `remedy === null` plus a list of cases, which is the reconstruction r8 finding 1 showed to be
 * wrong: a SUPPRESSED netting has a null remedy and a derivable credit-note side and a nettable
 * case, and would have been read as "settled, nothing to do" — the r5 defect in a new place, on
 * exactly the orders whose two figures could not be compared at all.
 */
type WcCouponHandoffRender = {
  lines: string[]
  remedy: WcCouponRemedy | null
  netPosition: WcCouponNetPosition | null
}

/** The FULL operator text for a render: its facts, then its netting claim, then its remedy. */
function composeWcCouponHandoffLines(render: WcCouponHandoffRender): string[] {
  return [
    ...render.lines,
    ...(render.netPosition ? wcCouponNetClaimSteps(render.netPosition) : []),
    ...(render.remedy ? wcCouponRemedySteps(render.remedy) : []),
  ]
}

/** Did the position net, and to nothing? A statement about the NETTING, never about a null remedy. */
export function wcCouponNettedToNothing(netPosition: WcCouponNetPosition | null): boolean {
  return netPosition !== null && netPosition.net === 0
}

/**
 * The invoice-side text for an order that has been credited against (r6 finding 1, r7 finding 4).
 *
 * The FINDING is still reported per case — it is a fact about the invoice and the operator needs it
 * to read the documents at all. A remedy is returned ONLY where the whole position nets: see the
 * module header for the conditions, all of which are established by
 * `readCreditNoteOrderDiscount` rather than assumed here.
 */
function wcCouponRefundedInvoiceLines(
  invoice: WcCouponInvoiceHandoff,
  context: {
    currency: string
    keptOrderLevel: number
    refunds: WcCouponRefundEvidence
    reversal: CreditNoteOrderDiscountReversal
    /**
     * The invoice-side position this render was derived from (r12 finding 2). It travels into every
     * remedy and every net position so their precondition can name it — REQUIRED, because a default
     * would let a caller that never read the invoice side assert one on the operator's behalf.
     */
    documents: WcCouponDocumentPosition
    derivedAt: string
  },
): WcCouponHandoffRender {
  const { currency, refunds, reversal } = context
  const kept = money(context.keptOrderLevel)
  const refundLine = describeRefundEvidence(refunds)

  // THE NETTED CASE (r7 finding 4). Available only where the posted invoice figure is known AND the
  // posted credit notes reverse the whole order by mirroring it. `net` is the difference between the
  // two documents' order-discount legs; the corrected residual does not enter it, because both
  // documents are wrong by the same mis-stated figure and what survives is what they differ by.
  const nettingBasis: WcCouponNettingBasis =
    invoice.case === 'NO_INVOICE_IN_LEDGER' || invoice.case === 'DOCUMENT_UNVERIFIED'
      ? { ok: false, detail: 'no readable invoice figure to net against' }
      : invoice.netting
  // r9 finding 1. The third condition, and the only one that needs BOTH documents: are they in the
  // same set of books at all? Computed here rather than in `classifyWcCouponInvoiceHandoff`, which
  // runs before the credit-note side has been read.
  const membership: WcCouponNettingBasis =
    invoice.case === 'NO_INVOICE_IN_LEDGER' || invoice.case === 'DOCUMENT_UNVERIFIED'
      ? { ok: false, detail: 'no readable invoice ledger to compare against' }
      : wcCouponLedgerMembership(invoice.externalSystem, reversal)
  // r8 findings 1 and 2, r9 finding 1. `reversal.ok` says the credit-note side is established;
  // `nettingBasis.ok` says the two sides are the same kind of number and describe one document each;
  // `membership.ok` says they are balances in the same ledger. All three are required, and none of
  // them is implied by the others.
  if (
    reversal.ok &&
    invoice.case !== 'NO_INVOICE_IN_LEDGER' &&
    invoice.case !== 'DOCUMENT_UNVERIFIED' &&
    nettingBasis.ok &&
    membership.ok
  ) {
    const net = money(invoice.postedDiscount - reversal.amount)
    // r10 finding 1. THE netting, and the only construction of a `WcCouponNetPosition` in this
    // module: it is reachable only from inside this branch, which has already established
    // `reversal.ok`, `nettingBasis.ok` and `membership.ok`. Every conclusion about how the two sides
    // relate is stated from this value by `wcCouponNetClaimSteps` and nowhere else, so a suppressed
    // path cannot reach one — it has no netting to state a conclusion from.
    const netPosition: WcCouponNetPosition = {
      postedDiscount: invoice.postedDiscount,
      reversedAmount: reversal.amount,
      net,
      currency,
      externalSystem: invoice.externalSystem,
      documentRef: invoice.documentRef,
      nettedAgainst: [...refunds.postedCreditNoteExternalIds],
      validAgainst: refunds,
      validAgainstDocuments: context.documents,
      derivedAt: context.derivedAt,
    }
    // The two documents' FACTS. The subtraction over them — and every conclusion drawn from it — is
    // `wcCouponNetClaimSteps`', reachable only from the value above.
    const facts = [
      `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency}, ` +
        `and ${reversal.detail}.`,
    ]
    if (net === 0) {
      // The conclusion — and its precondition — are `wcCouponNetClaimSteps`'. It is not a remedy and
      // does not become one: that function names no instrument, and `remedy` stays NULL, so "no
      // instrument reaches an operator except through the classifier" is untouched.
      return { lines: facts, remedy: null, netPosition }
    }
    const owed = net > 0
    return {
      lines: facts,
      remedy: {
        kind: owed ? 'INCREASE_RECEIVABLE' : 'DECREASE_RECEIVABLE',
        amount: Math.abs(net),
        currency,
        externalSystem: invoice.externalSystem,
        documentRef: invoice.documentRef,
        keptOrderLevel: kept,
        // A credit note is allocated to that invoice, so editing it is not on the table.
        documentIsAllocated: true,
        // r8 finding 3. The net is the difference between that invoice and THESE credit notes, and a
        // credit note voided or edited by hand in the accounting system writes nothing back to IMS —
        // the payment poller reads ACCREC invoice statuses, never ACCRECCREDIT. So the documents the
        // figure depends on travel with the instruction, and the operator is told to confirm they
        // still stand.
        nettedAgainst: [...refunds.postedCreditNoteExternalIds],
        validAgainst: refunds,
        validAgainstDocuments: context.documents,
        derivedAt: context.derivedAt,
      },
      netPosition,
    }
  }

  // Everything below is a refusal. The netting reason is carried into the fallback so the operator
  // is told WHICH half could not be established, and never left to infer it (r8 findings 1 and 2).
  // The membership refusal is added only where the invoice side itself was fine: on an unverified or
  // absent invoice `nettingBasis` is already the placeholder refusal for exactly that, and printing
  // "and also the ledgers cannot be compared" beside it names one failure twice.
  const nettingRefusals = reversal.ok
    ? [...(nettingBasis.ok ? (membership.ok ? [] : [membership.detail]) : [nettingBasis.detail])]
    : []
  // AND THE PROSE HAS TO MATCH WHICH HALF FAILED (r8). "What the credit notes carry could not be
  // established" is simply false where the legs derived and only the SUBTRACTION was withdrawn, and
  // a sentence an operator can see is wrong is a sentence they start discounting.
  const creditSideKnown = reversal.ok
  const creditSideClause = creditSideKnown
    ? 'what those credit note(s) carry IS established below — what could not be established is the ' +
      'NET, because the two figures cannot be subtracted from one another'
    : 'what they carry could not be established here'

  switch (invoice.case) {
    case 'NO_INVOICE_IN_LEDGER':
      return {
        lines: [
          'no sales invoice for this order is in the ledger — nothing to do on the invoice side.',
          `${refundLine}. NO REMEDY IS PRESCRIBED: with no invoice to compare them against, what those ` +
            'credit notes carry decides nothing this run can act on. If one of them reverses an ' +
            'order-level discount, it reversed a figure that was never charged — read it and settle ' +
            'that with the customer account, and post nothing on the strength of this report.',
          ...refundNetPositionSteps(null, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        netPosition: null,
      }

    case 'DOCUMENT_AGREES': {
      const why =
        invoice.postedDiscount === 0 && invoice.externalSystem === 'xero'
          ? ' The payload carried no discount account code, so Xero appended no "Order discount" line ' +
            'and that invoice already charges the full goods less the per-line coupon.'
          : ''
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency}, ` +
            `which is exactly what the corrected order retains.${why}`,
          // r10 finding 1. "the credit note(s) WERE raised from the pre-correction figure" is a
          // claim about how the two documents relate, and it is not true of every credit note here —
          // a WooCommerce-mirrored refund reverses what WooCommerce refunded, not what the invoice
          // charged. On a suppressed netting nothing has compared them, so it is stated as the
          // possibility it is.
          `NOTHING IS OWED ON THE INVOICE — but ${refundLine}, so this is NOT the "ledger is already ` +
            `right" case: the credit note(s) MAY have been raised from the PRE-CORRECTION figure, and ` +
            `${creditSideClause}. Do NOT raise a credit note or an adjustment against the invoice; ` +
            'it needs nothing. Check the credit note side instead.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        netPosition: null,
      }
    }

    case 'DOCUMENT_DISCOUNTS_MORE':
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
            `but the corrected order retains ${kept} ${currency}: ${documentNoun(invoice.documentCount)} ` +
            `charged ${invoice.difference} ${currency} TOO LITTLE${perDocument(invoice.documentCount)}.`,
          `NO REMEDY IS PRESCRIBED: ${refundLine}, and that shortfall may already have been credited ` +
            'away with the invoice itself.',
          // r10 finding 1. THE DEFECT THIS REPLACES ended "so on a full refund the two errors cancel
          // and the net owed is nothing" — the conclusion a netting reaches, asserted on a path
          // REACHED ONLY BECAUSE NO NETTING COULD BE PERFORMED. An operator reading it files the
          // order as square, which is the outcome the suppression exists to prevent. The
          // justification for the prohibition is now stated as the conditional it is, and the
          // refusal it depends on is named in the same breath.
          `Do NOT raise a further invoice for ${invoice.difference} ${currency}, and do NOT edit ` +
            `${invoice.documentCount > 1 ? 'any of those documents' : 'this invoice'} up to ${kept} ` +
            `${currency}. Either one RECREATES A RECEIVABLE against a customer ` +
            'who has already been refunded. IF the credit note that reversed this invoice was ' +
            'computed from the same pre-correction figure, then the two errors cancel and nothing is ' +
            'outstanding — but IMS DID NOT NET THEM FOR THIS ORDER (the reason is below), so whether ' +
            'they cancel is UNESTABLISHED and nothing here says that they do.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        netPosition: null,
      }

    case 'DOCUMENT_DISCOUNTS_LESS':
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
            `but the corrected order retains ${kept} ${currency}: ${documentNoun(invoice.documentCount)} ` +
            `charged ${invoice.difference} ${currency} TOO MUCH${perDocument(invoice.documentCount)}.`,
          `NO REMEDY IS PRESCRIBED: ${refundLine}, so the over-charge may already have been credited ` +
            'back.',
          // r10 finding 1, the same defect in the other direction: "an invoice that HAS ALREADY BEEN
          // CREDITED AWAY" states as fact the half of the position the withdrawn netting could not
          // read.
          `Do NOT raise a credit note for ${invoice.difference} ${currency}. IF this invoice has ` +
            'already been credited away — which IMS DID NOT ESTABLISH for this order (the reason is ' +
            'below) — then crediting it again refunds the same money a second time, and Xero will let ' +
            'you allocate it.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        netPosition: null,
      }

    case 'DOCUMENT_UNVERIFIED':
      return {
        lines: [
          unverifiedDocumentSentence(invoice),
          `NO REMEDY IS PRESCRIBED, and ${refundLine} — ` +
            (creditSideKnown
              ? 'so the half of the position that CAN be read is printed below and the invoice half ' +
                'cannot be, which is why no subtraction is offered.'
              : 'so there are TWO unknowns here, not one.') +
            ' The read-it-off-the-document ladder printed for an unrefunded order deliberately is ' +
            'NOT printed here: each of its branches ends in an instrument, and on a refunded order ' +
            'neither instrument can be chosen from the invoice alone.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        netPosition: null,
      }
  }
}

/**
 * The operator text for the invoice side, and the remedy that goes with it (at most one).
 *
 * ONE CASE, ONE JOB. No case shares another's wording, and no case writes its own instrument
 * sentence — those come from `wcCouponRemedySteps` alone (r7 finding 3).
 */
export function wcCouponInvoiceHandoffRender(
  invoice: WcCouponInvoiceHandoff,
  context: {
    currency: string
    keptOrderLevel: number
    refunds: WcCouponRefundEvidence
    reversal: CreditNoteOrderDiscountReversal
    /**
     * The invoice-side position this render was derived from (r12 finding 2). It travels into every
     * remedy and every net position so their precondition can name it — REQUIRED, because a default
     * would let a caller that never read the invoice side assert one on the operator's behalf.
     */
    documents: WcCouponDocumentPosition
    derivedAt: string
  },
): WcCouponHandoffRender {
  const { currency, refunds } = context
  const kept = money(context.keptOrderLevel)

  // r6 finding 1. The five cases below compare ONE document against the corrected order; on an
  // order with credit notes against it that comparison is half a position, and only the netted
  // branch above can say which way the remaining half points.
  if (isWcCouponOrderRefunded(refunds)) {
    return wcCouponRefundedInvoiceLines(invoice, context)
  }

  const remedyBase = {
    currency,
    externalSystem: 'externalSystem' in invoice ? invoice.externalSystem : null,
    keptOrderLevel: kept,
    documentIsAllocated: false,
    // Nothing was netted on an unrefunded order — there is no credit note to depend on.
    nettedAgainst: [] as string[],
    validAgainst: refunds,
    validAgainstDocuments: context.documents,
    derivedAt: context.derivedAt,
  }

  switch (invoice.case) {
    case 'NO_INVOICE_IN_LEDGER':
      return {
        lines: ['no sales invoice for this order is in the ledger — nothing to do on the invoice side.'],
        remedy: null,
        netPosition: null,
      }

    case 'DOCUMENT_AGREES': {
      const why =
        invoice.postedDiscount === 0 && invoice.externalSystem === 'xero'
          ? ' The payload carried no discount account code, so Xero appended no "Order discount" line ' +
            'and that invoice already charges the full goods less the per-line coupon.'
          : ''
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency}, ` +
            `which is exactly what the corrected order retains.${why}`,
          invoice.documentCount > 1
            ? // r10 finding 2. Each document agrees with the corrected order, so THIS RUN asks for
              // nothing — but "the ledger is already right" is a claim about the ledger, and a ledger
              // holding several posted sales-invoice documents for one order is not something this
              // correction establishes anything about. The fact is stated; nothing is prescribed.
              'NO ACCOUNTING ACTION FOLLOWS FROM THIS CORRECTION. Do NOT raise a credit note or an ' +
              `adjustment against any of them — each already carries what the corrected order ` +
              `retains, and this run only removed the duplicate from IMS. NOTE, and act on it ` +
              `separately if at all: the ledger holds ${invoice.documentCount} posted sales-invoice ` +
              'documents for this ONE order. This backfill establishes nothing about whether it ' +
              'should, and prescribes nothing about it.'
            : 'NO ACCOUNTING ACTION for this order. Do NOT raise a credit note or an adjustment ' +
              'against it — the ledger is already right and this run only removed the duplicate ' +
              'from IMS.',
        ],
        remedy: null,
        netPosition: null,
      }
    }

    case 'DOCUMENT_DISCOUNTS_MORE':
    case 'DOCUMENT_DISCOUNTS_LESS': {
      const tooLittle = invoice.case === 'DOCUMENT_DISCOUNTS_MORE'
      const facts = [
        `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
          `but the corrected order retains ${kept} ${currency}: ${documentNoun(invoice.documentCount)} ` +
          `charged ${invoice.difference} ${currency} ${tooLittle ? 'TOO LITTLE' : 'TOO MUCH'}` +
          `${perDocument(invoice.documentCount)}.`,
      ]
      // r10 finding 2 — SEVERAL POSTED DOCUMENTS PRESCRIBE NOTHING.
      //
      // r8 established that two POSTED events are two DISTINCT documents and that two agreeing
      // invoices hold the discount TWICE, and it withdrew the NETTING on that ground. The
      // non-netted remedy went on prescribing from ONE difference against ONE named document: an
      // operator told to correct "invoice INV-778" corrected one of two documents that each carry
      // the duplicate and left the other standing, and "raise a further invoice for the difference"
      // settles one document's worth of a mis-statement the ledger holds N times.
      //
      // Nor is the total a multiplication. Whether those documents each bill the whole order or
      // divide it between them is not recorded anywhere IMS can read, so `difference x N` is as
      // unfounded as `difference`. This is the established fallback: state the facts, name every
      // document, prescribe nothing.
      if (invoice.documentCount > 1) {
        return {
          lines: [
            ...facts,
            'NO REMEDY IS PRESCRIBED: the ledger holds more than one posted sales-invoice document ' +
              'for this order and each carries that discount, so the figure above is not what the ' +
              'ledger is out by, and no single correction settles it. Multiplying it by the number ' +
              'of documents would be just as unfounded — nothing IMS records says whether those ' +
              'documents each bill the whole order or divide it between them.',
            'ESTABLISH IT BY HAND before anything is posted:',
            '• open every document named above and read its order-level discount line;',
            `• decide from what they say whether this order should be billed by more than one ` +
              'document at all, and what the ledger therefore holds in total. IMS is deliberately ' +
              'naming nothing to perform for either answer;',
            '• if they cannot be reconciled, leave the ledger alone and escalate. Nothing is lost by ' +
              'stopping here: `--reprint <allowlist>` rebuilds this handoff from live state at any ' +
              'time, including for an order that has ALREADY been corrected — which a plain report ' +
              'will NOT do, because a corrected order is skipped by every later scan.',
          ],
          remedy: null,
          netPosition: null,
        }
      }
      return {
        lines: facts,
        netPosition: null,
        remedy: {
          ...remedyBase,
          kind: tooLittle ? 'INCREASE_RECEIVABLE' : 'DECREASE_RECEIVABLE',
          amount: invoice.difference,
          documentRef: invoice.documentRef,
        },
      }
    }

    case 'DOCUMENT_UNVERIFIED': {
      const facts = [
        unverifiedDocumentSentence(invoice),
        'NO FIGURE IS PRESCRIBED — acting on an assumption here is what produces a wrong ledger entry.',
      ]
      // r10 finding 2, on the one refusal that still prescribed. READ_THEN_CHOOSE is a remedy — its
      // branches end in instruments ("raise a further invoice for it", "credit the difference") —
      // and it is written against ONE document: "open the document and read its order-level discount
      // line". Where the derivation refused BECAUSE several posted documents disagree, there is no
      // "the document", the ladder's arithmetic is per document, and the ledger holds a figure this
      // run cannot total. So the facts are stated and nothing is prescribed.
      if (invoice.documentCount !== null && invoice.documentCount > 1) {
        return {
          lines: [
            ...facts,
            `NO REMEDY IS PRESCRIBED: the refusal above is that ${invoice.documentCount} posted ` +
              'sales-invoice documents disagree, so there is no single document to read the figure ' +
              'off and no per-document correction that settles the ledger. Open ' +
              // r11 finding 3. "Open all of them" is not an instruction unless the operator knows
              // which ones — and this is the ONE case where IMS cannot narrow it down for them.
              `${listPostedDocuments(invoice.documentCount, invoice.externalIds)}, ` +
              'establish what the ledger holds in total, and act on that — IMS is deliberately ' +
              'naming nothing to perform. `--reprint <allowlist>` rebuilds this handoff from live ' +
              'state at any time, including for an order that has ALREADY been corrected.',
          ],
          remedy: null,
          netPosition: null,
        }
      }
      return {
        lines: facts,
        remedy: { ...remedyBase, kind: 'READ_THEN_CHOOSE', amount: null, documentRef: invoice.documentRef },
        netPosition: null,
      }
    }
  }
}

/**
 * Backwards-compatible line-only view. The remedy travels on the handoff.
 *
 * `documents` is REQUIRED even though `reversal` and `derivedAt` are not (r12 finding 2). The two
 * optional ones have honest "not read" values — `NO_CREDIT_NOTE_REVERSAL` says so in words, and a
 * missing read time is a clock. An invoice-side position has no such value: every default would be a
 * claim about the ledger, printed inside a precondition an operator is told to re-check.
 */
export function wcCouponInvoiceHandoffLines(
  invoice: WcCouponInvoiceHandoff,
  context: {
    currency: string
    keptOrderLevel: number
    refunds: WcCouponRefundEvidence
    documents: WcCouponDocumentPosition
    reversal?: CreditNoteOrderDiscountReversal
    derivedAt?: string
  },
): string[] {
  const render = wcCouponInvoiceHandoffRender(invoice, {
    ...context,
    reversal: context.reversal ?? NO_CREDIT_NOTE_REVERSAL,
    derivedAt: context.derivedAt ?? new Date().toISOString(),
  })
  return composeWcCouponHandoffLines(render)
}

/** The reversal a caller passes when it has not read one (an order with no refunds at all). */
export const NO_CREDIT_NOTE_REVERSAL: CreditNoteOrderDiscountReversal = {
  ok: false,
  legs: [],
  detail: 'the credit-note side was not read for this order',
}


export function wcCouponDeferralHandoffLines(deferral: {
  batchRef: string
  unearnedRevenueAmount: number | null
}): string[] {
  return [
    `revenue-deferral batch ${deferral.batchRef} posted a manual journal deferring ` +
      `${deferral.unearnedRevenueAmount ?? 'an unrecorded amount'} (base currency) for this order, ` +
      'computed from the pre-correction order-level discount.',
    'DO NOT ADJUST THAT JOURNAL. IMS recognises the deferral back out using the SAME stamped ' +
      '`unearnedRevenueAmount`, so the pair still nets to zero; a manual correction to one half of it ' +
      'would strand the difference in the unearned-revenue account permanently. Until the order is ' +
      'fully recognised, the split between deferred and recognised revenue is out by the amount ' +
      'cleared here, and it closes itself on recognition.',
  ]
}

/**
 * Classify ONE corrected order and render its operator handoff.
 *
 * `client` may be the correction's own transaction — and at apply time it is, so the documents named
 * are the ones that existed at the moment the amount was rewritten.
 */
export type WcCouponHandoffClient = PostedInvoiceEventClient & CreditNoteOrderDiscountClient

export async function buildWcCouponLedgerHandoff(
  client: WcCouponHandoffClient,
  input: {
    orderId: string
    currency: string
    keptOrderLevel: number
    evidence: WcCouponLedgerEvidence
    /** When the evidence was read. Defaults to now; passed by tests so output is deterministic. */
    derivedAt?: Date
  },
): Promise<WcCouponLedgerHandoff> {
  const document = await readPostedInvoiceOrderDiscount(client, { id: input.orderId, currency: input.currency })
  // r11 finding 1. The canonical form of what was just read, so the re-validation before printing
  // can compare the invoice side as a value rather than assuming it stood still.
  const documents = buildWcCouponDocumentPosition(document, { currency: input.currency, evidence: input.evidence })
  const invoice = classifyWcCouponInvoiceHandoff({
    document,
    evidence: input.evidence,
    keptOrderLevel: input.keptOrderLevel,
  })
  const deferral = input.evidence.revenueDeferredBatchRef
    ? {
        batchRef: input.evidence.revenueDeferredBatchRef,
        unearnedRevenueAmount: input.evidence.unearnedRevenueAmount ?? null,
      }
    : null

  const refunds = input.evidence.refunds
  const refunded = isWcCouponOrderRefunded(refunds)

  // READ ONLY WHEN THERE IS SOMETHING TO READ. An unrefunded order — which is nearly all of them —
  // issues no query at all, and its reversal is the "not read" value rather than a derived zero.
  const reversal = refunded
    ? await readCreditNoteOrderDiscount(client, {
        disposition: refunds.disposition,
        refundIds: refunds.refundIds,
        postedCreditNoteExternalIds: refunds.postedCreditNoteExternalIds,
        unresolvedRefundParkExternalIds: refunds.unresolvedRefundParkExternalIds,
      })
    : NO_CREDIT_NOTE_REVERSAL

  const render = wcCouponInvoiceHandoffRender(invoice, {
    currency: input.currency,
    keptOrderLevel: input.keptOrderLevel,
    refunds,
    // r12 finding 2. The SAME value the re-validation compares against, so the position a remedy's
    // precondition tells an operator to re-check is exactly the position a withdrawal contradicts.
    documents,
    reversal,
    derivedAt: (input.derivedAt ?? new Date()).toISOString(),
  })

  const lines = [
    ...composeWcCouponHandoffLines(render),
    ...(deferral ? wcCouponDeferralHandoffLines(deferral) : []),
  ]

  // The deferral never contributes: its instruction is "leave it alone". An order whose only
  // accounting artefact is a deferral journal therefore needs NO accounting action, and must not be
  // put on a must-fix list that gives the operator nothing to do.
  //
  // A REFUNDED ORDER IS DIFFERENT (r6 finding 1): the position still has to be READ by a human even
  // where no remedy is prescribed, so it is on the list — with two exceptions that are not an
  // invention of work. When there is nothing derived from the pre-correction amount in the
  // accounting system at all (no invoice, no credit note, and no unrecorded refund park), there is
  // literally nothing to look at. And when the position NETTED TO ZERO (r7 finding 4) the answer is
  // known and it is "nothing" — putting that on the must-fix list would be the r5 defect in a new
  // place, which is exactly what r6 had to do because it could not derive the net.
  // NETTED TO NOTHING is a statement about the NETTED branch, not about "no remedy and a readable
  // credit-note side". An UNVERIFIED invoice with a perfectly derivable credit-note side also has
  // `remedy === null` and `reversal.ok`, and it is the opposite of settled — half its position is
  // unreadable.
  //
  // It is now read off the NETTED BRANCH'S OWN VALUE rather than reconstructed here from
  // `remedy === null` plus a list of cases (r8 finding 1). The reconstruction was already wrong: a
  // netting suppressed for a tax-inclusive invoice, or for an order with two posted invoices, has a
  // null remedy AND a derivable credit-note side AND a nettable case — and would have been declared
  // settled, dropping the one class of order whose two figures could not be compared at all off the
  // must-look list. `netPosition` exists only where the subtraction was performed (r10 finding 1),
  // so "netted to nothing" cannot be true of an order that was never netted.
  const nettedToNothing = wcCouponNettedToNothing(render.netPosition)
  const needsAccountingAction = refunded
    ? !nettedToNothing &&
      (invoice.case !== 'NO_INVOICE_IN_LEDGER' ||
        refunds.postedCreditNoteExternalIds.length > 0 ||
        refunds.unresolvedRefundParkExternalIds.length > 0)
    : invoice.case === 'DOCUMENT_DISCOUNTS_MORE' ||
      invoice.case === 'DOCUMENT_DISCOUNTS_LESS' ||
      invoice.case === 'DOCUMENT_UNVERIFIED'

  return {
    invoice,
    deferral,
    documents,
    refunds,
    refunded,
    reversal,
    netPosition: render.netPosition,
    remedy: render.remedy,
    needsAccountingAction,
    lines,
  }
}
