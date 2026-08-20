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
 * cannot be asked at all, and the case where the answer cannot be shown to be COMPLETE.
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
 * ------------------------------------------------------------------------------------------------
 * WHAT THE FENCE IS FOR ONCE XEROOM IS GONE, AND WHAT THE PRE-POST RECORD PROVES (Codex round 3)
 * ------------------------------------------------------------------------------------------------
 * Xeroom is REMOVED at cutover, not run alongside IMS. There are three states and only one writer
 * in each of them:
 *
 *   1. today      — xeroom posts; IMS sales invoices are OFF by owner instruction;
 *   2. cutover    — xeroom removed, IMS enabled;
 *   3. afterwards — IMS is the only writer, and Xero still holds ~14,415 documents xeroom posted,
 *                   under exactly the numbers IMS now derives from `_wcpdf_invoice_number`.
 *
 * SO THE FENCE IS ABOUT THE STANDING SET, NOT A CONCURRENT WRITER. Those 14,415 documents do not
 * disappear when the plugin does, and after cutover there is no second system left to notice an
 * overwrite. The realistic route to one is a re-import, a backfill, or a re-queue of an order
 * xeroom invoiced months ago: each arrives as an ordinary create under the number the customer's
 * PDF already carries, and each is caught here — PROVIDED THE LOOKUP CANNOT MISS. That is now the
 * load-bearing property of the whole fence, and it lives in
 * lib/connectors/xero/invoice-number-claim.ts.
 *
 * WHAT THE PRE-POST RECORD PROVES. `attemptedInvoiceNumber` records, before the request leaves,
 * that this row was about to post under this number at a moment when the ledger said nobody held
 * it. Round 2 turned that into a licence to post — "nobody held it then, somebody holds it now,
 * therefore the holder is ours". The RECORD is kept; the INFERENCE is retired, and not only
 * because a foreign writer could take the number in between:
 *
 *   - it is a fact about the LOOKUP's moment. It cannot identify who holds the number now;
 *   - it is consulted ONLY when the lookup says the number IS held. After cutover the only way a
 *     historical xeroom document can be held-now and unclaimed-then is THAT THE LOOKUP MISSED IT.
 *     So the licence would fire precisely in the state where the fence has already failed: it
 *     turns one overwrite into a repeated one, and removes the refusal that would have exposed it.
 *     A licence whose soundness depends on the lookup being exhaustive must not also be the
 *     compensation for a lookup that is not;
 *   - and the window it was meant to cover is not a foreign-system race any more. With xeroom gone
 *     the only things that can take a number between the lookup and the post are ANOTHER IMS
 *     WORKER — local, bounded (each sync row is claimed by exactly one worker, so this needs two
 *     rows carrying the same number), and closable here if it ever matters — or a person typing an
 *     invoice into Xero by hand. Neither is a reason to reintroduce the inference, and neither is
 *     described here as unclosable.
 *
 * The record therefore survives as MESSAGE MATERIAL and as a durability gate before an
 * irreversible write, and licenses nothing (see `attemptedInvoiceNumber` and `recordAttempt`).
 *
 * THE PRICE, STATED. The create carries an Idempotency-Key derived from the queue entry
 * (`buildXeroIdempotencyKey`), and Xero replays the original response for a repeated key inside
 * its retention window — which is what used to make a crash-after-post self-heal. The fence
 * refuses BEFORE that request is made, so it forfeits the heal: a lost response settles as
 * NUMBER_HELD_BY_FOREIGN_DOCUMENT until an operator confirms the document is ours and links it to
 * the order, after which the ordinary retry UPDATES it. That is a recoverable outcome bought with
 * an unrecoverable one. Making it automatic again would need evidence FROM THE LEDGER that the
 * holder is ours — the holder's own `UpdatedDateUTC` against `attemptedInvoiceNumberAt` is the
 * cheap candidate — and it is deliberately not built: it is machinery for a rare recovery path,
 * and its wrong answer is an overwrite while the refusal's is a phone call (o3d-k26m.8).
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
 *
 * `claims` IS AN EXHAUSTIVE SET, and the lookup owes that guarantee. An empty array does not mean
 * "no holder was seen", it means "the ledger was asked, the WHOLE result set was read, and nobody
 * holds it" — because an empty array is what authorises the post that overwrites. A lookup that
 * cannot prove it read the whole set must return `ok: false` instead (see
 * lib/connectors/xero/invoice-number-claim.ts, where a full page is a failure and not an answer).
 */
export type InvoiceNumberLookup =
  | { ok: true; claims: LedgerInvoiceClaim[] }
  | { ok: false; error: string }

export type InvoiceNumberRefusalCode =
  /** The payload has no invoice number at all. */
  | 'NO_INVOICE_NUMBER'
  /** The ledger could not be asked, or could not be shown to have answered in full. Retryable. */
  | 'LEDGER_LOOKUP_UNAVAILABLE'
  /** Held by a document IMS has never recorded. The cutover case: almost certainly xeroom's. */
  | 'NUMBER_HELD_BY_FOREIGN_DOCUMENT'
  /** Held by a document IMS owns — but for a DIFFERENT order than the one being posted. */
  | 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT'
  /** Held by a voided/deleted document. Xero will not accept a modification of one. */
  | 'NUMBER_HELD_BY_VOIDED_DOCUMENT'
  /** Held by more than one live document, so which one an upsert would replace is unknowable. */
  | 'NUMBER_HELD_BY_MULTIPLE_DOCUMENTS'

export type InvoiceNumberPostDecision =
  | {
      post: true
      /**
       * - `unclaimed`   — the ledger holds no document with this number, and said so in full.
       * - `own-document`— the number is held by the very document this order is linked to; the
       *                   POST modifies our own invoice, which is what an update is.
       */
      basis: 'unclaimed' | 'own-document'
      /** The document the post will land on, when one already exists. */
      claimedInvoiceId?: string
      /**
       * True only for `unclaimed`: record, on the queue entry and BEFORE the request leaves, the
       * number this attempt is about to post under. It licenses nothing (see the header) — it is
       * kept because a post whose local record cannot be written is a post whose OUTCOME cannot be
       * written either, and because a later refusal can then tell the operator that this row had
       * already set out under this number.
       */
      recordAttempt: boolean
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

/** " 2 voided/deleted documents also hold that number (…)." — context, never part of the rule. */
function describeAlsoHeldBy(dead: LedgerInvoiceClaim[]): string {
  if (dead.length === 0) return ''
  const phrase = dead.length === 1 ? 'document also holds' : 'documents also hold'
  return ` ${dead.length} voided/deleted ${phrase} that number (${dead.map(describeClaim).join('; ')}).`
}

/**
 * Decide whether a sales-invoice CREATE may be sent.
 *
 * `ownedInvoiceId` is the external id the local order already carries (SalesOrder
 * .accountingInvoiceId) — the authoritative, and now the ONLY, "this ledger document is ours"
 * record. It is written from the response of the post that created it, so it is evidence produced
 * by the ledger itself rather than an inference about it.
 */
export function decideInvoiceNumberPost(params: {
  /** The number the payload will post under. */
  invoiceNumber: string | null | undefined
  /** What the ledger said when asked who holds it. */
  lookup: InvoiceNumberLookup
  /** SalesOrder.accountingInvoiceId — the document IMS already owns for this order, if any. */
  ownedInvoiceId?: string | null
  /**
   * The number a PREVIOUS attempt on this same queue entry set out to post under.
   *
   * MESSAGE MATERIAL ONLY — never part of the rule, exactly like `contactName` on a claim. It
   * proves that this row was about to post under this number at a moment when the ledger said
   * nobody held it; it does NOT prove that whoever holds it now is us (see the header). Its only
   * job is to turn "some unknown document holds your number" into "this row already tried to post
   * under this number, so check whether the holder is ours before assuming it is xeroom's".
   */
  attemptedInvoiceNumber?: string | null
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

  const claims = params.lookup.claims
  if (claims.length === 0) return { post: true, basis: 'unclaimed', recordAttempt: true }

  // A voided document HOLDS its number but cannot be modified, so it can never be the document an
  // upsert lands on. Partitioning first is what stops an arbitrary holder being picked out of
  // several: the question "which document would this post replace?" is only ever about the live
  // ones, and if that is not exactly one document, it has no answer.
  const live = claims.filter((claim) => !UNMODIFIABLE_STATUSES.has(claim.status.toUpperCase()))
  const dead = claims.filter((claim) => UNMODIFIABLE_STATUSES.has(claim.status.toUpperCase()))
  const owned = params.ownedInvoiceId?.trim() || null

  if (live.length > 1) {
    return {
      post: false,
      code: 'NUMBER_HELD_BY_MULTIPLE_DOCUMENTS',
      retryable: false,
      reason:
        `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: ${live.length} live documents `
        + `in the ledger hold that number (${live.map(describeClaim).join('; ')}), so WHICH of them this `
        + 'update-or-create would replace cannot be established from here — including when one of them is ours. '
        + 'Resolve the duplicate in the accounting system (void or renumber all but one), then re-queue this '
        + `order.${describeAlsoHeldBy(dead)}`,
    }
  }

  if (live.length === 0) {
    return {
      post: false,
      code: 'NUMBER_HELD_BY_VOIDED_DOCUMENT',
      retryable: false,
      reason:
        `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: the ledger already holds that `
        + `number on a ${dead[0].status} document (${describeClaim(dead[0])}). The create would be a modification of `
        + 'that document, which the ledger will not accept, and reusing the number needs a human decision about '
        + `the voided one. Resolve it in the accounting system, then re-queue this order.${describeAlsoHeldBy(dead.slice(1))}`,
    }
  }

  const holder = live[0]
  if (owned && owned === holder.invoiceId) {
    return { post: true, basis: 'own-document', claimedInvoiceId: holder.invoiceId, recordAttempt: false }
  }

  if (owned) {
    return {
      post: false,
      code: 'NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT',
      retryable: false,
      reason:
        `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: this order is already linked to `
        + `ledger document ${owned}, but that number is held by a DIFFERENT document (${describeClaim(holder)}). `
        + 'Posting would overwrite the other document. Establish which document belongs to this order — the link '
        + `or the number is wrong — before anything is posted.${describeAlsoHeldBy(dead)}`,
    }
  }

  const attempted = params.attemptedInvoiceNumber?.trim() || null
  const attemptedNote = attempted && attempted === invoiceNumber
    ? ' NOTE: this sync row had already set out to post under this number once before, so the holder MAY be a '
      + 'document IMS created and failed to record — a lost response looks exactly like this. That is NOT proof '
      + 'of ownership: the number could equally have been taken by the other system in the same window, and '
      + 'nothing in the ledger’s answer tells the two apart (same order, same contact, same total). Check the '
      + 'document in the accounting system; if it is ours, link it to this order and the next retry will UPDATE '
      + 'it instead of replacing it.'
    : ''

  return {
    post: false,
    code: 'NUMBER_HELD_BY_FOREIGN_DOCUMENT',
    retryable: false,
    reason:
      `Refusing to post ${params.orderLabel} as invoice number ${invoiceNumber}: the ledger ALREADY HOLDS that `
      + `number (${describeClaim(holder)}) and IMS does not own that document. The sales-invoice create is `
      + 'update-or-create on the invoice number, so this post would not duplicate — it would silently REPLACE '
      + 'that invoice. The expected cause during cutover is that the WooCommerce PDF/xeroom plugin already '
      + 'posted this order. If the existing document is the right one, leave it and cancel this sync row; if '
      + 'this order genuinely has no ledger document yet, link the correct one to the order (or void the wrong '
      + `one in the accounting system) and re-queue.${attemptedNote}${describeAlsoHeldBy(dead)}`,
  }
}
