import {
  readPostedInvoiceOrderDiscount,
  type PostedInvoiceEventClient,
  type PostedInvoiceOrderDiscount,
} from '@/lib/domain/accounting/posted-order-discount'

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
 * SO WHY NOT JUST NET THEM AND PRESCRIBE THE REMAINDER? Because the net is NOT DERIVABLE here, and
 * the reason is structural rather than an omission:
 *
 *   • A credit note carries no document-level order-discount adjustment in either connector.
 *     `CreditNoteData` (lib/connectors/types.ts) has no discount field at all, and neither
 *     `pushCreditNote` (xero/credit-notes.ts) nor its QuickBooks counterpart looks for one — so
 *     there is no `discount.accountCode` discriminator to replay the way `readPostedDocumentDiscount`
 *     replays the invoice's.
 *   • The refund service instead MIRRORS the invoice's order-discount line as an ordinary NEGATIVE
 *     LINE (`buildChargebackRefundLines`, `lineKind: 'discount'`), and the mirrored payload keeps
 *     only description / quantity / unitAmount / accountCode — `lineKind` is dropped by
 *     `normalizeDocumentLine`, and the account code falls back to the sales account when no discount
 *     account is configured. Picking that line back out of the payload means guessing from a sign
 *     and a free-text description.
 *
 * A guess there decides whether a customer is billed again, so this REFUSES: on any order with
 * refund evidence, the invoice finding is still reported — it is a fact, and the operator needs it —
 * but NO REMEDY IS PRESCRIBED, and the instruction is to establish the net across the invoice and
 * every credit note by reading them. The refusal costs a handful of orders a manual check; the
 * alternative posts real money in the wrong direction. Refund evidence travels through the proposal
 * and is re-verified live at apply time, exactly like the posting evidence beside it.
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
 * WHAT HAS ALREADY BEEN CREDITED BACK TO THIS CUSTOMER (o3d-y14 r6 finding 1).
 *
 * Three signals, taken as a UNION rather than one preferred field, because each can be true while
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
 *
 * Absence of all three is read as "no refund", which is the same standard the invoice side applies
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
}

/** Has ANY value been credited back against this order? Any one signal is enough. */
export function isWcCouponOrderRefunded(refunds: WcCouponRefundEvidence): boolean {
  return (
    refunds.disposition !== 'NONE' ||
    refunds.refundIds.length > 0 ||
    refunds.postedCreditNoteExternalIds.length > 0
  )
}

export type WcCouponInvoiceHandoff =
  /** No sales-invoice document is recorded for this order at all. */
  | { case: 'NO_INVOICE_IN_LEDGER' }
  /** The document carries exactly the residual the order retains after the correction. */
  | {
      case: 'DOCUMENT_AGREES'
      postedDiscount: number
      documentRef: string
      externalSystem: string | null
    }
  /** The document discounts MORE than the corrected order: it charged `difference` too little. */
  | {
      case: 'DOCUMENT_DISCOUNTS_MORE'
      postedDiscount: number
      difference: number
      documentRef: string
      externalSystem: string | null
    }
  /** The document discounts LESS than the corrected order: it charged `difference` too much. */
  | {
      case: 'DOCUMENT_DISCOUNTS_LESS'
      postedDiscount: number
      difference: number
      documentRef: string
      externalSystem: string | null
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
  /** True when the order's documents were credited against, so no remedy may be prescribed. */
  refunded: boolean
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
    const documentRef =
      document.externalId
        ? `invoice ${document.externalId}`
        : (describeLedgerReference(evidence) ?? `the posted ${document.documentType}`)
    if (posted === kept) {
      return { case: 'DOCUMENT_AGREES', postedDiscount: posted, documentRef, externalSystem: document.externalSystem }
    }
    if (posted > kept) {
      return {
        case: 'DOCUMENT_DISCOUNTS_MORE',
        postedDiscount: posted,
        difference: money(posted - kept),
        documentRef,
        externalSystem: document.externalSystem,
      }
    }
    return {
      case: 'DOCUMENT_DISCOUNTS_LESS',
      postedDiscount: posted,
      difference: money(kept - posted),
      documentRef,
      externalSystem: document.externalSystem,
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

/** "delete the line" and "set it to 4" are different instructions; a residual of 0 is not a special case. */
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

function extraInvoiceStep(externalSystem: string | null, amount: number, currency: string): string {
  const coding =
    externalSystem === 'quickbooks'
      ? 'the income account and tax code the original used'
      : 'the revenue account and tax rate the original used'
  return (
    `• Otherwise raise a further invoice to the same contact for ${amount} ${currency}, on ${coding}, ` +
    'dated in an open period.'
  )
}

function creditNoteStep(externalSystem: string | null, documentRef: string, amount: number, currency: string): string {
  if (externalSystem === 'quickbooks') {
    return (
      `• Raise a credit memo for ${amount} ${currency} on the income account and tax code that ` +
      `invoice used, and apply it to ${documentRef}.`
    )
  }
  return (
    `• Raise a credit note for ${amount} ${currency} on the revenue account and tax rate that invoice ` +
    `used and allocate it to ${documentRef} — Invoice ▸ Options ▸ Add Credit Note pre-fills it.`
  )
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
  return `this order is ${disposition} (${parts.join(', ')})`
}

/**
 * WHY IMS STOPS HERE, and what the operator does instead. Identical for every case, because the
 * reason is a property of the DOCUMENTS rather than of the discrepancy — see the module header.
 */
function refundNetPositionSteps(documentRef: string | null): string[] {
  return [
    'IMS CANNOT NET THE TWO FOR YOU: a credit note carries no order-level discount adjustment in ' +
      'either connector (CreditNoteData has no such field, and neither credit-note adapter posts ' +
      "one), and the refund service mirrors the invoice's discount line as an ordinary NEGATIVE " +
      'LINE whose kind is not preserved in what IMS recorded. So what a credit note reversed of ' +
      'this discount cannot be replayed the way the invoice can, and a guess here moves real money.',
    'ESTABLISH THE NET BY HAND before anything is posted:',
    `• open ${documentRef ?? 'the sales invoice'} and every credit note above, and read what this ` +
      'customer was actually charged and actually refunded;',
    '• if they already net to nothing, there is NOTHING TO DO — this run only removed the duplicate ' +
      'from IMS;',
    '• if something is genuinely outstanding, settle THAT figure as an ordinary receivable, with ' +
      'both documents in front of you — never the figure above;',
    '• if the two cannot be reconciled, leave the ledger alone and escalate. Re-running the report ' +
      'reproduces this handoff, so nothing is lost by stopping here.',
  ]
}

/**
 * The invoice-side text for an order that has been credited against (r6 finding 1).
 *
 * The FINDING is still reported per case — it is a fact about the invoice and the operator needs it
 * to read the documents at all — but every case ends in a refusal, and each names the instrument
 * that would be wrong FOR IT rather than sharing one generic warning.
 */
function wcCouponRefundedInvoiceLines(
  invoice: WcCouponInvoiceHandoff,
  context: { currency: string; keptOrderLevel: number; refunds: WcCouponRefundEvidence },
): string[] {
  const { currency, refunds } = context
  const kept = money(context.keptOrderLevel)
  const refundLine = describeRefundEvidence(refunds)

  switch (invoice.case) {
    case 'NO_INVOICE_IN_LEDGER':
      return [
        'no sales invoice for this order is in the ledger — nothing to do on the invoice side.',
        `${refundLine}. NO REMEDY IS PRESCRIBED: with no invoice to compare them against, what those ` +
          'credit notes carry decides nothing this run can act on. If one of them reverses an ' +
          'order-level discount, it reversed a figure that was never charged — read it and settle ' +
          'that with the customer account, do not post anything on the strength of this report.',
      ]

    case 'DOCUMENT_AGREES': {
      const why =
        invoice.postedDiscount === 0 && invoice.externalSystem === 'xero'
          ? ' The payload carried no discount account code, so Xero appended no "Order discount" line ' +
            'and that invoice already charges the full goods less the per-line coupon.'
          : ''
      return [
        `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency}, ` +
          `which is exactly what the corrected order retains.${why}`,
        `NOTHING IS OWED ON THE INVOICE — but ${refundLine}, so this is NOT the "ledger is already ` +
          'right" case: the credit note(s) were raised from the PRE-CORRECTION figure and IMS cannot ' +
          'read what order-level discount they carry. Do NOT raise a credit note or an adjustment ' +
          'against the invoice; it needs nothing. Check the credit note side instead.',
        ...refundNetPositionSteps(invoice.documentRef),
      ]
    }

    case 'DOCUMENT_DISCOUNTS_MORE':
      return [
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
        ...refundNetPositionSteps(invoice.documentRef),
      ]

    case 'DOCUMENT_DISCOUNTS_LESS':
      return [
        `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
          `but the corrected order retains ${kept} ${currency}: that document charged ` +
          `${invoice.difference} ${currency} TOO MUCH.`,
        `NO REMEDY IS PRESCRIBED: ${refundLine}, so the over-charge may already have been credited ` +
          'back.',
        `Do NOT raise a credit note for ${invoice.difference} ${currency}. Crediting an invoice that ` +
          'has already been credited away refunds the same money a second time, and Xero will let ' +
          'you allocate it.',
        ...refundNetPositionSteps(invoice.documentRef),
      ]

    case 'DOCUMENT_UNVERIFIED':
      return [
        `${invoice.documentRef ?? 'a document'} may exist for this order and IMS CANNOT establish what ` +
          `order-level discount it carries: ${invoice.detail}.`,
        `NO REMEDY IS PRESCRIBED, and ${refundLine} — so there are TWO unknowns here, not one. The ` +
          'read-it-off-the-document ladder printed for an unrefunded order deliberately is NOT ' +
          'printed here: each of its branches ends in an instrument, and on a refunded order ' +
          'neither instrument can be chosen from the invoice alone.',
        ...refundNetPositionSteps(invoice.documentRef),
      ]
  }
}

/** The operator text for the invoice side. One case, one job, no case sharing another's wording. */
export function wcCouponInvoiceHandoffLines(
  invoice: WcCouponInvoiceHandoff,
  context: { currency: string; keptOrderLevel: number; refunds: WcCouponRefundEvidence },
): string[] {
  const { currency } = context
  const kept = money(context.keptOrderLevel)

  // r6 finding 1. The five cases below compare ONE document against the corrected order; on an
  // order with credit notes against it that comparison is half a position, and every remedy it
  // names moves money in a direction nobody here can justify.
  if (isWcCouponOrderRefunded(context.refunds)) {
    return wcCouponRefundedInvoiceLines(invoice, context)
  }

  switch (invoice.case) {
    case 'NO_INVOICE_IN_LEDGER':
      return ['no sales invoice for this order is in the ledger — nothing to do on the invoice side.']

    case 'DOCUMENT_AGREES': {
      const why =
        invoice.postedDiscount === 0 && invoice.externalSystem === 'xero'
          ? ' The payload carried no discount account code, so Xero appended no "Order discount" line ' +
            'and that invoice already charges the full goods less the per-line coupon.'
          : ''
      return [
        `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency}, ` +
          `which is exactly what the corrected order retains.${why}`,
        `NO ACCOUNTING ACTION for this order. Do NOT raise a credit note or an adjustment against it — ` +
          'the ledger is already right and this run only removed the duplicate from IMS.',
      ]
    }

    case 'DOCUMENT_DISCOUNTS_MORE':
      return [
        `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
          `but the corrected order retains ${kept} ${currency}: that document charged ` +
          `${invoice.difference} ${currency} TOO LITTLE.`,
        `REMEDY (${systemName(invoice.externalSystem)}) — the balance has to go UP, so a credit note is ` +
          'the wrong instrument. Do ONE of:',
        editInvoiceStep(invoice.externalSystem, invoice.documentRef, kept, currency),
        extraInvoiceStep(invoice.externalSystem, invoice.difference, currency),
      ]

    case 'DOCUMENT_DISCOUNTS_LESS':
      return [
        `${invoice.documentRef} carries an order-level discount of ${invoice.postedDiscount} ${currency} ` +
          `but the corrected order retains ${kept} ${currency}: that document charged ` +
          `${invoice.difference} ${currency} TOO MUCH.`,
        `REMEDY (${systemName(invoice.externalSystem)}) — the balance has to come DOWN. Do ONE of:`,
        creditNoteStep(invoice.externalSystem, invoice.documentRef, invoice.difference, currency),
        editInvoiceStep(invoice.externalSystem, invoice.documentRef, kept, currency),
      ]

    case 'DOCUMENT_UNVERIFIED':
      return [
        `${invoice.documentRef ?? 'a document'} may exist for this order and IMS CANNOT establish what ` +
          `order-level discount it carries: ${invoice.detail}.`,
        'NO REMEDY IS PRESCRIBED — acting on an assumption here is what produces a wrong ledger entry. ' +
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
      ]
  }
}

/** The operator text for the Group A1 revenue-deferral journal. Deliberately a NO-OP instruction. */
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
export async function buildWcCouponLedgerHandoff(
  client: PostedInvoiceEventClient,
  input: {
    orderId: string
    currency: string
    keptOrderLevel: number
    evidence: WcCouponLedgerEvidence
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

  const lines = [
    ...wcCouponInvoiceHandoffLines(invoice, {
      currency: input.currency,
      keptOrderLevel: input.keptOrderLevel,
      refunds,
    }),
    ...(deferral ? wcCouponDeferralHandoffLines(deferral) : []),
  ]

  // The deferral never contributes: its instruction is "leave it alone". An order whose only
  // accounting artefact is a deferral journal therefore needs NO accounting action, and must not be
  // put on a must-fix list that gives the operator nothing to do.
  //
  // A REFUNDED ORDER IS DIFFERENT (r6 finding 1): no remedy is prescribed for it, but the position
  // still has to be READ by a human, so it is on the list — with one exception that is not an
  // invention of work. When there is no invoice in the ledger AND no credit note of its refunds is
  // there either, nothing derived from the pre-correction amount is in the accounting system at all,
  // and DOCUMENT_AGREES/MORE/LESS/UNVERIFIED are all unreachable in that state. Calling that
  // actionable would put an order on the must-fix list whose entire instruction is "there is nothing
  // to look at" — the r5 defect in a new place.
  const needsAccountingAction = refunded
    ? invoice.case !== 'NO_INVOICE_IN_LEDGER' || refunds.postedCreditNoteExternalIds.length > 0
    : invoice.case === 'DOCUMENT_DISCOUNTS_MORE' ||
      invoice.case === 'DOCUMENT_DISCOUNTS_LESS' ||
      invoice.case === 'DOCUMENT_UNVERIFIED'

  return { invoice, deferral, refunds, refunded, needsAccountingAction, lines }
}
