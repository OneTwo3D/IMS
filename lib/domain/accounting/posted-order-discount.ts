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
 *     available here says which is current, so this REFUSES.
 *
 * WHEN IT CANNOT BE RECOVERED. Every branch that cannot establish the figure reports UNRECOVERABLE,
 * and the caller refuses and surfaces — which is what that path already does for the other cases
 * where the remaining balance is ambiguous (prior refunds, no discount account configured).
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
  linesJson: unknown
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
): { ok: true; amount: number } | { ok: false; detail: string } {
  const payload = document.linesJson
  if (!isRecord(payload) || payload.kind !== 'accounting-document') {
    return { ok: false, detail: 'the mirrored event does not carry a document payload' }
  }
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
    return { ok: true, amount: 0 }
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
  if (amount === 0) return { ok: true, amount: 0 }

  const accountCode = typeof payload.discount.accountCode === 'string' && payload.discount.accountCode.trim()
    ? payload.discount.accountCode.trim()
    : undefined
  return postedDiscountForConnector(document.externalSystem, amount, accountCode)
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
    }
  /** No POSTED mirrored sales-invoice event exists. NOT the same as "no document exists". */
  | { ok: false; reason: 'NO_POSTED_EVENT' }
  /** A document exists (or may) and what it carries cannot be established. Never guess past this. */
  | { ok: false; reason: 'UNRECOVERABLE'; detail: string }

export async function readPostedInvoiceOrderDiscount(
  client: PostedInvoiceEventClient,
  order: { id: string; currency: string },
): Promise<PostedInvoiceOrderDiscount> {
  // An invoice UPDATE that never settled. Under `@@unique([externalSystem, externalId])` this is
  // exactly what a SUCCESSFUL update leaves behind (see the header), so it cannot be read as "the
  // update never happened" and the original invoice's event cannot be trusted to describe the
  // document as it now stands.
  const unsettledUpdates = await client.accountingEvent.count({
    where: {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: order.id,
      type: 'SALES_INVOICE_UPDATE',
      status: { notIn: [...SETTLED_INVOICE_UPDATE_EVENT_STATUSES] },
    },
  })
  if (unsettledUpdates > 0) {
    return {
      ok: false,
      reason: 'UNRECOVERABLE',
      detail:
        `${unsettledUpdates} SALES_INVOICE_UPDATE event(s) for this order never reached POSTED — which ` +
        'is the state an update that DID modify the ledger document is left in, because it cannot ' +
        'record its own external id against the original invoice event',
    }
  }

  const documents = (await client.accountingEvent.findMany({
    where: {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: order.id,
      type: { in: [...POSTED_SALES_INVOICE_EVENT_TYPES] },
      status: POSTED_ACCOUNTING_EVENT_STATUS,
    },
    // PRESENTATIONAL ONLY — the newest document names the refusal or the recovery in the operator's
    // message. It decides no amount: every posted document must AGREE below, so no ordering
    // guarantee is being relied on (and, per the header, none exists).
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
    select: { type: true, status: true, currency: true, externalSystem: true, externalId: true, linesJson: true },
  })) as MirroredDocument[]

  if (documents.length === 0) return { ok: false, reason: 'NO_POSTED_EVENT' }

  const amounts: number[] = []
  for (const document of documents) {
    const read = readPostedDocumentDiscount(document, order.currency)
    if (!read.ok) {
      return {
        ok: false,
        reason: 'UNRECOVERABLE',
        detail: `a ${document.type} was posted for this order but ${read.detail}`,
      }
    }
    amounts.push(read.amount)
  }
  const distinct = [...new Set(amounts)]
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: 'UNRECOVERABLE',
      detail:
        `${documents.length} posted documents exist for this order and they carry different ` +
        `order-level discounts (${distinct.join(', ')} ${order.currency}); nothing here says which ` +
        'one a credit note now reverses',
    }
  }
  const [newest] = documents
  const amount = distinct[0]
  return {
    ok: true,
    amount,
    detail:
      `the posted ${newest.type}${newest.externalId ? ` ${newest.externalId}` : ''} carries an ` +
      `order-level discount of ${amount} ${order.currency}`,
    documentType: newest.type,
    externalId: newest.externalId,
    externalSystem: newest.externalSystem,
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
