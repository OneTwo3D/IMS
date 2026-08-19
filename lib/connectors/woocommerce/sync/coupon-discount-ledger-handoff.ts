import {
  readPostedInvoiceOrderDiscount,
  type PostedInvoiceEventClient,
  type PostedInvoiceOrderDiscount,
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
      externalSystem: string | null
      netting: WcCouponNettingBasis
    }
  /** The document discounts MORE than the corrected order: it charged `difference` too little. */
  | {
      case: 'DOCUMENT_DISCOUNTS_MORE'
      postedDiscount: number
      difference: number
      documentRef: string
      externalSystem: string | null
      netting: WcCouponNettingBasis
    }
  /** The document discounts LESS than the corrected order: it charged `difference` too much. */
  | {
      case: 'DOCUMENT_DISCOUNTS_LESS'
      postedDiscount: number
      difference: number
      documentRef: string
      externalSystem: string | null
      netting: WcCouponNettingBasis
    }
  /** A document exists (or may) and what it carries could not be established. */
  | { case: 'DOCUMENT_UNVERIFIED'; detail: string; documentRef: string | null }

export type WcCouponLedgerHandoff = {
  invoice: WcCouponInvoiceHandoff
  deferral: { batchRef: string; unearnedRevenueAmount: number | null } | null
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
  /** True when SOMETHING has to be done in the accounting system for this order. */
  needsAccountingAction: boolean
  /** Operator-facing text, one entry per line, already ordered. */
  lines: string[]
}

/** 2dp, because every figure here is money the operator will key into another system. */
function money(value: number): number {
  return Math.round(value * 100) / 100
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
    const documentRef =
      document.externalId
        ? `invoice ${document.externalId}`
        : (describeLedgerReference(evidence) ?? `the posted ${document.documentType}`)
    if (posted === kept) {
      return {
        case: 'DOCUMENT_AGREES',
        postedDiscount: posted,
        documentRef,
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
        externalSystem: document.externalSystem,
        netting,
      }
    }
    return {
      case: 'DOCUMENT_DISCOUNTS_LESS',
      postedDiscount: posted,
      difference: money(kept - posted),
      documentRef,
      externalSystem: document.externalSystem,
      netting,
    }
  }

  if (document.reason === 'UNRECOVERABLE') {
    return { case: 'DOCUMENT_UNVERIFIED', detail: document.detail, documentRef: describeLedgerReference(evidence) }
  }

  // NO_POSTED_EVENT. The mirror is best-effort and retention deletes the SYNCED sync log, so its
  // silence is not a statement that no document exists — only the evidence read under the lock is.
  const reference = describeLedgerReference(evidence)
  if (reference) {
    return {
      case: 'DOCUMENT_UNVERIFIED',
      detail: `the ledger holds ${reference} for this order but no posted accounting event records what it charged`,
      documentRef: reference,
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
  /** When the position above was read. */
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
 */
export function wcCouponRemedySteps(remedy: WcCouponRemedy): string[] {
  const { currency, amount, keptOrderLevel: kept } = remedy
  const steps: string[] = [
    `REMEDY (${systemName(remedy.externalSystem)}) — VALID ONLY WHILE this order's refund position is ` +
      `${describeRefundPrecondition(remedy.validAgainst)}, as read ${remedy.derivedAt}. RE-CHECK THAT ` +
      'IMMEDIATELY BEFORE POSTING: a refund recorded since voids this remedy. Re-derive it with ' +
      '`--reprint <allowlist>`, which rebuilds this handoff from live state for an order that has ' +
      'ALREADY been corrected (a plain report will not — a corrected order is skipped by every later ' +
      'scan).',
  ]
  if (remedy.nettedAgainst.length) {
    // r8 finding 3. This figure is a DIFFERENCE, and one half of it is a document IMS cannot watch.
    steps.push(
      `THIS FIGURE IS THE INVOICE NETTED AGAINST CREDIT NOTE(S) ${remedy.nettedAgainst.join(', ')}. ` +
        `CONFIRM IN ${systemName(remedy.externalSystem)} THAT THEY ARE STILL POSTED AND UNCHANGED: a ` +
        'credit note voided or edited by hand there writes nothing back to IMS, and the net above ' +
        'is wrong by exactly whatever was changed.',
    )
  }

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
 * What a case renders: its facts, AT MOST one remedy, and whether the position was NETTED TO NOTHING.
 *
 * `nettedToNothing` is set by the ONE branch that can establish it, rather than reconstructed by the
 * caller from `remedy === null` plus a list of cases (r8 finding 1 made that reconstruction wrong:
 * a suppressed netting has a null remedy and a derivable credit-note side and a nettable case, and
 * would have been read as "settled, nothing to do" — the r5 defect in a new place, on exactly the
 * orders whose two figures could not be compared at all).
 */
type WcCouponHandoffRender = { lines: string[]; remedy: WcCouponRemedy | null; nettedToNothing: boolean }

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
  // r8 findings 1 and 2. `reversal.ok` says the credit-note side is established; `nettingBasis.ok`
  // says the two sides are the same kind of number and describe one document each. Both are
  // required, and the second is NOT implied by the first.
  if (reversal.ok && invoice.case !== 'NO_INVOICE_IN_LEDGER' && invoice.case !== 'DOCUMENT_UNVERIFIED' && nettingBasis.ok) {
    const net = money(invoice.postedDiscount - reversal.amount)
    const facts = [
      `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency}, ` +
        `and ${reversal.detail}.`,
      `${refundLine}, and THE POSITION NETS: ${invoice.postedDiscount} - ${reversal.amount} = ${net} ` +
        `${currency}.`,
    ]
    if (net === 0) {
      return {
        lines: [
          ...facts,
          'THE TWO ERRORS CANCEL: the credit note reversed the same mis-stated discount the invoice ' +
            'charged, so this customer is square. NO ACCOUNTING ACTION for this order — this run only ' +
            'removed the duplicate from IMS.',
        ],
        remedy: null,
        nettedToNothing: true,
      }
    }
    const owed = net > 0
    return {
      lines: [
        ...facts,
        owed
          ? `THE CUSTOMER STILL OWES ${net} ${currency}: the invoice under-charged them by more than ` +
            'the credit note gave back.'
          : `THE CUSTOMER IS OWED ${Math.abs(net)} ${currency}: the credit note gave back more than ` +
            'the invoice charged them.',
      ],
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
        derivedAt: context.derivedAt,
      },
      nettedToNothing: false,
    }
  }

  // Everything below is a refusal. The netting reason is carried into the fallback so the operator
  // is told WHICH half could not be established, and never left to infer it (r8 findings 1 and 2).
  const nettingRefusals = reversal.ok && !nettingBasis.ok ? [nettingBasis.detail] : []
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
        nettedToNothing: false,
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
          `NOTHING IS OWED ON THE INVOICE — but ${refundLine}, so this is NOT the "ledger is already ` +
            `right" case: the credit note(s) were raised from the PRE-CORRECTION figure, and ` +
            `${creditSideClause}. Do NOT raise a credit note or an adjustment against the invoice; ` +
            'it needs nothing. Check the credit note side instead.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        nettedToNothing: false,
      }
    }

    case 'DOCUMENT_DISCOUNTS_MORE':
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
            `but the corrected order retains ${kept} ${currency}: that document charged ` +
            `${invoice.difference} ${currency} TOO LITTLE.`,
          `NO REMEDY IS PRESCRIBED: ${refundLine}, and that shortfall may already have been credited ` +
            'away with the invoice itself.',
          `Do NOT raise a further invoice for ${invoice.difference} ${currency}, and do NOT edit this ` +
            `invoice up to ${kept} ${currency}. Either one RECREATES A RECEIVABLE against a customer ` +
            'who has already been refunded: the credit note that reversed this invoice was computed ' +
            'from the same pre-correction figure, so on a full refund the two errors cancel and the ' +
            'net owed is nothing.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        nettedToNothing: false,
      }

    case 'DOCUMENT_DISCOUNTS_LESS':
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
            `but the corrected order retains ${kept} ${currency}: that document charged ` +
            `${invoice.difference} ${currency} TOO MUCH.`,
          `NO REMEDY IS PRESCRIBED: ${refundLine}, so the over-charge may already have been credited ` +
            'back.',
          `Do NOT raise a credit note for ${invoice.difference} ${currency}. Crediting an invoice that ` +
            'has already been credited away refunds the same money a second time, and Xero will let ' +
            'you allocate it.',
          ...refundNetPositionSteps(invoice.documentRef, refunds, reversal, nettingRefusals),
        ],
        remedy: null,
        nettedToNothing: false,
      }

    case 'DOCUMENT_UNVERIFIED':
      return {
        lines: [
          `${invoice.documentRef ?? 'a document'} may exist for this order and IMS CANNOT establish what ` +
            `order-level discount it carries: ${invoice.detail}.`,
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
        nettedToNothing: false,
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
    derivedAt: context.derivedAt,
  }

  switch (invoice.case) {
    case 'NO_INVOICE_IN_LEDGER':
      return {
        lines: ['no sales invoice for this order is in the ledger — nothing to do on the invoice side.'],
        remedy: null,
        nettedToNothing: false,
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
          `NO ACCOUNTING ACTION for this order. Do NOT raise a credit note or an adjustment against it — ` +
            'the ledger is already right and this run only removed the duplicate from IMS.',
        ],
        remedy: null,
        nettedToNothing: false,
      }
    }

    case 'DOCUMENT_DISCOUNTS_MORE':
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
            `but the corrected order retains ${kept} ${currency}: that document charged ` +
            `${invoice.difference} ${currency} TOO LITTLE.`,
        ],
        nettedToNothing: false,
        remedy: {
          ...remedyBase,
          kind: 'INCREASE_RECEIVABLE',
          amount: invoice.difference,
          documentRef: invoice.documentRef,
        },
      }

    case 'DOCUMENT_DISCOUNTS_LESS':
      return {
        lines: [
          `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
            `but the corrected order retains ${kept} ${currency}: that document charged ` +
            `${invoice.difference} ${currency} TOO MUCH.`,
        ],
        nettedToNothing: false,
        remedy: {
          ...remedyBase,
          kind: 'DECREASE_RECEIVABLE',
          amount: invoice.difference,
          documentRef: invoice.documentRef,
        },
      }

    case 'DOCUMENT_UNVERIFIED':
      return {
        lines: [
          `${invoice.documentRef ?? 'a document'} may exist for this order and IMS CANNOT establish what ` +
            `order-level discount it carries: ${invoice.detail}.`,
          'NO FIGURE IS PRESCRIBED — acting on an assumption here is what produces a wrong ledger entry.',
        ],
        remedy: { ...remedyBase, kind: 'READ_THEN_CHOOSE', amount: null, documentRef: invoice.documentRef },
        nettedToNothing: false,
      }
  }
}

/** Backwards-compatible line-only view. The remedy travels on the handoff. */
export function wcCouponInvoiceHandoffLines(
  invoice: WcCouponInvoiceHandoff,
  context: {
    currency: string
    keptOrderLevel: number
    refunds: WcCouponRefundEvidence
    reversal?: CreditNoteOrderDiscountReversal
    derivedAt?: string
  },
): string[] {
  const render = wcCouponInvoiceHandoffRender(invoice, {
    ...context,
    reversal: context.reversal ?? NO_CREDIT_NOTE_REVERSAL,
    derivedAt: context.derivedAt ?? new Date().toISOString(),
  })
  return [...render.lines, ...(render.remedy ? wcCouponRemedySteps(render.remedy) : [])]
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
    reversal,
    derivedAt: (input.derivedAt ?? new Date()).toISOString(),
  })

  const lines = [
    ...render.lines,
    ...(render.remedy ? wcCouponRemedySteps(render.remedy) : []),
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
  // It is now REPORTED BY THAT BRANCH rather than reconstructed here from `remedy === null` plus a
  // list of cases (r8 finding 1). The reconstruction was already wrong: a netting suppressed for a
  // tax-inclusive invoice, or for an order with two posted invoices, has a null remedy AND a
  // derivable credit-note side AND a nettable case — and would have been declared settled, dropping
  // the one class of order whose two figures could not be compared at all off the must-look list.
  const nettedToNothing = render.nettedToNothing
  const needsAccountingAction = refunded
    ? !nettedToNothing &&
      (invoice.case !== 'NO_INVOICE_IN_LEDGER' ||
        refunds.postedCreditNoteExternalIds.length > 0 ||
        refunds.unresolvedRefundParkExternalIds.length > 0)
    : invoice.case === 'DOCUMENT_DISCOUNTS_MORE' ||
      invoice.case === 'DOCUMENT_DISCOUNTS_LESS' ||
      invoice.case === 'DOCUMENT_UNVERIFIED'

  return { invoice, deferral, refunds, refunded, reversal, remedy: render.remedy, needsAccountingAction, lines }
}
