/**
 * QuickBooks Online payment detection polling.
 * Polls QBO for recently paid invoices and bills, updating IMS records.
 * Mirrors lib/connectors/xero/payment-poller.ts.
 */

import { db } from '@/lib/db'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import {
  detectPaymentReversals,
  readDatabaseLedgerFence,
  readPaidProvenanceVerdicts,
} from '@/lib/domain/accounting/payment-reversal'
import {
  zeroPaidIsProvenReversal,
  type LedgerReadFence,
  type RegisteredPaymentVerdict,
} from '@/lib/connectors/xero/invoice-delta'
import {
  closeWithheldMarker,
  deferWithheldMarker,
  dueWithheldMarkers,
  openWithheldDocuments,
  withheldEntityKey,
  WITHHELD_RECHECK_BATCH,
} from '@/lib/domain/accounting/withheld-reversal-markers'
import { qboQuery } from './api'
import { getSettingValue } from '@/lib/settings-store'

const LAST_POLL_KEY = 'quickbooks_last_payment_poll'

/** A QuickBooks reversal can only ever speak about rows QuickBooks itself issued. */
const QUICKBOOKS_CONNECTOR = 'quickbooks'

/**
 * Whose withheld-reversal markers this poller owns.
 *
 * `legacyOwner: false` — markers written before the connector key existed belong to XERO, which is the
 * only poller that had a recheck at all until o3d-psrx r4. Claiming them here would send QuickBooks
 * asking about Xero invoice ids for ever.
 */
const QBO_MARKER_SCOPE = { connector: QUICKBOOKS_CONNECTOR, legacyOwner: false } as const

type QboInvoice = {
  Id: string
  Balance: number
  /** o3d-psrx r4: a VOIDED document is zeroed rather than deleted, which is how the by-id read sees it. */
  TotalAmt?: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboBill = {
  Id: string
  Balance: number
  TotalAmt?: number
  MetaData?: { LastUpdatedTime?: string }
}

type QboQueryResponse<T> = {
  QueryResponse: Record<string, T[] | undefined>
}

type QboEntityId = { Id: string }

/**
 * Split the QBO transactions that regressed out of the fully-paid state into the
 * full reversed set and the subset that was VOIDED. Mirrors the Xero poller's
 * {all, voided} contract (audit-M-acct #3 / scjz.71):
 *  - balanceDueEntities: invoices/bills whose Balance returned to > 0 (the payment
 *    was deleted/un-applied but the document is still live) — eligible for a
 *    revenue chargeback on the sales side.
 *  - voidedEntities: invoices/bills QBO zeroed out (TotalAmt = 0). QBO has already
 *    reversed their AR/revenue, so paidAt is cleared but NO chargeback is raised
 *    (a separate credit note would double-reverse).
 * Pure set union so it can be unit-tested without the QBO API.
 */
export function classifyQboReversals(
  balanceDueEntities: QboEntityId[],
  voidedEntities: QboEntityId[],
): { all: Set<string>; voided: Set<string> } {
  const all = new Set<string>()
  const voided = new Set<string>()
  for (const e of balanceDueEntities) all.add(e.Id)
  for (const e of voidedEntities) {
    all.add(e.Id)
    voided.add(e.Id)
  }
  return { all, voided }
}

// QBO equivalent of Xero's fetchReversedInvoiceIds. An IMS-paid document (Balance
// was 0) is "reversed" if, modified since the last poll, its QBO transaction now
// has Balance > 0 (payment removed) or TotalAmt = 0 (voided/zeroed). Returns null
// if either query failed so the caller can hold the poll watermark and retry.
async function fetchReversedEntityIds(
  entity: 'Invoice' | 'Bill',
  since: string,
): Promise<{ all: Set<string>; voided: Set<string>; ledgerObservedBefore: LedgerReadFence | null } | null> {
  // o3d-psrx r3 — THE FENCE IS MINTED HERE, AND HERE IS BEFORE THE LEDGER IS ASKED.
  //
  // It is read inside this function rather than by the caller for one reason: the ordering that makes
  // the fence sound is PROGRAM ORDER — this statement running before `qboQuery` — and a fence passed
  // in from elsewhere is a fence whose ordering nobody in this file can see. Null is a legitimate
  // answer (the database clock could not be read) and it decides NOTHING, which withholds every
  // reversal that has a registration to weigh.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  const [balanceRes, voidedRes] = await Promise.all([
    qboQuery<QboQueryResponse<QboEntityId>>(entity, `Balance > '0' AND MetaData.LastUpdatedTime > '${since}'`),
    qboQuery<QboQueryResponse<QboEntityId>>(entity, `TotalAmt = '0' AND MetaData.LastUpdatedTime > '${since}'`),
  ])
  if (!balanceRes.ok || !voidedRes.ok) return null
  const balanceDue = balanceRes.data?.QueryResponse?.[entity] ?? []
  const voided = voidedRes.data?.QueryResponse?.[entity] ?? []
  return { ...classifyQboReversals(balanceDue, voided), ledgerObservedBefore }
}

/**
 * THE SAME QUESTION, ASKED ABOUT NAMED DOCUMENTS INSTEAD OF A TIME WINDOW (o3d-psrx r4 / o3d-a6i2).
 *
 * `fetchReversedEntityIds` above is the DELTA read: it asks which documents regressed since the
 * watermark, and it is what the watermark is for. This one asks about a LIST OF IDS and is deliberately
 * independent of the cursor — because the documents it is for are the ones the cursor has already moved
 * past, and the thing that will settle them is usually not a QuickBooks change at all (a PENDING
 * registration finishing, a FAILED one being cancelled, a database fence that failed once).
 *
 * ONE CLASSIFICATION, NOT A SECOND ONE WORDED LIKE IT: the two populations are split by
 * `classifyQboReversals`, exactly as the delta read splits them. What differs is only which documents
 * were asked about, which is the whole point.
 *
 * `returned` is the third answer this read gives and the delta read cannot: WHICH of the ids QuickBooks
 * actually answered about. A document that did not come back has not been reconsidered, and "we did not
 * hear" must never be spent as "there is nothing left to decide".
 *
 * Null on any failed query, so the caller closes nothing and every marker stays due.
 */
async function fetchReversedEntityIdsByIds(
  entity: 'Invoice' | 'Bill',
  ids: readonly string[],
): Promise<{ all: Set<string>; voided: Set<string>; returned: Set<string>; ledgerObservedBefore: LedgerReadFence | null } | null> {
  // Minted BEFORE the ledger is asked, for the reason `fetchReversedEntityIds` gives: the ordering is
  // PROGRAM ORDER, and one fence covering several batches only ever decides FEWER registrations.
  const ledgerObservedBefore = await readDatabaseLedgerFence()
  const balanceDue: QboEntityId[] = []
  const voided: QboEntityId[] = []
  const returned = new Set<string>()
  for (let i = 0; i < ids.length; i += WITHHELD_RECHECK_BATCH) {
    const batch = ids.slice(i, i + WITHHELD_RECHECK_BATCH)
    // Single-quoted ids, and ids that could break out of the quoting are refused rather than escaped:
    // an `accountingInvoiceId` is a QuickBooks-issued numeric id, and anything else in that column is
    // not a document this read can ask about.
    const safe = batch.filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
    if (safe.length === 0) continue
    const res = await qboQuery<QboQueryResponse<QboInvoice | QboBill>>(
      entity, `Id IN (${safe.map((id) => `'${id}'`).join(', ')})`,
    )
    if (!res.ok) return null
    for (const row of res.data?.QueryResponse?.[entity] ?? []) {
      returned.add(row.Id)
      // The same two predicates the delta read expresses as `Balance > '0'` and `TotalAmt = '0'`.
      if (typeof row.Balance === 'number' && row.Balance > 0) balanceDue.push({ Id: row.Id })
      if (typeof row.TotalAmt === 'number' && row.TotalAmt === 0) voided.push({ Id: row.Id })
    }
  }
  return { ...classifyQboReversals(balanceDue, voided), returned, ledgerObservedBefore }
}

/**
 * o3d-psrx r3 (Codex HIGH) — THE PROVENANCE GATE, APPLIED TO WHATEVER QUICKBOOKS SAYS REGRESSED.
 *
 * THE DEFECT. r2 established that a paid sale IMS never told the ledger about must not be reversed,
 * and wired it into the Xero poller. This poller's reversal candidate query selected neither
 * `unregisteredPaidAt` nor any receipt/registration evidence, so every recently modified balance-due
 * invoice walked straight into reversal handling. A native order marked paid through
 * `markSalesOrderPaid` has no shopping link, sets the marker, and by design creates no ledger
 * payment — it satisfied that query exactly, and IMS's deliberate non-registration read as a removed
 * payment: chargeback credit note raised, `paidAt` cleared, against a customer who paid.
 *
 * ONE DECISION, NOT A SECOND ONE WORDED LIKE IT. `readPaidProvenanceVerdicts` and
 * `zeroPaidIsProvenReversal` are the SAME functions the Xero poller reaches its verdict with. The
 * only connector-shaped argument is `ledgerListedPaymentIds`, and QuickBooks' answer to that is
 * always NULL: the reversal read asks which invoice ids regressed and nothing else, so this poller
 * cannot enumerate the payments a document carries. Null means "absence cannot be established from
 * this payload", NOT "no payments" — so GONE and STILL_HELD are unreachable here and a document with
 * a posted registration lands on LEDGER_DID_NOT_LIST_PAYMENTS.
 *
 * WHICH DIRECTION THIS MOVES. Every verdict `zeroPaidIsProvenReversal` admits was already reversed
 * before this gate existed, so no reversal this poller used to make is lost. What it adds is
 * withholding for the three states that used to reverse wrongly: the paid flag with no ledger
 * receipt behind it (PAID_WITHOUT_LEDGER_RECEIPT), a local receipt not yet registered
 * (RECEIPT_NOT_REGISTERED), and a registration this read cannot speak for (REGISTRATION_UNDECIDED).
 *
 * A RESIDUAL THIS DOES NOT CLOSE, stated so nobody reads it as closed: `Balance > 0` covers a PART
 * payment as well as a removed one, and this poller does not read the amounts to tell them apart.
 * Xero's poller does (`partitionPaymentReversals`). That is a different defect from the one Codex
 * found and it is filed separately; nothing here makes it worse.
 */
export type QboReversalGate<T> = {
  /** Reversal may proceed: the evidence proves the payment is gone, or there was never one of ours. */
  admitted: T[]
  /** Reversal WITHHELD — `paidAt` is left set and reported, never cleared on unproven evidence. */
  withheld: Array<{ doc: T; verdict: RegisteredPaymentVerdict }>
}

export async function gateQboReversalsOnProvenance<T extends { id: string; accountingInvoiceId: string | null; unregisteredPaidAt?: Date | null }>(
  candidates: T[],
  params: {
    registrationType: 'BILL_PAYMENT' | 'INVOICE_PAYMENT'
    referenceType: 'PurchaseInvoice' | 'SalesOrder'
    ledgerObservedBefore: LedgerReadFence | null
  },
): Promise<QboReversalGate<T>> {
  const gate: QboReversalGate<T> = { admitted: [], withheld: [] }
  if (candidates.length === 0) return gate
  const verdicts = await readPaidProvenanceVerdicts(candidates, {
    connector: QUICKBOOKS_CONNECTOR,
    registrationType: params.registrationType,
    referenceType: params.referenceType,
    ledgerObservedBefore: params.ledgerObservedBefore,
    // QuickBooks' reversal read enumerates no payments. See the header — null is not emptiness.
    ledgerListedPaymentIds: () => null,
  })
  for (const doc of candidates) {
    const verdict = verdicts.get(doc.id)
    // NO VERDICT IS NOT A PASS. An absence means nothing was decided about this document, and the
    // fail-closed reading of "nothing was decided" is the same one a null fence gets: withhold.
    if (verdict == null) {
      gate.withheld.push({ doc, verdict: { verdict: 'REGISTRATION_UNDECIDED', entryIds: [] } })
      continue
    }
    if (zeroPaidIsProvenReversal(verdict)) gate.admitted.push(doc)
    else gate.withheld.push({ doc, verdict })
  }
  return gate
}

/** Why a withheld reversal was withheld, in words an operator can act on. */
export function qboWithheldReversalReason(verdict: RegisteredPaymentVerdict): string {
  switch (verdict.verdict) {
    case 'PAID_WITHOUT_LEDGER_RECEIPT':
      return 'IMS holds this as paid from a channel or an operator, and no payment was ever registered '
        + 'with QuickBooks for it. QuickBooks showing a balance due is IMS\'s own silence, not a removed '
        + 'payment, so paidAt was LEFT SET and no chargeback credit note was raised. If the payment '
        + 'really was reversed, unwind it by hand.'
    case 'RECEIPT_NOT_REGISTERED':
      return `IMS has recorded a receipt (${verdict.paymentIds.join(', ')}) that has not been registered `
        + 'with QuickBooks yet, so the balance due is a payment of OURS that has not landed rather than '
        + 'one taken away. paidAt was LEFT SET; IMS will decide this itself once the registration posts.'
    case 'REGISTRATION_UNDECIDED':
      return `IMS holds a payment registration (${verdict.entryIds.join(', ') || 'clock unreadable'}) that `
        + 'this QuickBooks read cannot speak for, so the balance due may be a payment of ours still in '
        + 'flight. paidAt was LEFT SET rather than guessed.'
    case 'STILL_HELD':
      return `QuickBooks still lists the payment IMS registered (${verdict.paymentIds.join(', ')}) on a `
        + 'document it reports as unpaid. That contradiction is not proof of a reversal, so paidAt was '
        + 'LEFT SET. Reconcile the document in QuickBooks.'
    // o3d-psrx r7 (Codex HIGH 1). REACHABLE FROM THIS CONNECTOR, and by the route the header above
    // describes: QuickBooks enumerates no payments, so a document with a posted registration lands on
    // LEDGER_DID_NOT_LIST_PAYMENTS — which `zeroPaidIsProvenReversal` ADMITS. A £1 registration on a
    // £100 order marked paid off-ledger therefore reversed the whole £100 here exactly as it did on
    // the Xero side, and the guard that stops it lives in the shared classifier for that reason.
    case 'PART_COVERED_OFF_LEDGER':
      return `IMS holds this as paid on evidence QuickBooks was never given, and the payment `
        + `registration(s) it did raise `
        + `${verdict.registeredTotal == null
          ? 'do not record how much they sent'
          : `cover only ${verdict.registeredTotal} of the order's ${verdict.documentTotal} total`}. `
        + `A balance due is therefore an account of PART of this order; the rest of it was never in `
        + `QuickBooks to be removed. paidAt was LEFT SET and no chargeback credit note was raised. `
        + `Record the remaining receipt, or unwind the order by hand if the payment is genuinely gone.`
    case 'GONE':
    case 'NOTHING_REGISTERED':
    case 'LEDGER_DID_NOT_LIST_PAYMENTS':
      // Not reachable — these are the admitted verdicts. Stated rather than defaulted so a new
      // verdict added to the union is a type error here instead of a silent generic sentence.
      return 'Reversal was admitted; no reason to report.'
  }
}

/**
 * THE SALES REVERSAL CANDIDATES, AS ONE CALLABLE STEP (o3d-psrx r3, Codex HIGH).
 *
 * Lifted out of `pollQuickBooksPayments` for the same reason `readSalesResidualVerdicts` was lifted
 * out of the Xero poller: the defect Codex found was a break in the wiring from the DATABASE ROW to
 * the VERDICT — the poller asked a question the row could answer and never selected the column that
 * answers it — and a test that rebuilt the query by hand would have sailed straight over it. This is
 * the poller's OWN query, and tests/concurrency/qbo-paid-provenance-reversal.concurrent.test.ts calls
 * THIS and feeds it to the SAME gate production feeds it to, against a real PostgreSQL and with no
 * QuickBooks call anywhere.
 */
export async function readQboSalesReversalCandidates() {
  return await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: { not: null },
      shoppingLinks: { none: {} },
    },
    select: {
      id: true,
      accountingInvoiceId: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      revenueDeferredDate: true,
      // o3d-psrx r3 (Codex HIGH): WHERE this order's paid flag came from. Selected with `paidAt`'s own
      // candidates because the reversal verdict turns on it — see gateQboReversalsOnProvenance.
      // Leaving it out is the defect itself: every verdict then reads as NOTHING_REGISTERED and a sale
      // an operator marked paid by hand is reversed with a chargeback credit note against it.
      unregisteredPaidAt: true,
    },
  })
}

/** The bill reversal candidates, same reasoning. A bill carries no provenance column (o3d-a3wx). */
export async function readQboBillReversalCandidates() {
  return await db.purchaseInvoice.findMany({
    where: { accountingInvoiceId: { not: null }, paidAt: { not: null } },
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
  })
}

export type QboSalesReversalDoc = Awaited<ReturnType<typeof readQboSalesReversalCandidates>>[number]
export type QboBillReversalDoc = Awaited<ReturnType<typeof readQboBillReversalCandidates>>[number]

/**
 * THE DURABLE RECORD OF A WITHHELD REVERSAL, AND THE THING THAT BRINGS IT BACK (o3d-psrx r4).
 *
 * Before r4 this was `logActivity` — fire and forget — and the poll checkpointed regardless. That was
 * the whole of Codex's second finding: QuickBooks selects candidates only where `LastUpdatedTime`
 * exceeds the watermark, so a withheld document whose cause resolves LOCALLY (a PENDING registration
 * finishing, a FAILED one cancelled, a database fence that failed once) was never asked about again.
 *
 * Two things changed, and they are different things:
 *
 *   THE ROW IS THE WORK ITEM. It carries `connector` so `openWithheldDocuments` can claim it, and its
 *   `createdAt` is the recheck timer. Writing it again is what restarts that timer.
 *   A ROW THAT DID NOT LAND HOLDS THE WATERMARK. This is the one case where holding the cursor is
 *   right and not a freeze: with no marker there is nothing to bring the document back at all, so the
 *   delta window is the only remaining route to it. (A marker that DID land never holds the cursor —
 *   see the note at the withheld loop.)
 */
async function signalWithheldQboReversal(entry: {
  entityType: 'SALES_ORDER' | 'PURCHASE_ORDER'
  entityId: string
  action: 'payment_reversal_withheld' | 'bill_payment_reversal_withheld'
  description: string
  accountingInvoiceId: string | null
  verdict: RegisteredPaymentVerdict
}): Promise<boolean> {
  return await logActivityPersisted({
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    tag: 'sync',
    level: 'WARNING',
    description: entry.description,
    metadata: {
      // o3d-psrx r4: WHOSE marker this is. The Xero poller writes the same action names, and a recheck
      // that claimed the other connector's rows would ask the wrong ledger about the wrong ids.
      connector: QUICKBOOKS_CONNECTOR,
      registrationVerdict: entry.verdict.verdict,
      accountingInvoiceId: entry.accountingInvoiceId,
    },
    resolveUser: false,
  })
}

function qboSalesWithheldDescription(order: QboSalesReversalDoc, verdict: RegisteredPaymentVerdict): string {
  return `QuickBooks reports a balance due on order ${order.orderNumber ?? order.externalOrderNumber} `
    + `(status: ${order.status}), but the payment reversal was WITHHELD. ${qboWithheldReversalReason(verdict)}`
}

function qboBillWithheldDescription(bill: QboBillReversalDoc, verdict: RegisteredPaymentVerdict): string {
  return `QuickBooks reports a balance due on the bill for PO ${bill.po.reference} `
    + `(PO status: ${bill.po.status}), but the payment reversal was WITHHELD. ${qboWithheldReversalReason(verdict)}`
}

/**
 * The closing effects of an ADMITTED sales reversal, as one step both the delta pass and the recheck
 * run. Lifted out in r4 for the reason the candidate query was lifted out in r3: a recheck that
 * re-implemented "what happens when a reversal is admitted" would be a second answer to the question
 * that raises credit notes.
 *
 * `holdWatermark` is a FAILED chargeback: `paidAt` is left set so the reversal is retried, and the
 * cursor must not move past the invoice or the retry never happens.
 */
async function applyQboSalesReversal(
  order: QboSalesReversalDoc,
  opts: { invoiceVoided: boolean },
  errors: string[],
): Promise<{ reversed: boolean; holdWatermark: boolean }> {
  // scjz.71: a reversed payment on a revenue-POSTED order (revenue recognised +
  // invoiced) is a chargeback — raise a revenue-only credit note that reverses
  // recognised revenue against AR. Idempotent (one chargeback per order).
  // A VOIDED invoice has already had its AR/revenue reversed by QBO, so a
  // separate credit note would double-reverse — only auto-chargeback an
  // un-applied payment where the invoice is still live.
  // CRITICAL: clear paidAt ONLY after the chargeback is recorded — otherwise a
  // failed chargeback would drop the order out of the next poll's paidOrders
  // (paidAt: not null) and the recognised revenue would never be reversed.
  let chargebackFailed = false
  // o3d-w00 (Codex r8 #3): the refusal the posted-VAT fence raises stands until an admin changes
  // the tax configuration, so holding paidAt AND the poll watermark for it would freeze the whole
  // QuickBooks cursor indefinitely — every later payment and reversal behind it, not just this
  // order. Payment truth is reconciled and the order flagged instead.
  let chargebackManualReason: string | undefined
  if (order.revenueDeferredDate && !opts.invoiceVoided) {
    try {
      const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
      const chargeback = await raiseChargebackForReversedOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
      if (chargeback.error && chargeback.manualResolutionRequired) {
        chargebackManualReason = chargeback.error
        errors.push(`Chargeback for order ${order.orderNumber ?? order.id} needs manual handling: ${chargeback.error}`)
      } else if (chargeback.error) {
        chargebackFailed = true
        errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${chargeback.error}`)
      }
    } catch (chargebackError) {
      chargebackFailed = true
      errors.push(`Chargeback for order ${order.orderNumber ?? order.id} failed: ${String(chargebackError)}`)
    }
  }
  // Leave paidAt set on a failed chargeback so the reversal is re-attempted and
  // the order is not silently shown unpaid-and-unreversed. Also hold the poll
  // watermark: unlike Xero (whose cursor gate is errors.length===0), the QBO
  // cursor advances on allQueriesSucceeded, so without this the window moves past
  // the reversed invoice and the LastUpdatedTime>since reversal query never
  // re-returns it — the chargeback would never actually retry.
  if (chargebackFailed) return { reversed: false, holdWatermark: true }
  // o3d-psrx r2: the provenance is cleared with the flag it describes.
  await db.salesOrder.update({
    where: { id: order.id },
    data: { paidAt: null, unregisteredPaidAt: null },
  })
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: order.id,
    action: 'payment_reversal_detected',
    tag: 'sync',
    level: 'WARNING',
    description: chargebackManualReason
      ? `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt, but the revenue unwind was REFUSED and no credit note has been raised: ${chargebackManualReason} Raise the credit note manually, or fix the tax mapping and re-run the poller.`
      : `Payment no longer present in QuickBooks for order ${order.orderNumber ?? order.externalOrderNumber} (status: ${order.status}) — cleared paidAt. Review whether the order status should revert.`,
    resolveUser: false,
  })
  return { reversed: true, holdWatermark: false }
}

/** The closing effects of an ADMITTED bill reversal. No chargeback equivalent on the purchase side. */
async function applyQboBillReversal(bill: QboBillReversalDoc): Promise<void> {
  await db.purchaseInvoice.update({ where: { id: bill.id }, data: { paidAt: null } })
  await logActivity({
    entityType: 'PURCHASE_ORDER',
    entityId: bill.poId,
    action: 'bill_payment_reversal_detected',
    tag: 'sync',
    level: 'WARNING',
    description: `Bill payment no longer present in QuickBooks for PO ${bill.po.reference} (PO status: ${bill.po.status}) — cleared paidAt.`,
    resolveUser: false,
  })
}

/**
 * GO BACK AND RE-ASK EVERY WITHHELD QUICKBOOKS REVERSAL THAT HAS RESTED LONG ENOUGH
 * (o3d-psrx r4, Codex HIGH; closes o3d-a6i2).
 *
 * THE DEFECT. `pollQuickBooksPayments` advances `LastUpdatedTime` after every successful query, and
 * candidates are selected only where `LastUpdatedTime` exceeds it. A withheld candidate was therefore
 * checkpointed past — and several of the causes that withhold it resolve with NO QuickBooks document
 * change: a PENDING or PROCESSING registration finishing or being CANCELLED, or a database fence that
 * failed once. A genuine chargeback or supplier-payment reversal could stay represented as paid
 * indefinitely, recoverable only by a human reading the warning.
 *
 * WHAT THIS IS NOT. It is not a cursor hold. Holding the cursor for a paid flag that by design is
 * never registered would freeze every later QuickBooks payment and reversal behind it — the trap
 * o3d-w00 records, and the reason r3 advanced the watermark deliberately. The cursor keeps moving AND
 * the withheld documents are revisited BY KEY.
 *
 * THE LIFECYCLE IS XERO'S, NOT A SECOND ONE WORDED LIKE IT. `openWithheldDocuments`,
 * `dueWithheldMarkers`, `closeWithheldMarker` and `deferWithheldMarker` are the same functions
 * o3d-clxw rounds 4–6 argued into shape, moved to lib/domain/accounting/withheld-reversal-markers.ts
 * because none of that reasoning was ever about Xero: the work item is an activity row, the timer is
 * its `createdAt`, the page is a round robin over documents rather than rows, and a settled document
 * cannot spend the scan. All this connector supplies is its own read-by-id and its own gate — which is
 * the SAME gate the delta pass uses, so a recheck cannot reach a verdict the delta would not have.
 *
 * FAILURE IS ALWAYS TOWARDS ASKING AGAIN. A QuickBooks read that fails closes nothing; a document
 * QuickBooks did not return is DEFERRED, not closed; and a pass that recorded any error while these
 * documents were being decided defers rather than closes, because "we could not decide" must never be
 * spent as "there is nothing left to decide" (o3d-clxw round 5, finding 2).
 */
export async function recheckWithheldQboReversals(
  errors: string[],
): Promise<{ rechecked: number; resolved: number; salesReversed: number; billsReversed: number }> {
  const out = { rechecked: 0, resolved: 0, salesReversed: 0, billsReversed: 0 }
  // NO AGE BOUND (o3d-psrx r5, Codex HIGH 2). Every still-open marker is scanned, however old: an
  // outage longer than any horizon is exactly when a withheld reversal must not be dropped, and the
  // page is bounded by DOCUMENTS rather than by time. See the module note in withheld-reversal-markers.
  const { open: openMarkers, closed: closureMarkers } = await openWithheldDocuments(QBO_MARKER_SCOPE)
  const due = dueWithheldMarkers(openMarkers, closureMarkers, Date.now())
  if (due.length === 0) return out
  out.rechecked = due.length

  const poIds = due.filter((m) => m.entityType === 'PURCHASE_ORDER').map((m) => m.entityId)
  const soIds = due.filter((m) => m.entityType === 'SALES_ORDER').map((m) => m.entityId)

  // Only documents IMS STILL holds as paid have a disagreement left to settle. One PO can carry more
  // than one bill, which is why the bill side is keyed by poId and may map to several documents.
  const bills = poIds.length === 0 ? [] : await db.purchaseInvoice.findMany({
    where: { poId: { in: poIds }, paidAt: { not: null }, accountingInvoiceId: { not: null } },
    select: { id: true, accountingInvoiceId: true, poId: true, po: { select: { reference: true, status: true } } },
  })
  const orders = soIds.length === 0 ? [] : await db.salesOrder.findMany({
    where: { id: { in: soIds }, paidAt: { not: null }, accountingInvoiceId: { not: null } },
    select: {
      id: true,
      accountingInvoiceId: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      revenueDeferredDate: true,
      // No exceptions to the provenance rule inside a file that decides reversals — this read feeds
      // the SAME gate the delta pass feeds, and the gate is what consumes it.
      unregisteredPaidAt: true,
    },
  })

  const documentIdsByEntity = new Map<string, string[]>()
  const add = (key: string, invoiceId: string | null): void => {
    if (!invoiceId) return
    documentIdsByEntity.set(key, [...(documentIdsByEntity.get(key) ?? []), invoiceId])
  }
  for (const bill of bills) add(withheldEntityKey('PURCHASE_ORDER', bill.poId), bill.accountingInvoiceId)
  for (const order of orders) add(withheldEntityKey('SALES_ORDER', order.id), order.accountingInvoiceId)

  const salesRead = orders.length === 0 ? null : await fetchReversedEntityIdsByIds(
    'Invoice', [...new Set(orders.map((o) => o.accountingInvoiceId).filter((id): id is string => id != null))])
  const billsRead = bills.length === 0 ? null : await fetchReversedEntityIdsByIds(
    'Bill', [...new Set(bills.map((b) => b.accountingInvoiceId).filter((id): id is string => id != null))])
  if ((orders.length > 0 && salesRead == null) || (bills.length > 0 && billsRead == null)) {
    // Nothing is closed and nothing is deferred: every due document keeps the marker it already has,
    // so the whole page is still due on the next poll.
    errors.push('Withheld-reversal recheck could not read QuickBooks; nothing was reconsidered.')
    return out
  }

  const returned = new Set<string>([...(salesRead?.returned ?? []), ...(billsRead?.returned ?? [])])
  const stillWithheld = new Set<string>()
  // The recheck's equivalent of refusing to checkpoint is refusing to CLOSE, so it watches the same
  // signal the delta pass does: any error recorded while these documents were being decided means this
  // pass did not decide them all. Coarse in the safe direction only — an unrelated error defers
  // documents that were in fact settled, which costs one activity row and one more reconsideration.
  const errorsBeforeDecision = errors.length

  if (salesRead != null && orders.length > 0) {
    const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(orders, salesRead.all), {
      registrationType: 'INVOICE_PAYMENT',
      referenceType: 'SalesOrder',
      ledgerObservedBefore: salesRead.ledgerObservedBefore,
    })
    for (const { doc: order, verdict } of gate.withheld) {
      // Rewriting the marker is what RESTARTS the timer, which is what keeps the page a round robin
      // rather than a queue with a permanent head. `observe` before the write, not after: "we could
      // not write it down" must never be mistaken for "the disagreement is over".
      stillWithheld.add(withheldEntityKey('SALES_ORDER', order.id))
      await signalWithheldQboReversal({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'payment_reversal_withheld',
        description: qboSalesWithheldDescription(order, verdict),
        accountingInvoiceId: order.accountingInvoiceId,
        verdict,
      })
    }
    for (const order of gate.admitted) {
      const invoiceVoided = order.accountingInvoiceId != null && salesRead.voided.has(order.accountingInvoiceId)
      const applied = await applyQboSalesReversal(order, { invoiceVoided }, errors)
      if (applied.reversed) out.salesReversed++
      // A failed chargeback leaves `paidAt` set and the disagreement open, so the marker stays.
      else stillWithheld.add(withheldEntityKey('SALES_ORDER', order.id))
    }
  }

  if (billsRead != null && bills.length > 0) {
    const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(bills, billsRead.all), {
      registrationType: 'BILL_PAYMENT',
      referenceType: 'PurchaseInvoice',
      ledgerObservedBefore: billsRead.ledgerObservedBefore,
    })
    for (const { doc: bill, verdict } of gate.withheld) {
      stillWithheld.add(withheldEntityKey('PURCHASE_ORDER', bill.poId))
      await signalWithheldQboReversal({
        entityType: 'PURCHASE_ORDER',
        entityId: bill.poId,
        action: 'bill_payment_reversal_withheld',
        description: qboBillWithheldDescription(bill, verdict),
        accountingInvoiceId: bill.accountingInvoiceId,
        verdict,
      })
    }
    for (const bill of gate.admitted) {
      await applyQboBillReversal(bill)
      out.billsReversed++
    }
  }

  const decisionIncomplete = errors.length > errorsBeforeDecision

  for (const marker of due) {
    const key = withheldEntityKey(marker.entityType, marker.entityId)
    // Still withheld — the signal pass has already rewritten the marker, which restarts its timer. If
    // that write failed the OLD marker stands, and the document simply stays due.
    if (stillWithheld.has(key)) continue

    const documentIds = documentIdsByEntity.get(key)
    // Grounded in IMS's own state and in nothing QuickBooks said, so an error in the decision pass has
    // no bearing on it: there is no disagreement left to decide either way.
    if (!documentIds || documentIds.length === 0) {
      out.resolved++
      await closeWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'no-paid-document',
        'IMS no longer holds a paid, QuickBooks-linked document for this record, so the withheld '
        + 'payment reversal has nothing left to decide and is closed.')
      continue
    }
    // A read that did not come back cannot close anything. Deferring rewrites the marker so this
    // document goes to the BACK of the oldest-first page instead of holding its head for ever.
    if (!documentIds.every((id) => returned.has(id))) {
      await deferWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'QuickBooks did not return the document')
      continue
    }
    if (decisionIncomplete) {
      await deferWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'the reconsideration pass could not complete')
      continue
    }
    out.resolved++
    await closeWithheldMarker(marker, QBO_MARKER_SCOPE.connector, 'settled',
      'The withheld payment reversal for this document was reconsidered against a fresh QuickBooks '
      + 'read and is no longer withheld — it was either reversed, or the ledger and IMS now agree. Closed.')
  }

  return out
}

/**
 * Poll QuickBooks for paid invoices and bills.
 * Updates paidAt on matching IMS records and advances order status.
 */
export async function pollQuickBooksPayments(): Promise<{ salesPaid: number; billsPaid: number; salesReversed: number; billsReversed: number; salesReversalsWithheld: number; billsReversalsWithheld: number; withheldRechecked: number; withheldResolved: number; errors: string[] }> {
  const errors: string[] = []
  let salesPaid = 0
  let billsPaid = 0
  let salesReversed = 0
  let billsReversed = 0
  // o3d-psrx r3: reversals the provenance gate refused. Reported, never silently dropped.
  let salesReversalsWithheld = 0
  let billsReversalsWithheld = 0
  // o3d-psrx r4 / o3d-a6i2: withheld documents re-asked off the delta cursor, and the ones that settled.
  let withheldRechecked = 0
  let withheldResolved = 0
  let allQueriesSucceeded = true

  const lastPoll = await getSettingValue(LAST_POLL_KEY)
  const since = lastPoll || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  // --- Sales invoices (customer payments) ---
  const unpaidOrders = await db.salesOrder.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
      refundStatus: { not: 'FULL' }, // a fully refunded order must not be revived as paid
      shoppingLinks: { none: {} }, // manual orders only; shopping orders get channel payment status
    },
    select: { id: true, accountingInvoiceId: true, status: true },
  })

  if (unpaidOrders.length > 0) {
    // Query QBO for invoices with zero balance (fully paid)
    const res = await qboQuery<QboQueryResponse<QboInvoice>>(
      'Invoice',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks invoices: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidInvoices = res.data?.QueryResponse?.Invoice ?? []
      const paidInvoiceIds = new Set(paidInvoices.map((i) => i.Id))

      for (const order of unpaidOrders) {
        if (!order.accountingInvoiceId || !paidInvoiceIds.has(order.accountingInvoiceId)) continue

        try {
          // o3d-psrx r2: `unregisteredPaidAt: null` — a LEDGER-sourced paid flag (QuickBooks reported
          // the invoice paid). See SalesOrder.unregisteredPaidAt. Written here rather than left off
          // the object so this writer cannot inherit a marker an earlier non-ledger write left behind,
          // and so the paid-provenance guard can see it: an untyped `Record<string, unknown>` is
          // exactly the shape in which a missing column is not a type error.
          const updateData: Record<string, unknown> = { paidAt: new Date(), unregisteredPaidAt: null }
          // Advance status from PENDING_PAYMENT to PROCESSING
          if (order.status === 'PENDING_PAYMENT') {
            updateData.status = 'PROCESSING'
          }
          await db.salesOrder.update({
            where: { id: order.id },
            data: updateData,
          })

          // Trigger auto-allocation if status advanced.
          // o3d-67y: this runs in the sessionless cron, so it MUST pass INTERNAL_ACTION_BYPASS (as the Xero
          // poller does) — otherwise requirePermission('sales.process') fails, autoAllocateOrder returns
          // success:false, and since the poller only re-selects paidAt:null orders the paid order is never
          // retried and silently stays unallocated.
          if (order.status === 'PENDING_PAYMENT') {
            try {
              const { autoAllocateOrder } = await import('@/app/actions/allocation')
              await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
            } catch {
              // Non-critical — allocation can be done manually
            }
          }

          salesPaid++
        } catch (e) {
          errors.push(`Sales order ${order.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Sales payment reversals (audit-M-acct #3 / scjz.70/.71) ---
  // Forward poll only marks unpaid→paid. If an invoice IMS thinks is paid no longer
  // has a zero balance in QBO — payment deleted/un-applied (Balance > 0) or the
  // invoice voided (TotalAmt = 0) — clear paidAt so IMS stops showing it paid.
  // Status is NOT auto-reverted (the order may already be picking/shipped); a
  // WARNING carrying the current status flags it. Must run AFTER the forward pass
  // so a pay-then-reverse within one window nets to the correct (unpaid) state.
  const paidOrders = await readQboSalesReversalCandidates()

  if (paidOrders.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Invoice', since)
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks invoices for payment reversals')
    } else {
      // o3d-psrx r4 (Codex HIGH) — A NULL FENCE IS AN INCOMPLETE POLL, NOT A CLEAN ONE.
      //
      // With no database clock nothing is decided: every document carrying a registration withholds,
      // because every registration might have landed after the snapshot. That is the correct verdict
      // and it is NOT a reason to checkpoint — the query succeeded, so `allQueriesSucceeded` would
      // otherwise move the watermark past a window in which IMS could decide nothing at all. The
      // marker recheck would eventually re-ask, but the delta window is cheaper and this poll plainly
      // did not finish its job.
      if (reversedIds.ledgerObservedBefore == null) {
        allQueriesSucceeded = false
        errors.push('The database clock could not be read, so no sales payment reversal in this window '
          + 'could be decided. Holding the poll watermark so the window is re-read.')
      }
      // o3d-psrx r3 (Codex HIGH) — THE SAME EVIDENCE XERO NOW REQUIRES, REQUIRED HERE.
      const gate = await gateQboReversalsOnProvenance(
        detectPaymentReversals(paidOrders, reversedIds.all),
        {
          registrationType: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          ledgerObservedBefore: reversedIds.ledgerObservedBefore,
        },
      )

      // WITHHELD IS REPORTED, NEVER SILENT — AND NOW IT COMES BACK (o3d-psrx r4 / o3d-a6i2).
      //
      // The watermark is still deliberately NOT held for a withheld verdict that was RECORDED: a paid
      // flag that was never going to be registered stays unregistered for ever, so holding the cursor
      // on it would freeze every later QuickBooks payment and reversal behind it — the same trap
      // o3d-w00 (Codex r8 #3) records a few lines below for a refused chargeback.
      //
      // What r3 got wrong was the other half. The cursor moving on is fine; the document never being
      // asked about again is not, and QuickBooks selects candidates only where `LastUpdatedTime`
      // exceeds the watermark. Several withholding causes resolve with NO QuickBooks change at all — a
      // PENDING or PROCESSING registration finishing or being CANCELLED, a database fence that failed
      // once — so a genuine chargeback could stay represented as paid for ever. The activity row is now
      // a MARKER that `recheckWithheldQboReversals` re-reads by id on a timer, off the cursor entirely.
      //
      // A marker that did NOT land is the one case that holds the watermark, because then the delta
      // window is the only remaining route back to the document.
      for (const { doc: order, verdict } of gate.withheld) {
        salesReversalsWithheld++
        const landed = await signalWithheldQboReversal({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'payment_reversal_withheld',
          description: qboSalesWithheldDescription(order, verdict),
          accountingInvoiceId: order.accountingInvoiceId,
          verdict,
        })
        if (!landed) {
          allQueriesSucceeded = false
          errors.push(`Withheld payment reversal for order ${order.orderNumber ?? order.id} left no durable `
            + `marker, so nothing would bring it back. Holding the poll watermark instead.`)
        }
      }

      for (const order of gate.admitted) {
        const invoiceVoided = order.accountingInvoiceId != null && reversedIds.voided.has(order.accountingInvoiceId)
        const applied = await applyQboSalesReversal(order, { invoiceVoided }, errors)
        if (applied.holdWatermark) allQueriesSucceeded = false
        if (applied.reversed) salesReversed++
      }
    }
  }

  // --- Purchase bills (vendor payments) ---
  const unpaidBills = await db.purchaseInvoice.findMany({
    where: {
      accountingInvoiceId: { not: null },
      paidAt: null,
    },
    select: { id: true, accountingInvoiceId: true },
  })

  if (unpaidBills.length > 0) {
    const res = await qboQuery<QboQueryResponse<QboBill>>(
      'Bill',
      `Balance = '0' AND MetaData.LastUpdatedTime > '${since}'`,
    )

    if (!res.ok) {
      allQueriesSucceeded = false
      errors.push(`Failed to query QuickBooks bills: ${res.error ?? 'Unknown error'}`)
    } else {
      const paidBills = res.data?.QueryResponse?.Bill ?? []
      const paidBillIds = new Set(paidBills.map((b) => b.Id))

      for (const bill of unpaidBills) {
        if (!bill.accountingInvoiceId || !paidBillIds.has(bill.accountingInvoiceId)) continue

        try {
          await db.purchaseInvoice.update({
            where: { id: bill.id },
            data: { paidAt: new Date() },
          })
          billsPaid++
        } catch (e) {
          errors.push(`Purchase invoice ${bill.id}: ${String(e)}`)
        }
      }
    }
  }

  // --- Purchase bill payment reversals (audit-M-acct #3) ---
  // A bill IMS thinks paid whose QBO transaction regressed (Balance > 0, payment
  // un-applied; or TotalAmt = 0, voided) gets paidAt cleared with a WARNING. No
  // chargeback equivalent on the purchase side.
  const paidBills = await readQboBillReversalCandidates()

  if (paidBills.length > 0) {
    const reversedIds = await fetchReversedEntityIds('Bill', since)
    if (!reversedIds) {
      allQueriesSucceeded = false
      errors.push('Failed to query QuickBooks bills for payment reversals')
    } else {
      // o3d-psrx r4 (Codex HIGH): see the sales side — a fence that could not be read decides nothing,
      // and a window in which nothing could be decided must not be checkpointed past.
      if (reversedIds.ledgerObservedBefore == null) {
        allQueriesSucceeded = false
        errors.push('The database clock could not be read, so no bill payment reversal in this window '
          + 'could be decided. Holding the poll watermark so the window is re-read.')
      }
      // o3d-psrx r3: the SAME gate, at the sibling reader in this same file. A bill has no
      // `unregisteredPaidAt` column (markBillPaid queues its BILL_PAYMENT registration inside the paid
      // transaction — o3d-a3wx), so what this adds on the purchase side is the REGISTRATION fence: a
      // bill whose payment IMS has queued but not yet posted no longer has `paidAt` cleared on the
      // strength of a balance QuickBooks reports while that payment is still on its way. Clearing it
      // re-arms Mark Paid over money already leaving the bank, and pressing it pays the supplier twice.
      const gate = await gateQboReversalsOnProvenance(detectPaymentReversals(paidBills, reversedIds.all), {
        registrationType: 'BILL_PAYMENT',
        referenceType: 'PurchaseInvoice',
        ledgerObservedBefore: reversedIds.ledgerObservedBefore,
      })

      for (const { doc: bill, verdict } of gate.withheld) {
        billsReversalsWithheld++
        const landed = await signalWithheldQboReversal({
          entityType: 'PURCHASE_ORDER',
          entityId: bill.poId,
          action: 'bill_payment_reversal_withheld',
          description: qboBillWithheldDescription(bill, verdict),
          accountingInvoiceId: bill.accountingInvoiceId,
          verdict,
        })
        if (!landed) {
          allQueriesSucceeded = false
          errors.push(`Withheld bill payment reversal for PO ${bill.po.reference} left no durable marker, `
            + `so nothing would bring it back. Holding the poll watermark instead.`)
        }
      }

      for (const bill of gate.admitted) {
        await applyQboBillReversal(bill)
        billsReversed++
      }
    }
  }

  // o3d-psrx r4 / o3d-a6i2 — AND GO BACK FOR EVERYTHING THIS POLL, OR AN EARLIER ONE, WITHHELD.
  //
  // Runs whatever the delta pass did, because the documents it is for are precisely the ones the delta
  // will never return again. Its own failures are recorded on `errors` and never checkpoint anything:
  // a marker is only ever CLOSED on an answer.
  const rechecked = await recheckWithheldQboReversals(errors)
  withheldRechecked += rechecked.rechecked
  withheldResolved += rechecked.resolved
  salesReversed += rechecked.salesReversed
  billsReversed += rechecked.billsReversed

  // Only advance the poll watermark if all QBO queries succeeded.
  // If a query failed, keep the previous checkpoint so the next run
  // replays the missed window instead of permanently skipping payments.
  if (allQueriesSucceeded) {
    await db.setting.upsert({
      where: { key: LAST_POLL_KEY },
      create: { key: LAST_POLL_KEY, value: now },
      update: { value: now },
    })
  }

  if (salesPaid > 0 || billsPaid > 0 || salesReversed > 0 || billsReversed > 0
    || salesReversalsWithheld > 0 || billsReversalsWithheld > 0 || withheldRechecked > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_payment_poll',
      tag: 'sync',
      description: `QuickBooks payment poll: ${salesPaid} sales paid, ${billsPaid} bills paid, ${salesReversed} sales reversed, ${billsReversed} bills reversed`
        + `, ${salesReversalsWithheld} sales + ${billsReversalsWithheld} bill reversals withheld`
        + `, ${withheldRechecked} withheld reconsidered (${withheldResolved} settled)`,
      metadata: { salesPaid, billsPaid, salesReversed, billsReversed, salesReversalsWithheld, billsReversalsWithheld, withheldRechecked, withheldResolved },
    })
  }

  return { salesPaid, billsPaid, salesReversed, billsReversed, salesReversalsWithheld, billsReversalsWithheld, withheldRechecked, withheldResolved, errors }
}
