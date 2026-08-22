import type { Prisma } from '@/app/generated/prisma/client'
import { readDiscountRestatement, restatementHadPostedInvoice } from './discount-restatement'

/**
 * o3d-y14 r3 finding 1 — WHAT THE INVOICE POSTED, for a chargeback that must mirror it.
 *
 * THE DEFECT. `raiseChargebackForReversedOrder` builds the credit note's order-discount leg from
 * `SalesOrder.discountAmount`, live. That is right for every order whose column still says what its
 * invoice said, and wrong for exactly the orders the o3d-y14 backfill corrects: the invoice posted
 * the duplicated coupon as a negative "Order discount" line, the backfill then cleared that column,
 * and a chargeback raised afterwards omits the leg entirely — crediting the full goods against an
 * invoice that never charged them, and over-reversing AR and revenue by the cleared amount.
 *
 * WHY A FRESHNESS CHECK IS THE WRONG SHAPE. An earlier round proposed comparing the column against
 * the queued payload and refusing on drift. On a corrected order that drift is PERMANENT and
 * intended — the column is supposed to disagree with a document posted before the correction — so
 * the check would report the same "staleness" forever, on every corrected order, while never
 * producing a correct credit note for any of them. The problem is not that the two disagree; it is
 * that the chargeback reads the wrong one of them.
 *
 * WHEN IT IS CONSULTED AT ALL (r4 finding 1). Only for orders carrying a `discountRestatement`
 * marker, which `applyWcCouponCorrection` writes in the SAME `UPDATE` as the correction itself. A
 * NULL marker proves the row was never restated, so its column IS what any document for it carried —
 * which keeps every native, manual and pre-column order, every order the fixed importer wrote, and
 * every row the backfill's stamp-only pass merely MARKED as already-correct, on exactly today's
 * behaviour, without a single ledger query.
 *
 * The gate used to be `discountModel`, and that was wrong in both directions: the fixed importer
 * stamps that column on brand-new orders it never restated (so ordinary orders were being made to
 * depend on the mirror existing), while the marker below exists only where a figure was actually
 * rewritten. See `lib/domain/accounting/discount-restatement.ts`.
 *
 * WHERE THE POSTED FIGURE IS RECOVERED FROM, and why this source and not the obvious ones:
 *
 *   `AccountingEvent` — the internal mirror of the document that was sent. Every SALES_INVOICE /
 *   SALES_INVOICE_UPDATE enqueue mirrors its payload here through `mirrorAccountingSyncLogToEvent`
 *   (both connectors), and the processor flips it to POSTED on a successful post. Nothing purges
 *   these rows: `purgeExpiredData` does not touch `accounting_events` at all, which is what makes it
 *   usable for a question asked months later.
 *
 *   NOT `AccountingSyncLog.payload`, though it holds the same payload: data retention DELETES
 *   resolved sync rows past the horizon and COMPACTS unresolved ones to an attribution-only
 *   tombstone with the payload blanked. A chargeback follows a payment dispute, which routinely
 *   arrives months after the invoice — squarely past that horizon. A source that stops answering
 *   for old orders is no source at all for this question.
 *
 *   NOT the ActivityLog marker the backfill writes: it is INFO, and `purgeExpiredActivityLogs`
 *   deletes INFO after 30 days by default. Same objection, sooner.
 *
 *   NOT `unearnedRevenueAmount` / the Group A1 batch stamp: that is a deferral total
 *   (subtotal + shipping − discount), not the discount, and it exists only for orders a daily batch
 *   has taken.
 *
 * WHAT `linesJson` ACTUALLY IS, and how the posted figure is derived from it (r4 finding 3).
 *
 * The mirror records the payload IMS ENQUEUED, not a read-back of the document Xero or QuickBooks
 * created. Treating `discount.amount` as "the figure the document carried" was therefore wrong: the
 * Xero adapter appends its negative "Order discount" line only when a discount ACCOUNT CODE is
 * present (`lib/connectors/xero/invoices.ts`), so an invoice enqueued with a discount but no
 * configured account posted the FULL goods and no discount line at all — while the mirror recorded a
 * positive discount. Auto-raising a credit note carrying that discount (against an invoice that
 * never charged it) under-credits by the whole amount.
 *
 * The fix is NOT to start reading the document back. That would change what is recorded from now on
 * and do nothing whatever for the invoices this exists for, which posted in the past and whose
 * mirrored events already say what they say. What is recorded is the exact INPUT to a deterministic
 * connector rule, and the discriminator that rule tests — the discount account code — is recorded
 * with it. So the posted figure is derived by replaying that rule over the recorded request:
 *
 *   xero        the line is posted only when the payload carried a discount account code. Without
 *               one the document's order-level discount is 0, and 0 is the ANSWER, not a fallback.
 *   quickbooks  the DiscountLineDetail is pushed whenever the amount is positive — the account ref
 *               is optional and merely left undefined — so the recorded amount IS the posted one,
 *               rounded to 2dp exactly as that adapter rounds it.
 *   anything else, including a mirrored event with no `externalSystem`: REFUSED. A rule that cannot
 *               be replayed cannot be replayed optimistically.
 *
 * `connector-omission-rules.test.ts`-style source assertions in the test file pin both adapters, so
 * a change to either condition fails here rather than silently rotting this derivation.
 *
 * WHAT THE CONSTRAINT ON `AccountingEvent` MAKES REPRESENTABLE (r4 finding 2).
 *
 * `@@unique([externalSystem, externalId])`. A Xero SALES_INVOICE_UPDATE modifies the existing
 * invoice and returns the SAME InvoiceID, so when its mirrored event tries to go POSTED with that
 * id it collides with the original invoice's event — a P2002 that is not caught, aborting the very
 * transaction that marks the sync log SYNCED. An invoice update therefore CANNOT leave behind a
 * second POSTED event carrying the newer figure; the earlier "the latest posted document wins"
 * ordering described a row set the database cannot hold, and has been removed rather than left
 * implying a guarantee it never provided.
 *
 * What the database CAN hold is read instead:
 *
 *   - an unresolved SALES_INVOICE_UPDATE event (anything but POSTED or VOID) is exactly the trace a
 *     successfully-applied update leaves under that constraint, and is indistinguishable from one
 *     that never reached the ledger. Either way the document may no longer carry what the original
 *     invoice's event records, so this REFUSES;
 *   - several POSTED events are possible only with distinct (or NULL) external ids, i.e. distinct
 *     documents rather than revisions of one. They are all read: if they agree, that agreement is
 *     the posted figure whichever of them the credit note reverses; if they disagree, no ordering
 *     available here says which is current, so this REFUSES — and the refusal NAMES every one of
 *     them (r11 finding 3), because "several documents disagree" is precisely the answer an
 *     operator can act on only by opening them, and it says nothing about which.
 *
 * WHAT AGREEMENT DOES AND DOES NOT ESTABLISH (r8 finding 2). The agreement rule above answers the
 * RESOLVER's question — a credit note that mirrors one of these documents reverses this figure
 * whichever one it is — and it is not an answer to "how much order-level discount does the ledger
 * hold for this order". Two agreeing invoices hold it TWICE. So `documentCount` is returned beside
 * the amount, and the o3d-y14 netting refuses on it; nothing here silently promotes agreement to
 * singularity. The same applies to `taxBasis`: see `PostedDocumentTaxBasis` below.
 *
 * WHEN IT CANNOT BE RECOVERED. Every branch that cannot establish the figure reports UNRECOVERABLE,
 * and the caller refuses and surfaces — which is what that path already does for the other cases
 * where the remaining balance is ambiguous (prior refunds, no discount account configured). A
 * refusal describes a FAILURE and not the rows it happened over, so every answer — refusals
 * included — also carries `documentSet`, the fingerprint of the rows it was derived from
 * (r12 finding 1; see the block above `PostedOrderDiscountClient`), and every refusal carries
 * `postedDocuments`: HOW MANY posted documents it was derived over and which of them can be named
 * (r13 finding 1). That is evidence and not a claim — it is emphatically NOT the disagreement
 * count, which stays confined to the one branch that established a disagreement — and it exists
 * because a caller that reads "the disagreement count is null" as "there is one document" goes on
 * to prescribe against "the document" on an order whose ledger holds several.
 *
 * WHAT THE CALLER DOES WITH A RECOVERED FIGURE THAT DISAGREES. It refuses too, and that is a
 * deliberate limit on this function rather than a failure of it. Recovering the posted figure is
 * what makes the disagreement VISIBLE and quantifiable at all — without it the over-reversal is
 * silent. But a disagreement means the ledger document understates and the backfill has already
 * asked an operator to correct it by hand, in the accounting system, where IMS cannot see whether
 * they have. Before that adjustment the posted figure is the one to reverse; after it, the order's.
 * Both are wrong in one of the two worlds, so the caller names both and hands it to a human. See
 * `raiseChargebackForReversedOrder`.
 */

/** The sync/document types whose mirrored event describes the sales invoice for an order. */
export const POSTED_SALES_INVOICE_EVENT_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] as const

/** The mirrored-event status that means the document reached the ledger. */
export const POSTED_ACCOUNTING_EVENT_STATUS = 'POSTED'

/**
 * Mirrored-event statuses that settle a SALES_INVOICE_UPDATE.
 *
 * POSTED is read as a document below. VOID is written by `voidMirroredAccountingEventsForOrder` only
 * for an order whose invoice work was retired unposted (a cancelled order), so it is a positive
 * statement that this update never reached the ledger. Everything else — PENDING, FAILED, REVERSED —
 * leaves open that the remote document was modified, and is refused.
 */
export const SETTLED_INVOICE_UPDATE_EVENT_STATUSES = ['POSTED', 'VOID'] as const

export type PostedOrderDiscount =
  /**
   * The order's own `discountAmount` is what posted (or nothing has posted at all, so there is no
   * earlier document to mirror and a future one would carry this figure).
   */
  | { source: 'ORDER'; amount: number; detail: string }
  /** Read from the mirrored document that was actually sent. */
  | {
      source: 'POSTED_DOCUMENT'
      amount: number
      detail: string
      documentType: string
      externalId: string | null
      /**
       * Which connector's rule was replayed to reach `amount`. Carried because the remedy for a
       * document that disagrees is performed in THAT system's UI, and the o3d-y14 operator handoff
       * has to name steps that exist there rather than generic ones that exist nowhere.
       */
      externalSystem: string | null
    }
  /** A document exists and what it posted cannot be established. The caller must NOT guess. */
  | { source: 'UNRECOVERABLE'; detail: string }

type MirroredDocument = {
  type: string
  status: string
  currency: string
  externalSystem: string | null
  externalId: string | null
  /** Read for the document-set fingerprint only (r12 finding 1); it decides no amount. */
  createdAt: unknown
  linesJson: unknown
}

/** A SALES_INVOICE_UPDATE that has not settled — the rows the first refusal below is about. */
type UnsettledInvoiceUpdate = {
  type: string
  status: string
  externalSystem: string | null
  externalId: string | null
  createdAt: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Replay ONE connector's order-level-discount rule over the enqueued payload it received.
 *
 * Returns the amount the DOCUMENT carries, which is not always the amount that was requested. See
 * the module header; each branch names the adapter line it mirrors.
 */
function postedDiscountForConnector(
  externalSystem: string | null,
  requested: number,
  accountCode: string | undefined,
): { ok: true; amount: number } | { ok: false; detail: string } {
  switch (externalSystem) {
    case 'xero':
      // lib/connectors/xero/invoices.ts: `if (data.discountAmount > 0 && data.discountAccountCode)`.
      // No account code, no negative "Order discount" line — the invoice charged the full goods.
      if (!accountCode) {
        return { ok: true, amount: 0 }
      }
      // And when it is posted, it is posted verbatim as `UnitAmount: -data.discountAmount`.
      return { ok: true, amount: requested }
    case 'quickbooks':
      // lib/connectors/quickbooks/invoices.ts: the DiscountLineDetail is pushed on `discountAmount >
      // 0` alone — the account ref is resolved from the payload OR the connector setting and is
      // simply left undefined when neither resolves — so the line always exists, rounded to 2dp.
      return { ok: true, amount: Math.round(requested * 100) / 100 }
    default:
      return {
        ok: false,
        detail:
          `the mirrored event names no connector whose posting rule can be replayed ` +
          `(externalSystem ${JSON.stringify(externalSystem)}), so whether the document carried the ` +
          `${requested} it requested is unknown`,
      }
  }
}

/**
 * Pull the order-level discount THE DOCUMENT CARRIES out of ONE mirrored payload.
 *
 * Every branch that cannot answer says so rather than returning 0. A missing `discount` key means
 * "the document posted no discount leg", which is a real answer and genuinely 0; a payload this
 * cannot parse, or one denominated in a different currency from the order, is NOT — reading 0 out
 * of either would omit a discount leg that exists, which is the very defect being fixed.
 */
export function readPostedDocumentDiscount(
  document: { currency: string; externalSystem: string | null; linesJson: unknown },
  expectedCurrency: string,
): { ok: true; amount: number; taxBasis: PostedDocumentTaxBasis } | { ok: false; detail: string } {
  const payload = document.linesJson
  if (!isRecord(payload) || payload.kind !== 'accounting-document') {
    return { ok: false, detail: 'the mirrored event does not carry a document payload' }
  }
  // Read BEFORE any of the early returns below, because a 0 discount is still a document with a
  // basis and the netting has to be able to say which one it was.
  const taxBasis = readDocumentTaxBasis(payload)
  const documentCurrency = typeof payload.currency === 'string' ? payload.currency : document.currency
  if (documentCurrency.toUpperCase() !== expectedCurrency.toUpperCase()) {
    // The discount is a bare number in the document's own currency. Reversing it into an order of a
    // different currency would silently mix units.
    return {
      ok: false,
      detail: `the posted document is in ${documentCurrency} but the order is in ${expectedCurrency}`,
    }
  }
  if (payload.discount === undefined || payload.discount === null) {
    return { ok: true, amount: 0, taxBasis }
  }
  if (!isRecord(payload.discount)) {
    return { ok: false, detail: 'the posted document carries an unreadable discount adjustment' }
  }
  const amount = payload.discount.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return {
      ok: false,
      detail: `the posted document's discount amount ${JSON.stringify(amount)} is not a usable number`,
    }
  }
  // Both adapters skip a non-positive adjustment, and `normalizeAdjustment` never records one, so
  // there is no connector rule to replay: the document carried no order-level discount line.
  if (amount === 0) return { ok: true, amount: 0, taxBasis }

  const accountCode = typeof payload.discount.accountCode === 'string' && payload.discount.accountCode.trim()
    ? payload.discount.accountCode.trim()
    : undefined
  const replayed = postedDiscountForConnector(document.externalSystem, amount, accountCode)
  return replayed.ok ? { ok: true, amount: replayed.amount, taxBasis } : replayed
}

/**
 * WHICH TAX BASIS THE DOCUMENT'S ORDER-DISCOUNT LINE IS DENOMINATED IN (o3d-y14 r8 finding 1).
 *
 * A sales invoice is enqueued in the ORDER's own convention: `queueSalesInvoiceForOrder` passes
 * `SalesOrder.discountAmount` through verbatim and stamps `lineAmountsIncludeTax` beside it, so on a
 * tax-inclusive order the negative "Order discount" line Xero appends is a GROSS figure. Every
 * credit-note refund line IMS stores is NET (`SalesOrderRefundLine` amounts are net for every
 * caller, and the credit-note payload sets `lineAmountsIncludeTax: false`).
 *
 * The chargeback path knows this — it divides by `(1 + taxRatePercent)` before storing the mirrored
 * discount leg — so the two figures are on DIFFERENT BASES whenever the order is inclusive, and
 * their difference is not a number. Nothing IMS persists lets the division be inverted: the refund
 * line records a tax TYPE, never a rate, and the order's live `taxRatePercent` is not evidence of
 * what it was when the refund was created. So the basis is REPORTED here and the netting refuses on
 * it, rather than being silently assumed to be NET.
 *
 * `UNKNOWN` is a payload that states neither `lineAmountsIncludeTax` nor `lineAmountMode` — a
 * hand-built or pre-schema mirror. It is not read as EXCLUSIVE: "the builder defaults to false" is a
 * statement about the builder, not about a row that never went through it.
 */
export type PostedDocumentTaxBasis = 'EXCLUSIVE' | 'INCLUSIVE' | 'UNKNOWN'

/** Several documents whose bases disagree. Only reachable with more than one posted document. */
export type PostedInvoiceTaxBasis = PostedDocumentTaxBasis | 'MIXED'

function readDocumentTaxBasis(payload: Record<string, unknown>): PostedDocumentTaxBasis {
  if (typeof payload.lineAmountsIncludeTax === 'boolean') {
    return payload.lineAmountsIncludeTax ? 'INCLUSIVE' : 'EXCLUSIVE'
  }
  if (payload.lineAmountMode === 'INCLUSIVE') return 'INCLUSIVE'
  if (payload.lineAmountMode === 'EXCLUSIVE') return 'EXCLUSIVE'
  return 'UNKNOWN'
}

/**
 * THE DOCUMENT SET THIS ANSWER WAS DERIVED OVER, AS A VALUE (o3d-y14 r12 finding 1).
 *
 * THE DEFECT IT CLOSES. r11 finding 1 made the o3d-y14 re-validation compare the invoice-side
 * position as a VALUE — including, for a refusal, the refusal's own words — so that a document
 * voided, re-posted or joined by a second one between the correction and the print withdraws the
 * printed remedy. r11 removed one source of non-determinism from those words (the disagreement
 * refusal's amounts were sorted) so that they could be compared at all. This is the other half: an
 * `UNRECOVERABLE` refusal describes a FAILURE, and a failure is not a description of the rows it
 * happened over. Two entirely different document sets produce identical refusal text —
 *
 *   • `2 SALES_INVOICE_UPDATE event(s) … never reached POSTED` says only how many updates are
 *     unsettled. It is reached BEFORE the posted documents are looked at at all, so the whole posted
 *     set can be replaced underneath it and every field of the compared position is unchanged.
 *   • `a SALES_INVOICE was posted for this order but the mirrored event does not carry a document
 *     payload` names a TYPE and a reason, never a document. The same sentence covers INV-778 today
 *     and INV-900 (voided, re-raised, still unparseable) tomorrow.
 *   • only the several-documents-DISAGREE refusal carries `documentCount`/`externalIds`, and that is
 *     deliberate — the callers read those as "the derivation established WHICH documents this is
 *     about", and populating them elsewhere would make an unreadable-payload refusal render as a
 *     DISAGREEMENT, which is a different and false statement.
 *
 * So the fingerprint is a SEPARATE field from the prose, carried on EVERY variant including the
 * successful one, and read by nothing but the comparison and the withdrawal message.
 *
 * WHAT IT COVERS, and why exactly this set. It is the rows this derivation consulted, one entry each:
 *
 *   every POSTED sales-invoice event — its type, which connector and external id name it, when it
 *   was mirrored, its own currency, and WHAT THIS DERIVATION READ OUT OF IT (the replayed posted
 *   amount and tax basis, or the reason it could not be read). The read outcome is in there because
 *   the set can move without any row appearing or vanishing: with three documents where the first is
 *   unreadable, the refusal names the first and nothing else is examined at all — so a second
 *   document going from readable to unreadable, or its amount changing under a re-mirror, is invisible
 *   in every other field. Every document is therefore READ, not just the ones before the first
 *   failure;
 *
 *   every UNSETTLED SALES_INVOICE_UPDATE — its identity and its status. That refusal's own words are
 *   a COUNT, so one update settling to VOID while another arrives leaves the sentence, the posted set
 *   and the count all identical while an update is now in flight against the document an operator is
 *   being sent to read.
 *
 * WHAT IT DELIBERATELY IS NOT.
 *
 *   NOT A DIGEST. A withdrawal has to be able to SAY what moved (see
 *   `describeWcCouponDocumentPosition`), and an operator told only that "something changed" learns to
 *   re-run rather than to look. Every entry is a sentence.
 *
 *   NOT THE `AccountingEvent` PRIMARY KEY. A surrogate id means nothing to the operator who reads the
 *   withdrawal, and the reference this whole module is built on is the (connector, external id) pair.
 *   `createdAt` carries the row-identity part of the job and is readable.
 *
 *   NOT DE-DUPLICATED, unlike the id sets the position compares elsewhere. Two documents that are
 *   identical in every field are TWO documents holding the discount twice, and collapsing them would
 *   hide exactly the duplication r8 finding 2 exists for.
 *
 *   SORTED, for the reason r11 sorted the refusal's amounts: neither Prisma nor PostgreSQL promises a
 *   stable row order, and a comparison that refused on row order would withdraw remedies at random —
 *   which teaches an operator to ignore the withdrawal that matters.
 *
 * THE RESIDUAL, stated rather than rounded away. Two POSTED documents that record NO external id
 * (o3d-9kek), were mirrored at the same instant and read identically are indistinguishable here, so
 * swapping one for the other is not detected. The unique constraint makes that impossible for any
 * document that DID record an id, and adding or removing one still moves the entry count.
 *
 * THE OTHER RESIDUAL IS GONE (o3d-y14 r13 finding 2). The failure a refusal NAMES is the first in
 * the presentational order, and this block used to record that two documents tied on both
 * `businessDate` and `createdAt` could swap which one that is between reads — arguing it failed
 * SAFE because it presents as a withdrawal rather than as a remedy that should have been withdrawn.
 * That argument was wrong on its own terms: a withdrawal manufactured out of rows that never moved
 * is noise, and this module's whole case for the fingerprint is that noise teaches an operator to
 * ignore the withdrawal that matters. The read is ordered by the primary key as a last resort, so
 * the order is TOTAL and no tie can present as movement.
 */
function fingerprintInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString()
  }
  return 'no recorded time'
}

/** The identity half of a fingerprint entry, shared by posted documents and unsettled updates. */
function describeMirroredRow(row: {
  type: string
  externalSystem: string | null
  externalId: string | null
  createdAt: unknown
}): string {
  return (
    `${row.type} ${row.externalSystem ?? 'NO-SYSTEM'}/${row.externalId ?? 'NO-EXTERNAL-ID'} ` +
    `mirrored ${fingerprintInstant(row.createdAt)}`
  )
}

export type PostedOrderDiscountClient = Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingSyncLog'>

/** The client surface the mirrored-document read alone needs. */
export type PostedInvoiceEventClient = Pick<Prisma.TransactionClient, 'accountingEvent'>

/**
 * What the POSTED sales-invoice document for this order carries, read from the mirrored events.
 *
 * Split out of `resolvePostedOrderDiscount` so the o3d-y14 backfill's operator handoff can ask the
 * SAME question the chargeback path asks, with the same refusals, rather than a second
 * near-identical derivation that could drift from it. The backfill asks it BEFORE any restatement
 * record exists (in the dry run) and immediately AFTER writing one (at apply time), so it cannot go
 * through the restatement gate that wraps this — but every rule below is common to both callers.
 */
export type PostedInvoiceOrderDiscount =
  /** The document was found and its order-level discount replayed from the connector's rule. */
  | {
      ok: true
      amount: number
      detail: string
      documentType: string
      externalId: string | null
      externalSystem: string | null
      /**
       * HOW MANY POSTED DOCUMENTS AGREED ON `amount` (o3d-y14 r8 finding 2).
       *
       * `amount` is what EACH of them carries, and agreement is all a mirroring credit note needs:
       * whichever one it reverses, it reverses this figure. It is NOT what a caller NETTING the
       * ledger needs — two agreeing invoices charged that discount TWICE, and subtracting one
       * credit-note total from one of them describes a set of documents that is not the ledger's.
       * So the count travels with the figure and the netting caller refuses on it, instead of the
       * resolver's agreement rule being silently reused as a singularity rule.
       */
      documentCount: number
      /**
       * THE EXTERNAL ID OF EVERY POSTED DOCUMENT, newest first (o3d-y14 r10 finding 2).
       *
       * `externalId` above is the NEWEST document's, and naming it is right for a refusal ("the
       * posted SALES_INVOICE INV-778 carries…") because a refusal prescribes nothing. It is NOT
       * right for anything an operator is told to go and DO: with two agreeing documents the
       * duplicate is held twice, and an instruction naming one of them leaves the other standing.
       * So every id the ledger holds travels with the figure, and the caller names all of them.
       *
       * SHORTER THAN `documentCount` when a posted event carries no external id at all (the id
       * write-back can fail after the post succeeds — o3d-9kek). The difference is the number of
       * documents that exist and cannot be named, which is a fact the caller has to state rather
       * than round away.
       */
      externalIds: string[]
      /**
       * The tax convention those documents' order-discount lines are denominated in (r8 finding 1).
       * MIXED only where several documents disagree about it.
       */
      taxBasis: PostedInvoiceTaxBasis
      /**
       * THE ROWS THIS ANSWER WAS DERIVED OVER, sorted (o3d-y14 r12 finding 1). See the fingerprint
       * block above `PostedOrderDiscountClient`. Carried on the SUCCESS variant too: two POSTED
       * documents that both record no external id agree on an amount, a count and an (empty) id
       * list, so replacing one of them moves nothing else either.
       */
      documentSet: string[]
    }
  /** No POSTED mirrored sales-invoice event exists. NOT the same as "no document exists". */
  | { ok: false; reason: 'NO_POSTED_EVENT'; documentSet: string[] }
  /** A document exists (or may) and what it carries cannot be established. Never guess past this. */
  | {
      ok: false
      reason: 'UNRECOVERABLE'
      detail: string
      /**
       * HOW MANY POSTED DOCUMENTS THE REFUSAL IS ABOUT, where that is known (o3d-y14 r10 finding 2).
       *
       * Set only by the branch that read several documents and found them in DISAGREEMENT — the one
       * refusal where the count is established. A caller that goes on to tell an operator to read
       * the figure off "the document" needs it: with two documents disagreeing there is no "the
       * document", and every branch of a read-it-then-choose ladder ends in an instrument.
       */
      documentCount?: number
      /**
       * THE EXTERNAL ID OF EVERY DISAGREEING DOCUMENT, newest first (o3d-y14 r11 finding 3).
       *
       * r10 made the SUCCESS variant's reference plural so no call site could name one of several
       * agreeing documents. The refusal kept only a COUNT — and disagreement is the case where the
       * identifiers matter MOST: agreeing documents can be reasoned about collectively, whereas
       * "2 posted documents carry different order-level discounts" tells an operator that they must
       * open the documents and nothing whatever about WHICH ones. `documentCount` minus this
       * array's length is the number that exist and record no external id (o3d-9kek), which is a
       * fact to state rather than round away — exactly as on the success variant.
       *
       * Set by the same one branch that sets `documentCount`. Absent everywhere else, and absence
       * is "not established", never "there are none".
       */
      externalIds?: string[]
      /**
       * HOW MANY POSTED DOCUMENTS THIS REFUSAL WAS DERIVED OVER, AND WHICH (o3d-y14 r13 finding 1).
       *
       * REQUIRED, like `documentSet` below and unlike the two fields above, and the difference is
       * the whole finding. `documentCount`/`externalIds` are a CLAIM — "the derivation established
       * that THESE documents DISAGREE" — which is why only the disagreement branch sets them and
       * why their absence has to keep meaning "not established". r12 declined to populate them on
       * the other refusals for exactly that reason: it would make an unreadable-payload refusal
       * render through `describeDisagreeingDocuments`, which is a FALSE statement to an operator.
       *
       * This is not a claim. It is the same category as `documentSet` — evidence, present on every
       * refusal, prescribing nothing — reduced to the two things a caller needs to STOP prescribing
       * against "the document": how many posted documents are in the ledger for this order, and
       * which of them can be named. The unreadable-payload and unsettled-update refusals leave
       * `documentCount` null BY DESIGN while the ledger may hold several posted invoices, and a
       * caller reading null as "one" told the operator to open "the document", read its
       * order-level discount line and raise a further invoice or credit the difference — for a set
       * of documents with no "the".
       *
       * `count` minus `externalIds.length` is the number that exist and record no external id
       * (o3d-9kek), exactly as on the success variant.
       */
      postedDocuments: { count: number; externalIds: string[] }
      /**
       * THE ROWS THIS REFUSAL WAS DERIVED OVER, sorted (o3d-y14 r12 finding 1).
       *
       * REQUIRED here, unlike the two fields above, and that difference is the finding. Those two
       * are a CLAIM the derivation makes about a document set it established, so their absence has
       * to keep meaning "not established" — a caller renders `describeDisagreeingDocuments` from
       * them. This is not a claim and prescribes nothing: it is the evidence the answer was computed
       * from, it exists on every branch, and its whole job is to make "the same refusal about a
       * different set of rows" impossible to mistake for "nothing moved".
       */
      documentSet: string[]
    }

export async function readPostedInvoiceOrderDiscount(
  client: PostedInvoiceEventClient,
  order: { id: string; currency: string },
): Promise<PostedInvoiceOrderDiscount> {
  // An invoice UPDATE that never settled. Under `@@unique([externalSystem, externalId])` this is
  // exactly what a SUCCESSFUL update leaves behind (see the header), so it cannot be read as "the
  // update never happened" and the original invoice's event cannot be trusted to describe the
  // document as it now stands.
  //
  // READ AS ROWS, not counted (r12 finding 1). The refusal below states a COUNT, so an update
  // settling to VOID while another arrives leaves it word-for-word identical; the rows themselves go
  // into the fingerprint, where that swap is visible.
  const unsettledUpdates = (await client.accountingEvent.findMany({
    where: {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: order.id,
      type: 'SALES_INVOICE_UPDATE',
      status: { notIn: [...SETTLED_INVOICE_UPDATE_EVENT_STATUSES] },
    },
    // TOTAL, like the posted read below (r13 finding 2). Nothing downstream of this read depends on
    // the order today — its refusal states a COUNT and its fingerprint entries are sorted — and the
    // tie-break is here so that nothing can start depending on an order that is not total.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { type: true, status: true, externalSystem: true, externalId: true, createdAt: true },
  })) as UnsettledInvoiceUpdate[]

  // READ EVEN WHEN THE UPDATES ALREADY REFUSE (r12 finding 1). The refusal above is reached before
  // the posted documents are consulted at all, so without this the whole posted set could be
  // replaced underneath an identical sentence. It decides nothing on that branch; it is evidence.
  const documents = (await client.accountingEvent.findMany({
    where: {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: order.id,
      type: { in: [...POSTED_SALES_INVOICE_EVENT_TYPES] },
      status: POSTED_ACCOUNTING_EVENT_STATUS,
    },
    // PRESENTATIONAL, AND TOTAL (o3d-y14 r13 finding 2).
    //
    // It decides no amount — every posted document must AGREE below — but it decides which document
    // every refusal and every success NAMES, and r11 finding 1 made those names part of a VALUE that
    // is compared before a remedy is printed. `businessDate desc, createdAt desc` is not a total
    // order: two POSTED documents tied on BOTH columns may come back either way round, and then
    // "a SALES_INVOICE was posted for this order but <the newest one's reason>" and the disagreement
    // refusal's id list swap between two reads of rows that never moved. That presents as a
    // WITHDRAWAL — a spurious one, of exactly the kind this module argues teaches operators to
    // ignore withdrawals.
    //
    // `id` is the primary key, so appending it makes the order total and the presentation
    // reproducible. It is NOT thereby fit to be SHOWN to anyone (the fingerprint block above is
    // explicit that a surrogate id means nothing to an operator); it is a deterministic last
    // resort for two rows that are otherwise indistinguishable to the ordering, and it is read by
    // nothing but this ORDER BY.
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      type: true,
      status: true,
      currency: true,
      externalSystem: true,
      externalId: true,
      createdAt: true,
      linesJson: true,
    },
  })) as MirroredDocument[]

  const amounts: number[] = []
  const bases: PostedDocumentTaxBasis[] = []
  const postedEntries: string[] = []
  // The FIRST failure in the presentational order, which is the one the refusal has always named.
  // Recorded rather than returned on, because r12 finding 1 needs every document READ: with the
  // first one unreadable, a second going bad — or its amount moving under a re-mirror — used to be
  // invisible in every field the re-validation compares.
  let firstFailure: { type: string; detail: string } | null = null
  for (const document of documents) {
    const read = readPostedDocumentDiscount(document, order.currency)
    postedEntries.push(
      `POSTED ${describeMirroredRow(document)} ${document.currency} ` +
        (read.ok
          ? `carries ${read.amount} ${order.currency} (${read.taxBasis})`
          : `UNREADABLE: ${read.detail}`),
    )
    if (!read.ok) {
      firstFailure ??= { type: document.type, detail: read.detail }
      continue
    }
    amounts.push(read.amount)
    bases.push(read.taxBasis)
  }
  // SORTED across both kinds of row, so the same rows read twice fingerprint identically whatever
  // order either query returns them in. NOT de-duplicated: two identical documents are two
  // documents.
  const documentSet = [
    ...postedEntries,
    ...unsettledUpdates.map((update) => `UNSETTLED ${describeMirroredRow(update)} status ${update.status}`),
  ].sort()
  // Newest first, in the order the documents were read — the same order the success variant reports.
  const externalIds = documents.map((document) => document.externalId).filter((id): id is string => id !== null)
  // r13 finding 1. The POSTED DOCUMENT SET, carried by every refusal, so no caller has to read a
  // null disagreement count as "one document". Computed before the first refusal below rather than
  // beside the one branch that claims a disagreement — it is evidence about the ledger, and every
  // branch here is about the same ledger.
  const postedDocuments = { count: documents.length, externalIds }

  if (unsettledUpdates.length > 0) {
    return {
      ok: false,
      reason: 'UNRECOVERABLE',
      detail:
        `${unsettledUpdates.length} SALES_INVOICE_UPDATE event(s) for this order never reached POSTED — ` +
        'which is the state an update that DID modify the ledger document is left in, because it ' +
        'cannot record its own external id against the original invoice event',
      postedDocuments,
      documentSet,
    }
  }

  if (documents.length === 0) return { ok: false, reason: 'NO_POSTED_EVENT', documentSet }

  if (firstFailure) {
    return {
      ok: false,
      reason: 'UNRECOVERABLE',
      detail: `a ${firstFailure.type} was posted for this order but ${firstFailure.detail}`,
      postedDocuments,
      documentSet,
    }
  }
  // SORTED, so the refusal below reads the same on every re-read of the same rows. The netting and
  // the revalidation compare these refusals as VALUES (r11 finding 1), and a message whose numbers
  // arrive in row order would report a ledger that "moved" whenever the query came back the other
  // way round. Sorting decides nothing here — the success path needs exactly one distinct amount.
  const distinct = [...new Set(amounts)].sort((left, right) => left - right)
  if (distinct.length > 1) {
    // r11 finding 3. The identifiers travel with the refusal: an operator told that several
    // documents disagree can do nothing at all with that unless they know which ones to open.
    const unnamed = documents.length - externalIds.length
    const named = [
      externalIds.length ? externalIds.join(', ') : null,
      unnamed > 0 ? `${unnamed} that record NO external id and cannot be named from here` : null,
    ]
      .filter(Boolean)
      .join(', and ')
    return {
      ok: false,
      reason: 'UNRECOVERABLE',
      detail:
        `${documents.length} posted documents exist for this order (${named}) and they carry ` +
        `different order-level discounts (${distinct.join(', ')} ${order.currency}); nothing here ` +
        'says which one a credit note now reverses',
      // THE CLAIM: these documents were read and they disagree. Only this branch may make it.
      documentCount: documents.length,
      externalIds,
      // AND THE EVIDENCE, which every refusal carries. They coincide here — this is the one refusal
      // whose claim is about the whole posted set — and they are still two different statements:
      // a caller that renders "N DISAGREEING documents" must read the first, and a caller that only
      // needs to know whether "the document" exists must read the second (r13 finding 1).
      postedDocuments,
      documentSet,
    }
  }
  const [newest] = documents
  const amount = distinct[0]
  const distinctBases = [...new Set(bases)]
  return {
    ok: true,
    amount,
    detail:
      `the posted ${newest.type}${newest.externalId ? ` ${newest.externalId}` : ''} carries an ` +
      `order-level discount of ${amount} ${order.currency}`,
    documentType: newest.type,
    externalId: newest.externalId,
    externalSystem: newest.externalSystem,
    documentCount: documents.length,
    // Newest first, in the same order the documents were read. r10 finding 2.
    externalIds,
    taxBasis: distinctBases.length === 1 ? distinctBases[0] : 'MIXED',
    documentSet,
  }
}

/**
 * What order-level discount the ledger document for this order actually carries.
 *
 * The three outcomes are the caller's three obligations: mirror the order (nothing was restated, or
 * nothing has posted), mirror the document (the two disagree and the document is what the credit
 * note reverses), or refuse and hand it to a human.
 */
export async function resolvePostedOrderDiscount(
  client: PostedOrderDiscountClient,
  order: {
    id: string
    currency: string
    /** `SalesOrder.discountAmount`, in the order's own currency and tax convention. */
    discountAmount: number
    /** `SalesOrder.discountRestatement`. NULL proves the backfill never restated this row. */
    discountRestatement: unknown
    accountingInvoiceId: string | null
  },
): Promise<PostedOrderDiscount> {
  const restatement = readDiscountRestatement(order.discountRestatement)
  if (!restatement.present) {
    // Not "no discount model exists for WooCommerce orders" — the backfill's correction and its
    // marker are ONE update, so an unmarked row is one the backfill has never restated.
    return {
      source: 'ORDER',
      amount: order.discountAmount,
      detail: 'this order carries no restatement record, so nothing has rewritten its order-level discount',
    }
  }
  if (!restatement.ok) {
    // Damaged marker. It is NOT read as "never restated": that is the one conclusion an unreadable
    // record must not be able to produce.
    return {
      source: 'UNRECOVERABLE',
      detail: `this order carries a discount-restatement record that cannot be read (${restatement.detail})`,
    }
  }

  // THE SAME READ THE o3d-y14 OPERATOR HANDOFF USES (`readPostedInvoiceOrderDiscount`). One
  // implementation, so "what the document carries" cannot mean two different things depending on
  // which caller asks — the backfill tells an operator to alter a document on the strength of this
  // answer, and a chargeback declines to auto-raise a credit note on the strength of the same one.
  const document = await readPostedInvoiceOrderDiscount(client, order)
  if (!document.ok && document.reason === 'UNRECOVERABLE') {
    return { source: 'UNRECOVERABLE', detail: document.detail }
  }
  if (document.ok) {
    return {
      source: 'POSTED_DOCUMENT',
      amount: document.amount,
      detail: document.detail,
      documentType: document.documentType,
      externalId: document.externalId,
      externalSystem: document.externalSystem,
    }
  }

  // No mirrored document — which is NOT evidence that no document exists. The mirror is best-effort
  // (a mirroring failure is logged and the enqueue still commits), and invoices posted before
  // mirroring existed never had one. So every other trace is checked, and where they are all silent
  // the answer comes from the restatement record rather than from their silence.
  if (order.accountingInvoiceId) {
    return {
      source: 'UNRECOVERABLE',
      detail:
        `this order is linked to invoice ${order.accountingInvoiceId} but no posted accounting event ` +
        'records what that document charged',
    }
  }
  // o3d-9kek: a post can succeed and never write its id back, so the column alone under-reports.
  const postedButUnlinked = await client.accountingSyncLog.count({
    where: {
      referenceType: 'SalesOrder',
      referenceId: order.id,
      type: { in: [...POSTED_SALES_INVOICE_EVENT_TYPES] },
      status: { in: ['SYNCED'] },
      externalTransactionId: { not: null },
    },
  })
  if (postedButUnlinked > 0) {
    return {
      source: 'UNRECOVERABLE',
      detail:
        `${postedButUnlinked} posted sales invoice(s) exist for this order with no accountingInvoiceId ` +
        'written back, and no posted accounting event records what they charged',
    }
  }

  // r4 finding 1. Everything above can be absent while a real invoice stands — the back-reference
  // write can fail and retention DELETES the SYNCED sync log — so their silence decides nothing.
  // The restatement record is the one statement about that moment that nothing prunes.
  if (restatementHadPostedInvoice(restatement.value)) {
    const evidence = [
      restatement.value.ledger.accountingInvoiceId
        ? `invoice ${restatement.value.ledger.accountingInvoiceId}`
        : null,
      restatement.value.ledger.postedInvoiceExternalIds.length
        ? `unlinked invoice(s) ${restatement.value.ledger.postedInvoiceExternalIds.join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    return {
      source: 'UNRECOVERABLE',
      detail:
        `this order's order-level discount was restated on ${restatement.value.at} from ` +
        `${restatement.value.from} to ${restatement.value.to} ${restatement.value.currency} while ` +
        `${evidence} was already in the ledger, and no readable posted accounting event records what ` +
        'that document charged',
    }
  }

  return {
    source: 'ORDER',
    amount: order.discountAmount,
    detail:
      `no sales invoice existed for this order when its order-level discount was restated on ` +
      `${restatement.value.at}, and none has been recorded since — so no earlier document carries a ` +
      'different figure',
  }
}

/**
 * What a chargeback may do with a resolved posted discount.
 *
 * Split out of `raiseChargebackForReversedOrder` so the rule is testable without standing up a
 * server action, a permission check and the whole refund service — the same reason
 * `buildChargebackRefundLines` and `handleDetectedReversal` are pure.
 */
export type ChargebackOrderDiscountDecision =
  /** Safe to auto-raise: the order and the posted document say the same thing (or nothing posted). */
  | { action: 'MIRROR'; amount: number; source: PostedOrderDiscount['source']; detail: string }
  /** A human must raise this credit note. Both figures are carried so the alert can name them. */
  | {
      action: 'MANUAL'
      reason: 'POSTED_FIGURE_UNRECOVERABLE' | 'RESTATED_AFTER_POSTING'
      detail: string
      orderAmount: number
      postedAmount: number | null
      documentType: string | null
      externalId: string | null
    }

export function decideChargebackOrderDiscount(input: {
  posted: PostedOrderDiscount
  /** `SalesOrder.discountAmount`, the figure the chargeback used to mirror unconditionally. */
  orderDiscountAmount: number
}): ChargebackOrderDiscountDecision {
  const { posted, orderDiscountAmount } = input

  if (posted.source === 'UNRECOVERABLE') {
    return {
      action: 'MANUAL',
      reason: 'POSTED_FIGURE_UNRECOVERABLE',
      detail: posted.detail,
      orderAmount: orderDiscountAmount,
      postedAmount: null,
      documentType: null,
      externalId: null,
    }
  }

  if (posted.source === 'POSTED_DOCUMENT' && posted.amount !== orderDiscountAmount) {
    // The o3d-y14-corrected legacy order. Reversing `orderDiscountAmount` omits a discount leg the
    // invoice charged and over-credits by the difference; reversing `posted.amount` under-credits by
    // the same difference if the manual ledger adjustment the backfill asked for has already been
    // made — and which of those two worlds this is happens in the accounting system, not here.
    return {
      action: 'MANUAL',
      reason: 'RESTATED_AFTER_POSTING',
      detail: posted.detail,
      orderAmount: orderDiscountAmount,
      postedAmount: posted.amount,
      documentType: posted.documentType,
      externalId: posted.externalId,
    }
  }

  return { action: 'MIRROR', amount: posted.amount, source: posted.source, detail: posted.detail }
}
