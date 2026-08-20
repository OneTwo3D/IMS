/**
 * WHO OWNS THE NUMBER WE ARE ABOUT TO POST UNDER (o3d-k26m.5).
 *
 * The sales-invoice create is `POST /Invoices`, which is UPDATE-OR-CREATE on InvoiceNumber: hand
 * it a number the organisation already holds and it does not create a second document and does
 * not error — it REPLACES the one that is there and returns its InvoiceID. That verb was licensed
 * on a premise that no longer holds. It was safe while the number was MINTED BY US and unique by
 * construction; o3d-k26m.1 changed the source to WooCommerce's own `_wcpdf_invoice_number`, which
 * is correct (it is the number on the customer's PDF) and which the outgoing xeroom plugin is
 * ALSO posting to the same live organisation today, for the same orders, under the same numbers.
 *
 * So the failure mode inverted. Before, a cutover double-post produced two visibly duplicated
 * documents. Now it produces ONE document, silently overwritten — xeroom's invoice replaced by
 * ours, with no error anywhere, no second row to reconcile, and nothing in the audit trail except
 * a modification. Parity of numbering was supposed to make a double-post DETECTABLE; combined
 * with an upserting verb it makes it invisible.
 *
 * DOCUMENTATION IS NOT A FENCE. This module is the refusal. Before a create, the ledger is asked
 * who holds the number, and the post proceeds only when the answer is "nobody" or "a document IMS
 * already owns". Everything else is refused — including, deliberately, the case where the ledger
 * cannot be asked at all.
 *
 * WHY REFUSING IS THE RIGHT DIRECTION. A refused post leaves the order un-invoiced: the number
 * still exists, the WooCommerce PDF still exists, the sync row carries the reason, and an operator
 * can post it the moment the ownership question is settled. An overwritten live invoice has no
 * equivalent: the replaced document's lines, contact, dates and (if it was paid) its payment
 * allocation are gone, and nothing in either system knows they were ever different.
 *
 * WHY A LOOKUP AND NOT A CUTOVER MARKER. The alternative considered was a per-order handover
 * marker — a local flag asserting "xeroom is no longer responsible for this order, so IMS may
 * post it". That is an assertion ABOUT the ledger rather than a question PUT TO it, and every way
 * it can be wrong ends in the same silent overwrite: a marker set for an order xeroom had already
 * invoiced, a backfill or manual re-send from the plugin after the marker was set, a number reused
 * across the two systems' sequences. It also has to be maintained by hand for 14,415 historical
 * orders and every order in flight during cutover. The lookup needs no maintenance, is right by
 * construction for orders nobody thought about, and its wrong answers are refusals rather than
 * overwrites. The marker's one advantage — no extra API call — is not worth paying for in
 * irreversible writes.
 *
 * WHAT THIS DOES NOT CLOSE. Between the lookup and the POST there is a window in which xeroom can
 * claim the number; the fence cannot see it, and no client-side check can. It is bounded by the
 * duration of one HTTP call and it is not the population the fence exists for — that is the
 * standing set of documents xeroom has ALREADY posted, which the lookup sees every time. Closing
 * the residual needs create-only semantics from Xero (`PUT /Invoices`), which is tracked
 * separately: switching the verb also removes the upsert that makes OUR OWN retry safe, so it is
 * not a change to make in passing (see `ownClaimInvoiceNumber` below for what stands in for it).
 */

/** One ledger document, as much of it as the ownership question needs. */
export type LedgerInvoiceClaim = {
  /** The external document id — Xero's InvoiceID. */
  invoiceId: string
  /** The number as the ledger holds it. */
  invoiceNumber: string
  /** Xero invoice Status: DRAFT / SUBMITTED / AUTHORISED / PAID / VOIDED / DELETED. */
  status: string
  /** Whose invoice it is, when the ledger says. Message material only — never part of the rule. */
  contactName?: string
  /** The document total, when the ledger says. Message material only. */
  total?: number
}

/**
 * The answer to "who holds this number?".
 *
 * `ok: false` is NOT "nobody holds it". The two are opposite answers and conflating them is the
 * whole defect: an unreachable ledger would license exactly the post the fence exists to stop.
 */
export type InvoiceNumberLookup =
  | { ok: true; claim: LedgerInvoiceClaim | null }
  | { ok: false; error: string }

export type InvoiceNumberRefusalCode =
  /** The payload has no invoice number at all. */
  | 'NO_INVOICE_NUMBER'
  /** The ledger could not be asked. Retryable — nothing is decided, so nothing is posted. */
  | 'LEDGER_LOOKUP_UNAVAILABLE'
  /** Held by a document IMS has never recorded. The cutover case: almost certainly xeroom's. */
  | 'NUMBER_HELD_BY_FOREIGN_DOCUMENT'
  /** Held by a document IMS owns — but for a DIFFERENT order than the one being posted. */
  | 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT'
  /** Held by a voided/deleted document. Xero will not accept a modification of one. */
  | 'NUMBER_HELD_BY_VOIDED_DOCUMENT'

export type InvoiceNumberPostDecision =
  | {
      post: true
      /**
       * - `unclaimed`   — the ledger holds no document with this number. Post, and RECORD THE
       *                   CLAIM (see `ownClaimInvoiceNumber`) so a lost response is recoverable.
       * - `own-document`— the number is held by the very document this order is linked to; the
       *                   POST modifies our own invoice, which is what an update is.
       * - `own-claim`   — the ledger holds it, IMS has no link, but THIS queue entry recorded a
       *                   claim on this exact number before its previous attempt. See below.
       */
      basis: 'unclaimed' | 'own-document' | 'own-claim'
      /** The document the post will land on, when one already exists. */
      claimedInvoiceId?: string
      /** True only for `unclaimed` — the caller must persist the claim before posting. */
      recordClaim: boolean
    }
  | {
      post: false
      code: InvoiceNumberRefusalCode
      /**
       * Whether trying again unchanged could ever succeed. `true` only for a lookup that failed:
       * an ownership refusal is a verdict about the ledger's contents and repeating it just
       * spends API budget on the same answer.
       */
      retryable: boolean
      /** Operator-facing. Says which number, who holds it, and what to do. */
      reason: string
    }

/** Statuses in which a Xero invoice holds its number but cannot be modified. */
const UNMODIFIABLE_STATUSES = new Set(['VOIDED', 'DELETED'])

function describeClaim(claim: LedgerInvoiceClaim): string {
  const parts = [`invoice ${claim.invoiceId}`, `status ${claim.status}`]
  if (claim.contactName) parts.push(`contact "${claim.contactName}"`)
  if (typeof claim.total === 'number' && Number.isFinite(claim.total)) parts.push(`total ${claim.total}`)
  return parts.join(', ')
}

/**
 * Decide whether a sales-invoice CREATE may be sent.
 *
 * `ownedInvoiceId` is the external id the local order already carries (SalesOrder
 * .accountingInvoiceId) — the authoritative "this ledger document is ours" record, written from
 * the response of the post that created it.
 *
 * `ownClaimInvoiceNumber` is what stands in for that record in the ONE case where it cannot exist:
 * the post succeeded and the response was lost, so the ledger has our document and IMS has no id
 * for it. Without an answer for that case the fence would turn a self-healing retry into a
 * permanent refusal — today the retry simply re-POSTs and the upsert lands on the same document.
 * So the caller records, on the queue entry itself and BEFORE the first attempt, the number it is
 * about to post under, and only once the lookup has said that number was unclaimed. A claim
 * therefore means: *at a moment when nobody held this number, THIS entry set out to post it*. If
 * the number is held now and this entry holds that claim, the holder is our own document.
 *
 * The claim is scoped to one queue entry deliberately. A freshly enqueued row for the same order
 * does not inherit it, so a human re-queueing a failed post gets the full refusal rather than an
 * inherited licence to overwrite.
 */
export function decideInvoiceNumberPost(params: {
  /** The number the payload will post under. */
  invoiceNumber: string | null | undefined
  /** What the ledger said when asked who holds it. */
  lookup: InvoiceNumberLookup
  /** SalesOrder.accountingInvoiceId — the document IMS already owns for this order, if any. */
  ownedInvoiceId?: string | null
  /** The number this queue entry claimed before a previous attempt, if any. */
  ownClaimInvoiceNumber?: string | null
  /** How to name the local order in the refusal (order number, or id). */
  orderLabel: string
}): InvoiceNumberPostDecision {
  const invoiceNumber = params.invoiceNumber?.trim()
  if (!invoiceNumber) {
    return {
      post: false,
      code: 'NO_INVOICE_NUMBER',
      retryable: false,
      reason:
        `Refusing to post a sales invoice for ${params.orderLabel} with no invoice number. The create is `
        + 'update-or-create on the invoice number, so an empty one cannot be fenced against the documents '
        + 'already in the ledger.',
    }
  }

  if (!params.lookup.ok) {
    return {
      post: false,
      code: 'LEDGER_LOOKUP_UNAVAILABLE',
      retryable: true,
      reason:
        `Could not ask the ledger who holds invoice number ${invoiceNumber} before posting ${params.orderLabel}: `
        + `${params.lookup.error}. NOTHING WAS SENT — the create is update-or-create on that number, so posting `
        + 'without an answer risks silently overwriting an invoice another system already posted. This retries '
        + 'on its own once the accounting connection is reachable again.',
    }
  }

  const claim = params.lookup.claim
  if (!claim) return { post: true, basis: 'unclaimed', recordClaim: true }

  const owned = params.ownedInvoiceId?.trim() || null
  if (owned && owned === claim.invoiceId) {
    return { post: true, basis: 'own-document', claimedInvoiceId: claim.invoiceId, recordClaim: false }
  }

  // Checked BEFORE the foreign/other-order refusals but AFTER the direct link: a claim is weaker
  // evidence than a recorded id, and it only answers the lost-response case.
  const ownClaim = params.ownClaimInvoiceNumber?.trim() || null
  if (!owned && ownClaim && ownClaim === invoiceNumber && !UNMODIFIABLE_STATUSES.has(claim.status.toUpperCase())) {
    return { post: true, basis: 'own-claim', claimedInvoiceId: claim.invoiceId, recordClaim: false }
  }

  if (UNMODIFIABLE_STATUSES.has(claim.status.toUpperCase())) {
    return {
      post: false,
      code: 'NUMBER_HELD_BY_VOIDED_DOCUMENT',
      retryable: false,
      reason:
        `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: the ledger already holds that `
        + `number on a ${claim.status} document (${describeClaim(claim)}). The create would be a modification of `
        + 'that document, which the ledger will not accept, and reusing the number needs a human decision about '
        + 'the voided one. Resolve it in the accounting system, then re-queue this order.',
    }
  }

  if (owned) {
    return {
      post: false,
      code: 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT',
      retryable: false,
      reason:
        `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: this order is already linked to `
        + `ledger document ${owned}, but that number is held by a DIFFERENT document (${describeClaim(claim)}). `
        + 'Posting would overwrite the other document. Establish which document belongs to this order — the link '
        + 'or the number is wrong — before anything is posted.',
    }
  }

  return {
    post: false,
    code: 'NUMBER_HELD_BY_FOREIGN_DOCUMENT',
    retryable: false,
    reason:
      `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: the ledger ALREADY HOLDS that `
      + `number (${describeClaim(claim)}) and IMS does not own that document. The sales-invoice create is `
      + 'update-or-create on the invoice number, so this post would not duplicate — it would silently REPLACE '
      + 'that invoice. The expected cause during cutover is that the WooCommerce PDF/xeroom plugin already '
      + 'posted this order. If the existing document is the right one, leave it and cancel this sync row; if '
      + 'this order genuinely has no ledger document yet, link the correct one to the order (or void the wrong '
      + 'one in the accounting system) and re-queue.',
  }
}
