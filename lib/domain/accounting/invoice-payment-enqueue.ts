/**
 * Queueing a sales receipt to the ledger (o3d-lgo.15, o3d-ekn8).
 *
 * Lifted out of app/actions/sales.ts unchanged apart from the two edits noted below, because it now has
 * a SECOND caller: the Xero connector re-drives it once a SALES_INVOICE posts, for receipts that were
 * recorded while the invoice did not yet exist (o3d-ekn8). A 'use server' file cannot provide that —
 * every export there becomes a callable server action, and "post money for this order id" is not an
 * endpoint worth exposing — so the shared logic lives here and app/actions/sales.ts imports it.
 */

import { db } from '@/lib/db'
import { ACCOUNTING_CONNECTORS } from '@/lib/connectors/accounting-registry'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import {
  getActiveAccountingConnectorInfo,
  getPaymentAccountMap,
  isAccountingSyncTypeEnabled,
  isAccountingSyncTypeEnabledFor,
  lookupPaymentAccount,
  queueAccountingSyncTxWithOutcome,
} from '@/lib/accounting'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import {
  decideInvoicePaymentRegistration,
  selectReceiptsAwaitingRegistration,
  unresolvedInvoicePaymentAttempts,
  type InvoicePaymentRegistrationDecision,
  type InvoicePaymentRegistrationRefusal,
} from '@/lib/domain/accounting/invoice-payment-registration'
import {
  followUpObligationRecoveryNote,
  releaseFollowUpObligation,
  type FollowUpObligationRecovery,
  type FollowUpObligationReleaseOutcome,
} from '@/lib/domain/accounting/back-reference'
import { followUpObligationRecoveryFor } from '@/lib/domain/accounting/follow-up-obligation-registry'
import { ledgerSalesInvoiceTotalForeign, type PaymentSyncRow } from '@/lib/domain/accounting/settlement-status'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { attemptCouldHaveReachedTheLedger, effectiveTokenFor } from '@/lib/domain/accounting/followup-retry-guard'
import { pinnedAttemptDate, settlementMarkerFor } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { probeLedgerSettlement } from '@/lib/connectors/accounting-settlement-probe'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

/**
 * Every INVOICE_PAYMENT sync row for one order (o3d-lgo.15) — the ledger's own account of what it was
 * told about this order's receipts. Scoped to the ACTIVE connector: rows left by a connector that is no
 * longer in use describe a ledger nobody is reconciling against, and judging today's settlement by them
 * would report a discrepancy against a system that has been switched off.
 */
export type InvoicePaymentSyncRow = PaymentSyncRow & {
  paymentId: string | null
  /** The ledger document this row settles — null on rows queued before the payload carried it. */
  accountingInvoiceId: string | null
  /** The mark this attempt would have written into the ledger (o3d-0m56). */
  settlementMarker: string | null
  /** The date that attempt sent, so a settlement in the ledger can be matched to it (o3d-0m56). */
  paymentDate: string | null
  /** False when the stored body was too incomplete for the connector to have made the call. */
  couldHaveReachedLedger: boolean
}

export async function loadInvoicePaymentSyncRows(
  orderId: string,
  connector: string | null,
  /**
   * Read through the CALLER's transaction when one is supplied, so the capacity re-check below sees
   * rows a concurrent receipt has already written and is serialised by the order lock that
   * transaction holds. Reading outside it would re-open the check-then-act race it exists to close.
   */
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'> = db,
): Promise<InvoicePaymentSyncRow[]> {
  if (!connector) return []
  const rows = await client.accountingSyncLog.findMany({
    where: { connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: orderId },
    select: {
      status: true, externalTransactionId: true, errorMessage: true, retryCount: true, payload: true,
      // o3d-0m56: the row id, because the token an attempt POSTED under is derived from it for rows
      // whose payload pinned none. Without it `effectiveTokenFor` cannot name the mark to look for.
      id: true,
      // o3d-nf9i r3: HOW the row reached its status. Without it an operator-asserted SYNCED row is
      // indistinguishable from one Xero confirmed, and settlementStatus would compare two local
      // numbers nothing verified and call the invoice SETTLED. `settlementBasis` is OPTIONAL on
      // PaymentSyncRow, so dropping it in this move would have been a silent regression rather than
      // a type error.
      settlementBasis: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((r) => {
    const payload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, unknown>
    return {
      status: r.status,
      externalTransactionId: r.externalTransactionId,
      errorMessage: r.errorMessage,
      retryCount: r.retryCount,
      // The amount actually SENT, so a part payment is not mistaken for full settlement.
      amount: typeof payload.amount === 'number' ? payload.amount : null,
      settlementBasis: r.settlementBasis,
      paymentId: payloadPaymentId(r.payload),
      // o3d-hbgo: WHICH ledger invoice this settled. A row against a document the order no longer has
      // (deleted and re-posted) must not be read as bearing on the replacement's settlement.
      accountingInvoiceId: payloadAccountingInvoiceId(r.payload),
      // o3d-0m56. The three facts the unresolved-attempt fence weighs, all derived through the SAME
      // helpers the retry guard and the processors use rather than re-spelt here — copies of these
      // rules are what let a probe go looking for a settlement on a day no post would ever create.
      //
      // ...the date it sent, because amount alone cannot tell one receipt from another:
      paymentDate: pinnedAttemptDate('INVOICE_PAYMENT', r.payload),
      // ...whether the stored body was ever complete enough to have been sent at all:
      couldHaveReachedLedger: attemptCouldHaveReachedTheLedger('INVOICE_PAYMENT', r.payload),
      // ...and the mark it would have written, which identifies the attempt even if its amount or
      // date has since been corrected in the ledger.
      settlementMarker: connector === 'xero' || connector === 'quickbooks'
        ? settlementMarkerFor(effectiveTokenFor(connector, { id: r.id, payload: r.payload }))
        : null,
    }
  })
}

/** The local Payment row an INVOICE_PAYMENT was queued for, when the payload records one. */
export function payloadPaymentId(payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return typeof p.paymentId === 'string' ? p.paymentId : null
}

/**
 * WHICH LEDGER DOCUMENT A REGISTRATION WAS RAISED AGAINST (o3d-hbgo; o3d-psrx r4, Codex HIGH).
 *
 * Both INVOICE_PAYMENT and BILL_PAYMENT put `accountingInvoiceId` in the payload at enqueue time, and
 * it is the ONLY durable record of which document the money call was about: `salesOrder`/
 * `purchaseInvoice`.`accountingInvoiceId` answers "which document does this row point at NOW", which
 * a delete-and-re-post silently changes underneath every registration already raised.
 *
 * Spelt once, here, next to `payloadPaymentId`, because the settlement reader (`findRegisteredPayments`)
 * and the reversal evidence reader (`readPaidProvenanceVerdicts`) must agree about what "this
 * registration is about that document" means — two readings of one payload field is the same class of
 * defect as two readings of one money rule.
 *
 * A payload that records no id — a row from before the field existed, or one retention-compacted to
 * `{}` (o3d-m5qk) — answers NULL, which every caller must read as "cannot be tied to any document",
 * never as "tied to this one".
 */
export function payloadAccountingInvoiceId(payload: unknown): string | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  if (typeof p.accountingInvoiceId !== 'string') return null
  const trimmed = p.accountingInvoiceId.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * IMMUTABLE EVIDENCE OF THE POST THAT JUST HAPPENED (o3d-ekn8 r2, Codex HIGH).
 *
 * The deferred re-drive runs at one instant: straight after a SALES_INVOICE CREATE returned, on the
 * connector that made the call, with the ledger id that call returned in hand. Everything it needs to
 * decide is therefore already known at the call site — and every one of those facts is MUTABLE if it is
 * looked up again instead. `getActiveAccountingConnectorInfo` answers "which connector is switched on
 * NOW", and `salesOrder.accountingInvoiceId` answers "which document does this order point at NOW"; a
 * connector swap or a delete-and-re-post between the post and the re-drive silently redirects the whole
 * re-drive onto a ledger, or a document, that is not the one this evidence is about.
 *
 * So the evidence travels IN rather than being re-derived. Re-resolving after a pin is the race being
 * closed, not a check of it — the same correction o3d-2sm1 r8/r9 made for the refund hand-off, where the
 * answer has to name the connector it was GIVEN against.
 */
export type PostedInvoiceEvidence = {
  /** The connector whose processor made the call — not whichever one is active when this runs. */
  connector: 'xero' | 'quickbooks'
  /** The ledger invoice id THIS attempt returned — not whatever the order points at when this runs. */
  accountingInvoiceId: string
}

/**
 * WHAT THE RE-DRIVE ACTUALLY SETTLED (o3d-ekn8 r5, Codex HIGH).
 *
 * This used to return `void`, and the caller read that as "done". It was not: EVERY early return
 * below — the order carrying no invoice id because the back-reference write failed, the document
 * having moved, the catch — looks identical to "there was nothing to do" from the outside, and the
 * connector then RELEASED the follow-up obligation marker that is the only remaining record that
 * this order still owes the ledger a receipt. A recorded receipt was left permanently unsettled
 * behind a row that says its follow-ups completed.
 *
 * So the answer is now explicit, and `settled` is deliberately not "no error": it is TRUE only when
 * nothing is left awaiting registration under the PINNED connector AND document — a fact re-read
 * from the rows that exist afterwards, not inferred from having reached the end of the loop.
 *
 * A refusal counts as UNSETTLED. That is the asymmetry the obligation marker was designed around
 * (see followUpObligationClaim): a marker left set costs one idempotent re-enqueue on a later
 * sweep, a marker cleared early costs the payment.
 */
export type DeferredReceiptRedriveResult = {
  /** True only when no receipt on this order is still waiting to be registered against this post. */
  settled: boolean
  reason:
    | 'sync-disabled'
    | 'posting-context-unknown'
    | 'no-order'
    | 'no-receipts'
    | 'not-linked'
    | 'document-moved'
    | 'nothing-awaiting'
    | 'registered'
    | 'left-unregistered'
    | 'failed'
  /** How many receipts were still awaiting registration when this returned. */
  awaiting?: number
  /**
   * WHAT THIS PASS DID WITH THE CALLER'S OBLIGATION MARKER (o3d-0bfh r15, Codex HIGH).
   *
   * The caller USED to clear the marker itself on `settled: true`, and that is the race this field
   * exists to make unstateable: see {@link dischargeDeferredReceiptObligation}. A caller that holds
   * an obligation must read this and clear NOTHING of its own unless it says `unfenced`.
   */
  release: DeferredReceiptRelease
}

/**
 * THE MARKER DECISION, TAKEN UNDER THE SALES-ORDER LOCK — never by the caller afterwards.
 *
 *   • `released`   — the exact generation this pass was handed is now cleared, inside the fence.
 *   • `superseded` — a newer generation holds the marker, so it stands and this pass wrote nothing.
 *   • `unwritable` — the clearing write failed; the marker stands.
 *   • `retained`   — the fence found a receipt still awaiting registration, so nothing was cleared.
 *   • `not-held`   — the caller handed over no obligation, so there was none to clear.
 *   • `prerequisite-unmet` — the receipts settled, but the CALLER's own settlement prerequisite did
 *     not (o3d-0bfh r16). Nothing was cleared, and the caller must not clear it either: it is the
 *     party that just said its own settlement cannot be recorded.
 *   • `unfenced`   — the pass answered before the fence ran, on a fact no later receipt can change
 *     (payments do not post on this connector at all; the order no longer exists). ONLY on this
 *     answer may a caller clear a marker of its own.
 */
export type DeferredReceiptRelease =
  | FollowUpObligationReleaseOutcome
  | 'retained'
  | 'not-held'
  | 'prerequisite-unmet'
  | 'unfenced'

/**
 * THE OBLIGATION THIS PASS HOLDS, so its final recheck and its release commit TOGETHER.
 *
 * Handed over by the caller rather than re-read here, for the reason o3d-0bfh r4 gives: a generation
 * read inside this call is whichever one is live NOW, and clearing that is clearing an obligation
 * somebody else claimed. `generation: null` means the caller never took one, and then the release
 * writes nothing at all.
 */
export type DeferredReceiptObligation = {
  /** The AccountingSyncLog row carrying `backReferenceFollowUpsPendingAt`. */
  syncLogId: string
  /** The connector whose obligation this is — used for the log line, never for the predicate. */
  connector: string
  /** The generation THIS pass claimed, in the transaction that made the row SYNCED. */
  generation: Date | null
  /** What re-drives an obligation this call leaves behind. Required — see the type's header. */
  recovery: FollowUpObligationRecovery
  /**
   * WHAT ELSE MUST ALREADY BE DURABLE BEFORE THIS GENERATION MAY BE CLEARED (o3d-0bfh r16, Codex
   * HIGH).
   *
   * The fence knows one half of the settlement question — whether any receipt on this order is still
   * awaiting registration. It cannot know the other half, because the other half belongs to the
   * CALLER: the back-reference sweep discharges this same generation only once it has PERSISTED the
   * warning naming what a retention tombstone's compaction destroyed, and only once the sale's
   * invoice date is either recovered or announced as unrecoverable. Both are terminal notices — the
   * loss they describe cannot be undone by a later run — so a marker cleared before they are on
   * record retires the work and the notice together.
   *
   * r15 handed the generation down to this module so the clear could be taken under the order lock.
   * That closed the receipt race and, by the same move, put the clear BEFORE those caller-side
   * writes: a release that outruns its own evidence. So the caller states its condition here, and
   * the clear is not attempted until this answers true.
   *
   * Run OUTSIDE the fence transaction, between a fenced re-read that found nothing awaiting and the
   * fenced release itself — see {@link dischargeDeferredReceiptObligation}. It must not throw; a
   * caller whose prerequisite cannot answer must answer `false`, which is the safe direction (the
   * marker stays and the row comes back).
   */
  settlementPrerequisite?: () => Promise<boolean>
}

/**
 * How long the fence may wait for, and hold, the sales-order row lock. Deliberately SHORT: it wraps
 * two reads and one update and nothing else, so a wait longer than this is contention, not work.
 */
const RECEIPT_FENCE_TX_OPTIONS = { maxWait: 5000, timeout: 10000 }

// ---------------------------------------------------------------------------
// THE FENCED RELEASE (o3d-0bfh r15, Codex HIGH) — WHY THE DURABLE READ WAS NECESSARY AND NOT
// SUFFICIENT.
//
// r14 made the receipt path ask the durable state whether a deferred pass is in flight for its
// order, and answer `held` — which refuses a hand settlement — whenever one is. The marker IS live
// for the whole window in which an unpinned call can see a document that pass posted, and that much
// of the r14 argument holds.
//
// What it does not establish is the thing the notice actually promises. THE MARKER ANSWERS "IS A
// PASS IN FLIGHT", NOT "DID THAT PASS SEE THIS RECEIPT" — and the deferred pass's view of which
// receipts exist is FIXED AT ITS OWN SNAPSHOT (`order.payments`, read once near the top, and re-used
// by the verification at the bottom). So:
//
//   1. the pass reads the order and its receipts; there are two, both of which it will register;
//   2. `addPayment` commits a THIRD receipt and calls this module with no pin. The document has
//      posted, so the refusal is not DOCUMENT_NOT_POSTED; on any refusal both paths share it reads
//      the marker, gets `held`, and reports "recovery is retained, do not settle by hand";
//   3. the pass finishes its two, re-verifies AGAINST ITS OWN SNAPSHOT — which has two receipts in
//      it — finds nothing awaiting, and answers `settled: true`;
//   4. the caller clears the marker.
//
// The third receipt now has no sync row, no retained marker, and no pass that ever considered it,
// while its operator has been told in terms not to register it by hand. That is the same permanently
// missing customer payment r13 and r14 were closing, reached one step further along.
//
// SO THE RELEASE IS SERIALIZED AGAINST RECEIPT INSERTION, and the read is kept: they answer
// different halves. `addPayment` creates its Payment row inside a transaction whose FIRST statement
// is `lockSalesOrder(tx, orderId)`. This fence takes THE SAME LOCK, and inside it re-reads every
// receipt on the order and every sync row for the pinned connector — not the pass's snapshot — and
// clears the exact obligation generation in the SAME transaction. There is then no interleaving
// left: either the receipt commits before the fence takes the lock, in which case the fence SEES it
// and keeps the marker; or it commits after the fence has committed, in which case the marker it
// goes on to read is ALREADY CLEARED and it is told the truth — nothing will come back, settle it by
// hand. The window in step (2) exists only because the clearing write was outside the lock.
//
// WHY THE LOCK IS THIS SCOPE AND NO WIDER. The alternative weighed in r14 — serializing the whole
// deferred pass — puts the connector's REMOTE calls inside a lock on the money path: an unreachable
// ledger would then block every operator receipt on that order for the length of an HTTP timeout,
// and a lock held across a network round trip is how the sweep and the live path deadlock. So the
// registration loop above stays outside, exactly where it is, and only the recheck and the release
// are fenced. That is sound because the loop is not what the guarantee is about: whatever it did or
// failed to do is READ BACK from the rows inside the fence, through the same selector that chose the
// work, and a receipt it never saw is exactly what the fence's re-read is for.
//
// FAILING TO TAKE THE FENCE IS `settled: false`. The transaction can fail — lock timeout, a dead
// connection — and the catch in `registerDeferredOrderReceipts` turns that into a retained marker
// and a row the sweep comes back to. One idempotent re-enqueue against a payment that never posts:
// the asymmetry `followUpObligationClaim` was designed around, in the direction it was designed for.
// ---------------------------------------------------------------------------

/**
 * Re-read every receipt on this order under the sales-order lock and, only if none awaits
 * registration AND the caller's own settlement prerequisite holds, clear the caller's obligation
 * generation in the SAME transaction as that re-read.
 *
 * Exported so the interleaving regression test can drive the fence directly rather than through a
 * connector, and so nothing has to re-implement "is this order finished with?" a second time.
 *
 * NEVER re-reads the caller's snapshot. The `receipts` selection, the sync rows and the release all
 * happen inside a transaction that holds `lockSalesOrder`, and a release NEVER happens in a
 * different transaction from the re-read that permitted it — which is the property, rather than the
 * number of transactions the call takes.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SPLIT IN TWO WHEN A PREREQUISITE IS HANDED OVER (o3d-0bfh r16, Codex HIGH).
 *
 * r15 put the release inside the fence, which is right and stays. What it also did was make the
 * clear the FIRST of the caller's settlement writes rather than the last: the back-reference sweep
 * hands its generation down here, and only afterwards persists the warning that says WHY a
 * tombstone's follow-ups will never run. A warning that then failed to persist left the row with its
 * obligation already discharged — SYNCED, linked, marker null — which the next sweep reads as a
 * reconciled row and stamps in silence. The compacted payment registration is gone, and so is the
 * notice that was supposed to gate its loss.
 *
 * So the two facts are established in order, each under the lock, with the caller's write between
 * them:
 *
 *   1. A FENCED RE-READ that clears nothing. If a receipt is still awaiting registration this
 *      answers `retained` and stops — the caller is not told to announce anything, which keeps the
 *      existing rule that a terminal discard is never announced on a pass that also failed to
 *      register a receipt.
 *   2. THE CALLER'S PREREQUISITE, outside any transaction. Deliberately not run inside the fence:
 *      it writes to the activity log and reads the order, and holding the sales-order row lock —
 *      the lock `addPayment` takes on the money path — across a caller's I/O is how the sweep and
 *      the live path would deadlock. The failure being gated on is precisely a slow or unavailable
 *      log, which is the worst thing to hold that lock through.
 *   3. THE FENCED RELEASE, over a FRESH re-read. A receipt that commits between (1) and (3) is seen
 *      by (3) and keeps the marker, exactly as r15 requires — the window is not reopened by the
 *      split, because the release still only ever happens in the same transaction as a re-read that
 *      found nothing awaiting. The only cost is that a terminal warning can be announced once for a
 *      row that then retains its marker; the row is not settled, so it comes back and re-announces,
 *      which is noise rather than loss.
 * ---------------------------------------------------------------------------
 */
export async function dischargeDeferredReceiptObligation(
  orderId: string,
  posted: PostedInvoiceEvidence,
  obligation: DeferredReceiptObligation | null,
): Promise<{ awaiting: number; release: DeferredReceiptRelease }> {
  const prerequisite = obligation?.settlementPrerequisite
  // No prerequisite stated: one pass, exactly as r15 left it. Every connector post path is here.
  if (!prerequisite) return fencedReceiptPass(orderId, posted, obligation)
  // (1) The obligation is WITHHELD from this pass — `null` is what makes it clear nothing — so its
  // answer is only ever "is anything still awaiting?".
  const observed = await fencedReceiptPass(orderId, posted, null)
  if (observed.awaiting > 0) return observed
  // (2) The caller's own settlement evidence, before anything is discharged on the strength of it.
  if (!(await prerequisite())) return { awaiting: 0, release: 'prerequisite-unmet' }
  // (3) And only now the release, fenced again over receipts as they are at this instant.
  return fencedReceiptPass(orderId, posted, obligation)
}

/**
 * ONE fenced pass: take the order lock, re-read the receipts, and release the caller's generation in
 * the same transaction if — and only if — nothing awaits registration and a generation was handed
 * over. Handed `null` it is a pure read, which is what the first pass above needs.
 */
async function fencedReceiptPass(
  orderId: string,
  posted: PostedInvoiceEvidence,
  obligation: DeferredReceiptObligation | null,
): Promise<{ awaiting: number; release: DeferredReceiptRelease }> {
  return db.$transaction(async (tx) => {
    // THE SAME LOCK `addPayment` TAKES, and taken FIRST — see lib/domain/sales/allocation-service.
    // A receipt cannot be inserted for this order while this is held, so the read below is the whole
    // receipt set as of the moment the marker is cleared, not a snapshot from before the loop.
    await lockSalesOrder(tx, orderId)
    const receipts = await tx.payment.findMany({
      // A refund payment settles a CREDIT NOTE, not this invoice — the same predicate the pass's own
      // read uses, because a wider one here would hold the obligation open over a refund.
      where: { orderId, refundId: null },
      select: { id: true, amount: true, currency: true, method: true, reference: true, paidAt: true },
      orderBy: { paidAt: 'asc' },
    })
    const awaiting = selectReceiptsAwaitingRegistration({
      receipts,
      // Read THROUGH the transaction, so a sync row a concurrent registration has just written is
      // visible and serialised by the lock this holds.
      existing: await loadInvoicePaymentSyncRows(orderId, posted.connector, tx),
      accountingInvoiceId: posted.accountingInvoiceId,
    })
    // A receipt is still owed to the ledger, so the marker is the record of that and stays.
    if (awaiting.length > 0) return { awaiting: awaiting.length, release: 'retained' as const }
    // Nothing is awaiting and the caller holds no obligation to clear: some callers (a connector
    // with no consumer for the marker) genuinely have none. Answered explicitly rather than as
    // `released`, so "the marker is gone" is never claimed by a call that cleared nothing.
    if (!obligation) return { awaiting: 0, release: 'not-held' as const }
    const release = await releaseFollowUpObligation(tx, {
      syncLogId: obligation.syncLogId,
      connector: obligation.connector,
      generation: obligation.generation,
      recovery: obligation.recovery,
    })
    return { awaiting: 0, release }
  }, RECEIPT_FENCE_TX_OPTIONS)
}

/**
 * Thrown to ROLL BACK a registration that was written under a connector this call did not pin.
 *
 * `queueAccountingSyncTx` resolves the active connector for ITSELF, after the pin was taken, so a clean
 * `queued` says a row exists and says nothing about which ledger it was written for. The capacity
 * arithmetic above it was measured against the PINNED connector's rows, so a row written for the other
 * one is measured against nothing at all. Throwing out of the transaction is what makes that
 * unwritten rather than merely reported.
 */
class PinnedConnectorMoved extends Error {
  constructor(
    readonly wroteFor: string | null,
    /**
     * o3d-ekn8 r4 (Codex MEDIUM) — DID THIS CALL ACTUALLY WRITE THE ROW?
     *
     * `queueAccountingSyncTx` reports `queued: true` WITHOUT WRITING when its idempotency
     * short-circuit finds a live row under the same key. Throwing then rolls back an empty
     * transaction: the pre-existing PENDING row is untouched and WILL post, so the operator must not
     * be told "nothing was sent". The two cases need different messages, and this is what separates
     * them.
     */
    readonly alreadyQueued: boolean,
  ) {
    super(`accounting connector moved to ${wroteFor ?? 'none'} under a pinned payment registration`)
    this.name = 'PinnedConnectorMoved'
  }
}

/**
 * Register a manually-recorded sales receipt against the ledger invoice (o3d-lgo.15).
 *
 * An IMPORTED paid order registers its payment through the SALES_INVOICE follow-up (`_registerPayment`).
 * A receipt entered in IMS had no such path: the Payment row was created, the order went green, and the
 * ledger was never told — so it went on showing the invoice fully outstanding, for ever. This closes
 * that, on the same principle as markBillPaid: an operator recording a payment against a posted document
 * is an instruction to settle it in the ledger too.
 *
 * GUARDED, because the ledger may already know. Every refusal below leaves the payment recorded and the
 * settlement verdict visibly unsettled, which is the safe end: an operator can register it by hand, and
 * a second payment in a ledger nobody is watching cannot be undone by looking at IMS.
 *
 * Never throws — failing to register must not fail the receipt the operator just recorded.
 */
/**
 * o3d-ekn8 r3 (Codex HIGH) — THE ENQUEUE'S IDEMPOTENCY KEY CARRIES THE DOCUMENT ANCHOR.
 *
 * `queueAccountingSync` short-circuits on this key: it looks for a live row on the same
 * (connector, type, referenceType, referenceId) whose payload holds it, and REPORTS `queued: true`
 * WITHOUT WRITING ANYTHING when it finds one. Keyed on the receipt alone, that short-circuit was the
 * second document-blind write-side gate — an invoice deleted and re-posted found the retired
 * document's row under the same key and reported the replacement's payment as already queued, so
 * relaxing the selector above it would have changed nothing.
 *
 * The anchor makes this key agree with the two things it sits between, rather than being a third
 * opinion:
 *
 *   • `accounting_sync_logs_followup_live_unique` is already (connector, type, referenceType,
 *     referenceId, accountingInvoiceId, creditNoteId, paymentId) — receipt AND document. Two live
 *     registrations for one (receipt, document) are still refused by the database, so anchoring the
 *     key cannot open a second payment on the same invoice; it only stops the key claiming a
 *     DIFFERENT document's row as this one.
 *   • `buildFollowUpIdempotencySource` already folds the payload anchors into the REMOTE token, so
 *     the ledger key and the local key now name the same thing.
 *
 * A live row queued before this shipped carries the un-anchored key and will not be matched. Such a
 * row is refused by the unique index above rather than double-posted — a loud failure, not a silent
 * second payment — and only for the rows that were in flight at the moment of deploy.
 */
export function invoicePaymentEnqueueKey(paymentId: string, accountingInvoiceId: string): string {
  return `invoice-payment:payment:${paymentId}:invoice:${accountingInvoiceId}`
}

// ---------------------------------------------------------------------------
// WHAT ACTUALLY COMES BACK FOR A RECEIPT THIS MODULE REFUSED (o3d-0bfh r13, Codex HIGH).
//
// Every operator message below used to end in the same sentence — "register the payment in the
// ledger by hand", on the pinned branches beside "re-run the invoice sync for this order". On the
// OPERATOR-ENTERED path that is the only exit there is: nothing was queued, no obligation marker
// exists anywhere, and nothing will ever revisit the receipt. Banning a hand registration THERE
// would strand a customer's payment for good, which is why this file is not, and must not be,
// added to the whole-file scan that judges the retained-obligation producers.
//
// IT IS THE EXACT OPPOSITE ON THE DEFERRED PATH, and that is what r12 left undecided.
// `registerDeferredOrderReceipts` is called by a connector immediately after a SALES_INVOICE posts,
// INSIDE a claimed follow-up obligation, and every receipt it leaves unregistered makes it answer
// `settled: false` — on which the connector DELIBERATELY RETAINS the marker rather than clearing it.
// What re-reads a retained marker is a fact the registry declares per connector
// (`followUpObligationRecoveryFor`), and on Xero it is a bound, cron-invoked sweep that re-drives
// THIS VERY FUNCTION. So a hand remedy there races work that is already scheduled, and a payment a
// human keys into the accounting package's own UI carries no request id the queued row could ever be
// deduplicated against: both settle the invoice, and a second payment is not undoable.
//
// That is the same defect this branch removed from four other producers — the Xero processor, the
// back-reference sweep, the compacted-tombstone announcement, and the registry remedy itself. The
// fact the distinction turns on is `postedUnder`, which is what {@link InvoicePaymentRedrive}
// carries: it is not a property of the refusal REASON, because most of these branches are reachable
// from both paths and the same reason is safe on one and unsafe on the other.
//
// THE THIRD CASE IS DOCUMENT_NOT_POSTED, and it is the one r12 did not see at all. That refusal
// writes no sync row, and a receipt with no sync row of its own is EXACTLY what
// `selectReceiptsAwaitingRegistration` picks up when the SALES_INVOICE finally does post. So the
// automatic recovery is not behind a retained marker there — it is the deferred re-drive itself,
// still ahead of us. A hand registration in that window races it just as surely.
// ---------------------------------------------------------------------------

/**
 * WHAT WILL COME BACK FOR THIS RECEIPT once the message below has been written.
 *
 * Three states, and every operator string in this module ends in the remedy that belongs to the one
 * it is in. Deliberately NOT a boolean: "automatic" is not one fact here — on the deferred path the
 * recovery is a RETAINED MARKER whose consumer the registry declares per connector, and before the
 * invoice posts it is the re-drive that has not happened yet. The two have different remedies and
 * different failure modes, and collapsing them is how a connector with no consumer would inherit
 * Xero's sweep by omission (the r6 finding, one level down).
 */
export type InvoicePaymentRedrive =
  /**
   * Reached from `registerDeferredOrderReceipts`, i.e. under a follow-up obligation the connector
   * claimed for this post and will RETAIN because this receipt is left unregistered. The connector
   * is the PINNED one, never the active one — the registry answer must be about the ledger the
   * obligation is actually owed on.
   */
  | { redrive: 'deferred'; connector: string }
  /**
   * The invoice has not posted yet, so this receipt has no sync row and the deferred re-drive at the
   * next SALES_INVOICE post is what registers it. Automatic, conditional only on the DOCUMENT sync
   * that the message already tells the operator to chase.
   */
  | { redrive: 'invoice-post' }
  /**
   * THE DURABLE STATE COULD NOT BE READ (o3d-0bfh r14, Codex HIGH), so it is assumed that a recovery
   * exists. Suppressing a remedy a human could have carried out is recoverable — somebody asks again
   * — and licensing a settlement that races a queued registration is not. `connector` is the best
   * available guess and may be null; nothing in this state promises what will come back, because
   * nothing here knows.
   */
  | { redrive: 'recovery-unknown'; connector: string | null }
  /** Nothing holds an obligation and no re-drive is ahead: the hand remedy is the only exit. */
  | { redrive: 'none' }

/**
 * The remedy sentence for one refusal — the ONE place in this module that says what a human should
 * do, so a branch cannot acquire a hand remedy by having prose written at its call site.
 *
 * On the deferred path the recovery half is `followUpObligationRecoveryNote` over the REGISTRY's
 * declaration for the pinned connector, exactly as `releaseFollowUpObligation`, the Xero processor
 * and the sweep already do. Nothing about what re-drives a retained obligation is written as prose
 * here, on any connector: Xero's bound sweep and QuickBooks' "nothing does, READ AND ESCALATE" are
 * both the registry's answers, not this module's guesses.
 */
export function invoicePaymentRemedyNote(redrive: InvoicePaymentRedrive): string {
  if (redrive.redrive === 'recovery-unknown') {
    return 'HAND SETTLEMENT IS REFUSED HERE: IMS could not read whether a registration is still owed for this '
      + 'receipt — the follow-up obligation state for this order was unreadable — so it must be assumed that one '
      + 'is. That is the only safe direction: a remedy withheld from a human can be asked for again, while a '
      + "payment keyed into the accounting package's own UI carries no request id, so nothing could deduplicate "
      + 'it against a registration that turns out to be owed, and both would settle the invoice, which is not '
      + 'undoable. Read the document, record what is actually there, and ESCALATE.'
  }
  if (redrive.redrive === 'none') {
    return 'Nothing will come back for this receipt, so register it in the accounting connector by hand if it is '
      + 'genuinely owed.'
  }
  if (redrive.redrive === 'invoice-post') {
    return 'HAND SETTLEMENT IS REFUSED HERE: this receipt has no sync row of its own, which is exactly what the '
      + 'deferred re-registration selects, so the connector registers it automatically as soon as the invoice for '
      + "this order posts. A payment keyed into the accounting package's own UI carries no request id, so nothing "
      + 'could deduplicate it against that registration and both would settle the invoice. Chase the DOCUMENT sync; '
      + 'if the invoice cannot be posted at all, record what the accounting package already holds and ESCALATE.'
  }
  return 'HAND SETTLEMENT IS REFUSED HERE: this receipt is still owed under a follow-up obligation the connector '
    + `retains precisely because it is unregistered, and ${followUpObligationRecoveryNote(followUpObligationRecoveryFor(redrive.connector))}. `
    + "A payment keyed into the accounting package's own UI carries no request id, so nothing could deduplicate it "
    + 'against the registration that is still owed and both would settle the invoice, which is not undoable. Read '
    + 'the document, record what is actually there, and ESCALATE.'
}

// ---------------------------------------------------------------------------
// DOES A DEFERRED RECOVERY EXIST FOR *THIS RECEIPT*? (o3d-0bfh r14, Codex HIGH.)
//
// r13 answered that with `postedUnder`, which is a property of THIS INVOCATION, while the question
// the operator message actually answers is a property of THE RECEIPT — is anything going to come
// back for it? The two come apart in one interleaving, and it is reachable today:
//
//   1. the SALES_INVOICE post commits its SYNCED transaction, which CLAIMS the follow-up obligation
//      (claimFollowUpObligation, inside that transaction);
//   2. `updateBackReference` then writes `salesOrder.accountingInvoiceId`;
//   3. `addPayment` commits a receipt and calls this module with NO pin. The document is now posted,
//      so the refusal is not DOCUMENT_NOT_POSTED — on a refusal both paths share, such as
//      NO_BANK_ACCOUNT, r13's classifier answered `none` and the notice licensed a hand settlement;
//   4. `registerDeferredOrderReceipts` only then reads the payments. It selects that same receipt —
//      having no sync row of its own is exactly what `selectReceiptsAwaitingRegistration` looks for
//      — refuses it under the pin, answers `settled: false`, and the connector RETAINS the marker
//      precisely so its sweep comes back to it.
//
// So the settlement licensed at (3) races the registration (4) schedules, which is the double
// payment this whole round exists to prevent.
//
// THE DURABLE READ, AND A LOCK — BOTH, BECAUSE THEY ANSWER DIFFERENT HALVES (o3d-0bfh r15).
//
// The read is what makes the state legible to a caller that holds no pin: the obligation marker is
// claimed at step (1), STRICTLY BEFORE the back-reference write at step (2) that opens the window at
// all, so for the whole of the window in which an unpinned call can see a posted document from that
// pass, the marker is live. That is true, and r14 stopped there.
//
// IT IS NOT SUFFICIENT, and the reason is the sentence this block used to end on. The marker answers
// "IS A PASS IN FLIGHT". It does NOT answer "DID THAT PASS SEE THIS RECEIPT" — the pass's view of
// which receipts exist is fixed at its own snapshot, so a receipt committing after that snapshot
// reads `held`, is told its recovery is retained, and is then not in the set the pass verifies
// against before its marker is cleared. So the RELEASE is serialized against receipt insertion:
// `dischargeDeferredReceiptObligation` takes the same sales-order lock `addPayment` takes, re-reads
// every current receipt and sync row inside it, and clears the exact generation in that same
// transaction. What was rejected — and still is — is serializing the WHOLE pass, remote calls
// included: that is what would put a network round trip inside a lock on the money path. Only the
// recheck and the release are fenced, and the block above that function says why that suffices.
//
// TESTED FOR EXISTENCE ONLY. It is a generation, not a time — see the "WHAT
// `backReferenceFollowUpsPendingAt` IS, AND WHAT IT IS NOT" block in
// lib/domain/accounting/follow-up-obligation-registry.ts, and the scan over `lib` that enforces it.
//
// SCOPED TO (SALES_INVOICE, SalesOrder), the one pair in BACK_REFERENCE_PAIRS that writes
// `SalesOrder.accountingInvoiceId` and therefore the one whose follow-ups call
// `registerDeferredOrderReceipts`.
//
// NOT NARROWED TO THE CONNECTOR THAT IS ACTIVE NOW. A pass pinned to whichever connector holds the
// obligation selects this receipt just the same — it has no sync row on any ledger — and would
// register it against THAT one, so asking only about today's active connector would be the same
// wrong-object mistake one level along. The connector predicate that IS there enumerates the WHOLE
// accounting registry (plus the caller's own, if it somehow is not in it), which is a set the row
// cannot be outside; it exists so the read uses an index rather than scanning the sync log. See
// `connectorsThatCanOweFollowUps`.
// ---------------------------------------------------------------------------

/** What the durable follow-up obligation state says about a receipt on this order. */
export type DeferredReceiptRecovery =
  /** A follow-up obligation for this order is live, so a deferred registration can still select it. */
  | { state: 'held'; connector: string }
  /** No obligation is outstanding: nothing pinned to this order is going to come back for it. */
  | { state: 'none' }
  /**
   * The state could not be read. NOT collapsed into `none` — that is the answer that licenses a
   * settlement, and "we could not find out" is not evidence for it.
   */
  | { state: 'unreadable'; connector: string | null }

/** The minimal Prisma surface the read touches. Structural, so a test double fits. */
export type DeferredReceiptRecoveryClient = {
  accountingSyncLog: {
    findMany(args: {
      where: Record<string, unknown>
      select: { connector: true }
      orderBy: Array<Record<string, 'asc' | 'desc'>>
    }): Promise<Array<{ connector: string }>>
  }
}

/**
 * EVERY accounting connector, from the one registry that defines them — never a list spelt here.
 *
 * The predicate below names it so the read can use @@index([connector, referenceType, referenceId]);
 * without a leading connector this is a sequential scan of the sync log. It is EXHAUSTIVE rather than
 * a guess: `AccountingSyncLog.connector` is written by an accounting connector and
 * `AccountingConnectorId` is the closed type of those, so "in the registry" and "any row that exists"
 * are the same set. A caller's own connector is unioned in anyway, because the one direction that
 * costs money here is a live obligation this query did not look for.
 */
function connectorsThatCanOweFollowUps(preferredConnector: string | null): string[] {
  const declared = ACCOUNTING_CONNECTORS.map((connector) => connector.id as string)
  return preferredConnector && !declared.includes(preferredConnector) ? [...declared, preferredConnector] : declared
}

/**
 * The predicate, as a value, so the test that proves this asks about the RECEIPT'S ORDER rather than
 * about the caller can read the question instead of re-typing it.
 *
 * `{ not: null }` and nothing else on the marker. Any other operator on that column is a range
 * comparison against a generation and is rejected by the scan named above.
 */
export function deferredReceiptRecoveryWhere(orderId: string, preferredConnector: string | null): Record<string, unknown> {
  return {
    connector: { in: connectorsThatCanOweFollowUps(preferredConnector) },
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: orderId,
    backReferenceFollowUpsPendingAt: { not: null },
  }
}

/**
 * Read whether a deferred registration is still owed for this order.
 *
 * NEVER THROWS, and the failure answer is `unreadable` rather than `none`: see the type. The
 * `preferredConnector` only decides WHICH live obligation names the remedy when more than one
 * connector holds one; it never decides whether one exists.
 */
export async function readDeferredReceiptRecovery(
  orderId: string,
  preferredConnector: string | null,
  client: DeferredReceiptRecoveryClient,
): Promise<DeferredReceiptRecovery> {
  try {
    const rows = await client.accountingSyncLog.findMany({
      where: deferredReceiptRecoveryWhere(orderId, preferredConnector),
      select: { connector: true },
      // Deterministic, so two renders of the same state name the same connector.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (rows.length === 0) return { state: 'none' }
    const held = rows.find((row) => row.connector === preferredConnector) ?? rows[0]!
    return { state: 'held', connector: held.connector }
  } catch (error) {
    console.error(
      'invoice payment registration: could not read whether a deferred registration is owed for this order, '
      + 'so it is assumed to be',
      orderId,
      error,
    )
    return { state: 'unreadable', connector: preferredConnector }
  }
}

/**
 * The redrive state for one call of {@link registerInvoicePaymentWithLedger}.
 *
 * `recovery` is REQUIRED (o3d-0bfh r14). It was the absence of this argument that let the classifier
 * answer a question about the receipt with a fact about the call; making it optional, or defaulting
 * it to `{ state: 'none' }`, would put that back one keystroke at a time.
 */
export function invoicePaymentRedriveFor(
  pinned: PostedInvoiceEvidence | null,
  refusal: InvoicePaymentRegistrationRefusal | null,
  recovery: DeferredReceiptRecovery,
): InvoicePaymentRedrive {
  if (pinned) return { redrive: 'deferred', connector: pinned.connector }
  // Unpinned, but the durable state says a follow-up obligation for this order is still outstanding,
  // so a deferred pass can still select this receipt. Same state, same remedy, whoever is asking.
  if (recovery.state === 'held') return { redrive: 'deferred', connector: recovery.connector }
  // Unpinned, and the document is not there yet: the post that triggers the deferred re-drive is
  // still ahead of us, and this receipt is what it will select.
  if (refusal === 'DOCUMENT_NOT_POSTED') return { redrive: 'invoice-post' }
  if (recovery.state === 'unreadable') return { redrive: 'recovery-unknown', connector: recovery.connector }
  return { redrive: 'none' }
}

/**
 * EVERY REFUSAL MESSAGE `reportRefusal` CAN WRITE, as a pure producer (o3d-0bfh r13, Codex HIGH).
 *
 * Extracted out of the reporting closure so the runtime contract in
 * tests/accounting/follow-up-recovery-registry.test.ts can take THE BRANCH'S OWN STRING for both
 * redrive states rather than judging a sentence somebody re-typed into a test. `null` is
 * SYNC_DISABLED, which reports nothing at all: nothing was expected to post.
 */
export function describeInvoicePaymentRefusal(params: {
  refused: InvoicePaymentRegistrationDecision & { register: false }
  orderReference: string
  amount: number
  currency: string
  orderCurrency: string
  method: string | null
  redrive: InvoicePaymentRedrive
}): { description: string; metadata: Record<string, unknown> } | null {
  const { refused, redrive } = params
  const amount = `${params.currency} ${params.amount.toFixed(2)}`
  const remedy = invoicePaymentRemedyNote(redrive)
  const base = { amount: params.amount, currency: params.currency, refusal: refused.refusal }
  const withLedger = { ...base, detail: refused.detail, ledgerTotal: refused.ledgerTotal }
  const withRegistered = { ...base, alreadyRegistered: refused.alreadyRegistered, ledgerTotal: refused.ledgerTotal }
  switch (refused.refusal) {
    // Nothing is expected to post at all, so there is nothing to report.
    case 'SYNC_DISABLED':
      return null
    // Not a settlement fault — a payment cannot attach to an invoice the ledger has never seen, and
    // the DOCUMENT sync is what to chase. The receipt is NOT abandoned: it carries no sync row, so
    // the re-drive at the next SALES_INVOICE post is what registers it, which is why the remedy for
    // this branch refuses hand settlement rather than offering it (see invoicePaymentRedriveFor).
    case 'DOCUMENT_NOT_POSTED':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but its invoice has not posted to the `
          + `accounting connector yet, so the payment could not be registered there. ${remedy}`,
        metadata: base,
      }
    // addPayment rejects a currency mismatch, so this only fires if the order currency changed
    // underneath the receipt. Registering the wrong currency is worse than not registering.
    case 'CURRENCY_MISMATCH':
      return {
        description:
          `Recorded a ${params.currency} payment against ${params.orderReference}, which is in `
          + `${params.orderCurrency}. The payment was NOT registered in the accounting connector. ${remedy}`,
        metadata: { ...base, orderCurrency: params.orderCurrency },
      }
    case 'NO_BANK_ACCOUNT':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but no bank account is mapped for method `
          + `"${params.method ?? ''}" / currency "${params.currency}". Add a mapping in Settings → `
          + `Accounting → Payment Account Mapping. ${remedy}`,
        metadata: { ...base, method: params.method },
      }
    // o3d-0m56: an earlier attempt on this order is FAILED or CANCELLED and the ledger could not be
    // shown NOT to hold its payment. The capacity arithmetic cannot see this — a failed row
    // consumes no capacity — so without this arm the receipt would look like it fits and a second
    // payment would post. `detail` says which of the two it was: the ledger was unreachable, or it
    // answered and the answer matched the earlier attempt.
    case 'UNRESOLVED_PAYMENT_ATTEMPT':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but an earlier payment attempt on this `
          + `order did not resolve and could not be ruled out in the accounting connector `
          + `(${refused.detail ?? 'no detail'}). Sending this one could pay the invoice twice, so it was `
          + `not sent. Resolve the earlier attempt on the Accounting Sync page first. ${remedy}`,
        metadata: withLedger,
      }
    // o3d-ekn8 r4: a LIVE row for this receipt settles a document the order no longer points at —
    // the invoice was deleted and re-posted. Every document-scoped filter drops that row, which is
    // right for capacity and wrong for evidence: it is the record of a payment that was SENT, and
    // nothing here has read the ledger to see whether deleting the old document took it away.
    case 'SETTLED_ON_RETIRED_DOCUMENT':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but this receipt is ALREADY REGISTERED `
          + `in the accounting connector against a different document (${refused.detail ?? 'unnamed'}) — `
          + `that invoice was deleted and re-posted, so the order now points somewhere else. The earlier `
          + `payment was actually sent, and on some connectors a deleted invoice leaves its payment behind `
          + `as an unapplied credit, so sending this one could credit the customer twice. Nothing was sent. `
          + `Open that payment in the accounting system: if it is genuinely gone, cancel the earlier sync `
          + `row on the Accounting Sync page and the next invoice sync will register this receipt against `
          + `the new document. ${remedy}`,
        metadata: withLedger,
      }
    // o3d-anu8: a registration on this invoice was SETTLED BY AN OPERATOR, so the figure IMS holds
    // for it is what IMS meant to send and not what the ledger recorded. There IS a document id
    // to go and read, which is what separates this from LEDGER_AMOUNT_UNKNOWN, so the message
    // names it and says what reading it decides.
    case 'LEDGER_AMOUNT_ASSERTED':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but a payment already registered against this `
          + `invoice (${refused.detail ?? 'unnamed'}) was recorded on an OPERATOR'S ASSERTION rather than confirmed by `
          + `the accounting connector — IMS never made that call and never read the document, so the amount it holds `
          + `for it is what it MEANT to send, not what the ledger recorded. How much of the invoice is still `
          + `outstanding therefore cannot be computed, and this receipt was not sent. Open that payment in the `
          + `accounting system and confirm what it actually settled. ${remedy}`,
        metadata: withLedger,
      }
    // A registration is already on the invoice but IMS cannot read WHAT it was for, so the room
    // left on the invoice is unknown. Naming a figure here would be inventing one (o3d-cjt8).
    case 'LEDGER_AMOUNT_UNKNOWN':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but a payment already sent to the `
          + `accounting connector for this invoice does not record its amount, so IMS cannot tell how `
          + `much of the invoice is still outstanding. It was not sent. ${remedy}`,
        metadata: withRegistered,
      }
    // Since o3d-cjt8 this is a CAPACITY refusal, not a one-per-order one: part payments each
    // register, and only the receipt that would take the total past the invoice is refused. So the
    // message has to name what is already on it, not just the invoice total.
    case 'WOULD_OVERPAY':
      return {
        description:
          `Recorded ${amount} against ${params.orderReference}, but the invoice the accounting connector `
          + `holds is for ${params.currency} ${(refused.ledgerTotal ?? 0).toFixed(2)}`
          + (refused.alreadyRegistered
            ? ` with ${params.currency} ${refused.alreadyRegistered.toFixed(2)} already registered against it`
            : '')
          + ` — it would refuse a larger payment. Check the invoice in the ledger: on a tax-inclusive `
          + `imported order it can be posted NET of VAT. ${remedy}`,
        metadata: withRegistered,
      }
  }
}

/**
 * The order stopped pointing at the document this post returned — before the queue (`before-queue`)
 * or between the pre-check and the write (`while-queueing`).
 *
 * REACHABLE ONLY WITH A PIN, on both phases: each site is inside `if (pinned …)`. So the redrive is
 * always `deferred` and the remedy is always the registry's, which is precisely Codex's r13 finding
 * — this branch told an operator to re-run the sync and register by hand in front of a re-drive the
 * retained marker guarantees.
 */
export function invoicePaymentDocumentMovedDescription(params: {
  phase: 'before-queue' | 'while-queueing'
  orderReference: string
  amount: number
  currency: string
  postedInvoiceId: string
  currentInvoiceId: string | null
  connector: string
}): string {
  const head = `Recorded ${params.currency} ${params.amount.toFixed(2)} against ${params.orderReference}, but `
  const remedy = invoicePaymentRemedyNote({ redrive: 'deferred', connector: params.connector })
  return params.phase === 'before-queue'
    ? head
      + `the invoice that had just posted (${params.postedInvoiceId}) is no longer the one this order points `
      + `at (${params.currentInvoiceId ?? 'none'}) — it was re-posted while the receipt was being registered. `
      + `Nothing was sent. ${remedy}`
    : head
      + `its invoice was re-posted while the payment was being queued, so the document this receipt was `
      + `measured against (${params.postedInvoiceId}) is no longer the one the order holds. Nothing was sent. `
      + `${remedy}`
}

/**
 * The enqueue wrote for a connector this call did not pin — see {@link PinnedConnectorMoved}.
 *
 * ALSO PIN-ONLY (the throw is guarded by `pinned &&`), so both arms carry the registry remedy. The
 * `alreadyQueued` arm keeps its own instruction — cancelling a live row on the Accounting Sync page
 * is not a hand settlement, it is the removal of one — and gains the refusal, because the row that
 * is still live is a QUEUED registration and creating a second by hand is the hazard.
 */
export function invoicePaymentConnectorMovedDescription(params: {
  orderReference: string
  amount: number
  currency: string
  pinnedConnector: string | null
  wroteFor: string | null
  alreadyQueued: boolean
}): string {
  const head =
    `Recorded ${params.currency} ${params.amount.toFixed(2)} against ${params.orderReference}, but the `
    + `active accounting connector changed from ${params.pinnedConnector ?? 'none'} to `
    + `${params.wroteFor ?? 'none'} while the payment was being queued, so the registration would have `
    + `been sent to a ledger it was never measured against.`
  const remedy = invoicePaymentRemedyNote(
    params.pinnedConnector
      ? { redrive: 'deferred', connector: params.pinnedConnector }
      : { redrive: 'none' },
  )
  // o3d-ekn8 r4: the rollback only rolls something back if this call WROTE something. On the
  // idempotency short-circuit it did not — a live row was already there under the other connector,
  // the transaction had nothing in it to undo, and that row is still going to post. Telling an
  // operator "nothing was sent" there is the one message that stops them looking.
  return params.alreadyQueued
    ? `${head} A registration for this receipt was ALREADY QUEUED under `
      + `${params.wroteFor ?? 'none'} before this ran, so there was nothing to roll back and THAT ROW `
      + `IS STILL LIVE AND WILL POST. Check it on the Accounting Sync page and cancel it if it must not `
      + `go to that ledger. ${remedy}`
    : `${head} Nothing was sent. ${remedy}`
}

/** Payment posting was switched off between the check and the write. Reachable pinned and unpinned. */
export function invoicePaymentPostingContextChangedDescription(params: {
  orderReference: string
  amount: number
  currency: string
  redrive: InvoicePaymentRedrive
}): string {
  return `Recorded ${params.currency} ${params.amount.toFixed(2)} against ${params.orderReference}, but `
    + `accounting sync for payments was switched off while it was being queued, so nothing was sent. `
    + `Re-enable it. ${invoicePaymentRemedyNote(params.redrive)}`
}

/**
 * The enqueue threw. Same shape as markBillPaid's queue failure: the receipt is recorded in IMS with
 * nothing queued to tell the ledger and no FAILED row to notice, because the row was never written.
 *
 * Reachable pinned and unpinned, and the two are genuinely different: unpinned, nothing will ever
 * retry and the hand remedy is the only exit; pinned, the connector retains the obligation on
 * `settled: false` and the registry says what re-reads it.
 */
export function invoicePaymentNotQueuedDescription(params: {
  orderReference: string
  amount: number
  currency: string
  redrive: InvoicePaymentRedrive
}): string {
  return `Recorded ${params.currency} ${params.amount.toFixed(2)} against ${params.orderReference}, but the `
    + `payment could not be queued for the accounting connector — the ledger still shows the invoice `
    + `outstanding. ${invoicePaymentRemedyNote(params.redrive)}`
}

/**
 * THE DEFERRED WRAPPER'S OWN THREE MESSAGES (o3d-0bfh r13, Codex HIGH).
 *
 * Every one of these is written from inside `registerDeferredOrderReceipts`, i.e. always under a
 * claimed obligation, and every one of them returns `settled: false` — so the connector retains the
 * marker and the registry's declared consumer is what comes back. There is no unpinned form of any
 * of them, which is why they take a connector and not a redrive.
 */
export function deferredReceiptsUnlinkedDescription(params: {
  connector: string
  postedInvoiceId: string
  receipts: number
}): string {
  return `The invoice for this order posted to ${params.connector} as ${params.postedInvoiceId}, but the `
    + `order carries no invoice id — the back-reference write did not land — so the ${params.receipts} `
    + `receipt(s) recorded before it were NOT registered. Link the order to ${params.postedInvoiceId}. `
    + invoicePaymentRemedyNote({ redrive: 'deferred', connector: params.connector })
}

export function deferredReceiptsDocumentMovedDescription(params: {
  connector: string
  postedInvoiceId: string
  currentInvoiceId: string
}): string {
  return `The invoice that just posted (${params.postedInvoiceId}) is no longer the one this order `
    + `points at (${params.currentInvoiceId}), so the receipts recorded before it were NOT registered `
    + `— they would have settled a document this post did not create. `
    + invoicePaymentRemedyNote({ redrive: 'deferred', connector: params.connector })
}

export function deferredReceiptsFailedDescription(params: { connector: string; error: string }): string {
  return `The invoice for this order posted, but the receipts recorded before it could not be registered `
    + `with the accounting connector: ${params.error}. `
    + invoicePaymentRemedyNote({ redrive: 'deferred', connector: params.connector })
}

export async function registerInvoicePaymentWithLedger(params: {
  orderId: string
  orderReference: string
  paymentId: string
  amount: number
  currency: string
  method: string | null
  reference: string | null
  paidAt: Date
  /**
   * The post this registration is a consequence of (o3d-ekn8 r2). Supplied ONLY by the deferred
   * re-drive, which has it; the operator-entered receipt path has no such post behind it and passes
   * nothing, so it keeps resolving the active connector and reading the order's current invoice id.
   * An ADDITION, not a substitution.
   */
  postedUnder?: PostedInvoiceEvidence
}): Promise<void> {
  const warn = async (action: string, description: string, metadata: Record<string, unknown>) => {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.orderId,
      action,
      tag: 'accounting',
      level: 'WARNING',
      description,
      metadata: { orderNumber: params.orderReference, paymentId: params.paymentId, ...metadata },
    }).catch(() => { /* logging must never block the receipt */ })
  }

  const pinned = params.postedUnder ?? null

  // WHICH live obligation names the remedy when more than one connector holds one — filled in below
  // once the active connector is resolved. It never decides WHETHER one exists (o3d-0bfh r14).
  let preferredConnector: string | null = pinned?.connector ?? null

  /**
   * THE DURABLE ANSWER TO "IS ANYTHING GOING TO COME BACK FOR THIS RECEIPT?", read at most once.
   *
   * A PINNED call needs no query: it IS the deferred pass, holding the obligation this would look
   * for. A receipt that registers cleanly asks nothing either — this is only ever awaited on a path
   * that is about to write an operator message.
   */
  let recoveryRead: Promise<DeferredReceiptRecovery> | null = null
  const deferredRecovery = (): Promise<DeferredReceiptRecovery> => {
    if (pinned) return Promise.resolve<DeferredReceiptRecovery>({ state: 'held', connector: pinned.connector })
    recoveryRead ??= readDeferredReceiptRecovery(params.orderId, preferredConnector, db)
    return recoveryRead
  }
  /**
   * THE ONE PLACE THIS MODULE CLASSIFIES A REFUSAL, so no path can be given a redrive state that was
   * decided from something other than the durable read above.
   */
  const redriveFor = async (refusal: InvoicePaymentRegistrationRefusal | null): Promise<InvoicePaymentRedrive> =>
    invoicePaymentRedriveFor(pinned, refusal, await deferredRecovery())

  try {
    const [paymentSyncEnabled, so, activeConnector] = await Promise.all([
      // Not merely "is the connector on": if INVOICE_PAYMENT posting is off, queueAccountingSync would
      // drop this silently, so treat it as nothing being expected rather than as a failure to report.
      //
      // o3d-ekn8 r2: when a post is pinned, the question is whether the PINNED connector posts payments
      // — the active-connector form would answer about whatever is switched on now, which is not an
      // answer about the connector that just posted this invoice at all.
      (pinned
        ? isAccountingSyncTypeEnabledFor(pinned.connector, 'INVOICE_PAYMENT')
        : isAccountingSyncTypeEnabled('INVOICE_PAYMENT')).catch(() => false),
      db.salesOrder.findUnique({
        where: { id: params.orderId },
        select: {
          accountingInvoiceId: true, currency: true, totalForeign: true, taxForeign: true, pricesIncludeVat: true,
          shoppingLinks: { select: { connector: true }, take: 1 },
        },
      }),
      // Not resolved at all when a connector was pinned: a second resolution can agree with the pin
      // while the write did not, which is the race rather than a check of it.
      pinned ? Promise.resolve(null) : getActiveAccountingConnectorInfo().catch(() => null),
    ])
    if (!so) return

    const connectorId: PostedInvoiceEvidence['connector'] | null = pinned ? pinned.connector : (activeConnector?.id ?? null)
    // Only a tie-break for the remedy's wording — see `deferredRecovery`.
    preferredConnector = connectorId

    // o3d-ekn8 r2: THE DOCUMENT THIS RECEIPT WOULD SETTLE. Pinned, it is the id the post returned — but
    // only while the order still points at it. If the invoice has been deleted and re-posted since (or
    // the back-reference write lost its race), the order now names a DIFFERENT document, and neither
    // answer is safe: settling the pinned one pays a retired invoice, and settling the current one
    // registers a receipt against a post this evidence says nothing about. Refuse and say so — the next
    // SALES_INVOICE post re-drives, and the message names the hand remedy.
    if (pinned && so.accountingInvoiceId !== pinned.accountingInvoiceId) {
      await warn('invoice_payment_not_registered',
        invoicePaymentDocumentMovedDescription({
          phase: 'before-queue',
          orderReference: params.orderReference,
          amount: params.amount,
          currency: params.currency,
          postedInvoiceId: pinned.accountingInvoiceId,
          currentInvoiceId: so.accountingInvoiceId,
          connector: pinned.connector,
        }),
        {
          amount: params.amount, currency: params.currency, refusal: 'DOCUMENT_MOVED',
          postedInvoiceId: pinned.accountingInvoiceId, currentInvoiceId: so.accountingInvoiceId,
          connector: pinned.connector,
        })
      return
    }
    const accountingInvoiceId = pinned ? pinned.accountingInvoiceId : so.accountingInvoiceId

    const existing = paymentSyncEnabled && accountingInvoiceId
      ? await loadInvoicePaymentSyncRows(params.orderId, connectorId)
      : []

    // o3d-0m56: a FAILED or CANCELLED attempt does NOT prove the ledger is clear — the call may have
    // committed before its response was lost. Recording another receipt beside one queues a fresh row
    // under a NEW token, which posts a second payment without ever touching the retry guard. So when
    // there is such an attempt, ask the ledger what it holds; the decision refuses unless the answer
    // positively rules that attempt out.
    //
    // Conditional on purpose: this is a network read, and the ordinary receipt has no history to check.
    const probeConnector = connectorId
    const ledgerSettlements = accountingInvoiceId
      && probeConnector
      && unresolvedInvoicePaymentAttempts(existing, params.paymentId).length > 0
      ? await (async () => {
        const probe = await probeLedgerSettlement(probeConnector, {
          type: 'INVOICE_PAYMENT',
          payload: { accountingInvoiceId },
        })
        // A probe that could not answer stays null, which the decision reads as "refuse".
        return probe.ok ? probe.records : null
      })()
      : null

    // Hoisted so the re-check under the order lock re-runs the IDENTICAL decision with only `existing`
    // refreshed — anything else diverging between the two would make the second a different guard.
    //
    // `ledgerSettlements` is deliberately NOT re-read there: it is a network call, and holding the
    // order lock and the follow-up scope lock across one would let a slow remote block every payment
    // enqueue in the system. What changes fast is the local row set, which is what IS re-read.
    const decisionInput = {
      syncEnabled: paymentSyncEnabled,
      accountingInvoiceId,
      orderCurrency: so.currency,
      paymentCurrency: params.currency,
      paymentAmount: params.amount,
      paymentId: params.paymentId,
      bankAccountId: paymentSyncEnabled && accountingInvoiceId
        ? lookupPaymentAccount(await getPaymentAccountMap(), params.method ?? '', params.currency)
        : null,
      existing,
      ledgerSettlements,
      ledgerTotal: ledgerSalesInvoiceTotalForeign({
        totalForeign: Number(so.totalForeign),
        taxForeign: Number(so.taxForeign),
        pricesIncludeVat: so.pricesIncludeVat,
        // Both still passed, and both now deliberately unread — see ledgerSalesInvoiceTotalForeign:
        // since o3d-cyn an imported tax-inclusive invoice posts at gross like every other, so the
        // ledger total is the order total whatever these say.
        importedFromShop: so.shoppingLinks.length > 0,
      }),
    }
    const decision = decideInvoicePaymentRegistration(decisionInput)

    // THE REDRIVE STATE FOR THIS CALL (o3d-0bfh r13, Codex HIGH). Not a property of the refusal
    // reason: most of these branches are reachable from BOTH the operator-entered receipt and the
    // deferred re-drive, and the hand remedy that is the only exit on one races a queued
    // registration on the other. `pinned` is one of the two facts that separate them; the other —
    // o3d-0bfh r14 — is whether the durable follow-up obligation state says a deferred pass can
    // still select this receipt, which is a fact about the RECEIPT and not about this call.
    // Both are weighed by the hoisted `redriveFor` above.

    const reportRefusal = async (refused: InvoicePaymentRegistrationDecision & { register: false }) => {
      const notice = describeInvoicePaymentRefusal({
        refused,
        orderReference: params.orderReference,
        amount: params.amount,
        currency: params.currency,
        orderCurrency: so.currency,
        method: params.method,
        redrive: await redriveFor(refused.refusal),
      })
      // SYNC_DISABLED produces no notice: nothing was expected to post at all.
      if (!notice) return
      await warn('invoice_payment_not_registered', notice.description, notice.metadata)
    }

    if (!decision.register) {
      await reportRefusal(decision)
      return
    }
    // Unreachable — `decideInvoicePaymentRegistration` refuses DOCUMENT_NOT_POSTED before anything
    // else can say `register: true`. Asserted rather than cast away, because the idempotency key
    // below is built FROM this id (o3d-ekn8 r3): a key silently assembled around `null` would collapse
    // every unanchored receipt into one slot, which is the blindness this round is closing.
    if (!accountingInvoiceId) {
      await reportRefusal({ register: false, refusal: 'DOCUMENT_NOT_POSTED' })
      return
    }

    // ENQUEUE UNDER THE ORDER LOCK, and only if the receipt is still there. The Payment row committed
    // before this runs, and deletePayment cancels a queued registration by looking for one — so a delete
    // landing in between saw nothing to cancel, and this then posted a payment to the ledger for a
    // receipt IMS had already deleted, with no warning anywhere (Codex, PR #582 round 1).
    //
    // deletePayment takes the same per-order lock, so serialising on it closes the window in both
    // directions: either we find the payment gone and do nothing, or we queue first and the delete finds
    // our row and retracts it.
    const runEnqueue = () => db.$transaction(async (tx) => {
      await lockSalesOrder(tx, params.orderId)
      // o3d-0m56: AND the follow-up scope lock, taken before the rows are re-read.
      //
      // The order lock serialises this against deletePayment, which is what it was added for. It does
      // NOT serialise it against the other writers that can put an INVOICE_PAYMENT row into this same
      // scope — the connector queues and the manual retry, neither of which touches the sales order.
      // Between the re-read below and the insert, one of those can queue a row for this document under
      // a fresh token; FAILED rows sit outside accounting_sync_logs_followup_live_unique, so nothing
      // objects, and both can post. Only a lock BOTH sides take closes that, because PostgreSQL has no
      // predicate locks and SELECT ... FOR UPDATE says nothing about a row about to be inserted.
      //
      // Order is fixed and uniform across every writer — sales-order row lock first, scope lock second
      // — so this cannot deadlock against the enqueue path. See followup-scope-lock.ts.
      if (probeConnector) {
        await lockFollowUpScope(tx, {
          connector: probeConnector,
          type: 'INVOICE_PAYMENT',
          referenceType: 'SalesOrder',
          referenceId: params.orderId,
        })
      }
      const stillRecorded = await tx.payment.findUnique({ where: { id: params.paymentId }, select: { id: true } })
      if (!stillRecorded) return 'receipt-deleted' as const
      // o3d-ekn8 r2: and the order still points at the document this post returned. The check above ran
      // before the lock; the delete-and-re-post that moves it takes the same order lock, so this is the
      // read that actually decides. Without it the pin is only ever tested in a window that has since
      // reopened.
      if (pinned) {
        const current = await tx.salesOrder.findUnique({
          where: { id: params.orderId },
          select: { accountingInvoiceId: true },
        })
        if (current?.accountingInvoiceId !== pinned.accountingInvoiceId) return 'document-moved' as const
      }
      // RE-DECIDE UNDER THE LOCK (o3d-cjt8). While one live registration per ORDER was the rule, the
      // unique index caught two receipts racing: the loser got a P2002. Now that the index is scoped to
      // the receipt, both would insert cleanly and the invoice would be over-settled — because "the
      // parts must not exceed the whole" is arithmetic, and a unique index cannot enforce arithmetic.
      // The capacity read has to happen inside the transaction that holds the order lock, against the
      // same client, or the check-then-act window is simply moved rather than closed.
      const underLock = decideInvoicePaymentRegistration({
        ...decisionInput,
        existing: await loadInvoicePaymentSyncRows(params.orderId, connectorId, tx),
      })
      if (!underLock.register) return { refused: underLock } as const
      const enqueued = await queueAccountingSyncTxWithOutcome(tx, {
        type: 'INVOICE_PAYMENT',
        referenceType: 'SalesOrder',
        referenceId: params.orderId,
        payload: {
          accountingInvoiceId,
          bankAccountId: underLock.bankAccountId,
          amount: params.amount,
          currency: params.currency,
          paymentDate: params.paidAt.toISOString().slice(0, 10),
          method: params.method ?? '',
          reference: params.reference ?? undefined,
          // Which local receipt this is, so deletePayment can retract exactly this row rather than any
          // row that happens to share its amount.
          paymentId: params.paymentId,
        },
        // Exactly once per recorded receipt AND DOCUMENT, however many times this runs.
        idempotencyKey: invoicePaymentEnqueueKey(params.paymentId, accountingInvoiceId),
      })
      // THE ROW IS WRITTEN UNDER THE CONNECTOR THE ENQUEUE RESOLVED FOR ITSELF (o3d-ekn8 r2). A clean
      // `queued` says a row exists; `connector` is the only thing that says which ledger it is for. The
      // capacity arithmetic that licensed this write was measured against the PINNED connector's rows,
      // so a row written for the other one was measured against nothing — roll it back rather than
      // report it, because a payment queued to a ledger nobody reckoned it against is what this whole
      // path exists to prevent.
      if (pinned && enqueued.queued && enqueued.connector !== pinned.connector) {
        throw new PinnedConnectorMoved(enqueued.connector, enqueued.reason === 'already-queued')
      }
      return enqueued.queued ? ('queued' as const) : ('context-changed' as const)
    }, STOCK_TX_OPTIONS)

    let outcome: Awaited<ReturnType<typeof runEnqueue>>
    try {
      outcome = await runEnqueue()
    } catch (moved) {
      if (!(moved instanceof PinnedConnectorMoved)) throw moved
      await warn('invoice_payment_not_registered',
        invoicePaymentConnectorMovedDescription({
          orderReference: params.orderReference,
          amount: params.amount,
          currency: params.currency,
          pinnedConnector: pinned?.connector ?? null,
          wroteFor: moved.wroteFor,
          alreadyQueued: moved.alreadyQueued,
        }),
        {
          amount: params.amount, currency: params.currency, refusal: 'PINNED_CONNECTOR_MOVED',
          pinnedConnector: pinned?.connector ?? null, wroteFor: moved.wroteFor,
          // Whether the throw actually undid a write, or found the work already queued elsewhere.
          rolledBack: !moved.alreadyQueued,
        })
      return
    }

    // queueAccountingSyncTx RE-READS the posting context and returns false when it has since changed —
    // the connector switched off, or INVOICE_PAYMENT posting disabled, between the check above and the
    // write. Ignoring that boolean left the receipt accepted locally with no sync row, no warning and
    // nothing to retry: the silent loss this whole issue is about (Codex, PR #582 round 8).
    // The capacity re-check under the lock refused it. A concurrent receipt for the same order took the
    // room this one was measured against, so it is reported exactly as if it had been refused up front
    // — the operator sees one message naming the reason, not a silent no-op.
    if (typeof outcome === 'object' && 'refused' in outcome) {
      await reportRefusal(outcome.refused)
      return
    }
    if (outcome === 'document-moved') {
      await warn('invoice_payment_not_registered',
        invoicePaymentDocumentMovedDescription({
          phase: 'while-queueing',
          orderReference: params.orderReference,
          amount: params.amount,
          currency: params.currency,
          postedInvoiceId: pinned?.accountingInvoiceId ?? 'unknown',
          currentInvoiceId: so.accountingInvoiceId,
          // Only reachable under a pin — the `document-moved` outcome is written inside `if (pinned)`.
          connector: pinned?.connector ?? 'unknown',
        }),
        {
          amount: params.amount, currency: params.currency, refusal: 'DOCUMENT_MOVED',
          postedInvoiceId: pinned?.accountingInvoiceId ?? null,
        })
      return
    }
    if (outcome === 'context-changed') {
      await warn('invoice_payment_not_registered',
        invoicePaymentPostingContextChangedDescription({
          orderReference: params.orderReference,
          amount: params.amount,
          currency: params.currency,
          redrive: await redriveFor(null),
        }),
        { amount: params.amount, currency: params.currency, refusal: 'POSTING_CONTEXT_CHANGED' })
    }
  } catch (e) {
    // Same shape as markBillPaid's queue failure: the receipt is recorded in IMS with nothing queued to
    // tell the ledger, so nothing will ever retry and there is no FAILED row to notice — the row was
    // never written. That is the quietest way the two systems disagree, so it is recorded as an ERROR.
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: params.orderId,
      action: 'invoice_payment_not_queued',
      tag: 'accounting',
      level: 'ERROR',
      description: invoicePaymentNotQueuedDescription({
        orderReference: params.orderReference,
        amount: params.amount,
        currency: params.currency,
        redrive: await redriveFor(null),
      }),
      metadata: {
        orderNumber: params.orderReference,
        paymentId: params.paymentId,
        amount: params.amount,
        currency: params.currency,
        error: e instanceof Error ? e.message : String(e),
      },
    }).catch(() => { /* logging must never block the receipt either */ })
  }
}
/**
 * REGISTER RECEIPTS THAT WERE RECORDED BEFORE THE INVOICE EXISTED (o3d-ekn8).
 *
 * `registerInvoicePaymentWithLedger` refuses with DOCUMENT_NOT_POSTED when the order has no
 * accountingInvoiceId — a payment cannot attach to a document the ledger has never seen. That refusal is
 * right; what was missing is that nothing re-visited the receipt once the SALES_INVOICE finally posted.
 * The receipt stayed recorded, the ledger stayed unsettled, and the only sign was the settlement verdict
 * flipping to a red NOT_SENT that somebody had to notice.
 *
 * So this is NOT a key fix. Nothing about the uniqueness of a payment was wrong — the work simply
 * arrived before the thing it depends on. The fix is a re-drive at the one moment the refusal stops
 * applying: the connector calls this straight after a SALES_INVOICE CREATE posts and updateBackReference
 * has written accountingInvoiceId (that ordering is what makes the re-read below see the new id).
 *
 * It re-runs the SAME guarded decision rather than a second, laxer copy of it — currency, bank-account
 * mapping and invoice capacity are all re-checked per receipt — and `selectReceiptsAwaitingRegistration`
 * keeps it to receipts with no sync row of their own at all, so it can never re-drive an attempt that
 * may already have posted. Sequential by design: each call re-reads the live rows, so the second receipt
 * is measured against an invoice the first has already consumed part of.
 *
 * PINNED TO THE POST THAT TRIGGERED IT (o3d-ekn8 r2, Codex HIGH). The caller holds the two facts this
 * whole re-drive is about — the connector that made the call, and the invoice id that call returned —
 * and both are MUTABLE if looked up again here instead. Re-reading them meant a connector switched
 * between the post and this line sent the receipts to the wrong ledger, and a delete-and-re-post
 * between them settled a document this post knows nothing about; neither leaves a trace beyond a
 * settlement figure that stops adding up. So they travel in, and every check below is made against
 * them rather than against whatever is live now.
 *
 * Never throws: a follow-up enqueue must not fail the sync entry that posted the invoice. It does,
 * since o3d-ekn8 r5, REPORT what it settled — because "did not throw" and "the receipts reached the
 * ledger" are different facts, and the caller releases a durable obligation on the answer.
 */
export async function registerDeferredOrderReceipts(
  orderId: string,
  posted: PostedInvoiceEvidence,
  /**
   * THE OBLIGATION THIS PASS HOLDS (o3d-0bfh r15, Codex HIGH). REQUIRED, and `null` is a statement
   * rather than a default: the caller took no generation and therefore has nothing to clear. It is
   * not optional, because a caller that forgot to pass it would go back to clearing the marker
   * itself, outside the lock — which is the entire finding.
   */
  obligation: DeferredReceiptObligation | null,
): Promise<DeferredReceiptRedriveResult> {
  /**
   * Every exit whose truth a LATER RECEIPT COULD CHANGE goes through the fence, and the fence is
   * what clears the marker. `reason` is what this pass believed on the way in; `settled` is what the
   * fence found under the lock, which can disagree — a pass that had nothing to do can still find a
   * receipt that arrived while it was running.
   */
  const discharge = async (
    reason: DeferredReceiptRedriveResult['reason'],
  ): Promise<DeferredReceiptRedriveResult> => {
    const fenced = await dischargeDeferredReceiptObligation(orderId, posted, obligation)
    return fenced.awaiting === 0
      ? { settled: true, reason, release: fenced.release }
      : { settled: false, reason: 'left-unregistered', awaiting: fenced.awaiting, release: fenced.release }
  }
  try {
    // Does the PINNED connector post payments at all?
    //
    // FALSE is a complete answer — nothing is expected of this order — so it ends the call and the
    // caller's obligation with it, without reading the order at all. A THROW is not an answer
    // (o3d-ekn8 r5): it says we could not find out, and `.catch(() => false)` used to collapse the
    // two into the one that lets the follow-up marker be cleared. So it does NOT end the call on its
    // own; it falls through, and the cheap certain facts below — no order, no receipts — still get
    // to say that nothing was owed either way.
    const paymentsPost = await isAccountingSyncTypeEnabledFor(posted.connector, 'INVOICE_PAYMENT').catch(() => null)
    // UNFENCED, and safely so: nothing on this order will EVER be registered against this
    // connector, so no receipt arriving later can make this answer wrong.
    if (paymentsPost === false) return { settled: true, reason: 'sync-disabled', release: 'unfenced' }
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        accountingInvoiceId: true,
        payments: {
          // A refund payment settles a CREDIT NOTE, not this invoice, so it is not a receipt against it.
          where: { refundId: null },
          select: { id: true, amount: true, currency: true, method: true, reference: true, paidAt: true },
          orderBy: { paidAt: 'asc' },
        },
      },
    })
    // UNFENCED: a Payment row requires this order to exist, so a receipt cannot arrive for one that
    // does not.
    if (!order) return { settled: true, reason: 'no-order', release: 'unfenced' }
    // Nothing was recorded before the invoice, so nothing is owed and the caller's obligation is
    // genuinely discharged. Asked BEFORE the link check on purpose: an order with no receipts must
    // not hold an obligation open over a back-reference that has nothing to do with money.
    // FENCED (o3d-0bfh r15). "There were no receipts a moment ago" is exactly the snapshot claim the
    // finding is about: a receipt committing between this read and the release would read a live
    // marker and then have it cleared over it.
    if (order.payments.length === 0) return await discharge('no-receipts')
    // Receipts exist and we could not find out whether they are meant to post. That is the one state
    // where nothing has been decided about them, so nothing may be discharged on their behalf.
    if (paymentsPost === null) return { settled: false, reason: 'posting-context-unknown', release: 'retained' }

    // THE LINK NEVER LANDED (o3d-ekn8 r5, Codex HIGH). QuickBooks' `updateBackReference` catches its
    // own failure, so the invoice can post while the order is left with no accountingInvoiceId at
    // all — and this function's old first line treated that exactly like "no receipts to register"
    // and returned in silence. Every receipt on this order then stayed unregistered, nothing said
    // so, and the processor released the marker that was the last record of the debt.
    //
    // It is NOT folded into the mismatch arm below, even though `null !== posted.accountingInvoiceId`
    // would reach it: the cause is different and so is the remedy. A mismatch means somebody
    // re-posted the invoice; this means the local link write failed and the document in the ledger
    // has no local record of it at all.
    if (!order.accountingInvoiceId) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'deferred_invoice_payment_registration_unlinked',
        tag: 'accounting',
        level: 'ERROR',
        description: deferredReceiptsUnlinkedDescription({
          connector: posted.connector,
          postedInvoiceId: posted.accountingInvoiceId,
          receipts: order.payments.length,
        }),
        metadata: {
          orderId,
          connector: posted.connector,
          postedInvoiceId: posted.accountingInvoiceId,
          receipts: order.payments.length,
        },
      }).catch(() => { /* logging must never block the follow-up */ })
      return { settled: false, reason: 'not-linked', awaiting: order.payments.length, release: 'retained' }
    }

    // The order must still point at the document this post returned. It normally does — updateBackReference
    // runs immediately before this — but "normally" is the whole of the old guarantee, and a re-post in
    // between would have this re-drive settle receipts against an invoice nobody here has seen posted.
    if (order.accountingInvoiceId !== posted.accountingInvoiceId) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: orderId,
        action: 'deferred_invoice_payment_registration_skipped',
        tag: 'accounting',
        level: 'WARNING',
        description: deferredReceiptsDocumentMovedDescription({
          connector: posted.connector,
          postedInvoiceId: posted.accountingInvoiceId,
          currentInvoiceId: order.accountingInvoiceId,
        }),
        metadata: {
          orderId,
          connector: posted.connector,
          postedInvoiceId: posted.accountingInvoiceId,
          currentInvoiceId: order.accountingInvoiceId,
        },
      }).catch(() => { /* logging must never block the follow-up */ })
      return { settled: false, reason: 'document-moved', awaiting: order.payments.length, release: 'retained' }
    }

    const awaiting = selectReceiptsAwaitingRegistration({
      receipts: order.payments,
      // Scoped to the connector that POSTED, not the active one: rows belonging to a ledger this post
      // was not made against cannot say whether this post's receipts still need registering.
      existing: await loadInvoicePaymentSyncRows(order.id, posted.connector),
      // o3d-ekn8 r3 — AND TO THE DOCUMENT THIS POST RETURNED. `posted.accountingInvoiceId`, not the
      // order's column: the two are equal here (the check above refuses otherwise) and the pin is the
      // one that is evidence. Without it a receipt already registered against a RETIRED invoice read
      // as spoken for, and the replacement invoice was never settled by anything.
      accountingInvoiceId: posted.accountingInvoiceId,
    })
    // FENCED for the same reason as `no-receipts`: this selection is over the snapshot.
    if (awaiting.length === 0) return await discharge('nothing-awaiting')

    const orderReference = getSalesOrderReference(order)
    for (const receipt of awaiting) {
      await registerInvoicePaymentWithLedger({
        postedUnder: posted,
        orderId: order.id,
        orderReference,
        paymentId: receipt.id,
        amount: Number(receipt.amount),
        currency: receipt.currency,
        method: receipt.method,
        reference: receipt.reference,
        paidAt: receipt.paidAt,
      })
    }

    // DID THE MONEY ACTUALLY GET QUEUED? (o3d-ekn8 r5, Codex HIGH.) Reaching the end of the loop is
    // not evidence that it did: `registerInvoicePaymentWithLedger` never throws — it reports every
    // refusal and every rollback as a warning and returns — so a receipt refused for capacity, or one
    // whose row was written for another ledger and UNWRITTEN by the pinned-connector fence, leaves
    // this loop looking exactly like a receipt that was registered.
    //
    // So the answer is read back off the rows that now exist, through the SAME selector that chose
    // the work — scoped to the pinned connector and the pinned document, so a row queued under the
    // connector that was switched on mid-flight cannot answer for one that was not. A second, laxer
    // copy of "is this receipt spoken for?" is exactly what o3d-ekn8 r3 had to unpick.
    //
    // AND IT IS READ OFF THE RECEIPTS THAT EXIST NOW, UNDER THE ORDER LOCK, WITH THE RELEASE IN THE
    // SAME TRANSACTION (o3d-0bfh r15, Codex HIGH). This re-check used to re-run the selector over
    // `order.payments` — the snapshot taken before the loop — so a receipt that committed while the
    // loop was making its remote calls was invisible to it, and the marker it had already read as
    // `held` was then cleared by the caller. See the block above `dischargeDeferredReceiptObligation`.
    // AWAITED, not returned bare: a promise returned out of a `try` rejects OUTSIDE it, so a fence
    // that cannot take the lock would escape this function's catch — and this function's contract is
    // that it never throws, because a receipt it cannot register must not fail a sync entry whose
    // invoice HAS posted. `return await` is load-bearing here, and a test proves it.
    return await discharge('registered')
  } catch (error) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'deferred_invoice_payment_registration_failed',
      tag: 'accounting',
      level: 'WARNING',
      description: deferredReceiptsFailedDescription({
        connector: posted.connector,
        error: String(error),
      }),
      metadata: { orderId, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => { /* logging must never block the follow-up either */ })
    return { settled: false, reason: 'failed', release: 'retained' }
  }
}
