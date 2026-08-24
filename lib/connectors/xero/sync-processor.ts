/**
 * Process pending XeroSyncLog entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one Xero API call.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { db, POST_REMOTE_PERSIST_TX_OPTIONS } from '@/lib/db'
import { XERO_INVOICE_NUMBER_SLOT_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import {
  LostClaimDuringPersistError,
  LOST_CLAIM_DURING_PERSIST_REASON,
  persistAfterRemoteWrite,
  postRemotePersistDeadlineMs,
  reportUnrecordedRemoteWrite,
  UnrecordedRemoteWriteError,
} from '@/lib/db/post-remote-persist'
import { logActivity, logActivityInTransaction, logActivityPersisted, redactActivityLogText, sanitizeActivityLogMetadata } from '@/lib/activity-log'
import { pushSalesInvoice, updateSalesInvoice, type BeforeRemoteWrite } from './invoices'
import { pushPurchaseBill, updatePurchaseBill } from './bills'
import { allocatePurchaseCreditNote, pushCreditNote, pushPurchaseCreditNote } from './credit-notes'
import { prepareManualJournal, postPreparedManualJournal } from './journals'
import { getGrantedScopes } from './auth'
import { blockingScopeFor, scopeBlockedError } from './scopes'
import {
  carryAccountingOriginRecord,
  carryAccountingOriginRecordFrom,
  mintAccountingConnectionProvenanceColumn,
  readAccountingPayloadConnectionStamp,
  type AccountingConnectionStamp,
  type AccountingOriginRecord,
} from '@/lib/connectors/accounting-connection-provenance'
import { withAccountingPostingIntent } from '@/lib/connectors/accounting-posting-intent'
import { xeroUploadAttachment, xeroPost } from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { readClaimedSyncLogOriginRecord } from '@/lib/domain/accounting/claimed-sync-payload'
import { CREATE_DISPATCH_REPLAY_MARGIN_MS, describeCreateDispatchNotSent, planCreateDispatch, readCreateDispatchAge, type CreateDispatchAge, type CreateDispatchMint } from '@/lib/domain/accounting/create-dispatch-record'
import { XERO_IDEMPOTENCY_KEY_RETENTION_MS } from '@/lib/domain/accounting/idempotency-retention'
import { decideInvoiceNumberPost, xeroInvoiceNumberIdentity } from '@/lib/domain/accounting/invoice-number-ownership'
import { lookupXeroInvoiceNumberClaim } from './invoice-number-claim'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { refuseUnreconciledDocument } from '@/lib/domain/accounting/document-tax-reconciliation'
import {
  BACK_REFERENCE_REPAIRABLE_STATUSES,
  applyBackReference,
  backReferenceIsMissing,
  followUpObligationClaim,
  releaseFollowUpObligation,
  syncTypeWritesBackReference,
} from '@/lib/domain/accounting/back-reference'
import { stampSyncedAtFromDatabaseClock } from './synced-at-clock'
import { claimHeldFrom, heldClaimWhere, releaseClaimForRetry, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'
import { isMoneyMovingSyncType } from '@/lib/domain/accounting/followup-retry-guard'
import {
  FOLLOW_UPS_ENQUEUED,
  combineFollowUpEnqueueOutcomes,
  describeFollowUpEnqueueRefusals,
  refusedFollowUpEnqueue,
  type FollowUpEnqueueOutcome,
} from '@/lib/domain/accounting/followup-enqueue-outcome'
import {
  describeUnrecordablePostedDocument,
  PostedDocumentEvidenceUnwritten,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
  type UnrecordablePostedDocument,
  type UnrecordablePostedDocumentReason,
} from '@/lib/domain/accounting/unrecorded-posted-document'
import {
  DEFAULT_BACK_REFERENCE_SWEEP_LIMIT,
  createBackReferenceSweepCursorStore,
  repairAccountingBackReferences,
  type BackReferenceRepairResult,
  type BackReferenceSweepRelease,
} from '@/lib/domain/accounting/back-reference-sweep'
import {
  liveRowOccupiesFollowUpSlot,
  planFollowUpEnqueue,
  readFollowUpIdempotencyKey,
  type FollowUpPayload,
  type SettlementAssertionReliance,
} from '@/lib/domain/accounting/followup-idempotency'
import {
  isOperatorAssertedSettlement,
  OPERATOR_ASSERTION_SETTLEMENT_BASIS,
} from '@/lib/domain/accounting/sync-row-settlement'
import { repairMoneyAttemptsOutsideStampingCustody, stampingCustodyOnClaim, stampingCustodyOnCreate } from '@/lib/domain/accounting/money-attempt-provenance'
import { ledgerClearsFollowUpRevival, postMoneyUnderLedgerFence } from '@/lib/connectors/accounting-settlement-probe'
import { moneyPostDateToSend, settlementMarkerFor } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import {
  buildCompactedFollowUpLossActivity,
  compactionDiscardedFollowUps,
} from '@/lib/domain/accounting/compacted-followup-loss'
import {
  guardInvoicePaymentCapacity,
  retireOverSettlingInvoicePayment,
} from '@/lib/domain/accounting/invoice-payment-capacity'
import { logFollowUpRevival, resolveLostFollowUpRevival } from '@/lib/domain/accounting/followup-revival'
import {
  UNCLAIMED_ATTEMPT_REVISION,
  claimAttemptWhere,
  nextAttemptRevision,
  updateAtAttemptRevision,
  type AttemptRef,
} from '@/lib/domain/accounting/sync-log-attempt'
import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
import {
  claimIntegrationOutboxWork,
  INTEGRATION_OUTBOX_STATUS,
  markIntegrationOutboxPermanentFailure,
  markIntegrationOutboxRetryableFailure,
  markIntegrationOutboxSuccess,
  type IntegrationOutboxRow,
} from '@/lib/domain/integrations/outbox'
import {
  parseXeroAccountingOutboxPayload,
  scheduleXeroAccountingOutbox,
  XERO_ACCOUNTING_POST_OPERATION,
  XERO_OUTBOX_CONNECTOR,
} from './outbox'
import { resolveStoredInvoiceUploadPath } from '@/lib/upload-storage'

const MAX_RETRIES = 5
const MAX_PER_RUN = 50 // Xero rate limit: 60/min — leave headroom
const CLAIM_STALE_MS = 15 * 60 * 1000
const RATE_LIMIT_BACKOFF_BASE_MS = 60_000
const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60_000
const XERO_CONNECTOR = 'xero'
const XERO_ACCOUNTING_WORKER_ID = 'xero-accounting-sync'

class XeroOutboxCompletionError extends Error {}

/**
 * The outbox job carrying an unrecorded posted document could not be buried (Codex r3, HIGH). Thrown
 * out of the run rather than swallowed, and carrying the incident wording rather than only the database
 * error, because at that moment the wording is not written down anywhere the run can point at.
 */
class XeroOutboxBurialError extends Error {}

/**
 * The warning about a retention tombstone's unrebuildable follow-ups could not be written down.
 *
 * Thrown, not swallowed, so both short-circuit sites route it into their EXISTING follow-up-failure
 * handling: the row goes back to PENDING (or FAILED at MAX_RETRIES) still carrying
 * `backReferenceFollowUpsPendingAt`, so the obligation stays owed and the next pass — this
 * processor's own retry, or the repair sweep — gets another chance to announce it.
 */
class CompactedFollowUpLossUnrecorded extends Error {}

/**
 * o3d-peh1 — THE FOLLOW-UPS THIS ENTRY OWES WERE REFUSED, SO THE OBLIGATION IS NOT RELEASED.
 *
 * All four post paths do the same three things in the same order: enqueue the follow-ups, then
 * release `backReferenceFollowUpsPendingAt`, then count the entry as succeeded. A refusal that
 * returned normally slipped straight through all three — the marker was cleared, the entry was
 * reported as synced, and a money follow-up that was never queued had nothing left pointing at it.
 *
 * Thrown rather than branched at each site, deliberately, because the handling it needs ALREADY
 * EXISTS at every one of them and is exactly right: the catch marks the row for follow-up retry
 * (back to PENDING, or FAILED at MAX_RETRIES) with the obligation marker INTACT, so this processor's
 * own retry or the repair sweep picks the work up again. It is the same mechanism
 * `announceCompactedFollowUpLoss` uses one line below, for the same reason.
 */
class FollowUpEnqueueRefused extends Error {}

function requireFollowUpsEnqueued(entryId: string, outcome: FollowUpEnqueueOutcome): void {
  if (outcome.enqueued) return
  throw new FollowUpEnqueueRefused(
    `Xero sync entry ${entryId} posted, but its follow-ups were REFUSED and nothing was queued: `
    + `${describeFollowUpEnqueueRefusals(outcome)}`,
  )
}

/**
 * o3d-nepa r3 — SAY SO WHEN A RETRY SETTLES A ROW WHOSE FOLLOW-UPS CANNOT BE REBUILT.
 *
 * The short-circuit below is reached when a sync row already carries an external id: the document
 * posted, so the retry must NOT re-post it, and the row goes straight to SYNCED. That branch then
 * calls `enqueueFollowUps` with the row's payload and releases the follow-up obligation.
 *
 * On a RETENTION TOMBSTONE the payload is `{}`. The enqueue does not fail on it — it takes no
 * branch, enqueues nothing and returns normally — so the release ran on the strength of work that
 * never happened, and `backReferenceFollowUpsPendingAt`, the last record that a payment or
 * attachment was still owed, was cleared. A bulk "Retry all" over old failures therefore lost them
 * silently. The repair sweep had announced exactly this loss since o3d-9kek r4; the processors had
 * not, and the processors are the path an operator actually triggers.
 *
 * So the loss is announced, from the SAME shared message the sweep uses, and the obligation is
 * released only once the announcement is on record. A no-op for every row that is not a tombstone.
 *
 * r4 finding 1: it runs AFTER `enqueueFollowUps`, not before. Throwing from here is how the release
 * is withheld, and putting it first made that throw withhold the ENQUEUE as well — including the
 * follow-ups that survive compaction and would have gone out fine. The gate is on the release only.
 *
 * o3d-bqw7 / o3d-kemx — AND THE STAMP IS NOT THE LOSS. r4 warned whenever the compaction stamp was
 * set, which says the payload was thrown away; the warning claims the row's outstanding follow-ups
 * can no longer be enqueued. Those are different facts, and the module header above says so: some
 * follow-ups are rebuilt from columns compaction KEEPS, and some types owe none at all — a
 * `CREDIT_NOTE` tombstone was warned about on every pass while having nothing to lose.
 *
 * Two costs, and the second is the one that moves work rather than noise. Because this announcement
 * gates the RELEASE, a warning that is both FALSE and unwritable holds an already-posted row at
 * PENDING and re-drives it every pass, for ever. So the guard is now `compactionDiscardedFollowUps`,
 * which answers per type from an exhaustive table — see compacted-followup-loss.ts for why it fails
 * towards WARNING on a type it does not recognise.
 *
 * r2 (Codex HIGH) — AND A TYPE IS STILL COARSER THAN THE TRUTH. A SALES_INVOICE owes a payment
 * registration only when its payload carried `_registerPayment`, and the ordinary sales path composes
 * payloads without it, so a type-level answer went on warning about tombstones that lost nothing. The
 * guard now reads the row's OWN record of what it owed, written by retention's compaction in the same
 * statement that emptied the payload it was derived from; a row compacted before that record existed
 * has none and keeps the over-broad type answer, for ever, because the payload it would have to be
 * derived from is exactly what was thrown away.
 */
async function announceCompactedFollowUpLoss(entry: {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  backReferenceEvidenceCompactedAt: Date | null
  /**
   * o3d-bqw7 r2: what this row RECORDED that it owed, written by the compaction that erased the
   * payload it was owed from. NULL means no record — the classification falls back to the type table,
   * which over-reports, which is the safe direction.
   */
  followUpObligations?: unknown
}): Promise<void> {
  if (compactionDiscardedFollowUps(entry).length === 0) return
  // logActivityPersisted, NOT logActivity: the release below is conditional on having warned, and
  // logActivity swallows its own write failures and resolves regardless — which is the same
  // "reported success, did nothing" shape as the empty enqueue this exists to catch.
  const persisted = await logActivityPersisted(buildCompactedFollowUpLossActivity({
    connectorLabel: 'Xero',
    activityActionPrefix: XERO_CONNECTOR,
    row: entry,
    phase: 'processor-short-circuit',
  }))
  if (persisted) return
  throw new CompactedFollowUpLossUnrecorded(
    `Xero sync entry ${entry.id} outlived the retention period and was compacted, so its follow-ups cannot be rebuilt — `
    + 'and the warning about that could not be written. The row keeps its follow-up obligation so the loss is announced '
    + 'by a later pass instead of disappearing with it.',
  )
}

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>
type FollowUpSyncType = 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE' | 'PURCHASE_CREDIT_NOTE_ALLOCATION'
type InvoicePaymentOrderingEntry = {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  createdAt: Date
}

export function isXeroAccountingOutboxEnabled(value = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED): boolean {
  return !['false', '0', 'off'].includes(String(value ?? 'true').trim().toLowerCase())
}

/**
 * Xero rejects an Idempotency-Key longer than this with HTTP 400 — the document never
 * reaches the ledger.
 */
const XERO_IDEMPOTENCY_KEY_MAX_LENGTH = 128

export function buildXeroIdempotencyKey(entryId: string, operation: string, payload?: SyncPayload): string {
  if (typeof payload?._idempotencyKey === 'string' && payload._idempotencyKey.trim()) {
    const digest = createHash('sha256').update(payload._idempotencyKey).digest('hex')
    return `ims-${operation}-${digest}`
  }

  // Bound the key HERE rather than trusting every caller to pass something short.
  //
  // Not hypothetical: the manual-journal branch passes a composite
  // `purchase-receipt:<cuid>:<receipt-ref>:<sha256>` as entryId and omits `payload`, so it
  // skipped the hash above and built a 156-char key. Xero 400'd every one, meaning
  // STOCK_RECEIPT journals NEVER posted. Because the 400 body was discarded (api.ts), it
  // surfaced only as "HTTP 400" and got written off as a demo-tenant quirk
  // (e2e/xero.spec.ts:134 fixme).
  //
  // Hashing is deterministic — the same entryId still yields the same key, so idempotency
  // is preserved; only over-long keys change shape.
  const key = `ims-${operation}-${entryId}`
  if (key.length <= XERO_IDEMPOTENCY_KEY_MAX_LENGTH) return key
  return `ims-${operation}-${createHash('sha256').update(entryId).digest('hex')}`
}

/**
 * o3d-h2wx: the source a money-moving follow-up's Idempotency-Key is built from. Prefers
 * the stable follow-up token when this row carries one, so the key survives the row being
 * regenerated; otherwise the entry id, exactly as before.
 *
 * Deliberately does NOT consult the generic `payload._idempotencyKey`. These branches have
 * always ignored it, and starting to read it would change the key of every manual-receipt
 * payment already in flight at deploy time — creating the double-post window this closes.
 */
function followUpIdempotencySource(entryId: string, payload: SyncPayload): string {
  return readFollowUpIdempotencyKey(payload) ?? entryId
}

function getRateLimitBackoffMs(retryCount: number, message: string): number {
  const hinted = message.match(/retry after (\d+)ms/i)
  const hintedMs = hinted ? Number.parseInt(hinted[1] ?? '0', 10) : 0
  const exponential = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** retryCount, RATE_LIMIT_BACKOFF_MAX_MS)
  return Math.max(hintedMs, exponential)
}

function isRateLimitError(message: string): boolean {
  return /rate limit|rate limited|http 429|status 429/i.test(message)
}

async function updateMirroredEventForSyncLog(client: Pick<Prisma.TransactionClient, 'accountingEvent' | 'accountingEventLog'>, params: {
  syncLogId: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: SyncPayload
  status: 'POSTED' | 'FAILED'
  externalId?: string | null
  /**
   * o3d-cvj9 r3: the revision stamp Xero put on the document as it applied THIS write, out of the
   * response to that write. Supplied only where a write actually landed in this attempt — the
   * short-circuit for a sync log that already carries an external id makes no connector call, so it
   * supplies nothing and can never take a document id off the row that holds it.
   */
  externalRevisionAt?: Date | null
  message?: string
}): Promise<void> {
  await updateMirroredAccountingEventStatus(client, {
    connector: XERO_CONNECTOR,
    syncLogId: params.syncLogId,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    payload: params.payload,
    status: params.status,
    externalId: params.externalId,
    ...(params.externalRevisionAt !== undefined ? { externalRevisionAt: params.externalRevisionAt } : {}),
    message: params.message,
  })
}

/**
 * THE CLAIM FENCE IS NOT DEFINED HERE (o3d-550x; Codex r1, medium 1).
 *
 * `heldClaimWhere` and the single non-terminal release that carries it live in
 * `@/lib/domain/accounting/sync-claim-fence`, because the cancelled-order invoice retirement releases
 * these same claims and a second hand-spelt copy of the predicate would be a second DEFINITION of
 * ownership, free to drift from this one. Re-exported so existing importers of the connector keep
 * working and so the fence still reads as part of this processor's contract.
 *
 * THE CLAIM INSTANT CONVENTION THIS FILE FOLLOWS (Codex r2, medium 2). This runner never renews a
 * claim: it stamps one instant when it takes the row and holds it for the entry. But it does NOT pass
 * that instant around as a `Date` — it passes the CLAIM, a `HeldClaim` built by `claimHeldFrom`, and
 * every fence asks it for the instant at the moment of the write. The sibling that DOES renew
 * (o3d-batch-small2's remote-write lease) satisfies the same interface with the same method name, so
 * when the two land together the holder is swapped for the lease and all six releases keep fencing on
 * the claim this worker actually holds. A carried-down `Date` would compile there and match nothing —
 * and these fences fail closed, so the symptom is silent refusal, not an error.
 *
 * WHAT A MISSING FENCE COSTS ON THIS BRANCH SPECIFICALLY (o3d-a3wx r6). A displaced owner that writes
 * the row back erases the replacement's PROCESSING claim and drops the row to PENDING/FAILED WHILE THE
 * REPLACEMENT'S REQUEST IS STILL ON THE WIRE — and that reopens the post slot with nothing to show a
 * post is in flight. For an order-scoped INVOICE_PAYMENT that is the double post: the exclusion test
 * ({@link decideInvoicePaymentClaim}) admits a sibling the moment no row for the reference is
 * PROCESSING, the sibling posts, and the same invoice is settled twice. Nothing downstream catches it,
 * because the capacity guard counts SYNCED rows and neither request has landed yet. A re-claim does not
 * advance retryCount, so the `{ id, retryCount }` guard those writers used to carry does not stop any
 * of it.
 */
export { claimHeldFrom, heldClaimWhere, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'

/**
 * The outcome of trying to record a posted document on its sync row (o3d-550x).
 *
 * `ANOTHER_DOCUMENT_NAMED` is the case the claim fence must NOT be used for: the row already carries a
 * DIFFERENT externalTransactionId, so a newer claim posted its own document while this worker was on
 * the wire. Both documents are real and in the ledger. Overwriting would destroy the only local record
 * of one of them, so the row keeps what it already names and the displaced id is recorded as evidence
 * instead — in the same transaction, which is what `evidence` on the refusal variants is proof of.
 */
export type PostedSyncRecord =
  | { recorded: true }
  | { recorded: false; reason: 'ANOTHER_DOCUMENT_NAMED'; namedExternalId: string | null; evidence: string }
  | { recorded: false; reason: 'ROW_MISSING'; evidence: string }

/**
 * Record a posted document on its sync row — NOT fenced on claim ownership, on purpose (o3d-550x).
 *
 * o3d-550x asked for every result write to be fenced on the claim, `count === 0` meaning "discard my
 * result". That is right for the FAILURE and DEFERRAL writes ({@link heldClaimWhere}) and WRONG here,
 * and the difference is the whole point: a failure write asserts a state the row can be talked out of,
 * while this one records A FACT ABOUT THE EXTERNAL LEDGER that has already happened. Making it
 * conditional on still holding the claim would mean the displaced worker — the one that DID post —
 * writes nothing, and the document exists in Xero with nothing in IMS naming it.
 *
 * So the only precondition is the fact it protects: the row must not already name a DIFFERENT
 * document. `externalTransactionId: null` (nothing recorded yet) or the same id again (an idempotent
 * re-record) both land; a different id refuses, AND FILES THE EVIDENCE NAMING BOTH IDS BEFORE THIS
 * TRANSACTION COMMITS ({@link recordUnrecordablePostedDocument}) — the caller is handed the wording,
 * not the job of writing it. Whichever worker gets there first is recorded unconditionally — no race
 * decides it.
 */
export async function recordPostedSyncResult(
  // `activityLog` because the conflict evidence is filed inside this transaction (o3d-550x r2);
  // `$executeRaw` because the database-clock stamp below is raw SQL (o3d-batch-billpay / o3d-clxw r4).
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'accountingEvent' | 'accountingEventLog' | 'activityLog' | '$executeRaw'>,
  params: {
    entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
    externalId: string | null
    payload: SyncPayload
    /**
     * o3d-cvj9: the revision stamp Xero put on the document as it applied THIS write. Supplied ONLY
     * by the call sites where a connector write actually landed in this attempt. The short-circuit
     * sites — the row already carried an external id, so nothing was called — omit it entirely, and
     * that ABSENCE (not `null`) is what `resolveDocumentRevisionOrder` decides those paths on: an
     * attempt that called nothing changed nothing about the document and takes no claim on it.
     */
    externalRevisionAt?: Date | null
    /**
     * CALLED THE INSTANT A CONFLICT IS OBSERVED — before anything is written, and outside the
     * transaction's fate (Codex r3, HIGH).
     *
     * The return value of this function only reaches the caller if the transaction COMMITS. Round 3
     * covered a failure of the RECORD, which throws from inside and is therefore preserved; it did not
     * cover a failure of the TRANSACTION at any other point — a deadlock victim, a serialization
     * failure, a connection dropped at COMMIT. Those roll the record back and surface as an ORDINARY
     * error, and an ordinary error is handed to the ordinary retry, which round 3 traced to the end:
     * the row by then names the other document, so the runner completes the job as a success before it
     * even claims. The displaced identifier is in this process's memory and nowhere else, so it has to
     * leave the callback by a route a rollback cannot take with it.
     */
    onConflictObserved?: (incident: UnrecordablePostedDocument) => void
  },
): Promise<PostedSyncRecord> {
  const { entry, externalId, payload } = params
  const written = await tx.accountingSyncLog.updateMany({
    where: {
      id: entry.id,
      OR: [
        { externalTransactionId: null },
        ...(externalId ? [{ externalTransactionId: externalId }] : []),
      ],
    },
    data: {
      status: 'SYNCED',
      externalTransactionId: externalId,
      syncedAt: new Date(),
      errorMessage: null,
      processingStartedAt: null,
      // Claimed IN this transaction, so the row can never be SYNCED-with-an-id and silent about the
      // follow-ups it still owes (r10 finding 1).
      ...followUpObligationClaim(),
    },
  })
  if (written.count === 0) {
    const current = await tx.accountingSyncLog.findUnique({
      where: { id: entry.id },
      select: { externalTransactionId: true },
    })
    // THE EVIDENCE IS WRITTEN HERE, IN THE TRANSACTION THAT OBSERVED THE CONFLICT (Codex r1, high).
    // Not afterwards by the caller: see recordUnrecordablePostedDocument for why "afterwards" was a
    // way to lose it permanently.
    const refusal = current === null
      ? { reason: 'ROW_MISSING' as const, namedExternalId: null }
      : { reason: 'ANOTHER_DOCUMENT_NAMED' as const, namedExternalId: current.externalTransactionId }
    const evidence = await recordUnrecordablePostedDocument(tx, entry, externalId, refusal, params.onConflictObserved)
    return refusal.reason === 'ROW_MISSING'
      ? { recorded: false, reason: 'ROW_MISSING', evidence }
      : { recorded: false, reason: 'ANOTHER_DOCUMENT_NAMED', namedExternalId: refusal.namedExternalId, evidence }
  }
  // The registration's completion time is stamped by the DATABASE, in this transaction and strictly
  // after the POST returned (o3d-clxw round 4, merged as o3d-batch-billpay). The payment poller fences
  // its reversal verdict on this value against a `clock_timestamp()` it reads from the same database,
  // so no application host's clock can order — or misorder — a supplier payment.
  //
  // AFTER the Prisma write above, never before: the SYNCED write changes `status` without assigning
  // the provenance marker, so it trips the trigger that clears the marker; this statement then mints
  // the new pair. Swapped, the transaction would erase its own stamp.
  await stampSyncedAtFromDatabaseClock(tx, entry.id)
  await updateMirroredEventForSyncLog(tx, {
    syncLogId: entry.id,
    type: entry.type,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    payload,
    status: 'POSTED',
    externalId,
    // Spread, not `externalRevisionAt: params.externalRevisionAt`: the mirror distinguishes an
    // absent field from an explicit `null`, and a replay that called nothing must leave the stamp
    // an earlier write established alone rather than wiping it.
    ...(params.externalRevisionAt !== undefined ? { externalRevisionAt: params.externalRevisionAt } : {}),
  })
  return { recorded: true }
}

/**
 * A POSTED DOCUMENT COULD NOT BE RECORDED ON ITS ROW — and this write is the only thing that will ever
 * say so (o3d-550x; Codex r1 HIGH, Codex r2 medium 1).
 *
 * WHAT WENT WRONG THE FIRST TIME. The branch's whole rule is "fence the releases, never the evidence",
 * and {@link recordPostedSyncResult} honours it: the id write refuses no race. But when that write
 * REFUSES — the one case where the evidence is irreplaceable, because the row will never name this
 * document — the escalation was handed to `logActivityPersisted` AFTER the transaction closed. That
 * logger catches its own database errors and returns `false`; the return was ignored, and a crash
 * between the transaction and the call lost it just as completely. On the outbox path the job was then
 * marked PERMANENTLY failed on the strength of an escalation that may never have been written, and on
 * replay the already-SYNCED row is skipped — so a real Xero document ended up with NO durable IMS
 * evidence anywhere. The fence covered the happy evidence path and left the conflict evidence to the
 * weakest writer in the system.
 *
 * WHAT IT DOES NOW. The record is created inside the SAME transaction that observed the conflict, from
 * the SAME `findUnique` that established which document the row keeps — so it cannot describe a row
 * state that never existed, there is no window between observing and recording, and a failure to write
 * it ABORTS the transaction and throws {@link PostedDocumentEvidenceUnwritten} instead of returning a
 * description nobody wrote down. Callers therefore cannot complete or permanently fail an outbox job on
 * unwritten evidence: they never reach that code.
 *
 * THE STORE, RE-DECIDED WITH THE THIRD CONSTRAINT IN VIEW (Codex r2, medium 1). Four candidates, three
 * of which destroy the record they are asked to keep:
 *
 *   • The mirrored `AccountingEvent` — REJECTED. Its `(externalSystem, externalId)` unique is exactly
 *     what a second document for one reference collides on (o3d-cvj9), so the evidence of the collision
 *     would be the thing the collision destroys.
 *   • `AccountingSyncLog.errorMessage` — REJECTED. A later legitimate re-record of the id the row
 *     already names sets `errorMessage: null`, which erases it. It also does not exist at all in the
 *     ROW_MISSING case, which is the case that needs the record MOST.
 *   • `ActivityLog` under ordinary retention — REJECTED, and this is what round 2 got wrong. It is
 *     append-only and takes no foreign key, so it survives both of the above; but ERROR rows are
 *     deleted at 90 days by `purgeExpiredActivityLogs`, and this branch exists to stop a real Xero
 *     document becoming permanently untracked. Evidence that expires is the same defect one layer out.
 *   • `ActivityLog` NAMED IN THE RETENTION SWEEP'S EXEMPTION LIST — CHOSEN. The sweep's own
 *     `RETAINED_ACTIONS` is the mechanism the codebase already uses for rows that are STATE rather than
 *     history, it is enforced in the delete predicate itself (`action <> ALL(...)`), and it keeps every
 *     property that made ActivityLog right in the first place. See lib/activity-log-cleanup.ts for the
 *     boundedness argument that entry has to carry.
 *
 * The action name is imported, not spelt here, so the sweep and this write cannot drift apart.
 *
 * Redaction is applied here rather than inherited from the activity-log helper, because this write does
 * not go through it. `userId: null` deliberately: this runs on cron with no session, and resolving one
 * inside a transaction would put an auth round-trip on the conflict path.
 *
 * Returns the operator-facing description so the caller can reuse it as the outbox job's failure
 * message WITHOUT rebuilding it — one wording for one incident.
 */
async function recordUnrecordablePostedDocument(
  tx: Pick<Prisma.TransactionClient, 'activityLog'>,
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  externalId: string | null,
  refusal: { reason: UnrecordablePostedDocumentReason; namedExternalId: string | null },
  onConflictObserved?: (incident: UnrecordablePostedDocument) => void,
): Promise<string> {
  const incident: UnrecordablePostedDocument = {
    entry,
    postedExternalId: externalId,
    reason: refusal.reason,
    namedExternalId: refusal.namedExternalId,
  }
  // BEFORE the write, not after it. What this hands upward is the OBSERVATION, and the observation is
  // already complete: the row was read in this transaction and it names another document. Announcing it
  // after a successful insert would make it worth exactly as much as the insert — nothing, if the
  // transaction then fails to commit (Codex r3, HIGH).
  onConflictObserved?.(incident)
  const description = describeUnrecordablePostedDocument(incident)
  try {
    await tx.activityLog.create({ data: unrecordedPostedDocumentRecord(incident, description) })
  } catch (cause) {
    // Aborts the transaction, AND carries the displaced identifier upward — the runners match on this
    // type and escalate it out of band, because the ordinary retry cannot (Codex r2, HIGH).
    throw new PostedDocumentEvidenceUnwritten(incident, cause)
  }
  return description
}

/**
 * The one shape of the durable record, built in one place because it is written from TWO — inside the
 * conflict transaction, and again standalone by {@link escalateUnwrittenPostedEvidence} when that
 * transaction could not commit. Two spellings of the same record would be two `action` values the day
 * anybody edited one of them, and the retention exemption only protects the spelling it was given.
 */
function unrecordedPostedDocumentRecord(incident: UnrecordablePostedDocument, description: string) {
  const { entry } = incident
  return {
    userId: null,
    entityType: 'SYSTEM' as const,
    entityId: entry.id,
    action: UNRECORDED_POSTED_DOCUMENT_ACTION,
    tag: 'sync',
    level: 'ERROR' as const,
    description: redactActivityLogText(description),
    metadata: JSON.parse(JSON.stringify(sanitizeActivityLogMetadata({
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      postedExternalId: incident.postedExternalId,
      rowNamesExternalId: incident.reason === 'ANOTHER_DOCUMENT_NAMED' ? incident.namedExternalId : null,
      reason: incident.reason,
    }))),
  }
}

/**
 * HOW MANY TIMES THE CONFLICT TRANSACTION IS RE-DRIVEN BEFORE THE IDENTIFIER IS DECLARED UNSAVEABLE.
 *
 * Each attempt is a WHOLE fresh transaction — it re-takes the row, re-observes which document the row
 * names, and writes the record from that same observation — so re-driving does not weaken the property
 * round 2 established. What it buys is the common failure: a serialization conflict or a deadlock
 * victim, where the transaction that lost is perfectly able to commit a moment later. There is no sleep
 * between attempts on purpose: the conflicting transaction has already committed by the time ours is
 * rolled back, and a cron worker holding a claim is the wrong place to add latency.
 */
const EVIDENCE_TRANSACTION_ATTEMPTS = 3

/**
 * RECORD A POSTED DOCUMENT, AND DO NOT COME BACK WITHOUT EITHER THE RECORD OR THE IDENTIFIER
 * (Codex r2, HIGH).
 *
 * THE DEFECT THIS CLOSES. Round 2 made an unwritable conflict record abort its transaction and throw,
 * on the reasoning that the job would then be "retried rather than buried". But look at what the retry
 * is. It re-enters the sweep as an ORDINARY sync attempt against a row that now names the OTHER
 * document — so it takes the `entry.externalTransactionId` short-circuit, records that id (which
 * matches, so it lands), settles the row SYNCED and completes the outbox job as a SUCCESS. On the
 * outbox path it does not even get that far: the top of the loop sees a SYNCED row with an external id
 * and completes the job before claiming anything. The displaced identifier was never in the database
 * and is not in the retry's memory, so the retry that was supposed to preserve it is precisely what
 * throws it away, quietly, with a success verdict.
 *
 * So the identifier never enters the ordinary retry path. Every one of the four call sites goes through
 * this function, which owns the transaction, and:
 *
 *   • re-drives the whole conflict transaction while the failure is the RECORD (bounded — see
 *     {@link EVIDENCE_TRANSACTION_ATTEMPTS}); a later attempt that finds the row recordable after all
 *     records the document normally, which is the right answer and not a special case;
 *   • lets any OTHER error out untouched, so ordinary sync failures keep their ordinary handling;
 *   • rethrows {@link PostedDocumentEvidenceUnwritten}, carrying both identifiers, for the runners to
 *     escalate through {@link escalateUnwrittenPostedEvidence} instead of through a retry.
 */
export async function recordPostedDocumentDurably(
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  externalId: string | null,
  payload: SyncPayload,
  /**
   * o3d-cvj9, threaded through the re-drive: the revision stamp of the write THIS attempt made, or
   * omitted entirely by the two short-circuit sites that called nothing. Omitted and `null` are
   * different answers to the mirror, so this stays optional rather than defaulting to `null`.
   */
  externalRevisionAt?: Date | null,
  /**
   * o3d-xl63 r3 #2: the transaction options for a POST-REMOTE persist. Prisma's default `maxWait` is
   * 2 seconds, which is right for work that has not started and wrong for the record of a document
   * the external ledger already holds — it gives up long before the pool's own acquisition bound and
   * turns a busy moment into a lost identifier. Callers persisting after a remote write pass
   * `POST_REMOTE_PERSIST_TX_OPTIONS`; everyone else keeps Prisma's defaults.
   */
  txOptions?: { maxWait?: number; timeout?: number },
): Promise<PostedSyncRecord> {
  const revision = externalRevisionAt !== undefined ? { externalRevisionAt } : {}
  let unwritten: PostedDocumentEvidenceUnwritten | undefined
  /**
   * THE OBSERVATION IS STICKY FOR THE WHOLE CALL, AND ROUND 4 MADE IT PER ATTEMPT (Codex r4, HIGH).
   *
   * Round 4 reset the observation every attempt, on the reasoning that "an observation from a
   * rolled-back attempt must not DESCRIBE the next one". That half is still true and is still honoured
   * below — `observed` wins whenever this attempt made one of its own. What round 4 also did, by
   * accident, was let a later attempt that observed NOTHING throw the earlier observation away: attempt
   * 1 sees the conflict and cannot write the record, attempt 2 dies in the row `updateMany` before it
   * ever reaches the conflict branch, `observed` is undefined, and `throw error` leaves this function
   * as a BARE DATABASE ERROR. The runners do not recognise that type, so it takes the ordinary failure
   * branch, and round 3 already traced where that ends: next run the row is the winner's, settled with
   * ITS id, and the job is completed as a success. The re-drive that exists to PRESERVE the displaced
   * identifier discarded it on the attempt that followed.
   *
   * So an observation is kept for the life of the call. It is a fact about the LEDGER — this worker
   * posted `externalId` and the row named something else — not a fact about the attempt that saw it,
   * and no rollback can make it untrue. The part a later attempt could legitimately update
   * (`namedExternalId`) is exactly the part a later observation overrides.
   */
  let carried: UnrecordablePostedDocument | undefined
  for (let attempt = 1; attempt <= EVIDENCE_TRANSACTION_ATTEMPTS; attempt++) {
    // Per ATTEMPT for DESCRIBING this attempt: each attempt is a whole fresh transaction that
    // re-observes the row, so a stale observation never gets to speak for a fresh one. It is `carried`
    // that survives the attempt, and only as the fallback.
    let observed: UnrecordablePostedDocument | undefined
    try {
      return await db.$transaction(async (tx) => recordPostedSyncResult(tx, {
        entry,
        externalId,
        payload,
        ...revision,
        onConflictObserved: (incident) => { observed = incident },
      }), txOptions)
    } catch (error) {
      if (error instanceof PostedDocumentEvidenceUnwritten) {
        // Both halves: the ready-made failure to throw if we run out of attempts, AND the incident
        // itself, so an attempt that observes nothing still has something true to carry (Codex r4, HIGH).
        unwritten = error
        carried = error.incident
        continue
      }
      // THE TRANSACTION FAILED SOMEWHERE ELSE, AND THE CONFLICT WAS ALREADY OBSERVED (Codex r3, HIGH).
      //
      // Round 3 preserved a failure OF THE RECORD, because that one throws from inside and the throw is
      // the preservation. A deadlock victim, a serialization failure or a connection lost at COMMIT does
      // not: the record rolls back, and what leaves this function is an ordinary database error. Follow
      // it, the way round 3 followed the retry. The runners' catch tests for
      // PostedDocumentEvidenceUnwritten and this is not one, so it lands in the ORDINARY failure branch
      // — applyMainSyncFailureRetry plus markXeroOutboxRetry — and the next run reads a row that the
      // winning worker has already settled SYNCED with ITS id. The outbox runner completes such a job at
      // the top of the loop, before it claims anything; the direct runner never selects the row again at
      // all. Green verdict, and the identifier this process is holding is the only copy there was.
      //
      // So an observed conflict converts the failure rather than being lost to it: same incident, both
      // ids, same operator wording, and a type the runners escalate out of band. Re-driven like any
      // other attempt first — a deadlock victim is exactly the case that commits a moment later.
      //
      // AND `carried`, NOT ONLY `observed` (Codex r4, HIGH). A conflict this call has ALREADY seen is
      // not unseen by a later attempt failing earlier than the branch that would have seen it again;
      // rethrowing bare here is the same discard, one attempt further on.
      const incident = observed ?? carried
      if (!incident) throw error
      carried = incident
      unwritten = new PostedDocumentEvidenceUnwritten(incident, error)
    }
  }
  // `unwritten` is set by construction (the loop runs at least once), but throwing `undefined` if
  // somebody ever set the attempt budget to zero would lose the incident in a different way.
  throw unwritten ?? new Error(
    `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} was never recorded and never `
    + `attempted: the posted-document attempt budget is ${EVIDENCE_TRANSACTION_ATTEMPTS}.`,
  )
}

/**
 * THE LAST RESORT, and it is deliberately not a retry (Codex r2, HIGH).
 *
 * Reached only when {@link recordPostedDocumentDurably} could not save the record at all. The identifier
 * exists in exactly one place — the error in this function's hand — and every ordinary route out of here
 * discards it:
 *
 *   • handing the row back through `applyMainSyncFailureRetry` schedules an ordinary attempt, and an
 *     ordinary attempt settles the row and reports success;
 *   • `markXeroOutboxRetry` does the same thing one level up: the next run sees SYNCED + an external id
 *     and completes the job;
 *   • `markXeroOutboxSuccess` is obviously worse.
 *
 * The row itself is left ALONE. In the usual shape of this incident the winning worker has already
 * recorded its document and released the row, so this worker no longer holds the claim and must not
 * touch it — failing closed means refusing to release, never retracting a settlement somebody else's
 * successful read justified. No document is at risk from leaving it: the row already names a document,
 * so any later attempt short-circuits and settles rather than posting a second one.
 *
 * What is left is to put the identifier somewhere that is NOT the store that just refused it. The
 * process log always gets it (it cannot fail and it cannot be swept), and the outbox runner also burns
 * the job PERMANENTLY with the same wording — which is not the round-1 defect of burying on evidence
 * nobody wrote, but the opposite: burying is what stops the retry that would erase the incident, and the
 * job's own failure column is a durable record in a different table from the one that failed.
 *
 * ONE MORE ATTEMPT AT THE DURABLE RECORD, STANDALONE (Codex r3, HIGH). The transaction is gone; the
 * record it wanted to write need not be. Since the conflict is now also carried out of transactions that
 * failed at COMMIT — where the insert itself was never the problem — a plain, unwrapped write of the
 * same row very often lands, and it is the only writable form of the incident that a later run can READ.
 * It is what stops a job whose burial failed from being completed as a success on the next pass (see
 * `findUnrecordedPostedDocumentEvidenceFor`). It is attempted AFTER the console line, never before: the
 * console line cannot fail, and the order means a crash inside this call still leaves the incident said
 * out loud. Its own failure is swallowed for the same reason — there is nothing further to try, and
 * throwing here would replace an escalation with a stack trace.
 *
 * Returns whether the record landed, so a caller can say which kind of incident it is looking at.
 */
export async function escalateUnwrittenPostedEvidence(error: PostedDocumentEvidenceUnwritten): Promise<boolean> {
  console.error(`[xero-sync] ${error.operatorMessage}`)
  try {
    await db.activityLog.create({
      data: unrecordedPostedDocumentRecord(
        error.incident,
        // The incident's own wording, not `operatorMessage`: the same sentence the transactional write
        // would have stored, so one incident reads identically wherever it landed. `operatorMessage`
        // ends by saying the identifier exists only in that message, which this write makes untrue.
        `${describeUnrecordablePostedDocument(error.incident)} (Recorded outside its own transaction, `
        + `which could not be committed: ${String(error.cause)}.)`,
      ),
    })
    return true
  } catch (cause) {
    console.error(
      `[xero-sync] the unrecorded-document record for sync log ${error.syncLogId} could not be written `
      + `outside its transaction either: ${String(cause)}`,
    )
    return false
  }
}

/** How many times the outbox job's burial is re-driven before the run itself is failed. */
const EVIDENCE_BURIAL_ATTEMPTS = 3

/**
 * BURY THE JOB, AND DO NOT LET A FAILED BURIAL BECOME A SUCCESS (Codex r3, HIGH).
 *
 * Round 3 chose burial for one reason: burying is what STOPS the retry that erases the incident. Follow
 * what a failed `markXeroOutboxPermanent` actually did before this function existed. It threw from
 * inside the catch handler, so it escaped the handler, the loop and the run — leaving the job exactly as
 * it was, PROCESSING and locked by this worker. `CLAIM_STALE_MS` later, `claimIntegrationOutboxWork`
 * re-claims it as a stale lock, and the next run reads the sync row: SYNCED, with the WINNER's id on it.
 * That is the branch at the top of the loop, whose own comment said the incident could no longer reach
 * it — `markXeroOutboxSuccess`, `result.skipped++`. The incident round 3 refused to let a retry erase
 * was erased by a reclaim instead, with a green verdict, which is the same failure one layer further
 * out.
 *
 * Three things now stand between that failure and a success:
 *
 *   • the burial is RE-DRIVEN, because the common failure here is a blip, not a verdict;
 *   • if it still cannot be written, the run FAILS carrying the operator wording, instead of a bare
 *     database error with the incident detached from it;
 *   • and the reclaim path reads the standalone evidence record before it completes anything, so the
 *     job is buried on the next pass rather than completed. That is the durable half: it survives this
 *     process ending, which nothing held in memory here does.
 */
export async function buryOutboxJobForUnwrittenPostedEvidence(
  job: IntegrationOutboxRow,
  error: PostedDocumentEvidenceUnwritten,
  /** Whether {@link escalateUnwrittenPostedEvidence} got the record written down after all. */
  recordFiled: boolean,
): Promise<void> {
  let lastFailure: unknown
  for (let attempt = 1; attempt <= EVIDENCE_BURIAL_ATTEMPTS; attempt++) {
    try {
      await markXeroOutboxPermanent(job, error.operatorMessage)
      return
    } catch (cause) {
      lastFailure = cause
    }
  }
  throw new XeroOutboxBurialError(
    `${error.operatorMessage} THE OUTBOX JOB ${job.id} COULD NOT BE BURIED EITHER: ${String(lastFailure)}. `
    + (recordFiled
      ? 'The incident IS on record in the activity log, and the next run reads it before completing this '
        + 'job, so the reclaim will bury the job rather than complete it.'
      : 'NOTHING WAS WRITTEN DOWN: not the record, not the job. This message is the only copy of the '
        + 'identifier, and a reclaim of this job will find a settled row and complete it as a success.'),
    { cause: lastFailure },
  )
}

/**
 * NOT fenced on the claim, deliberately (o3d-a3wx r6). This runs only AFTER the post succeeded and the
 * row was written SYNCED with `processingStartedAt: null`, so there is no claim left to match — the
 * row is already out of the live set either way. A displaced owner reaching here has posted, and its
 * SYNCED row is what the post-time capacity guard counts, so the slot it frees is not a silent one.
 */
export async function markSyncLogForFollowUpRetry(
  attempt: AttemptRef,
  entry: { retryCount: number },
  error: unknown,
  client?: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
): Promise<{ errorMessage: string; finalFailure: boolean }> {
  const errorMessage = `Xero follow-up work failed after connector post: ${String(error)}`
  const retryCount = entry.retryCount + 1
  const finalFailure = retryCount >= MAX_RETRIES
  const conn = client ?? db
  // Optimistic-concurrency guard: only advance from the retryCount we observed.
  // Two workers handling the same sync log (e.g. duplicate outbox jobs pointing
  // at one AccountingSyncLog) must not both increment from a stale value and
  // double-write the failure transition. The compound where makes the update a
  // no-op for the loser of the race.
  //
  // o3d-e2mz: fenced on the claimed attempt too. retryCount alone cannot identify
  // an attempt — retryFailedXeroSync resets it to 0 — so without the revision this
  // write could land on a LATER attempt, or revive a row an operator has settled.
  const updated = await conn.accountingSyncLog.updateMany({
    where: { id: attempt.id, attemptRevision: attempt.attemptRevision, retryCount: entry.retryCount },
    data: {
      status: finalFailure ? 'FAILED' : 'PENDING',
      retryCount,
      errorMessage,
      processingStartedAt: null,
    },
  })
  if (updated.count > 0) {
    return { errorMessage, finalFailure }
  }
  // Lost the race: another worker already advanced this row. Reflect the
  // PERSISTED state so the caller's outbox decision (permanent vs retry) acts on
  // reality, not our stale view — otherwise we could mark the outbox job for
  // retry while the row is already terminally FAILED (or vice-versa).
  const current = await conn.accountingSyncLog.findUnique({
    where: { id: attempt.id },
    select: { retryCount: true, status: true },
  })
  return {
    errorMessage,
    finalFailure: current
      ? current.status === 'FAILED' || current.retryCount >= MAX_RETRIES
      : finalFailure,
  }
}

/**
 * audit-om4e: apply a MAIN-sync failure (processEntry failed, not a follow-up)
 * to the sync-log row with the same optimistic-concurrency guard as
 * markSyncLogForFollowUpRetry. Two workers handling the same row (stale-claim
 * reclaim, or duplicate outbox jobs) must not both advance retryCount from a
 * stale value and double-write the failure transition / mirrored event. The
 * compound where makes the update a no-op for the loser; on a lost race we
 * re-read so the caller's outbox permanent/retry decision reflects reality and
 * we skip the mirrored-event write the winner already did.
 *
 * o3d-550x: RETRYCOUNT WAS NEVER THE LOSER-DETECTOR IT WAS WRITTEN AS, for the stale-claim reclaim
 * this header names first. Re-claiming a row does not advance retryCount, so both workers observe the
 * same value and BOTH updates match. The displaced owner therefore wins here, un-claims the
 * replacement mid-flight and drops the row back to PENDING/FAILED, which frees the row for a third
 * claim while a request is still on the wire. This write now also carries {@link heldClaimWhere}: a
 * failure is recorded only by the worker that still holds the claim it took, and a displaced one falls
 * through to the lost-race branch and reports the row as it actually stands.
 */
export async function applyMainSyncFailureRetry(
  tx: Pick<Prisma.TransactionClient, 'accountingSyncLog' | 'accountingEvent' | 'accountingEventLog'>,
  attempt: AttemptRef,
  entry: { retryCount: number; type: AccountingSyncType; referenceType: string; referenceId: string },
  errorMessage: string,
  payload: SyncPayload,
  /** The claim THIS worker holds. Required: an unfenced release is the o3d-550x defect. */
  held: HeldClaim,
): Promise<{ finalFailure: boolean }> {
  const retryCount = entry.retryCount + 1
  const computedFinal = retryCount >= MAX_RETRIES
  // o3d-e2mz: fenced on the claimed attempt as well as the observed retryCount. A
  // failure belongs to ONE attempt; without the revision this write reopens a row an
  // operator settled while this attempt was in flight, sending it round again as
  // PENDING/FAILED with no trace that a decision was discarded.
  const updated = await tx.accountingSyncLog.updateMany({
    // BOTH fences, and they answer different questions (o3d-550x + o3d-e2mz). The held claim says
    // "I still own this row" — it stops a DISPLACED owner writing over its replacement. The attempt
    // revision says "this failure belongs to the attempt I claimed" — it stops the write landing on
    // a row an OPERATOR has decided about, which moves the revision without touching the claim.
    where: {
      ...heldClaimWhere(attempt.id, held),
      attemptRevision: attempt.attemptRevision,
      retryCount: entry.retryCount,
    },
    data: {
      status: computedFinal ? 'FAILED' : 'PENDING',
      retryCount,
      errorMessage,
      processingStartedAt: null,
    },
  })
  if (updated.count > 0) {
    if (computedFinal) {
      await updateMirroredEventForSyncLog(tx, {
        syncLogId: attempt.id,
        type: entry.type,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        payload,
        status: 'FAILED',
        message: errorMessage,
      })
    }
    return { finalFailure: computedFinal }
  }
  // Lost the race: another worker already advanced this row (and wrote the
  // mirrored event if it became terminal). Report the persisted state.
  const current = await tx.accountingSyncLog.findUnique({
    where: { id: attempt.id },
    select: { retryCount: true, status: true },
  })
  return {
    finalFailure: current
      ? current.status === 'FAILED' || current.retryCount >= MAX_RETRIES
      : computedFinal,
  }
}

async function logFollowUpRetry(entryId: string, error: unknown): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_followup_error',
    tag: 'sync',
    level: 'WARNING',
    description: `Xero sync entry ${entryId} posted successfully but follow-up work failed and will be retried: ${String(error)}`,
  })
}

/**
 * o3d-hbgo: a live row only owns this follow-up when it targets the SAME external document. Counting
 * rows by (connector, type, reference) alone made a re-invoiced order's payment look already-handled,
 * so the replacement invoice was never settled — and a skip logs nothing. The anchor comparison lives
 * in the follow-up idempotency module so the ROW dedup and the remote TOKEN are scoped by the same
 * fields; a dedup that names less than the token can only discard work the token could distinguish.
 *
 * Payloads rather than a count: the anchors live inside the JSON, and the live rows for one scope are
 * bounded by the partial unique index that backs this check.
 */
async function hasExistingSyncLog(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
): Promise<{ exists: boolean; asserted: boolean }> {
  const liveRows = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type,
      referenceType,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
    // o3d-anu8: settlementBasis, because the occupying row is what makes the enqueue a silent skip
    // and a SYNCED row is written by TWO things — the processor's writeback after Xero answered, and
    // an operator typing a document id into the settlement dialog.
    select: { payload: true, settlementBasis: true },
  })
  const occupying = liveRows.filter((row) => liveRowOccupiesFollowUpSlot(row.payload, payload as FollowUpPayload))
  return {
    exists: occupying.length > 0,
    // WORST-FIRST, as o3d-nf9i established for aggregation: one asserted occupant is enough for the
    // suppression to rest on an assertion, because any of them may be the only reason this is skipped.
    asserted: occupying.some((row) => isOperatorAssertedSettlement(row.settlementBasis)),
  }
}

/**
 * True for a Postgres unique-constraint violation surfaced by Prisma (P2002) —
 * used so a concurrent follow-up enqueue that loses the race against the
 * accounting_sync_logs_followup_live_unique index (audit-42co) is swallowed as an
 * idempotent no-op rather than thrown.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/**
 * Where a follow-up's ORIGIN RECORD comes from. Never from "what is connected now" (Codex r3 finding 1).
 *
 * A follow-up is always work about a document some earlier post created, so the only honest statement
 * about which organisation its ids belong to is the one the row that made that post already carries.
 * Naming the two cases in the type is the point: a caller cannot reach the enqueue without saying which
 * of them it is in, and there is no third option that means "look it up".
 */
type FollowUpOriginEvidence =
  /**
   * The COMPLETE DURABLE ORIGIN RECORD of the row whose post issued the ids in this follow-up — its
   * payload, its `connectionProvenance` column and retention's `backReferenceEvidenceCompactedAt`.
   * Carried VERBATIM where the payload speaks, including its absence, which then refuses.
   *
   * o3d-bqw7 r2 (Codex HIGH): the payload ALONE was not the record. Compaction writes `payload: {}`
   * and keeps the column, so on a tombstone — precisely the rows this pipeline classifies as still
   * having a REBUILDABLE invoice PDF — the payload said nothing, the follow-up was created unstamped,
   * and it could never post. The classification was a claim the code did not honour.
   */
  | { from: 'postedRow'; record: AccountingOriginRecord }
  /** Nothing in hand observed the origin. The row is created carrying no record, and cannot post. */
  | { from: 'unobserved' }

/**
 * o3d-anu8 — THIS MONEY POST IS CLEARED BY A HUMAN'S WORD, and the record says so.
 *
 * The plan carries `restsOnAssertion` only on a money-moving create/reuse whose scope holds a row an
 * operator settled as NOT_POSTED. That settlement is what dropped the distinct-token count and turned
 * a refusal into this enqueue — deliberately, it is the documented purpose of the action — but
 * without this line the resulting payment is indistinguishable from one the connector's own history
 * cleared, and if the assertion was wrong there is nothing to lead anybody back to it.
 *
 * WRITTEN INSIDE THE ENQUEUE'S OWN TRANSACTION, AFTER THE ROW EXISTS (Codex, this branch). The first
 * revision wrote it at PLAN time, with `logActivity(...).catch(() => {})`, and got both halves wrong:
 *
 *   • NOT TIED TO THE OUTCOME. The word in the record is "Enqueued", and at that point nothing had
 *     been. Three things could still stop the enqueue afterwards — the unfenced-reuse refusal, the
 *     ledger-clearance refusal, and the create/revive itself (a lost compare-and-swap, a unique-index
 *     collision, any database failure). Each leaves a WARNING on the log asserting a money post that
 *     never happened, which is worse than silence: the next person to reconcile a suspected duplicate
 *     is led to a payment that does not exist, and the operator assertion it names looks acted upon.
 *   • NOT DURABLE. `.catch(() => {})` is the correct default for the hundreds of informational writes
 *     in this codebase and the wrong one here. This record is the ONLY thing that will ever say a
 *     ledger-affecting post rested on a human's word rather than on evidence — o3d-nf9i's own rule,
 *     and `logActivityInTransaction` exists for exactly it. Best-effort would let the enqueue commit
 *     with the reliance silently unrecorded and nothing would ever surface the gap.
 *
 * One transaction, so the record and the row commit together or neither does: an unwritable record
 * aborts the enqueue rather than leaving a money post nobody can trace back to the assertion that
 * released it. Called on BOTH arms — a revived row is as much a post cleared by that assertion as a
 * created one — and on neither of the arms that did not enqueue.
 */
async function recordEnqueueRestingOnAssertion(
  tx: Pick<Prisma.TransactionClient, 'activityLog'>,
  identity: { type: FollowUpSyncType; referenceType: string; referenceId: string },
  plan: { action: 'create' | 'reuse'; restsOnAssertion?: SettlementAssertionReliance },
): Promise<void> {
  if (!plan.restsOnAssertion) return
  await logActivityInTransaction(tx, {
    // Explicit null: the session lookup logActivity falls back on is a React cache() read, which has
    // no place inside a database transaction — and no operator is present here anyway. The people
    // this names are on the settlement rows the metadata points at.
    userId: null,
    entityType: 'SYSTEM',
    action: 'xero_followup_enqueue_rests_on_operator_assertion',
    tag: 'sync',
    level: 'WARNING',
    description: `Enqueued Xero ${identity.type} for ${identity.referenceType} ${identity.referenceId} while `
      + `${plan.restsOnAssertion.assertedNotPostedRowIds.length} earlier row(s) for it are CANCELLED because an `
      + 'OPERATOR asserted they never posted. IMS verified nothing about that: if any of them did reach the ledger, '
      + 'this post duplicates it. Reconcile in the accounting system if this money appears twice.',
    metadata: {
      type: identity.type,
      referenceType: identity.referenceType,
      referenceId: identity.referenceId,
      assertedNotPostedRowIds: plan.restsOnAssertion.assertedNotPostedRowIds,
      planAction: plan.action,
    },
  })
}

/**
 * Exported for unit tests (o3d-e2mz r3): the revival compare-and-swap in here is the one write on a
 * money-moving path that a whole processor run has to be driven to reach, and the fence on it is
 * cheaper to pin directly than through a full post-and-follow-up loop.
 *
 * o3d-peh1 — IT RETURNS WHETHER THE FOLLOW-UP IS ACTUALLY OWED, and every path out of it says so.
 * THREE of them decline deliberately, and they are the whole of `FollowUpEnqueueRefusalReason`: an
 * ambiguous token history, a ledger that will not confirm the attempt is absent, and a revival
 * target with no attempt revision whose type the ledger probe does not speak for. A live row holding
 * the scope under a DIFFERENT token is NOT one of them: `resolveLostFollowUpRevival` either answers
 * FOLLOW_UPS_ENQUEUED or THROWS, and the `slot_lost` code that once said otherwise was removed as
 * unconstructible (o3d-peh1 r4). The first two used to write a WARNING and then return `void`, which
 * every caller read as "enqueued". The back-reference sweep read it
 * that way while SETTLING the parent row, so a money follow-up that was never re-enqueued was logged
 * as recovered. The refusal is now part of the return type, so a caller that settles on it is a
 * compile error rather than a silent loss.
 */
export async function enqueueFollowUpSyncLog(
  type: FollowUpSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  origin: FollowUpOriginEvidence,
  /** Bounds the re-plan below, so a pathological race cannot recurse forever. */
  attempt = 0,
): Promise<FollowUpEnqueueOutcome> {
  // o3d-19gy: the origin record is settled HERE, before anything reads or plans against it, so a
  // follow-up payload carries the connection whose post issued the external id it is built from.
  //
  // IT IS INHERITED, NEVER MINTED (Codex r2 finding 1, then r3 finding 1). Round 1 claimed "re-stamping
  // on a revival is deliberate", and that was the defect: a revived row is pinned to the idempotency
  // token its EARLIER attempt was spent under, and rewriting its origin to the current tenant made a
  // payment first attempted against organisation A look, to the post-time guard, like ordinary
  // organisation-B work. Round 2 fixed the REVIVAL path in `planFollowUpEnqueue`, and left the CREATE
  // path still reading `activeAccountingIdProvenance()` — the same forgery one step out, because a
  // creating repair had not witnessed the post either, and the guard would later compare B against B.
  //
  // So there is no read of the live connection on this path at all. A caller that took the post hands
  // over that row's payload and its record travels; a caller that did not hands over nothing and the row
  // is born with no record, which `accountingPayloadConnectionVerdict` refuses rather than assumes.
  payload = (origin.from === 'postedRow'
    // o3d-bqw7 r2: the COMPLETE record, so a retention tombstone hands on the organisation its
    // durable column still names instead of handing on the silence its emptied payload holds.
    ? carryAccountingOriginRecordFrom(payload, origin.record)
    : carryAccountingOriginRecord(payload, undefined)) as SyncPayload
  // Fast-path check; the partial unique index (audit-42co) is the atomic backstop
  // for the check-then-create race between concurrent sync runs.
  const live = await hasExistingSyncLog(type, referenceType, referenceId, payload)
  const liveRowExists = live.exists
  // o3d-h2wx: a FAILED row is REUSED rather than replaced. Xero's Idempotency-Key is
  // derived from the entry id, so creating a replacement row would post the retry under a
  // key Xero has never seen — and if the failed attempt had actually committed, a SECOND
  // payment lands on the invoice.
  //
  // KEEPING THE KEY IS NECESSARY, NOT SUFFICIENT (o3d-wahn r2 #1). Xero forgets an
  // Idempotency-Key after SIX MINUTES, and a follow-up is re-enqueued long after that, so a
  // pinned token is by then a string Xero no longer recognises either. What actually stops
  // the second payment is the plan's REFUSAL on an ambiguous token history below, plus the
  // pinned request body — see lib/domain/accounting/idempotency-retention.ts for what is and
  // is not protected once the window has closed.
  const failedLogs = liveRowExists ? [] : await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR, type, referenceType, referenceId,
      // o3d-anu8: the SAME query widened rather than a second one, because the two row sets answer
      // one question between them. FAILED rows are the ambiguity set. A CANCELLED row carrying
      // OPERATOR_ASSERTION is a row that LEFT that set on a human's word — `buildSettlementData`
      // documents that as the intended unblock — and the planner is told about it so a money post
      // cleared that way can be recorded as such instead of looking connector-cleared.
      OR: [
        { status: 'FAILED' },
        { status: 'CANCELLED', settlementBasis: OPERATOR_ASSERTION_SETTLEMENT_BASIS },
      ],
    },
    orderBy: { createdAt: 'desc' },
    // remoteAttemptedAt is what tells the planner whether a row's payload is the record of a call
    // that reached Xero. A revival OVERWRITES the payload it recycles, so recycling an attempted
    // row rotates that attempt's token and discards its anchors, amount and date — see the recycle
    // note in followup-idempotency.ts. attemptStampingCustodyAt comes with it because an unstamped
    // row only proves anything when nothing but a STAMPING binary has handled it (round 10): it is
    // read off the row rather than resolved from a global epoch, so this path needs no extra query
    // and cannot be given a stale answer.
    //
    // o3d-e2mz r3: and the attempt each candidate row is AT when it was read. Reviving one is a
    // write to that attempt and must be fenced on it — see the compare-and-swap below.
    select: {
      id: true, payload: true, status: true,
      remoteAttemptedAt: true, attemptStampingCustodyAt: true,
      attemptRevision: true,
    },
  })
  // Split back out. Only FAILED rows are the ambiguity set the planner counts tokens over; the
  // asserted-cancelled ones are carried purely so a plan can say what cleared it (o3d-anu8).
  // The PAYLOAD travels with the id (Codex round 2, MEDIUM). These rows are scoped to the ORDER, not
  // to the document this follow-up targets, so the planner filters them by anchor before it records
  // a reliance on them — and it can only do that from the payload. Handing over ids alone is what
  // let the audit record name assertions about an invoice this payment never touched.
  const assertedNotPostedRows = failedLogs
    .filter((row) => row.status === 'CANCELLED')
    .map((row) => ({ id: row.id, payload: row.payload }))
  const failedAttemptRevisions = new Map(
    failedLogs.filter((row) => row.status === 'FAILED').map((row) => [row.id, row.attemptRevision]),
  )
  const failedRows = failedLogs.filter((row) => row.status === 'FAILED').map((row) => ({
    id: row.id,
    payload: row.payload,
    // Exactly what followUpIdempotencySource would have produced for this row, so pinning it
    // reproduces a byte-identical Idempotency-Key even after the row itself is gone.
    effectiveToken: followUpIdempotencySource(row.id, (row.payload ?? {}) as SyncPayload),
    remoteAttemptedAt: row.remoteAttemptedAt,
    attemptStampingCustodyAt: row.attemptStampingCustodyAt,
  }))
  const plan = planFollowUpEnqueue({
    connector: XERO_CONNECTOR,
    type,
    referenceType,
    referenceId,
    payload,
    liveRowExists,
    liveRowAsserted: live.asserted,
    failedRows,
    assertedNotPostedRows,
  })
  // A live row already owns this scope, so the follow-up IS queued — by that row. This is the one
  // early return that is genuinely "enqueued", and it is spelt as such rather than shared with the
  // refusals below (o3d-peh1).
  if (plan.action === 'skip') return FOLLOW_UPS_ENQUEUED
  if (plan.action === 'refuse') {
    const message = `Refused to re-enqueue Xero ${type} for ${referenceType} ${referenceId}: ${plan.reason} `
      + 'Nothing was queued and the FAILED rows are unchanged. '
      + 'A RETRY CANNOT CLEAR THIS: the manual retry applies the same rule and refuses for the same reason. Open the '
      + 'document in Xero, establish which attempt actually landed, and record that on each row with Settle on the '
      + 'accounting sync log (\'it posted, here is the id\' / \'it did not post\'). The follow-up is enqueued by the '
      + 'next sweep once the scope is no longer ambiguous.'
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: message,
      metadata: { type, referenceType, referenceId, reason: 'plan_refused', failedRowIds: failedRows.map((row) => row.id) },
    })
    return refusedFollowUpEnqueue({ type, referenceType, referenceId, reason: 'plan_refused', message })
  }

  // TWO REFUSALS GUARD THE AUTOMATIC REVIVAL, AND THEY ARE NOT THE SAME QUESTION (o3d-e2mz + o3d-0m56).
  //
  //   o3d-e2mz asks CAN THIS WRITE BE TIED TO AN ATTEMPT. A revival is a write to an attempt, and the
  //   compare-and-swap below used to key on `(id, status: 'FAILED')` — the ABA the manual retry was
  //   already fenced against. Status is not an identity: a row leaves FAILED and comes back every
  //   time it is retried, so between the read above and the write it can be revived, claimed, posted
  //   or failed and land back on FAILED as a DIFFERENT attempt, which the status CAS matches. It
  //   would reset that attempt's outcome and overwrite its `payload`, where the pinned idempotency
  //   token lives, sending the row out under a token chosen for the attempt we read rather than the
  //   one that ran.
  //
  //   o3d-peh1 — AND REVISION 0 IS FENCED BY THE REVISION ITSELF, WHICH IS WHY IT IS NO LONGER
  //   REFUSED. ON THIS CONNECTOR. `attemptRevision` only ever moves UP here: every Xero writer sets
  //   it through `nextAttemptRevision`, and nothing anywhere resets it. So `(id, FAILED,
  //   attemptRevision: 0)` is a STRICTLY STRONGER predicate than the `(id, FAILED)` ABA — a row that
  //   has been claimed since the read is at 1 or more and matches nothing. The ABA that made
  //   revision 0 dangerous also cannot occur: getting from FAILED back to FAILED requires a claim,
  //   and A XERO CLAIM MINTS 1.
  //
  //   THAT ARGUMENT IS XERO-ONLY AND MUST NOT BE READ AS CONNECTOR-GENERAL (round 4, Codex LOW).
  //   The QuickBooks processor mints NO attempt revision at all: `retryFailedQuickBooksSync` drives
  //   FAILED -> PENDING and its claim leaves the row at 0, so a QuickBooks row goes
  //   FAILED -> PENDING -> FAILED WITHOUT THE REVISION MOVING, and the twin of the revival below
  //   (lib/connectors/quickbooks/sync-processor.ts, the `plan.action === 'reuse'` CAS) carries no
  //   revision clause whatsoever — it is `{ id, status: 'FAILED' }`, the exact ABA this paragraph
  //   declares impossible. That is PRE-EXISTING there, not something this change introduced, and
  //   closing it needs the QuickBooks attempt fence that rounds 6 and 7 failed to build out of
  //   claim-time markers. It is filed as o3d-rw0w; do not port this justification across.
  //
  //   Refusing it instead was a DEAD END, and that is the defect this replaces. The migration left
  //   every pre-existing FAILED Xero payment and allocation at revision 0; FAILED rows are not
  //   processor candidates; and the per-row Retry refuses at revision 0 for the same reason this did.
  //   So the refusal's own suggested remedy could not be performed, and only an operator who knew to
  //   click the bulk "Retry All" could ever revive one. The revival now happens automatically and
  //   LEAVES THE REVISION AT 0, exactly as `retireSalesInvoiceForCancelledOrder` does: the row goes
  //   back to PENDING, the PROCESSOR's own claim mints revision 1, and "0 is never forged into 1 by
  //   anything but a claim" holds unchanged — the revival creates no attempt, it only offers one.
  //
  //   o3d-0m56 asks MAY THIS BE RE-POSTED AT ALL. Reviving a money row under a PINNED token only
  //   protects while Xero still remembers that token — minutes — and this runs whenever the
  //   connector next sweeps, long after. So the ledger has to say the attempt is not already in it.
  //
  // Neither implies the other: a perfectly fenced attempt can still be one the ledger already holds,
  // and a clear ledger says nothing about which attempt this write will land on. Both refusals leave
  // the row FAILED and visible, which is the state it was already in; posting twice is not.
  //
  // With revision 0 now revivable, the o3d-0m56 ledger question is the one left to ask before a
  // reuse — BUT IT IS ONLY ASKED OF MONEY-MOVING TYPES, and round 4 wrote that it "is asked for EVERY
  // reuse" as though it were not (round 5, Codex MEDIUM). `ledgerClearsFollowUpRevival` returns
  // `{ clear: true }` without probing anything when `isMoneyMovingSyncType(type)` is false, and there
  // is no ledger to probe for an email, a PDF, a store note or an attachment — none of them creates a
  // document.
  const reuseAttempt: AttemptRef | null = plan.action === 'reuse'
    ? { id: plan.syncLogId, attemptRevision: failedAttemptRevisions.get(plan.syncLogId) ?? UNCLAIMED_ATTEMPT_REVISION }
    : null

  // SO THE HALF OF ROUND 4's REFUSAL THAT NOTHING REPLACED IS KEPT.
  //
  // Round 4 removed a blanket refusal of revision-0 reuse targets. For a MONEY type that was right:
  // the CAS carries `attemptRevision: 0`, which is strictly stronger than the `(id, FAILED)` ABA, and
  // the ledger probe now answers the separate question of whether the attempt already committed. For
  // every other type the second half is missing, and it is missing for the population that most needs
  // it: the migration left every pre-existing FAILED row at revision 0, so "revision 0 means never
  // claimed" is true of rows this binary created and FALSE of legacy ones — which reached FAILED by
  // running, up to MAX_RETRIES times, and for INVOICE_EMAIL that means the customer may already hold
  // the invoice. `POST_EFFECT.INVOICE_EMAIL` says it in as many words: the email CANNOT be recalled.
  //
  // Refusing does NOT strand the work silently. The refusal is part of the return type, so the
  // back-reference sweep reports it and declines to settle the parent instead of logging a recovery
  // that did not happen, and the message names a remedy that exists today: the bulk "Retry All" on
  // the sync log is not attempt-fenced, drives the row FAILED -> PENDING, and the processor's own
  // claim then mints revision 1 — after which this reuse is fenced like any other. That makes an
  // unrecallable duplicate a deliberate human act rather than something a sweep does on its own,
  // which is the most this can honestly offer while no evidence about the effect exists.
  //
  // NOT PORTED TO QUICKBOOKS. That processor's reuse CAS carries no revision clause at all, so it has
  // a different and larger hole; it is filed as o3d-rw0w and closing it needs the QuickBooks attempt
  // fence, not this refusal.
  if (reuseAttempt
    && reuseAttempt.attemptRevision === UNCLAIMED_ATTEMPT_REVISION
    && !isMoneyMovingSyncType(type)) {
    const message = `Refused to re-enqueue Xero ${type} for ${referenceType} ${referenceId}: the FAILED row it would `
      + `revive (${reuseAttempt.id}) carries no attempt revision, and ${type} creates no ledger document, so nothing `
      + 'can establish whether its effect already happened — a row left at revision 0 predates the attempt fence and '
      + 'reached FAILED by RUNNING, so reviving it could repeat an effect that cannot be taken back. Nothing was '
      + 'queued and the row is unchanged. Check whether the effect landed (see the row\'s own type), and if it should '
      + 'run again use Retry All on the accounting sync log: that re-queues the row, the processor\'s claim stamps an '
      + 'attempt, and every later revival of it is fenced.'
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: message,
      metadata: {
        type,
        referenceType,
        referenceId,
        syncLogId: reuseAttempt.id,
        reason: 'unprobed_unfenced_reuse',
        failedRowIds: failedRows.map((row) => row.id),
      },
    })
    return refusedFollowUpEnqueue({
      type, referenceType, referenceId, reason: 'unprobed_unfenced_reuse', message, syncLogId: reuseAttempt.id,
    })
  }

  const evidence = await ledgerClearsFollowUpRevival({
    connector: XERO_CONNECTOR,
    type,
    payload: plan.payload,
    tokenDisposition: plan.action === 'reuse' ? plan.tokenDisposition : 'rotated',
    syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
  })
  if (!evidence.clear) {
    const message = `Refused to re-enqueue Xero ${type} for ${referenceType} ${referenceId}: `
      + `${evidence.reason}. Re-posting it could duplicate a payment, so nothing was queued and the row is `
      + 'unchanged. Open the document in Xero: if that settlement IS this attempt, record it with Settle on the '
      + 'accounting sync log so the row stops being retried; if it is not, the follow-up is enqueued by the next '
      + 'sweep once the ledger no longer matches.'
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: message,
      metadata: {
        type,
        referenceType,
        referenceId,
        reason: 'ledger_not_clear',
        syncLogId: reuseAttempt?.id,
        failedRowIds: failedRows.map((row) => row.id),
      },
    })
    return refusedFollowUpEnqueue({
      type, referenceType, referenceId, reason: 'ledger_not_clear', message, syncLogId: reuseAttempt?.id,
    })
  }

  try {
    const outcome = await db.$transaction(async (tx) => {
      // Serializes this insert/revival against the manual retry's read-then-reset for the same
      // document (o3d-0m56). Money-moving types only; everything else pays nothing.
      await lockFollowUpScope(tx, { connector: XERO_CONNECTOR, type, referenceType, referenceId })
      if (plan.action === 'reuse') {
        if (!reuseAttempt) throw new Error(`Xero follow-up revival for ${plan.syncLogId} reached its write with no attempt to fence on`)
        // Fenced on the ATTEMPT, not on the status: if another run revived the same row first, a
        // worker claimed it, or retention deleted it between the read and here (o3d-nepa), this
        // updates nothing rather than resetting an attempt it does not own. The bump is what stops
        // the previous attempt's holder writing back over the revival.
        // o3d-peh1: the revision is ADVANCED only where there is an attempt to advance. A row at
        // UNCLAIMED_ATTEMPT_REVISION is left at 0 so the processor's claim mints its first attempt —
        // the same shape `retireSalesInvoiceForCancelledOrder` uses, and for the same reason: forging
        // an attempt that never ran would let a later decision believe this row had been fenced.
        // `attemptRevision: 0` is still IN the predicate, so this is a compare-and-swap either way.
        const fenced = reuseAttempt.attemptRevision !== UNCLAIMED_ATTEMPT_REVISION
        const revived = await tx.accountingSyncLog.updateMany({
          where: { id: reuseAttempt.id, status: 'FAILED', attemptRevision: reuseAttempt.attemptRevision },
          data: {
            status: 'PENDING',
            payload: plan.payload as never,
            retryCount: 0,
            errorMessage: null,
            processingStartedAt: null,
            ...(fenced ? { attemptRevision: nextAttemptRevision(reuseAttempt.attemptRevision) } : {}),
          },
        })
        if (revived.count === 0) return 'cas-lost' as const
        // The reliance record commits with the revival, or the revival does not commit.
        await recordEnqueueRestingOnAssertion(tx, { type, referenceType, referenceId }, plan)
        await scheduleXeroAccountingOutbox(tx, {
          accountingSyncLogId: plan.syncLogId,
          // Explicit 0 rather than resetAttempts: a PROCESSING outbox row honours only an
          // explicit `attempts` (outbox.ts) and ignores resetAttempts, so the revived entry
          // would keep a spent attempt budget and never be claimed (Codex review, r1 #6).
          attempts: 0,
        })
        return 'done' as const
      }
      const log = await tx.accountingSyncLog.create({
        data: {
          connector: XERO_CONNECTOR,
          type,
          status: 'PENDING',
          referenceType,
          referenceId,
          payload: plan.payload as never,
          // o3d-dzip: the DURABLE half of the same origin record, minted from the stamp in the
          // payload this statement is writing — which for a follow-up is the origin INHERITED from the
          // row whose post issued these ids (carryAccountingOriginRecord above), never the connection
          // that happens to be live now. A repair that witnessed nothing mints nothing, and that
          // absence refuses.
          connectionProvenance: mintAccountingConnectionProvenanceColumn(plan.payload),
          // o3d-0m56 r10: created INSIDE attempt-stamping custody. That is what later lets a revival
          // read this row's unset `remoteAttemptedAt` as proof no remote call ever left it — see
          // money-attempt-provenance.ts. A row created without it is never recycled again.
          ...stampingCustodyOnCreate(),
        },
      })
      // Same rule on the create arm: one transaction, so a money post cleared by an assertion cannot
      // exist without the line that says so.
      await recordEnqueueRestingOnAssertion(tx, { type, referenceType, referenceId }, plan)
      await scheduleXeroAccountingOutbox(tx, {
        accountingSyncLogId: log.id,
      })
      return 'done' as const
    })
    if (outcome === 'cas-lost' && plan.action === 'reuse') {
      // o3d-peh1: the resolver's verdict IS this call's verdict. It either finds a live row carrying
      // our token (enqueued, by somebody else), re-plans — whose own outcome must travel back out —
      // or throws. Discarding it here would put the silence straight back one frame down.
      return await resolveLostFollowUpRevival({
        connector: XERO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.syncLogId,
        attempt,
        // plan.payload carries the PINNED token, and withFollowUpIdempotencyKey never
          // overwrites one — so a row created by the re-plan posts under the same remote
          // key as the row that vanished. That is what makes losing the row survivable.
          // The plan's payload already holds the origin this enqueue resolved (carried from the row
          // it reuses, or inherited on a create), so the re-plan inherits from itself rather than
          // asking again — asking again is what "look it up" would reintroduce.
          retry: () => enqueueFollowUpSyncLog(
            type, referenceType, referenceId, plan.payload,
            { from: 'postedRow', record: { payload: plan.payload, connectionProvenance: null } }, attempt + 1,
          ),
      })
    }
    if (plan.action === 'reuse') await logFollowUpRevival(XERO_CONNECTOR, type, referenceType, referenceId, plan)
  } catch (error) {
    // A concurrent run took the live slot and the partial unique index
    // (accounting_sync_logs_followup_live_unique) rejected ours. This used to return as an
    // idempotent no-op, which silently accepted a winner posting under a DIFFERENT token
    // while ours may already have committed (Codex review, r7 #1). It now goes through the
    // same resolver as a lost compare-and-set, which only accepts a live row carrying our
    // token.
    if (isUniqueConstraintViolation(error)) {
      return await resolveLostFollowUpRevival({
        connector: XERO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
        attempt,
        retry: () => enqueueFollowUpSyncLog(
          type, referenceType, referenceId, plan.payload,
          { from: 'postedRow', record: { payload: plan.payload, connectionProvenance: null } }, attempt + 1,
        ),
      })
    }
    throw error
  }
  return FOLLOW_UPS_ENQUEUED
}

function syncLogNextAttemptAt(log: { status: string; processingStartedAt: Date | null }): Date | null {
  if (log.status === 'PENDING' && log.processingStartedAt && log.processingStartedAt > new Date()) {
    return log.processingStartedAt
  }
  return null
}

function invoicePaymentReferenceKey(entry: Pick<InvoicePaymentOrderingEntry, 'referenceType' | 'referenceId'>): string {
  return `${entry.referenceType}\u0000${entry.referenceId}`
}

/**
 * A TOTAL order over the live INVOICE_PAYMENT rows of one reference (Codex round 3 #2).
 *
 * `createdAt` ALONE IS NOT AN ORDER. `default(now())` is transaction-clock, so two rows inserted in
 * the same transaction — or in two transactions that committed inside the same clock tick — carry the
 * IDENTICAL timestamp. Under a strict `<` comparison neither of them is "after" the other, so NEITHER
 * is deferred, and both run.
 *
 * That is not a cosmetic tie. The whole reason the post-time capacity guard may treat PENDING and
 * PROCESSING siblings as consuming no capacity is that this function lets exactly ONE live entry per
 * order be undeferred at a time — the later ones re-run the arithmetic against the earlier one's
 * SYNCED row when their turn comes. Two same-timestamp receipts defeat that serialisation, both read
 * a table in which neither has posted yet, and both post: the order is settled twice.
 *
 * So the order is made total by falling back to the row id, which is unique by construction. The
 * TIE-BREAK VALUE DOES NOT MATTER — only that every runner computing this set independently picks the
 * SAME winner. `id` is stable and identical in every process, where `createdAt` is not discriminating.
 * (`[{ createdAt: 'asc' }, { id: 'asc' }]` is the same tie-break the tree already uses for stable
 * pagination, e.g. pending-shipment-reconciliation.ts and outbox-admin.ts.)
 */
export function invoicePaymentLogPrecedes(
  a: { id: string; createdAt: Date },
  b: { id: string; createdAt: Date },
): boolean {
  const at = a.createdAt.getTime()
  const bt = b.createdAt.getTime()
  if (at !== bt) return at < bt
  return a.id < b.id
}

export async function findInvoicePaymentsBlockedByEarlierLiveLogs(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entries: InvoicePaymentOrderingEntry[],
): Promise<Set<string>> {
  const paymentEntries = entries.filter((entry) => entry.type === 'INVOICE_PAYMENT')
  if (paymentEntries.length === 0) return new Set()

  const referenceFilters = [...new Map(
    paymentEntries.map((entry) => [invoicePaymentReferenceKey(entry), {
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
    }]),
  ).values()]
  const liveLogs = await client.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: 'INVOICE_PAYMENT',
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: referenceFilters,
    },
    // `status` is selected because this pre-filter now asks decideInvoicePaymentClaim the question
    // rather than re-deriving a second, narrower rule of its own (round 5 #1).
    select: { id: true, referenceType: true, referenceId: true, status: true, createdAt: true },
    // Tie-broken by id so the database's own ordering agrees with invoicePaymentLogPrecedes below.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })

  // ONE RULE, ASKED TWICE (round 5 #1). Both runners consult this set AFTER taking the locked claim
  // and defer the entry if it is a member — so a verdict here that the locked claim does not share is
  // not a cheap pre-filter, it is a second, contradictory decider that hands the claim straight back.
  //
  // Round 4's local rule was "is any live row for this reference earlier than me?", which says YES for
  // the stale PROCESSING holder that the claim had just admitted: claimed, then immediately deferred,
  // every minute, for ever. That is the same deadlock as decideInvoicePaymentClaim's, reached through
  // the pre-filter instead. Delegating removes the possibility of the two disagreeing at all.
  const liveByReference = new Map<string, LiveInvoicePaymentEntry[]>()
  for (const log of liveLogs) {
    const key = invoicePaymentReferenceKey(log)
    const bucket = liveByReference.get(key)
    if (bucket) bucket.push(log)
    else liveByReference.set(key, [log])
  }

  const blocked = new Set<string>()
  for (const entry of paymentEntries) {
    const live = liveByReference.get(invoicePaymentReferenceKey(entry)) ?? []
    if (!decideInvoicePaymentClaim({ entryId: entry.id, live }).claim) {
      blocked.add(entry.id)
    }
  }
  return blocked
}

/**
 * THE ELECTION IS NOT A SERIALISATION (Codex round 4 #3).
 *
 * `findInvoicePaymentsBlockedByEarlierLiveLogs` makes every runner that sees THE SAME ROWS elect the
 * same winner. Round 3 proved that property and then used it as though it were mutual exclusion. It
 * is not, and the gap is not the tie-break:
 *
 *   Both runners compute the blocked set ONCE, before their claim loop, from their OWN snapshot of
 *   the table. `processPendingXeroSyncDirect` reads at t1; the outbox worker reads at t2. A row that
 *   commits between them is in one snapshot and not the other:
 *
 *     t1  direct runner reads live rows for order O and sees only X. X is the minimum, so X runs.
 *     t1' a second receipt Y commits for order O, with an EARLIER createdAt (a deferred re-drive
 *         restoring an older row's timestamp, or simply two receipts recorded seconds apart under
 *         clock skew between the app instances).
 *     t2  outbox worker reads and sees {X, Y}. The minimum is Y — not X — so Y runs.
 *
 *   Two runners, one total order, no tie anywhere, and both entries post. The post-time capacity
 *   guard cannot catch it either: it counts SYNCED rows, and at the moment both read the table
 *   neither sibling has posted yet. That guard's own header states the assumption plainly — "only the
 *   EARLIEST live INVOICE_PAYMENT for an order is ever un-deferred, so a sibling cannot be posting
 *   alongside us" — and that is precisely what an unsynchronised election does not deliver.
 *
 * WHAT ACTUALLY EXCLUDES. A rule of the form "am I the smallest?" can always be invalidated by a row
 * arriving later with a smaller key, so no amount of agreement about ORDER produces exclusion. What
 * does is a rule that only ever looks BACKWARD: another entry for this reference is already claimed,
 * therefore I may not be. That is monotone — a newly-committed row cannot un-claim an existing claim.
 *
 * So the ordering keeps its job (which PENDING entry goes next, and it is still total so both runners
 * pick the same one) and a second, decisive test is added: nothing else for this reference may be
 * PROCESSING. Both are evaluated INSIDE the transaction that takes the claim, under the sales order's
 * row lock — the same lock o3d-3zgy already makes order-scoped accounting writes take — so two
 * runners cannot interleave their read and their write at all.
 *
 * STALENESS IS NOT AN EXEMPTION. A PROCESSING sibling whose claim went stale fifteen minutes ago is
 * still a request nothing local can recall; that is the settled reading everywhere else in this tree
 * (IN_FLIGHT_BILL_PAYMENT_STATUSES, the round-2 supersession rule). Blocking on it costs a 60-second
 * deferral, because a stale row is itself re-claimable and will be driven to SYNCED or FAILED by
 * whichever runner takes it — at which point this entry proceeds and the capacity guard judges it on
 * what that row ended up saying.
 *
 * AND THAT LAST SENTENCE WAS NOT TRUE AS ROUND 4 WROTE IT (Codex round 5 #1). The stale row is only
 * re-claimable if the rules let it claim, and they did not:
 *
 *     S  PROCESSING, claimed fifteen minutes ago, createdAt 09:00:05
 *     P  PENDING, createdAt 09:00:00
 *
 *   P asks to claim: S is PROCESSING, so ANOTHER_ENTRY_IS_POSTING — defer 60s.
 *   S asks to re-claim: P is PENDING and precedes it, so AN_EARLIER_ENTRY_IS_WAITING — defer 60s.
 *
 * Each defers to the other, for ever, and the order's payment never posts. The exclusion rule and the
 * ordering rule formed a cycle: exclusion points forward in status, ordering points backward in time,
 * and with the two rows disagreeing on those two axes there is no member of the live set that either
 * rule admits.
 *
 * THE CUT IS AT THE ORDERING RULE, NEVER AT THE EXCLUSION. Ordering exists to pick which UNCLAIMED
 * entry goes next; a row that is ITSELF PROCESSING is not queueing for the slot, it already holds it.
 * Applying a queue-position rule to the holder is what closed the cycle. So the holder skips the
 * ordering test — and only that test: it still has to pass the exclusion, so it can never run
 * alongside a different in-flight post. Nothing forward-looking is reintroduced.
 *
 * WHY THIS TERMINATES, as a property of the live set L for one reference rather than a hope:
 *   • If some row of L is PROCESSING, it is the ONLY one (exclusion + the order row lock admit no
 *     second claim), every other row is deferred by exclusion, and the holder is admitted by the
 *     exemption above. Whoever takes it drives it to SYNCED/FAILED/CANCELLED and it leaves L.
 *   • If no row of L is PROCESSING, the minimum under the total order has no PROCESSING sibling and
 *     no earlier sibling, so it is admitted.
 * L is therefore never fully blocked, and every admission ends with a row leaving L. |L| strictly
 * decreases, which is the termination argument round 4 asserted and did not have.
 *
 * The exemption costs nothing in safety: `accountingSyncLogClaimWhere` is still the fence that decides
 * whether a PROCESSING row may actually be re-taken, and it requires the claim to be older than the
 * stale cutoff. A live worker's own row is admitted by this function and then refused by that where
 * clause. This function decides QUEUE POSITION; the where clause decides WHO OWNS THE ROW.
 */
export type LiveInvoicePaymentEntry = { id: string; status: string; createdAt: Date }

export type InvoicePaymentClaimDecision =
  | { claim: true }
  /** Another entry for this reference holds the post slot. Nothing may be sent alongside it. */
  | { claim: false; reason: 'ANOTHER_ENTRY_IS_POSTING'; blockedBy: string }
  /** An earlier live entry for this reference has not gone yet. Ordering, not exclusion. */
  | { claim: false; reason: 'AN_EARLIER_ENTRY_IS_WAITING'; blockedBy: string }

/**
 * Pure. `live` is every PENDING/PROCESSING INVOICE_PAYMENT row for this entry's reference, INCLUDING
 * the entry itself when it is still live (a stale re-claim reads its own row back as PROCESSING —
 * self is never a blocker, or nothing could ever be retried).
 */
export function decideInvoicePaymentClaim(input: {
  entryId: string
  live: LiveInvoicePaymentEntry[]
}): InvoicePaymentClaimDecision {
  const others = input.live.filter((row) => row.id !== input.entryId)
  const self = input.live.find((row) => row.id === input.entryId)

  // BACKWARD-LOOKING, and therefore the only test here that excludes. Ordered by the same total order
  // so the id reported is stable rather than whichever row the database happened to return first.
  const posting = others
    .filter((row) => row.status === 'PROCESSING')
    .sort((a, b) => (invoicePaymentLogPrecedes(a, b) ? -1 : 1))[0]
  if (posting) return { claim: false, reason: 'ANOTHER_ENTRY_IS_POSTING', blockedBy: posting.id }

  // THE HOLDER OF THE SLOT IS NOT QUEUEING FOR IT (round 5 #1). Reached only when nothing ELSE is
  // posting, so this row is the single live claim for the reference. Deferring it behind an earlier
  // PENDING row — which is itself deferred by the exclusion above, because THIS row is the thing
  // posting — is the deadlock: the two rules point in opposite directions and neither admits anybody.
  // Ordering decides which unclaimed entry goes next; it has no opinion about the entry that already
  // went. Whether this row may actually be RE-taken is `accountingSyncLogClaimWhere`'s question, and
  // it still answers "only if the claim is stale".
  if (self?.status === 'PROCESSING') return { claim: true }

  if (!self) return { claim: true }
  const earlier = others
    .filter((row) => invoicePaymentLogPrecedes(row, self))
    .sort((a, b) => (invoicePaymentLogPrecedes(a, b) ? -1 : 1))[0]
  if (earlier) return { claim: false, reason: 'AN_EARLIER_ENTRY_IS_WAITING', blockedBy: earlier.id }
  return { claim: true }
}

export type SyncLogClaimResult =
  | { outcome: 'claimed' }
  /** The row was not claimable (already taken, retired, posted, or out of retries). */
  | { outcome: 'not-claimable' }
  /** Another INVOICE_PAYMENT for the same reference owns the slot, or precedes this one. */
  | { outcome: 'deferred'; reason: 'ANOTHER_ENTRY_IS_POSTING' | 'AN_EARLIER_ENTRY_IS_WAITING'; blockedBy: string }

/**
 * Take the claim. For an order-scoped INVOICE_PAYMENT this happens under the order row lock together
 * with the exclusion test, so the read that authorises the claim and the claim itself cannot be
 * interleaved by another runner. Everything else claims exactly as before — the lock buys nothing for
 * a type that is not competing for a single per-reference post slot, and taking it would put an
 * unnecessary order lock in front of every journal and invoice push.
 */
async function claimAccountingSyncLog(
  entry: { id: string; type: string; referenceType: string; referenceId: string; attemptRevision: number },
  claimedAt: Date,
  staleClaimCutoff: Date,
  /**
   * o3d-e2mz: the attempt this claim MINTS, taken from the revision the caller read.
   *
   * It is stamped by the claim statement itself and the claim swaps on the observed revision, so the
   * claim is the compare-and-swap that creates the identity: two workers reading the same row can
   * never both believe they hold it, and the winner holds a value nothing else can name. Passed in
   * rather than derived here so the caller and every write below fence on ONE object.
   */
  attempt: AttemptRef,
): Promise<SyncLogClaimResult> {
  // o3d-0m56 r10 / o3d-anu8 r3: the claim, attempt-stamping CUSTODY and the refusal that makes
  // restoring custody safe are ONE `updateMany` argument, built here — in the one object both claim
  // statements below share — rather than assembled at each call site.
  //
  // A claim is what precedes a post, so the database's forfeit trigger reads a claim that does not
  // re-assert custody as one made by a binary that does not stamp, and takes custody away. Losing it
  // is silent and permanent for that row: its unset `remoteAttemptedAt` can never again be read as
  // proof no remote call left it, so the planner will never recycle it.
  //
  // And restoring it is not unconditional. A money row an OLD binary claimed, posted from and left
  // unstamped carries neither custody nor a stamp, and that pair means "undetermined". Restoring
  // custody alone would rewrite it into `attemptProvenNeverMade`'s positive proof — a payment that
  // may have posted, read as certainly not posted. The helper's predicate refuses that row instead;
  // the repair on the first line of this sweep stamps it, and it claims normally afterwards.
  const claimStatement = stampingCustodyOnClaim({
    where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff, entry.attemptRevision),
    processingStartedAt: claimedAt,
    data: {
      status: 'PROCESSING' as const,
      attemptRevision: attempt.attemptRevision,
    },
  })

  if (entry.type !== 'INVOICE_PAYMENT' || entry.referenceType !== 'SalesOrder') {
    const claim = await db.accountingSyncLog.updateMany({ ...claimStatement })
    return claim.count === 0 ? { outcome: 'not-claimable' } : { outcome: 'claimed' }
  }

  return db.$transaction(async (tx) => {
    await lockSalesOrder(tx, entry.referenceId)
    const live = await tx.accountingSyncLog.findMany({
      where: {
        connector: XERO_CONNECTOR,
        type: 'INVOICE_PAYMENT',
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      select: { id: true, status: true, createdAt: true },
    })
    const decision = decideInvoicePaymentClaim({ entryId: entry.id, live })
    if (!decision.claim) {
      return { outcome: 'deferred', reason: decision.reason, blockedBy: decision.blockedBy }
    }
    const claim = await tx.accountingSyncLog.updateMany({ ...claimStatement })
    return claim.count === 0 ? { outcome: 'not-claimable' } : { outcome: 'claimed' }
  })
}

/**
 * How long an ordering deferral holds the row before it may be claimed again.
 *
 * One constant, and one message per deferral reason, consumed by BOTH runners — the outbox runner
 * also puts the reason on its job, and two spellings of the same deferral would read as two different
 * conditions on the exceptions page (o3d-550x, Codex r1).
 */
const ORDERING_DEFERRAL_MS = 60_000
const PAYMENT_ORDERING_DEFERRAL_MESSAGE = 'Deferred until older invoice payment sync logs post'
const UPDATE_ORDERING_DEFERRAL_MESSAGE = 'Deferred until the invoice CREATE for this document posts'

/** Which of the two exclusion tests declined, and the entry that stands in the way. */
export type InvoicePaymentDeferralDetail = {
  reason: 'ANOTHER_ENTRY_IS_POSTING' | 'AN_EARLIER_ENTRY_IS_WAITING'
  blockedBy: string
}

/**
 * What the row's errorMessage says while it waits, in terms an operator reading the queue can act on.
 *
 * Still ONE spelling per condition and still shared by both runners (o3d-550x): the no-detail answer
 * is `PAYMENT_ORDERING_DEFERRAL_MESSAGE` itself, so the pre-filter deferral reads exactly as it did.
 * The two detailed forms are not a second spelling of that condition — they are the two conditions
 * the locked claim can distinguish and the snapshot pre-filter cannot, and each names the entry to
 * go and look at.
 */
export function invoicePaymentDeferralMessage(detail?: InvoicePaymentDeferralDetail): string {
  if (detail?.reason === 'ANOTHER_ENTRY_IS_POSTING') {
    return `Deferred: invoice payment sync log ${detail.blockedBy} for the same order is being sent now`
  }
  if (detail?.reason === 'AN_EARLIER_ENTRY_IS_WAITING') {
    return `Deferred until earlier invoice payment sync log ${detail.blockedBy} posts`
  }
  return PAYMENT_ORDERING_DEFERRAL_MESSAGE
}

/**
 * o3d-550x: the caller holds the claim, so this gives it back through the one fenced release.
 * o3d-e2mz: and through the attempt it claimed — a deferral is still a write ABOUT one attempt, and
 * unfenced on the revision it can hand back a row an operator has decided about.
 */
export async function deferPaymentUntilEarlierLogsPost(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entry: { id: string },
  held: HeldClaim,
  detail?: InvoicePaymentDeferralDetail,
  attempt?: AttemptRef,
): Promise<boolean> {
  return releaseClaimForRetry(client, entry.id, held, {
    errorMessage: invoicePaymentDeferralMessage(detail),
    nextAttemptAt: new Date(Date.now() + ORDERING_DEFERRAL_MS),
  }, attempt)
}

/**
 * THE OTHER WAY TO GET HERE, AND IT IS NOT A RELEASE (o3d-a3wx round 4 #3, merged with o3d-550x).
 *
 * The locked claim can DECLINE, and then this entry was never claimed at all. There is no claim to
 * give back, so this deliberately does not go through `releaseClaimForRetry` and is not a second copy
 * of it: that function's whole job is to return a row this worker owns to PENDING under
 * `heldClaimWhere`, and here we own nothing.
 *
 * WHAT IT MUST NOT DO IS WRITE THE STATUS. An unconditional `status: 'PENDING'` would stamp over a
 * claim another runner took in the meantime — un-claiming a request that may already be on the wire,
 * which is the exact failure `heldClaimWhere` exists to prevent, reached from the opposite direction.
 * So the where-clause pins the row to PENDING (if it is not PENDING, somebody else owns it and this
 * must be a no-op) and only the next-attempt gate and the message move.
 */
export async function deferUnclaimedPaymentUntilEarlierLogsPost(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entry: { id: string },
  detail?: InvoicePaymentDeferralDetail,
): Promise<boolean> {
  // A future `processingStartedAt` on a PENDING row is the existing retry gate: it is read as
  // "earliest next claim time", not as a claim.
  //
  // The `data` below carries NO `status` KEY, and that is the whole point — see the header above.
  // This row was never claimed, so writing the queued status here would stamp over a claim another
  // runner took in the meantime, un-claiming a request that may already be on the wire. (Spelt that
  // way deliberately: the structural test in xero-sync-processor.test.ts scans this call's argument
  // text for a queued-status write, and a comment quoting one reads as the defect itself.) The
  // where-clause pins the row instead.
  //
  // BUT THE CUSTODY STAMP IS STILL REQUIRED, and the two rules are not in tension. The forfeit
  // trigger fires on ANY update that moves `processingStartedAt` to a new non-null value — it does
  // not also require the status to change — so this write would silently drop
  // `attemptStampingCustodyAt` and make the row permanently un-recyclable, however careful it is
  // about ownership. `stampingCustodyOnClaim` re-asserts it and sets no status of its own, so it
  // satisfies both fences at once. Custody is a claim about the BINARY that touched the row, not
  // about who owns it, and a stamping binary is exactly what is touching it here.
  //
  // AND THIS IS THE ONE CUSTODY WRITE THAT REACHES A ROW THIS WORKER DOES NOT OWN (o3d-anu8 r3), so
  // it is the one most able to launder an old binary's unstamped attempt back into custody. The
  // helper's refusal covers it: an INVOICE_PAYMENT row carrying neither custody nor a stamp is not
  // re-gated at all, and this reports that the deferral did not land — the closed direction.
  const deferred = await client.accountingSyncLog.updateMany(stampingCustodyOnClaim({
    where: { id: entry.id, status: 'PENDING' },
    processingStartedAt: new Date(Date.now() + ORDERING_DEFERRAL_MS),
    data: {
      errorMessage: invoicePaymentDeferralMessage(detail),
    },
  }))
  return deferred.count > 0
}

// audit-H5: an *_INVOICE_UPDATE must not post before the invoice's CREATE. The
// CREATE and its UPDATE share (referenceType, referenceId) — SALES_INVOICE /
// SalesOrder and PURCHASE_INVOICE / PurchaseOrder respectively.
const INVOICE_UPDATE_TO_CREATE_TYPE: Partial<Record<AccountingSyncType, AccountingSyncType>> = {
  SALES_INVOICE_UPDATE: 'SALES_INVOICE',
  PURCHASE_INVOICE_UPDATE: 'PURCHASE_INVOICE',
}

function invoiceCreateKey(createType: AccountingSyncType, referenceType: string, referenceId: string): string {
  return `${createType}\x00${referenceType}\x00${referenceId}`
}

/**
 * audit-H5: find *_INVOICE_UPDATE entries that should be deferred because the
 * invoice's CREATE row for the same document is still live (PENDING/PROCESSING).
 * Processing the UPDATE first fails with "invoice not found" and burns retries.
 * Same shape/pattern as findInvoicePaymentsBlockedByEarlierLiveLogs.
 */
export async function findInvoiceUpdatesBlockedByPendingCreate(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entries: InvoicePaymentOrderingEntry[],
): Promise<Set<string>> {
  const updateEntries = entries.filter((entry) => INVOICE_UPDATE_TO_CREATE_TYPE[entry.type])
  if (updateEntries.length === 0) return new Set()

  const orFilters = [...new Map(updateEntries.map((entry) => {
    const createType = INVOICE_UPDATE_TO_CREATE_TYPE[entry.type]!
    return [invoiceCreateKey(createType, entry.referenceType, entry.referenceId), {
      type: createType,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
    }]
  })).values()]

  const liveCreates = await client.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: orFilters,
    },
    select: { id: true, type: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const earliestLiveCreateByKey = new Map<string, { id: string; createdAt: Date }>()
  for (const log of liveCreates) {
    const key = invoiceCreateKey(log.type, log.referenceType, log.referenceId)
    if (!earliestLiveCreateByKey.has(key)) earliestLiveCreateByKey.set(key, log)
  }

  const blocked = new Set<string>()
  for (const entry of updateEntries) {
    const createType = INVOICE_UPDATE_TO_CREATE_TYPE[entry.type]!
    const liveCreate = earliestLiveCreateByKey.get(invoiceCreateKey(createType, entry.referenceType, entry.referenceId))
    // Defer only when the live CREATE was queued no later than the UPDATE — the
    // normal case (CREATE first, possibly same millisecond). A CREATE queued
    // AFTER this UPDATE (a re-issued invoice) does not block it, so the UPDATE is
    // never deferred indefinitely waiting on a newer CREATE.
    if (liveCreate && liveCreate.createdAt <= entry.createdAt) {
      blocked.add(entry.id)
    }
  }
  return blocked
}

/**
 * o3d-550x: fenced on the claim this worker holds, through the one release, like every other.
 * o3d-e2mz: and on the attempt that claim minted, for the reason on the payment deferral above.
 */
export async function deferUpdateUntilCreatePosts(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entry: { id: string },
  held: HeldClaim,
  attempt?: AttemptRef,
): Promise<boolean> {
  return releaseClaimForRetry(client, entry.id, held, {
    errorMessage: UPDATE_ORDERING_DEFERRAL_MESSAGE,
    nextAttemptAt: new Date(Date.now() + ORDERING_DEFERRAL_MS),
  }, attempt)
}

async function ensureXeroOutboxForPendingSyncLogs(limit: number, staleClaimCutoff: Date): Promise<void> {
  const now = new Date()
  const logs = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      OR: [
        {
          status: 'PENDING',
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lte: now } },
          ],
        },
        {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleClaimCutoff },
        },
      ],
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  for (const log of logs) {
    await scheduleXeroAccountingOutbox(db, {
      accountingSyncLogId: log.id,
      nextAttemptAt: syncLogNextAttemptAt(log),
      attempts: log.retryCount,
      resetAttempts: true,
    })
  }
}

/**
 * o3d-e2mz: the claim is itself a compare-and-swap on `attemptRevision`. Reading a row and then
 * claiming it on status alone lets two workers that read the same row both believe they hold it —
 * and lets a claim land on a row an operator has decided about since the read. Pairing this where
 * with `attemptRevision: nextAttemptRevision(observed)` in the data makes exactly one of them win
 * and gives the winner a value nothing else can hold.
 */
function accountingSyncLogClaimWhere(id: string, staleClaimCutoff: Date, observedAttemptRevision: number) {
  return claimAttemptWhere({
    id,
    connector: XERO_CONNECTOR,
    retryCount: { lt: MAX_RETRIES },
    OR: [
      {
        status: 'PENDING' as const,
        OR: [
          { processingStartedAt: null },
          { processingStartedAt: { lte: new Date() } },
        ],
      },
      {
        status: 'PROCESSING' as const,
        processingStartedAt: { lt: staleClaimCutoff },
      },
    ],
  }, observedAttemptRevision)
}


/**
 * RECORD A DOCUMENT XERO HAS ALREADY ACCEPTED (o3d-xl63 r2 #2, r3 #1-#3).
 *
 * Both processors reach the same point: `POST /Invoices` (or /Payments, /ManualJournals ...) has
 * returned an id, and the ONLY thing standing between that id and a duplicate on the next run is this
 * local write. Three properties, none of which the round-2 shape had:
 *
 *  1. IT IS RE-DRIVEN ACROSS A FAILURE TO START, using the transaction options that put the wait back
 *     under the pool's bound rather than Prisma's 2-second default (`POST_REMOTE_PERSIST_TX_OPTIONS`).
 *
 *  2. ITS DEADLINE IS THE CLAIM'S, NOT A CHOSEN NUMBER. `claim` is this row's actual claim —
 *     `processingStartedAt` and the cutoff another worker measures staleness against — so
 *     `persistAfterRemoteWrite` derives a deadline that always ends before this worker could be
 *     overtaken. That matters because the Xero post in front of it can itself burn minutes on
 *     rate-limit waits: a fixed two minutes measured from HERE could have run straight through the
 *     moment the claim lapsed, which is the double-post this is all for.
 *
 *  3. WHEN IT GIVES UP, THE EVIDENCE IS NOT WRITTEN THROUGH THE POOL THAT JUST REFUSED IT. Returning
 *     false used to drop the caller into the generic failure handler, whose first act is another
 *     `db.$transaction` — a connection from the pool that has spent the whole deadline handing none
 *     out. The record of what went unrecorded therefore could not be written in exactly the case it
 *     existed for. Now the id goes to fd 2 first (`reportUnrecordedRemoteWrite`), with no precondition
 *     beyond this process still holding it, and only then is a database record ATTEMPTED — as a single
 *     statement rather than an interactive transaction, because that path waits the full pool bound
 *     instead of being cut off after 2s, and because one statement needs a connection for an instant
 *     rather than for a transaction.
 *
 * Returns true when the row was recorded normally. On false the caller must NOT touch the database for
 * this row: the pool is exhausted, and everything worth saying has already been said by the reporter.
 */
/**
 * RE-TAKE THE CLAIM AT THE INSTANT THE REMOTE WRITE BEGINS (o3d-xl63 round 4, finding 1).
 *
 * Round 3 anchored the persist's deadline to the row's claim, which stops the persist outliving this
 * worker's exclusivity. It says nothing about the OTHER end: the claim can be gone before the post
 * even starts.
 *
 * The claim is taken, and then `processEntry` runs — and `processEntry` is not a POST. It reads the
 * granted scopes, resolves (or creates) the Xero contact, looks items up, and every one of those calls
 * goes through the same rate-limited client: `api.ts` records the worst case between the first HTTP
 * call and the last as three 90-second Retry-After sleeps plus three 60-second minute-limit waits.
 * Several such calls in front of the document post, and fifteen minutes of claim is spent BEFORE
 * anything is posted. Meanwhile the next sweep tick measures staleness, finds this row past the
 * cutoff, re-claims it and posts the document. Then this worker's post lands too: two documents in the
 * ledger, and the persist that follows — deadline 0 — cannot even record which one we made.
 *
 * A check would only tell us we had lost. Re-taking tells us AND fixes the runway: the update is
 * fenced on the exact `processingStartedAt` this worker wrote, so
 *
 *  • one row matched  -> the claim was still ours, and it now runs from HERE, giving the post and the
 *                        persist that follows it the full claim rather than whatever was left;
 *  • no row matched   -> someone else owns it. NOTHING IS POSTED. That is the whole point: the cheapest
 *                        possible outcome for a lost claim is to have sent nothing.
 *
 * The renewed timestamp becomes the claim anchor for everything downstream — the cancelled-order
 * guards inside `processEntry`, the persist deadline, and the claim-fenced terminal write on the
 * give-up path — so all of them fence on the claim this worker actually holds.
 */
// Exported for tests/accounting/xero-claim-before-remote-write.test.ts: "we did not post" is the
// outcome under test, and it is only observable at this seam.
export async function renewClaimForRemoteWrite(
  entryId: string,
  held: HeldClaim,
  /**
   * o3d-jit6 (Codex r1 finding 2): the durable "a create for this row is on the wire" record, minted
   * IN THIS STATEMENT rather than in one of its own.
   *
   * The record has to be committed before the request leaves, and the claim has to be the last thing
   * proven before it — and those two requirements only fit together if they are the same write. A
   * separate statement before the fence writes the marker on paths that then send nothing (the defect);
   * a separate statement after it puts an await between proving the claim and using it (o3d-xl63
   * r5 #1). One statement is both: the marker lands if and only if this worker still holds the row.
   *
   * Absent for every other remote mutation, which mint nothing.
   */
  mint?: CreateDispatchMint,
): Promise<Date | null> {
  const renewedAt = new Date()
  const renewed = await db.accountingSyncLog.updateMany({
    // The shared claim-identity fence (see heldClaimWhere), narrowed to this connector. `held` is
    // asked for its instant HERE, as the statement is built — so a renewal that has happened since
    // the caller obtained the claim is the instant this re-take fences on (o3d-xl63 r6).
    where: { ...heldClaimWhere(entryId, held), connector: XERO_CONNECTOR },
    // `processingStartedAt` is this host's clock and `createDispatchedAt` is the DATABASE's, read by
    // `planCreateDispatch` one statement ago. They are deliberately not the same instant: the claim is
    // only ever compared against itself, while the dispatch instant is aged against `clock_timestamp()`
    // by the next attempt, and mixing the two clocks there is the o3d-clxw defect.
    data: mint ? { processingStartedAt: renewedAt, ...mint } : { processingStartedAt: renewedAt },
  })
  return renewed.count === 1 ? renewedAt : null
}

/**
 * What to say when a claim was lost before anything was sent. Nothing is wrong with the row — it is
 * being worked on by somebody else — so this is a re-drive, not a failure.
 */
function lostClaimMessage(entryId: string, operation?: string): string {
  return `Xero sync log ${entryId} was not posted: this worker's claim on it had been taken by another `
    + `worker before the remote write${operation ? ` (${operation})` : ''} began, so posting would have `
    + `created a second document. The row belongs to whoever holds it now.`
}

/**
 * ONE ABSOLUTE LEASE OVER THE WHOLE ENTRY, AND A FENCE AT EVERY REMOTE MUTATION (o3d-xl63 r5 #1).
 *
 * Round 4 re-took the claim at the instant the remote write began and flagged, in its own commit
 * message, what that did NOT close: `processEntry` is not one call. Preparing an invoice loops over
 * every distinct item; a credit-note allocation does two reads and then a write; several types read
 * the chart of accounts first. Every one of those goes through the same rate-limited client, whose
 * in-request budget is six minutes PER CALL. The re-take happened once, in front of all of it — so
 * with enough sequential preparation calls the claim it took could be gone again by the time the
 * document itself was sent, which is the very state the re-take existed to prevent.
 *
 * Two bounds, and they answer different questions:
 *
 *  • THE FENCE answers "is this row still mine, right now?" It re-takes the claim immediately before
 *    each remote mutation — not once per entry — so the exclusivity is proven at the instant it is
 *    relied on rather than minutes earlier. Renewing rather than merely checking also means a long
 *    but legitimate entry stops LOOKING stale to the next sweep tick, which is what invited the
 *    second worker in.
 *
 *  • THE ABSOLUTE DEADLINE answers "has this entry had long enough?" It is fixed when the lease opens
 *    and NEVER moves, however many times the claim is renewed. Without it the renewals are a
 *    perpetual motion machine: a row wedged behind a rate limit could hold its claim for ever and
 *    never post. Preparation calls are inside it, which is the whole point — round 4's window began
 *    at the post; this one begins where the work does.
 *
 * A refusal from either is the SAME outcome, and it is the good one: nothing has been sent, so there
 * is nothing to be duplicated, no id to lose, and no persist to fence. The row is handed back.
 */
export const XERO_ENTRY_LEASE_MS = CLAIM_STALE_MS

export type RemoteWriteFence = { ok: true } | { ok: false; result: EntryResult }

export type RemoteWriteLease = HeldClaim & {
  entryId: string
  /**
   * The claim this worker holds RIGHT NOW. Moves forward on every successful fence.
   *
   * This accessor is the whole of the {@link HeldClaim} contract, so a lease IS a claim: it is passed
   * to `heldClaimWhere` and to every consumer that fences, and each of them reads the instant the row
   * currently carries rather than one snapshotted before the fences ran (o3d-xl63 r6).
   */
  heldFrom: () => Date
  /** Wall-clock instant past which no further remote mutation may BEGIN. Never moves. */
  deadlineAt: number
  /**
   * Re-take the claim immediately before a remote mutation, or refuse to make it.
   *
   * `mintCreateDispatch` (o3d-jit6) makes the SAME statement record that a create is going out. It is
   * written only on the path that actually reaches the socket, and it is written before it — see
   * {@link renewClaimForRemoteWrite}.
   */
  fenceBeforeRemoteWrite: (operation: string, mintCreateDispatch?: CreateDispatchMint) => Promise<RemoteWriteFence>
}

/**
 * Renew this worker's lock on the outbox job, fenced on the exact `lockedAt` it holds.
 *
 * The sync-row claim is not the only thing that can lapse under a long entry: the outbox job carries
 * its own `staleLockMs` (the same fifteen minutes), and a job whose lock has gone stale is handed to
 * another worker by `claimIntegrationOutboxWork` exactly as the row is. Fencing one and not the other
 * would leave the second worker free to re-post from the queue side.
 *
 * On success `job.lockedAt` is advanced IN PLACE, because every `markXeroOutbox*` helper fences on
 * it — a renewal that did not update the caller's copy would make the job impossible to complete.
 */
async function renewOutboxLockForRemoteWrite(job: IntegrationOutboxRow): Promise<boolean> {
  if (!job.lockedAt) return false
  const renewedAt = new Date()
  const renewed = await db.integrationOutbox.updateMany({
    where: {
      id: job.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedBy: XERO_ACCOUNTING_WORKER_ID,
      lockedAt: job.lockedAt,
    },
    data: { lockedAt: renewedAt },
  })
  if (renewed.count !== 1) return false
  job.lockedAt = renewedAt
  return true
}

/**
 * Open a lease for one entry: re-take the claim now, and fix the absolute deadline from this moment.
 *
 * Returns null when the claim is already gone, which is round 4's outcome unchanged — nothing is
 * sent and the row belongs to whoever holds it.
 */
export async function openRemoteWriteLease(
  entryId: string,
  claimedAt: Date,
  outboxJob?: IntegrationOutboxRow,
  now: () => number = () => Date.now(),
): Promise<RemoteWriteLease | null> {
  // `claimedAt` really is a fixed instant at this one point — it is the claim the sweep loop stamped,
  // and this is the statement that replaces it — so it is wrapped rather than carried further.
  const renewed = await renewClaimForRemoteWrite(entryId, claimHeldFrom(claimedAt))
  if (!renewed) return null

  let heldFrom = renewed
  // From here on the claim is an OBJECT, never a value: the fences below move `heldFrom`, and
  // everything downstream must see those moves (o3d-xl63 r6).
  const claim: HeldClaim = { heldFrom: () => heldFrom }
  const deadlineAt = now() + XERO_ENTRY_LEASE_MS

  return {
    entryId,
    heldFrom: () => heldFrom,
    deadlineAt,
    async fenceBeforeRemoteWrite(operation: string, mintCreateDispatch?: CreateDispatchMint): Promise<RemoteWriteFence> {
      // The deadline is checked BEFORE the renewal, so an entry that has run out of lease does not
      // extend its own claim on the way to refusing. Nothing is sent either way.
      if (now() >= deadlineAt) {
        const message = `Xero sync log ${entryId} was not posted: this entry has held its lease for the `
          + `full ${Math.round(XERO_ENTRY_LEASE_MS / 60_000)} minutes it is allowed — preparation calls `
          + `included — and the remote write (${operation}) was not started. Nothing was sent, so the row `
          + `is handed back intact and the next run gets a fresh lease.`
        return { ok: false, result: { success: false, error: message, notPosted: { reason: 'lease-expired', operation, message } } }
      }

      // Outbox lock first: if it is gone the sync-row claim is left exactly as it was, so the two
      // never disagree about who holds this work.
      if (outboxJob && !(await renewOutboxLockForRemoteWrite(outboxJob))) {
        const message = `Xero sync log ${entryId} was not posted: this worker's lock on outbox job `
          + `${outboxJob.id} had been taken before the remote write (${operation}) began, so the queue `
          + `may already be posting it. Nothing was sent.`
        return { ok: false, result: { success: false, error: message, notPosted: { reason: 'claim-lost', operation, message } } }
      }

      // THE CLAIM PROOF AND THE DISPATCH RECORD, ONE STATEMENT (o3d-jit6, Codex r1 finding 2). Every
      // gate that can refuse — the deadline, the outbox lock — has already refused above, without
      // writing anything. From here the only outcomes are "this worker still owns the row, the record
      // is committed, send" and "it does not, nothing was written, nothing is sent".
      let again: Date | null
      try {
        again = await renewClaimForRemoteWrite(entryId, claim, mintCreateDispatch)
      } catch (error) {
        // A create whose local record cannot be written is a create whose OUTCOME cannot be recorded
        // either (o3d-k26m.5), so it is refused rather than sent unrecorded. Only the minting fence
        // catches: without a record to write, a failed renewal is an ordinary error and belongs to the
        // per-entry catch exactly as it did before.
        if (!mintCreateDispatch) throw error
        const message = `Xero sync log ${entryId} was not posted: IMS could not record that a create `
          + `(${operation}) was about to be dispatched — ${String(error)}. NOTHING WAS SENT, because a `
          + 'create whose dispatch cannot be written down is one whose outcome cannot be written down '
          + 'either, which is the state that produces a duplicate document.'
        return { ok: false, result: { success: false, error: message, notPosted: { reason: 'dispatch-unrecorded', operation, message } } }
      }
      if (!again) {
        const message = lostClaimMessage(entryId, operation)
        return { ok: false, result: { success: false, error: message, notPosted: { reason: 'claim-lost', operation, message } } }
      }
      heldFrom = again
      return { ok: true }
    },
  }
}

// Exported for tests/accounting/xero-unrecorded-remote-write.test.ts: the give-up path is the one
// that runs when the database is unreachable, so it has to be drivable without one.
export type PostedDocumentPersistOutcome =
  | { persisted: true }
  /**
   * THE POOL refused this attempt for the whole deadline (o3d-xl63 r3). The identifier has already
   * been reported on a channel that does not need a connection, and the caller must NOT touch the
   * database again for this row — the next thing it would do is ask the same exhausted pool.
   */
  | { persisted: false; reason: 'pool-exhausted' }
  /**
   * THE ROW ALREADY NAMES A DIFFERENT DOCUMENT (o3d-550x, merged as #639). Nothing is wrong with the
   * pool and the conflict evidence IS durable — both identifiers are filed. This is a settled,
   * permanent outcome, and it is deliberately distinct from the one above: retrying it would only
   * post a second document, whereas the pool case is transient.
   */
  | { persisted: false; reason: 'not-recorded'; evidence: string }

export async function persistPostedXeroDocument(input: {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  payload: SyncPayload
  externalId: string | null | undefined
  /**
   * THE CLAIM, NOT A SNAPSHOT OF IT (o3d-xl63 r6). The caller hands over the LEASE. Every statement
   * below asks it for its instant as that statement is built, so a claim that has been renewed since
   * this function was entered is fenced on the instant the row actually carries. A `Date` here would
   * compile and then fail closed in silence: the fence would match nothing, the persist would report
   * a lost claim, and a document Xero already holds would go unrecorded for a claim we never lost.
   */
  claim: HeldClaim
  /**
   * o3d-cvj9 (merged into development as o3d-batch-cvj9): the revision stamp Xero put on the document
   * as it applied THIS write. Supplied by the call sites where a connector write actually landed; a
   * site that called nothing omits it, and the ABSENCE — not `null` — is what the mirror's ordering
   * rule decides such a path on.
   */
  externalRevisionAt?: Date | null
}): Promise<PostedDocumentPersistOutcome> {
  const { entry, payload, claim } = input
  const externalId = input.externalId ?? null
  const what = `xero sync log ${entry.id} (${entry.type})`

  try {
    // WHAT IS WRITTEN IS o3d-550x'S; WHETHER WE GET A CONNECTION TO WRITE IT IS THIS BRANCH'S.
    //
    // Until #639 merged, this function spelt the SYNCED transition out inline. It must not any more,
    // and re-introducing that inline write is the silent regression this rebase had to avoid: the
    // merged `recordPostedDocumentDurably` is not the same statement in a different place. It refuses
    // to overwrite a row that already names a DIFFERENT document, files the conflict evidence inside
    // the transaction that observed it, re-drives that evidence transaction on its own budget, and
    // reports the displaced identifier rather than losing it. An inline `update({ where: { id } })`
    // has none of those and would look identical in a green test run.
    //
    // So the delegation is total: this function contributes only the things o3d-550x has no opinion
    // about — the post-remote transaction options (r3 #2), the pool re-drive, the deadline derived
    // from this worker's own claim, and the off-pool give-up report.
    const record = await persistAfterRemoteWrite(
      what,
      () => recordPostedDocumentDurably(
        entry,
        externalId,
        payload,
        input.externalRevisionAt,
        POST_REMOTE_PERSIST_TX_OPTIONS,
      ),
      // o3d-xl63 r6/r7: the deadline is derived from the claim THIS worker holds, read here as the
      // call is built rather than carried down from the top of the sweep. A renewal that moved the
      // claim forward lengthens the window it is safe to re-drive in; a snapshot would have shortened
      // it silently.
      { claim: { heldFrom: claim.heldFrom(), staleAfterMs: CLAIM_STALE_MS } },
    )
    // Not a pool problem and not this branch's to report: a newer claim posted its own document while
    // this attempt was on the wire, and o3d-550x has already made both identifiers durable.
    if (!record.recorded) return { persisted: false, reason: 'not-recorded', evidence: record.evidence }
    return { persisted: true }
  } catch (error) {
    // Only the pool's own give-up is handled here. Everything else — including the unwritten-evidence
    // throw o3d-550x raises when it cannot file a conflict — is left to the runner, untouched.
    //
    // o3d-xl63 r5/r6 also caught `LostClaimDuringPersistError` here. Nothing raises it any more: it
    // was thrown by the claim fence this branch put on the SETTLING write, and #639 rejected that
    // fence for this write in as many words. See the note on it in persistPostedXeroDocument.
    if (!(error instanceof UnrecordedRemoteWriteError)) throw error
    await reportUnrecordedXeroWrite({ entry, externalId, claim, error })
    return { persisted: false, reason: 'pool-exhausted' }
  }
}

/**
 * The claim was lost between deriving the persist's deadline and making its write (o3d-xl63 r5 #2).
 *
 * There is no recovery write to attempt, and that is not a gap — it is the finding. Every write this
 * module makes to a sync row is fenced on this worker's claim, and the claim is gone; a fenced write
 * would match nothing, and an UNFENCED one is exactly the trample the fence was added to prevent.
 * What is left is evidence, and the id is the whole of it.
 *
 * fd 2 FIRST and unconditionally, before anything touches the database — the round-3 ordering, kept
 * for the same reason: it is the only channel with no precondition beyond this process still holding
 * the id. The activity row follows, because a log line nobody greps is not an alert; here, unlike the
 * pool-exhaustion case, the database is not the thing that failed, so it is very likely reachable.
 */
async function reportLostClaimAfterXeroWrite(input: {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  externalId: string | null
  claim: HeldClaim
  error: LostClaimDuringPersistError
}): Promise<void> {
  const { entry, externalId, claim, error } = input
  // The instant the fence that just failed was built from — read from the claim, so the evidence
  // names the claim this worker actually held rather than one it captured earlier (r6).
  const claimedAt = claim.heldFrom()

  reportUnrecordedRemoteWrite({
    what: error.what,
    externalId,
    detail: {
      connector: XERO_CONNECTOR,
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      claimedAt: claimedAt.toISOString(),
    },
    attempts: 1,
    elapsedMs: 0,
    recorded: false,
    reason: LOST_CLAIM_DURING_PERSIST_REASON,
  })

  const description = externalId
    ? `Xero accepted this document (${externalId}) but the record of it could NOT be written: this `
      + `worker's claim on sync log ${entry.id} was taken by another worker before the write landed. `
      + `The row now belongs to that worker, which may post the document a SECOND time. CHECK XERO for `
      + `${externalId} and for a duplicate of it before doing anything to this row.`
    : `Xero accepted a document for sync log ${entry.id} but returned no id, AND this worker's claim `
      + `was taken before the attempt could be recorded. There is nothing that would stop a re-post. `
      + `CHECK XERO before re-queueing this row.`

  try {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_sync_claim_lost_during_persist',
      tag: 'sync',
      level: 'ERROR',
      description,
      metadata: {
        syncLogId: entry.id,
        type: entry.type,
        externalId,
        claimedAt: claimedAt.toISOString(),
        reason: LOST_CLAIM_DURING_PERSIST_REASON,
      },
      resolveUser: false,
    })
  } catch (activityError) {
    reportUnrecordedRemoteWrite({
      what: error.what,
      externalId,
      attempts: 1,
      elapsedMs: 0,
      recorded: false,
      reason: `the activity row for the lost claim could not be written either, so THIS LINE IS THE `
        + `ONLY RECORD of ${externalId ?? 'an unidentified document'} in Xero: ${String(activityError)}`,
    })
  }
}

/**
 * The give-up path: say what went unrecorded somewhere the exhausted pool cannot reach, then try the
 * database anyway.
 *
 * The fallback write is deliberately the SMALLEST one that removes the duplicate hazard: record the
 * external id and hand the row back as PENDING. The next run claims it, takes the
 * `if (entry.externalTransactionId)` short-circuit at the top of the loop, posts NOTHING, and finishes
 * the mirrored event and follow-ups properly. Its WHERE clause is this worker's own claim, so if the
 * claim has since been taken the write does nothing rather than trampling another worker's row.
 *
 * With no external id there is nothing that would stop a re-post, so the row keeps its claim and only
 * gains an errorMessage: re-queueing it would be the duplicate, and saying so is all we honestly can.
 */
async function reportUnrecordedXeroWrite(input: {
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string }
  externalId: string | null
  claim: HeldClaim
  error: UnrecordedRemoteWriteError
}): Promise<void> {
  const { entry, externalId, claim, error } = input
  const claimedAt = claim.heldFrom()
  const base = {
    what: `xero sync log ${entry.id} (${entry.type})`,
    externalId,
    detail: {
      connector: XERO_CONNECTOR,
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      claimedAt: claimedAt.toISOString(),
    },
    attempts: error.attempts,
    elapsedMs: error.elapsedMs,
  }

  // FIRST, and unconditionally: the id, on a channel with no database in it.
  reportUnrecordedRemoteWrite({ ...base, recorded: false, reason: error.message })

  const errorMessage = externalId
    ? `Xero accepted this document (${externalId}) but the record of it could not be written for `
      + `${error.elapsedMs}ms (${error.attempts} attempts): no database transaction could be started. `
      + `The external id was recovered by a single-statement write; this row will finish on the next run `
      + `WITHOUT posting again. Do not re-queue it.`
    : `Xero accepted this document but returned no id, and the record of the attempt could not be `
      + `written for ${error.elapsedMs}ms (${error.attempts} attempts). CHECK XERO before re-queueing: `
      + `a re-post would create a second document.`

  try {
    const recovery = await db.accountingSyncLog.updateMany({
      where: {
        // Read at the point of use (r6), NOT from the value the deadline was derived from minutes
        // ago: the re-drive above can span the whole claim, and on this branch a claim moves. A
        // fence on the stale instant matches nothing, and `count === 0` here is indistinguishable
        // from a genuinely lost claim — so the external id of a document Xero holds would be
        // reported as unrecoverable while the row was still ours.
        ...heldClaimWhere(entry.id, claim),
        connector: XERO_CONNECTOR,
        ...(externalId ? { externalTransactionId: null } : {}),
      },
      data: externalId
        ? { externalTransactionId: externalId, status: 'PENDING', processingStartedAt: null, errorMessage }
        : { errorMessage },
    })
    reportUnrecordedRemoteWrite({
      ...base,
      recorded: recovery.count === 1 && externalId !== null,
      reason: recovery.count === 0
        ? 'the fallback write matched no row: this claim was already lost, so another worker owns it'
        : externalId
          ? 'the external id was recorded by the single-statement fallback; the next run will not re-post'
          : 'there is no external id to record — the row carries the warning and nothing else',
    })
  } catch (fallbackError) {
    reportUnrecordedRemoteWrite({
      ...base,
      recorded: false,
      reason: `the single-statement fallback write failed as well, so THIS LINE IS THE ONLY RECORD of `
        + `${externalId ?? 'an unidentified document'} in Xero: `
        + `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
    })
  }
}

/**
 * Hand an outbox job back at an instant THIS CALLER chooses, without spending one of its attempts.
 *
 * The difference from {@link markXeroOutboxRetry} is the whole reason both exist, and r4 gives it a
 * second caller so the name no longer says "rate limit". `markXeroOutboxRetry` is the FAILURE path:
 * it counts the attempt against `MAX_RETRIES` and computes its own backoff, whose floor for the first
 * retry is `DEFAULT_RETRY_BASE_DELAY_MS` = five minutes. That is right for a job that really failed
 * and wrong for one that never ran — a rate-limit backoff must sit exactly as long as Xero asked, and
 * an attempt that provably sent nothing must not be charged an attempt at all, nor deferred past the
 * window inside which it can still be replayed safely.
 */
async function deferOutboxWithoutSpendingAnAttempt(
  client: Pick<Prisma.TransactionClient, 'integrationOutbox'>,
  job: IntegrationOutboxRow,
  error: string,
  retryDelayMs: number,
): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  const released = await client.integrationOutbox.updateMany({
    where: {
      id: job.id,
      status: INTEGRATION_OUTBOX_STATUS.PROCESSING,
      lockedBy: XERO_ACCOUNTING_WORKER_ID,
      lockedAt: job.lockedAt,
    },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED,
      nextAttemptAt: new Date(Date.now() + retryDelayMs),
      lastError: error.slice(0, 1000),
      lockedAt: null,
      lockedBy: null,
    },
  })
  if (released.count === 0) throw new Error(`Xero outbox job ${job.id} is not claimed by ${XERO_ACCOUNTING_WORKER_ID}`)
}

/**
 * THE REFUSAL EVIDENCE, BUILT ONCE FOR BOTH RUNNERS AND BOTH WAYS OF WRITING IT (o3d-jit6 r5).
 *
 * This is the activity row a later refusal tells an operator to look for: on the `transport-refused`
 * reason it is THE ONLY DURABLE TRACE that a create was recorded by the marker and then not sent, and
 * `CREATE_DISPATCH_UNSETTLED_MEANING` names its `action` verbatim. So the wording and the metadata are
 * produced here rather than spelt out at each call site — a transactional write and a best-effort one
 * that described the same refusal differently would send that operator looking for the wrong row.
 */
function unsentPostEvidence(
  entry: { id: string; type: string },
  notPosted: NonNullable<EntryResult['notPosted']>,
  outboxJobId?: string,
  /**
   * o3d-jit6 r8: THE DETERMINISTIC IDENTITY OF THE HAND-BACK THAT WROTE THIS ROW, on the one path
   * that has one. It is what lets a retry whose COMMIT landed but whose acknowledgement was lost
   * recognise its own committed work instead of reporting the row permanently stranded — see
   * {@link unsentHandBackOperationId} and {@link findRecordedUnsentHandBack}.
   */
  handBackId?: string,
) {
  return {
    entityType: 'SYSTEM' as const,
    // o3d-jit6 r8: NAMED ON THE ROW, not only inside the metadata. This is the row an operator is
    // sent to find, and it is the row the ambiguous-commit probe must look up cheaply — `entityType`
    // + `entityId` is an index, a JSON scan of every activity row is not.
    entityId: entry.id,
    action: notPosted.reason === 'lease-expired'
      ? 'xero_sync_lease_expired_before_post'
      : notPosted.reason === 'dispatch-unrecorded'
        ? 'xero_sync_dispatch_unrecorded_before_post'
        // o3d-jit6 r3: THE ONLY DURABLE TRACE that a create was recorded and then not sent. The
        // refusal a later attempt makes names this action and tells an operator to look for it
        // before they go hunting in the ledger.
        : notPosted.reason === 'transport-refused'
          ? 'xero_sync_transport_refused_before_post'
          : 'xero_sync_claim_lost_before_post',
    tag: 'sync',
    level: 'WARNING' as const,
    description: notPosted.message,
    metadata: {
      syncLogId: entry.id,
      type: entry.type,
      ...(outboxJobId ? { outboxJobId } : {}),
      operation: notPosted.operation,
      reason: notPosted.reason,
      ...(handBackId ? { handBackId } : {}),
    },
  }
}

/** The three tables one unsent-refusal hand-back touches, and nothing else. */
type UnsentRefusalTransactionClient = Pick<Prisma.TransactionClient, 'activityLog' | 'accountingSyncLog' | 'integrationOutbox'>

/**
 * THE DETERMINISTIC NAME OF ONE HAND-BACK (o3d-jit6 r8, Codex MEDIUM).
 *
 * A retried transaction can COMMIT and still fail: the connection drops between the commit and its
 * acknowledgement, and the caller sees only a rejection. Round 7 named that residual honestly and
 * then paid its full price — the next attempt met an already-released row, aborted on the outbox
 * fence, and the sequence reported the work PERMANENTLY STRANDED at an operator when it had in fact
 * been handed back. A false alarm pointed at a human is not a cheaper failure than the one it
 * replaces.
 *
 * So the hand-back carries an identifier it can recognise afterwards, and the identifier is derived
 * rather than generated: the ROW, the exact CLAIM INSTANT the release is fenced on, and the ATTEMPT
 * the operator-fence is taken against. Those three are precisely what make this hand-back the one it
 * is, they are fixed for the whole retry sequence — no fence runs during it, so `heldFrom()` cannot
 * move — and any OTHER sequence, on this row or another, necessarily differs in one of them. A
 * random id would have to be threaded through and could not be re-derived by a later reader; a
 * derived one is the same on every attempt by construction.
 */
export function unsentHandBackOperationId(entryId: string, lease: HeldClaim, attempt: AttemptRef): string {
  return `${entryId}:${lease.heldFrom().toISOString()}:${attempt.attemptRevision}`
}

/**
 * THE RECORD THAT THE FENCED RELEASE ACTUALLY RAN, AND WHAT IT MATCHED (o3d-jit6 r9, Codex MEDIUM).
 *
 * r8's probe looked for the EVIDENCE row and read it as proof that the whole hand-back landed. It is
 * not. The evidence row is written FIRST — before the release — and the transaction deliberately
 * commits even when the fenced release matches ZERO rows, because a refusal that really happened must
 * not be rolled back on the grounds that somebody else now owns the row. That asymmetry stays. What
 * it means is that "the named evidence row exists" and "the release ran" are different facts, and the
 * probe was certifying the second from the first.
 *
 * So the release's own result is persisted, in the same transaction, on a row that carries the
 * hand-back's deterministic name — written AFTER the release, so it cannot exist unless the release
 * returned. The probe requires THAT row, and requires it to state a boolean: a hand-back is
 * acknowledged as landed only by a record that says what the release matched.
 *
 * `false` is a perfectly good answer here and still means the hand-back committed. What is no longer
 * possible is a hand-back certified by a record that never saw the release at all.
 */
export const UNSENT_HANDBACK_COMMIT_ACTION = 'xero_sync_transport_refusal_handback_committed'

/** True only for a commit record that actually states what the fenced release matched. */
export function unsentHandBackCommitProvesRelease(metadata: unknown): boolean {
  return typeof (metadata as { released?: unknown } | null | undefined)?.released === 'boolean'
}

/**
 * THE WHOLE HAND-BACK, AS ONE TRANSACTION BODY — SHARED BY BOTH RUNNERS (o3d-jit6 r5, Codex HIGH).
 *
 * WHAT ROUND 4 GOT RIGHT AND WHERE IT STOPPED, AGAIN. r4 established the ORDER: write the evidence
 * first, release second, so no worker can meet the standing dispatch marker with the trace of why it
 * stands already missing. That ordering is correct and it could not enforce itself, because the write
 * it ordered was `logActivity` — which SWALLOWS ITS OWN FAILURES so that logging can never break its
 * caller — and it sat OUTSIDE the transaction that released the row and requeued the job. So the
 * release could commit while the ONLY DURABLE EVIDENCE OF THE REFUSAL was silently lost, and the
 * invariant the ordering existed to buy did not hold at all:
 *
 *   • the row goes back to PENDING and another worker takes it;
 *   • it meets `createDispatchedAt`/`createDispatchIdempotencyKey` still standing;
 *   • past the window, `decideCreateDispatch` refuses and its message tells an operator to look for
 *     `xero_sync_transport_refused_before_post` before they go hunting in the ledger;
 *   • and that activity row is not there, because the write that would have made it failed into a
 *     `console.error` nobody durably keeps.
 *
 * SO ALL THREE WRITES COMMIT TOGETHER. `logActivityInTransaction` applies the identical redaction and
 * sanitisation as `logActivity` but writes through the caller's transaction and does NOT catch, so an
 * unwritable record ABORTS the hand-back rather than letting it proceed silently. That is the same
 * consequence o3d-batch-settle settled on for an operator's settlement assertion, and for the same
 * reason: an audit record written best-effort BEFORE the thing it describes can vanish while the
 * thing proceeds.
 *
 * ONE BODY, TWO CALLERS. The direct runner holds no outbox job, so it passes none and the requeue is
 * simply absent; the queued runner passes the job and the requeue joins the same commit. Both halves
 * of the queued pair were already required to be atomic (r4): a released row whose job stayed
 * PROCESSING waits for the queue's own fifteen-minute stale-lock sweep — the very fifteen minutes the
 * release exists to escape — and a requeued job whose row stayed PROCESSING is claimed by the next
 * tick only to find the row unclaimable and skip it. The evidence is now the third member of that
 * set, on the same reasoning.
 *
 * A ZERO-ROW RELEASE DOES NOT ABORT, and the asymmetry with the log failure is deliberate. `false`
 * from the fenced release means a displaced owner, or an attempt an operator has since moved — the
 * fence doing its job. The refusal it records still happened, it is still the row the marker's
 * refusal points at, and rolling it back would delete the record of a real refusal on the grounds
 * that somebody else now owns the row. The caller gets the flag so it can say so.
 */
export async function recordAndReleaseUnsentTransportRefusal(
  tx: UnsentRefusalTransactionClient,
  args: {
    entry: { id: string; type: string }
    notPosted: NonNullable<EntryResult['notPosted']>
    /**
     * THE LEASE, NOT the sweep's captured claim instant (o3d-xl63 r6's rule, load-bearing here of all
     * places). `openRemoteWriteLease` renews `processingStartedAt` when it opens and again in the
     * fence that mints the dispatch marker, so `claimHeldFrom(claimedAt)` from the top of the runner
     * loop names an instant the row no longer carries. `releaseClaimForRetry` fences on the instant
     * and fails CLOSED, so a release fenced on the stale one matches nothing, reports nothing, and
     * leaves the row in PROCESSING exactly as round 3 did — an invisible no-op that looks like a fix.
     */
    lease: HeldClaim
    attempt: AttemptRef
    /** The queued runner's job. Absent on the direct runner, which owns no outbox row. */
    job?: IntegrationOutboxRow | null
  },
): Promise<{ released: boolean }> {
  const handBackId = unsentHandBackOperationId(args.entry.id, args.lease, args.attempt)
  // EVIDENCE FIRST — inside the transaction, so the order is now belt as well as braces.
  await logActivityInTransaction(tx, {
    // o3d-jit6 r8: AND IT CARRIES THE HAND-BACK'S OWN NAME. The evidence row is the only member of
    // this commit a later reader can identify unambiguously, so it is what makes the whole commit
    // detectable to a retry whose acknowledgement went missing.
    ...unsentPostEvidence(args.entry, args.notPosted, args.job?.id, handBackId),
    // No session exists on either runner; both are cron-driven. `resolveUser: false` is the
    // best-effort helper's way of saying this, and this one takes the answer directly.
    userId: null,
  })
  const released = await releaseUnsentTransportRefusal(
    tx, args.entry.id, args.lease, args.attempt, args.notPosted.message,
  )
  // AND NOT `markXeroOutboxRetry`: that one counts the attempt against MAX_RETRIES and its first
  // backoff floor is five minutes, which would burn the replay window this is racing.
  if (args.job) await deferOutboxWithoutSpendingAnAttempt(tx, args.job, args.notPosted.message, 0)
  // AND LAST, WHAT THE FENCED RELEASE MATCHED — see UNSENT_HANDBACK_COMMIT_ACTION. Written after the
  // release, so this row cannot exist unless the release returned; committed with everything else, so
  // it cannot exist unless the whole hand-back landed. This, not the evidence row, is what the
  // ambiguous-commit probe is allowed to read as proof.
  await logActivityInTransaction(tx, {
    entityType: 'SYSTEM',
    entityId: args.entry.id,
    action: UNSENT_HANDBACK_COMMIT_ACTION,
    tag: 'sync',
    level: 'INFO',
    description: `[xero-sync] sync log ${args.entry.id}: the unsent-refusal hand-back committed — `
      + `evidence written, fenced release matched ${released ? 'the row' : 'NOTHING (displaced owner '
        + 'or a moved attempt; the refusal is still recorded)'}`
      + `${args.job ? ', job requeued' : ''}.`,
    metadata: {
      syncLogId: args.entry.id,
      type: args.entry.type,
      ...(args.job?.id ? { outboxJobId: args.job.id } : {}),
      operation: args.notPosted.operation,
      reason: args.notPosted.reason,
      handBackId,
      released,
    },
    userId: null,
  })
  return { released }
}

/**
 * SAY THAT THE HAND-BACK ABORTED — because the alternative is the silence this round exists to end
 * (o3d-jit6 r5, Codex HIGH).
 *
 * The refusal evidence and the hand-back now commit together, which means a database that cannot take
 * the evidence takes neither: nothing is released, nothing is requeued, and the row waits for the
 * stale-claim cutoff exactly as round 3 left it. That is the CORRECT outcome — an unwritable record
 * must abort rather than let the release proceed without it — but an abort nobody hears is how the
 * best-effort write failed in the first place.
 *
 * So it is reported twice, and the pair is deliberate. `console.error` survives the case where the
 * database itself is refusing writes, which is precisely when the transaction is most likely to have
 * rolled back. The best-effort activity row covers every other cause — a serialisation failure, a
 * fence that matched no outbox job, a constraint — and is where an operator actually looks; it carries
 * the original refusal wording, so in those cases the trace is not lost after all, only relabelled.
 * Best-effort is right HERE and wrong inside the transaction: this write guards no state change, and a
 * throw would spend a retry and FAIL a row that sent nothing.
 */
async function reportUnsentHandBackAborted(
  entry: { id: string; type: string },
  notPosted: NonNullable<EntryResult['notPosted']>,
  error: unknown,
  outboxJobId?: string,
  exhaustion?: {
    attempts: number
    abandoned: UnsentHandBackAbandonment
    /** r8: whether the wall-time bound was the marker's real one, or the fallback from entry. */
    deadlineAnchor?: UnsentHandBackDeadline['anchor']
  },
): Promise<void> {
  // o3d-jit6 r7: HOW HARD IT TRIED, AND WHAT THE ROW IS NOW. An operator meeting the marker's
  // permanent refusal later needs both: that this was not one unlucky statement, and that the row
  // itself is sitting in PROCESSING rather than waiting its turn in PENDING.
  const tried = exhaustion
    ? ` The complete hand-back was attempted ${exhaustion.attempts} time${exhaustion.attempts === 1 ? '' : 's'} `
      + `and abandoned (${exhaustion.abandoned}).`
    : ''
  const stranded = ` THE ROW IS LEFT PROCESSING: no selector re-takes it for ${Math.round(CLAIM_STALE_MS / 60_000)} `
    + 'minutes, which is past the replay window the standing dispatch marker allows, so the next attempt '
    + 'will meet a permanent refusal for a create that was never sent and only an operator can resolve it. '
    + 'That is the least-bad end: throwing here would spend a retry and mark FAILED a row that provably '
    + 'sent nothing, and releasing without the evidence would let a worker meet the marker with no trace '
    + 'of why it stands.'
  // Only the transport-refusal path binds the evidence to the hand-back, so only it can have lost
  // the evidence with it. Saying otherwise on the other three reasons would send an operator looking
  // for a row that IS there.
  const detail = notPosted.reason === 'transport-refused'
    ? `[xero-sync] sync log ${entry.id} could not be handed back after a transport refusal, and the `
      + `refusal evidence was NOT recorded either — they roll back together: ${String(error)}.${tried}${stranded}`
    : `[xero-sync] sync log ${entry.id} could not be handed back after ${notPosted.reason}: ${String(error)}`
  console.error(detail)
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_sync_transport_refusal_handback_aborted',
    tag: 'sync',
    // ERROR, not WARNING: the row is stranded in PROCESSING until the stale cutoff, by which time
    // the dispatch marker's replay window has closed and only a human can resolve it.
    level: 'ERROR',
    description: `${detail} The refusal was: ${notPosted.message}`,
    metadata: {
      syncLogId: entry.id,
      type: entry.type,
      ...(outboxJobId ? { outboxJobId } : {}),
      operation: notPosted.operation,
      reason: notPosted.reason,
      abortedBy: String(error),
      ...(exhaustion
        ? {
          handBackAttempts: exhaustion.attempts,
          abandoned: exhaustion.abandoned,
          ...(exhaustion.deadlineAnchor ? { deadlineAnchor: exhaustion.deadlineAnchor } : {}),
        }
        : {}),
    },
    resolveUser: false,
  })
}

/**
 * BOUNDEDLY RETRY THE COMPLETE ATOMIC HAND-BACK, WHILE THE REPLAY WINDOW IS STILL OPEN
 * (o3d-jit6 r7, Codex HIGH).
 *
 * WHAT ROUND 6 GOT RIGHT AND WHERE IT STOPPED. r6 made the evidence, the release and the requeue ONE
 * transaction, and it chose deliberately NOT to throw the abort into the per-entry catch: that would
 * spend a retry and mark FAILED a row that provably sent nothing, which is the very outcome
 * `notPosted` exists to prevent. Both of those still hold and neither is traded away here.
 *
 * WHAT IT DID INSTEAD WAS GIVE UP AFTER ONE ATTEMPT. The catch reported best-effort and continued, so
 * a transaction that aborted for a transient reason — a serialisation failure, a deadlock, a dropped
 * connection — left the row PROCESSING at a freshly renewed `processingStartedAt`, unclaimable until
 * the FIFTEEN-MINUTE stale cutoff, which is past the SIX-minute window in which a replay is provably
 * not a second create. That is precisely the defect round 5 fixed, reached again through the abort
 * path, and a transient abort is exactly the case that succeeds on a second attempt.
 *
 * SO THE WHOLE TRANSACTION IS RE-RUN, NOT PART OF IT. Retrying anything smaller would reintroduce the
 * separation r5 closed. The body is atomic, so a failed attempt left nothing behind: re-running it
 * writes the evidence, releases under the same lease fence and defers the same job, or rolls all
 * three back again.
 *
 * AND THE SEQUENCE IS BOUNDED BY A DEADLINE, NOT BY A BUDGET IT GRANTS ITSELF AT ENTRY (r8, Codex
 * HIGH). `UNSENT_HANDBACK_MAX_ATTEMPTS` still caps the attempts. The wall-time bound is now an
 * ABSOLUTE INSTANT derived from `createDispatchedAt` — the marker's own DATABASE-clock stamp, which is
 * when the replay window actually opened — so the time already spent between the mint and this
 * hand-back is time the sequence does not get to spend a second time. r7 computed its budget at entry
 * and then checked only the REQUESTED delay before sleeping, which bounded nothing it did not itself
 * choose: a slow attempt, or a sleep that took longer than it asked for, carried the sequence past the
 * very window it exists to protect while every check it made still passed. So the ELAPSED time is
 * measured before EVERY attempt — which is also after every sleep — and what remains is passed DOWN
 * into the attempt as its own transaction timeout, so an attempt cannot outlive the deadline either.
 *
 * THE FIRST ATTEMPT IS NEVER SKIPPED, however late the marker already is. Declining to try leaves the
 * row PROCESSING for the full stale cutoff with no evidence written at all, which is strictly worse
 * than a hand-back that lands late: the late one still records why the marker stands and still returns
 * the row to PENDING, where the next tick can at least meet an honest refusal.
 *
 * AND AN AMBIGUOUS COMMIT IS NO LONGER REPORTED AS PERMANENT STRANDING (r8, Codex MEDIUM). r7 named
 * this residual and then paid its full price: an attempt whose COMMIT succeeded and whose
 * ACKNOWLEDGEMENT was lost had already written the evidence, released the row and requeued the job —
 * and the sequence then re-ran, met the already-released row, threw on the outbox fence that no longer
 * matched, and told an operator the work was permanently stranded. It was not stranded; it was done.
 * A false alarm pointed at a human is not a cheaper failure than the one it replaces. So the hand-back
 * carries a deterministic name ({@link unsentHandBackOperationId}) written into the evidence row, and
 * a failed attempt ASKS THE DATABASE whether that name is already recorded. If it is, the hand-back
 * happened: the sequence returns success, no second attempt duplicates the evidence, and nobody is
 * sent looking for a row that is already back in the queue.
 */
export type UnsentHandBackAbandonment = 'attempts-exhausted' | 'budget-exhausted'

export type UnsentHandBackOutcome =
  /** The hand-back committed on this run, and `released` is what its fenced release matched. */
  | { handedBack: true; released: boolean; attempts: number; alreadyRecorded: false }
  /**
   * The hand-back was found ALREADY RECORDED after an attempt failed ambiguously: an earlier attempt
   * committed and its acknowledgement was lost. `released` is null because this run did not perform
   * the release and must not claim to know what it matched — the commit that did is the authority.
   */
  | { handedBack: true; released: null; attempts: number; alreadyRecorded: true }
  | { handedBack: false; attempts: number; error: unknown; abandoned: UnsentHandBackAbandonment }

/** Attempts of the COMPLETE hand-back transaction, including the first. */
export const UNSENT_HANDBACK_MAX_ATTEMPTS = 3
/** The first pause between attempts; each subsequent one doubles. */
export const UNSENT_HANDBACK_RETRY_BASE_DELAY_MS = 250
/**
 * The whole sequence's share of the window it is racing — a tenth of
 * `XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS`, derived rather than retyped
 * so that shortening the window shortens this with it. The refusal happens within seconds of the
 * mint, so spending at most a tenth of what remains cannot be what closes it.
 *
 * r8: this is a LENGTH, and the deadline it produces is measured FROM THE MARKER (see
 * {@link unsentHandBackDeadline}), not from whenever the hand-back happened to start.
 */
export const UNSENT_HANDBACK_RETRY_BUDGET_MS =
  Math.floor((XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS) / 10)
/**
 * ACQUISITION AND EXECUTION HAVE SEPARATE MINIMA, BECAUSE THEY BUY DIFFERENT THINGS (o3d-jit6 r10,
 * Codex HIGH).
 *
 * r8 wrote down ONE floor and meant it as a floor under EXECUTION: a transaction handed a timeout of
 * a millisecond cannot write three rows, so an already-overrun deadline would turn the last
 * permitted attempt into a guaranteed abort — a bound that manufactures the failure it is measuring.
 * r9 then took the connection wait OUT of that same clamped value, so the floor case was left
 * running the transaction in HALF the time the floor exists to guarantee it. Each change is right on
 * its own; together they cancel.
 *
 * So the two are named separately and the attempt's floor is their SUM. That is what makes the split
 * safe: whatever {@link unsentHandBackAttemptBounds} reserves for the wait, execution still ends up
 * with at least `UNSENT_HANDBACK_MIN_EXECUTION_MS`.
 */
export const UNSENT_HANDBACK_MIN_EXECUTION_MS = 1_000
/**
 * The floor under the connection wait. A `maxWait` of a millisecond fails an attempt against a pool
 * that would have handed it a connection immediately, so the reservation is never squeezed below
 * this — a self-inflicted abort is not cheaper than a short wait.
 */
export const UNSENT_HANDBACK_MIN_ACQUISITION_MS = 250
/**
 * The floor under a single attempt's own bound: the two minima TOGETHER, so that an attempt clamped
 * to the floor can still wait for a connection AND run its transaction for as long as each of those
 * actually needs. Clamping to the execution minimum alone — r8's figure — is what r9's split then
 * halved.
 */
export const UNSENT_HANDBACK_MIN_ATTEMPT_MS =
  UNSENT_HANDBACK_MIN_EXECUTION_MS + UNSENT_HANDBACK_MIN_ACQUISITION_MS
/** How long an attempt may wait for a connection before it counts as failed; never past its own bound. */
export const UNSENT_HANDBACK_MAX_WAIT_MS = 2_000

/**
 * The instant past which no FURTHER attempt may begin, and what it is anchored to.
 *
 * `anchor` is reported rather than inferred: an operator reading an exhausted sequence needs to know
 * whether the deadline was the real one (the marker's) or the fallback the code had to invent because
 * the marker could not be read.
 */
export type UnsentHandBackDeadline = { atMs: number; anchor: 'dispatch-marker' | 'hand-back-entry' }

/**
 * ANCHOR THE DEADLINE ON THE MARKER'S OWN TIMESTAMP (r8, Codex HIGH).
 *
 * `age` is a DURATION measured entirely on the database's clock (see `readCreateDispatchAge`), so
 * subtracting it from the budget converts "a tenth of the usable window" from a promise the sequence
 * makes to itself into the deadline the row is actually under. `atMs` may already be in the past when
 * the marker is old; the loop still makes its first attempt, because not handing the row back at all
 * is the worse end.
 */
export function unsentHandBackDeadline(nowMs: number, age: CreateDispatchAge): UnsentHandBackDeadline {
  if (!age.known) return { atMs: nowMs + UNSENT_HANDBACK_RETRY_BUDGET_MS, anchor: 'hand-back-entry' }
  return { atMs: nowMs + (UNSENT_HANDBACK_RETRY_BUDGET_MS - age.elapsedMs), anchor: 'dispatch-marker' }
}

/**
 * What one attempt may spend: the measured remainder, floored so it can work and capped by the budget.
 *
 * r10: the floor is `UNSENT_HANDBACK_MIN_ATTEMPT_MS`, which is acquisition's minimum PLUS execution's
 * — clamped high enough that what {@link unsentHandBackAttemptBounds} reserves for the connection
 * wait still leaves the transaction its own `UNSENT_HANDBACK_MIN_EXECUTION_MS` to run in.
 */
export function unsentHandBackAttemptBudgetMs(remainingMs: number): number {
  return Math.min(Math.max(remainingMs, UNSENT_HANDBACK_MIN_ATTEMPT_MS), UNSENT_HANDBACK_RETRY_BUDGET_MS)
}

/**
 * ONE REMAINDER, SPLIT — NEVER TWO BUDGETS THAT ADD UP (o3d-jit6 r9, Codex HIGH).
 *
 * r8 handed the attempt's whole budget down as the transaction's `timeout` and then let `maxWait`
 * allow ANOTHER two seconds, independently, for getting a connection out of the pool. Those are
 * consecutive, not concurrent: an attempt could wait its full acquisition and then execute for its
 * full budget, and the sequence would leave the deadline the previous round installed behind it by up
 * to `UNSENT_HANDBACK_MAX_WAIT_MS` per attempt — under pool exhaustion, which is exactly the
 * condition that produces the long wait in the first place.
 *
 * So the acquisition is RESERVED OUT OF the attempt's budget rather than added to it: `maxWait +
 * timeout` is the budget, exactly, whatever the budget is. The reservation is capped at
 * `UNSENT_HANDBACK_MAX_WAIT_MS` so a large budget still gives execution nearly all of it.
 *
 * AND THE RESERVATION NEVER EATS THE EXECUTION MINIMUM (r10, Codex HIGH). r9's second cap was HALF
 * the budget, which reads as generous and is the opposite: the budget is clamped UP to a floor
 * precisely because the transaction needs that much time to RUN, so taking half of that floor for
 * the connection wait handed the floor case half the execution the clamp was there to guarantee. The
 * reservation is therefore capped at whatever sits ABOVE `UNSENT_HANDBACK_MIN_EXECUTION_MS`, never
 * dropping below `UNSENT_HANDBACK_MIN_ACQUISITION_MS` — and because
 * {@link unsentHandBackAttemptBudgetMs} clamps the total to the SUM of the two minima, the floor
 * case now splits into exactly `MIN_ACQUISITION` for the wait and `MIN_EXECUTION` for the
 * transaction, with the two still summing to the budget.
 */
export function unsentHandBackAttemptBounds(attemptBudgetMs: number): { maxWait: number; timeout: number } {
  // What the wait may take without pushing execution under its own minimum — but never below the
  // acquisition minimum, so a budget too small to satisfy both still leaves a usable wait.
  const reservable = Math.max(
    UNSENT_HANDBACK_MIN_ACQUISITION_MS,
    attemptBudgetMs - UNSENT_HANDBACK_MIN_EXECUTION_MS,
  )
  // Also held under the budget itself, so the two halves still SUM to it exactly.
  const maxWait = Math.max(1, Math.min(UNSENT_HANDBACK_MAX_WAIT_MS, reservable, attemptBudgetMs - 1))
  return { maxWait, timeout: Math.max(1, attemptBudgetMs - maxWait) }
}

export async function retryUnsentHandBack(
  /** Runs the COMPLETE hand-back transaction, bounded by the time it is given. */
  run: (attemptBudgetMs: number) => Promise<{ released: boolean }>,
  deps: {
    sleep?: (ms: number) => Promise<void>
    monotonicMs?: () => number
    /** Defaults to a budget from entry — the r7 behaviour — only when no marker could be read. */
    deadline?: UnsentHandBackDeadline
    /** "Did an earlier attempt's hand-back already commit?" Defaults to "no idea", i.e. no. */
    recordedHandBack?: () => Promise<boolean>
  } = {},
): Promise<UnsentHandBackOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const monotonicMs = deps.monotonicMs ?? (() => Date.now())
  const deadlineAtMs = deps.deadline?.atMs ?? monotonicMs() + UNSENT_HANDBACK_RETRY_BUDGET_MS
  const recordedHandBack = deps.recordedHandBack ?? (async () => false)
  let attempts = 0
  let lastError: unknown = undefined
  for (;;) {
    // MEASURED, NOT REQUESTED, AND CHECKED HERE — which is before every attempt AND after every
    // sleep. r7 checked only the delay it was about to ask for, so an attempt that overran its share
    // of the budget, or a pause that slept longer than it requested, was never noticed at all.
    const remainingMs = deadlineAtMs - monotonicMs()
    if (attempts > 0 && remainingMs <= 0) {
      return { handedBack: false, attempts, error: lastError, abandoned: 'budget-exhausted' }
    }
    attempts++
    try {
      // AND THE ATTEMPT CANNOT OUTLIVE THE DEADLINE EITHER: what is left is handed down as the
      // transaction's own bound, so a hung statement ends the attempt instead of the window.
      const { released } = await run(unsentHandBackAttemptBudgetMs(remainingMs))
      return { handedBack: true, released, attempts, alreadyRecorded: false }
    } catch (error) {
      lastError = error
      // AN AMBIGUOUS COMMIT IS NOT AN EXHAUSTED ONE. Asked BEFORE the bounds are consulted and before
      // a retry is made, so a hand-back that committed is neither duplicated nor reported stranded.
      // A probe that cannot answer says "no", which is exactly the r7 behaviour it replaces.
      if (await recordedHandBack()) {
        return { handedBack: true, released: null, attempts, alreadyRecorded: true }
      }
      if (attempts >= UNSENT_HANDBACK_MAX_ATTEMPTS) {
        return { handedBack: false, attempts, error, abandoned: 'attempts-exhausted' }
      }
      // CHECKED BEFORE THE PAUSE IS TAKEN as well as after it: a pause that would land past the
      // deadline is not worth taking, and the check above catches one that overran anyway.
      const delayMs = UNSENT_HANDBACK_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1)
      if (monotonicMs() + delayMs >= deadlineAtMs) {
        return { handedBack: false, attempts, error, abandoned: 'budget-exhausted' }
      }
      await sleep(delayMs)
    }
  }
}

/**
 * DID THE HAND-BACK ALREADY COMMIT? (o3d-jit6 r8, Codex MEDIUM.)
 *
 * The hand-back's own deterministic name is the one thing a later reader can identify unambiguously —
 * the released row and the requeued job look the same whoever released them.
 *
 * BUT THE NAMED EVIDENCE ROW IS NOT THE PROOF (r9, Codex MEDIUM). It is written BEFORE the release,
 * and the transaction commits even when the fenced release matches zero rows, so its existence says
 * a refusal was recorded and says nothing about whether the release ran. The proof is the COMMIT
 * RECORD — written after the release, stating what it matched — and this asks for that row and for
 * the boolean on it. See {@link UNSENT_HANDBACK_COMMIT_ACTION}.
 *
 * BEST-EFFORT ON PURPOSE. A probe that throws answers "not recorded", which is precisely the r7
 * outcome — an over-stated abort report — rather than a new failure mode. It must never be the thing
 * that turns a hand-back into an exception.
 */
async function findRecordedUnsentHandBack(args: {
  entry: { id: string; type: string }
  notPosted: NonNullable<EntryResult['notPosted']>
  handBackId: string
}): Promise<boolean> {
  try {
    const found = await db.activityLog.findFirst({
      where: {
        entityType: 'SYSTEM',
        entityId: args.entry.id,
        action: UNSENT_HANDBACK_COMMIT_ACTION,
        metadata: { path: ['handBackId'], equals: args.handBackId },
      },
      select: { metadata: true },
    })
    // A row is not enough: it must SAY what the fenced release matched. Anything else — a row from a
    // writer this build does not contain, a truncated metadata — is "not recorded", which is the r7
    // behaviour and never a false certification.
    return unsentHandBackCommitProvesRelease(found?.metadata)
  } catch {
    return false
  }
}

/**
 * SAY THAT AN ACKNOWLEDGEMENT WAS LOST — and that the work was NOT (o3d-jit6 r8, Codex MEDIUM).
 *
 * Silence here would be defensible: the row is back in the queue and nothing needs doing. But the
 * sequence took a rejection from the database and then decided it did not mean what it said, and that
 * is worth a line an operator can find later — not least because the same conditions that lose an
 * acknowledgement lose other things too. WARNING, not ERROR: nothing is stranded.
 */
async function reportUnsentHandBackAcknowledgementLost(
  entry: { id: string; type: string },
  notPosted: NonNullable<EntryResult['notPosted']>,
  attempts: number,
  handBackId: string,
  outboxJobId?: string,
): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    entityId: entry.id,
    action: 'xero_sync_transport_refusal_handback_ack_lost',
    tag: 'sync',
    level: 'WARNING',
    description: `[xero-sync] sync log ${entry.id}: attempt ${attempts} of the unsent-refusal hand-back `
      + 'reported a failure, but the hand-back it describes is already recorded in the database — the '
      + 'commit landed and only its acknowledgement was lost. The row was handed back: the refusal '
      + 'evidence is written, the claim is released and (on the queued runner) the job is requeued. '
      + 'NOTHING IS STRANDED and no operator action is needed; this is recorded because a rejection '
      + 'that did not mean what it said is worth knowing about.',
    metadata: {
      syncLogId: entry.id,
      type: entry.type,
      ...(outboxJobId ? { outboxJobId } : {}),
      operation: notPosted.operation,
      reason: notPosted.reason,
      handBackAttempts: attempts,
      handBackId,
    },
    resolveUser: false,
  })
}

/**
 * THE ONE PLACE EITHER RUNNER HANDS BACK AN UNSENT TRANSPORT REFUSAL (o3d-jit6 r7).
 *
 * r5 shared the transaction BODY between the runners; r6 left the transaction, its catch and its
 * report spelt out at each call site, which is where a bounded retry would have had to be written
 * twice and could drift once. All of it lives here now, so the direct and queued runners differ in
 * exactly one thing — whether an outbox job joins the commit — and in nothing else.
 *
 * It does not throw. The caller counts the row as `skipped` either way: it sent nothing, so it must
 * not be failed and must not spend a retry, whether or not the hand-back landed.
 */
async function handBackUnsentTransportRefusal(args: {
  entry: { id: string; type: string }
  notPosted: NonNullable<EntryResult['notPosted']>
  lease: HeldClaim
  attempt: AttemptRef
  job?: IntegrationOutboxRow | null
}): Promise<UnsentHandBackOutcome> {
  const { entry, notPosted, lease, attempt, job } = args
  // THE DEADLINE IS ANCHORED WHERE THE WINDOW ACTUALLY OPENED (r8): the marker's own database-clock
  // stamp, read as an ELAPSED DURATION so no instant crosses between clocks. Unreadable — or no marker
  // at all — falls back to a budget from here, which is the r7 bound and never a longer one.
  const deadline = unsentHandBackDeadline(Date.now(), await readCreateDispatchAge(db, entry.id))
  // Derived from the row, the claim instant the release fences on and the attempt: the same on every
  // pass of the sequence, and different for any other sequence.
  const handBackId = unsentHandBackOperationId(entry.id, lease, attempt)
  // r9: ACQUISITION AND EXECUTION SHARE THE ONE REMAINDER — see unsentHandBackAttemptBounds. Passing
  // the budget as `timeout` while `maxWait` independently allowed more was two budgets, not one.
  const outcome = await retryUnsentHandBack((attemptBudgetMs) => db.$transaction(async (tx) => {
    return recordAndReleaseUnsentTransportRefusal(tx, { entry, notPosted, lease, attempt, job })
  }, unsentHandBackAttemptBounds(attemptBudgetMs)), {
    deadline,
    recordedHandBack: () => findRecordedUnsentHandBack({ entry, notPosted, handBackId }),
  })
  if (outcome.handedBack) {
    // A LOST ACKNOWLEDGEMENT IS NOT AN EXHAUSTION (r8): the work is done, and the line that says so
    // is a WARNING about the database, not an ERROR about this row.
    if (outcome.alreadyRecorded) {
      await reportUnsentHandBackAcknowledgementLost(entry, notPosted, outcome.attempts, handBackId, job?.id)
    }
  } else {
    // ABORTED, AND SAID SO — see reportUnsentHandBackAborted, which now also names how many complete
    // attempts were made, what the deadline was anchored to, and what state the row is left in.
    await reportUnsentHandBackAborted(entry, notPosted, outcome.error, job?.id, {
      attempts: outcome.attempts,
      abandoned: outcome.abandoned,
      deadlineAnchor: deadline.anchor,
    })
  }
  return outcome
}

/**
 * HAND BACK A ROW THAT PROVABLY SENT NOTHING — AND HAND IT BACK IN TIME TO REPLAY IT
 * (o3d-jit6 r4, Codex HIGH).
 *
 * WHAT ROUND 3 GOT RIGHT AND WHERE IT STOPPED. r3 classified a pre-egress transport refusal as
 * `notPosted`, so the row was not failed and spent no retry — the right instinct. But the branch then
 * logged the named activity row and moved on, leaving the row PROCESSING at the `processingStartedAt`
 * the fence had just RENEWED. Neither runner's selector can take a PROCESSING row until it is older
 * than `CLAIM_STALE_MS` (fifteen minutes), so the earliest possible next attempt was fifteen
 * minutes after the refusal — and the dispatch marker minted moments earlier is only replayable for
 * SIX. "No retry spent" had become "no retry possible in time": the marker stands, the window closes
 * under it, and the next attempt meets a permanent refusal that needs an operator, for a create that
 * was never sent.
 *
 * SO THE CLAIM IS RELEASED, THROUGH THE ONE FENCED RELEASE, AT AN INSTANT ALREADY PAST. `nextAttemptAt`
 * is `now` rather than `now + backoff`: `releaseClaimForRetry` writes it as the PENDING row's
 * earliest-next-claim gate, so the row is claimable from the refusal onwards — at EVERY instant of
 * the window that is left, rather than at none of them.
 *
 * AND BE PRECISE ABOUT WHAT THAT DOES AND DOES NOT GUARANTEE. The usable part of the window is
 * `XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS` = five minutes from the
 * dispatch, and `accounting-sync` ticks every five: whether a tick actually falls inside is a
 * question about the cron's phase, which this layer does not choose and must not pretend to. What is
 * ours is the INTERVAL. A zero delay leaves the whole remainder of the window open; a backoff carves
 * ticks off the front of it, and the five-minute one `markXeroOutboxRetry` would apply leaves none at
 * all. Nothing is spent to buy that — the release does not touch `retryCount` — so a refusal that
 * persists costs one attempt per tick and never drives the row to FAILED, which is the correct
 * treatment for a connection, a posting-intent refusal, an egress authorisation or an exhausted rate
 * budget: none of them is a fact about this row.
 *
 * AND IT DOES NOT LICENSE A SECOND POST. THIS IS THE PART THAT HAD TO STAY TRUE.
 *
 * The marker is untouched — `createDispatchedAt` and `createDispatchIdempotencyKey` are write-once by
 * database trigger, and this release writes neither. So the retry this makes possible arrives back at
 * `planCreateDispatch`/`decideCreateDispatch` carrying the same deterministic key, and the marker
 * answers exactly as it would have answered fifteen minutes later:
 *
 *   • INSIDE the window — `basis: 'replay-within-idempotency-window'`. Xero answers a repeat of a key
 *     it still holds with the ORIGINAL document, so this is provably not a second create. And in the
 *     case this path actually produces, there is no original: the transport refused, so the replay is
 *     the first request Xero ever sees. One document either way, which is the point.
 *   • PAST the window — REFUSED, unchanged, with the same message naming both producers of the state
 *     and pointing at `xero_sync_transport_refused_before_post`. Releasing the claim buys a chance to
 *     get back before the deadline; it does not move the deadline, and it cannot talk the marker into
 *     letting a late attempt through.
 *
 * The order at the call sites is therefore LOG FIRST, RELEASE SECOND. The activity row is the evidence
 * a later refusal tells an operator to look for, and it is the only durable trace that a create was
 * recorded and then not sent; writing it before the row becomes claimable means no other worker can
 * pick the row up in a state where that trace is missing.
 *
 * Fenced on the claim AND on the attempt, like every other non-terminal release: a displaced owner
 * releases nothing, and an operator decision taken while this claim was held is not reopened.
 */
export async function releaseUnsentTransportRefusal(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entryId: string,
  held: HeldClaim,
  attempt: AttemptRef,
  message: string,
  now: Date = new Date(),
): Promise<boolean> {
  return releaseClaimForRetry(client, entryId, held, {
    errorMessage: message,
    nextAttemptAt: now,
  }, attempt)
}

async function markXeroOutboxRetry(job: IntegrationOutboxRow, error: string, client?: Pick<Prisma.TransactionClient, 'integrationOutbox'>): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  await markIntegrationOutboxRetryableFailure({
    client,
    id: job.id,
    workerId: XERO_ACCOUNTING_WORKER_ID,
    lockedAt: job.lockedAt,
    error,
    attemptsBeforeFailure: job.attempts,
    maxAttempts: MAX_RETRIES,
  })
}

async function markXeroOutboxPermanent(job: IntegrationOutboxRow, error: string, client?: Pick<Prisma.TransactionClient, 'integrationOutbox'>): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  await markIntegrationOutboxPermanentFailure({
    client,
    id: job.id,
    workerId: XERO_ACCOUNTING_WORKER_ID,
    lockedAt: job.lockedAt,
    error,
  })
}

async function markXeroOutboxSuccess(job: IntegrationOutboxRow): Promise<void> {
  if (!job.lockedAt) throw new Error(`Xero outbox job ${job.id} was claimed without lockedAt`)
  try {
    await markIntegrationOutboxSuccess({
      id: job.id,
      workerId: XERO_ACCOUNTING_WORKER_ID,
      lockedAt: job.lockedAt,
    })
  } catch (error) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_outbox_completion_error',
      tag: 'sync',
      level: 'ERROR',
      description: `Xero outbox job ${job.id} posted but mark-complete failed: ${String(error)}`,
    })
    throw new XeroOutboxCompletionError(`Xero outbox job ${job.id} posted but mark-complete failed: ${String(error)}`)
  }
}

/**
 * Report an attempt-stamping custody repair, when there was one (o3d-0m56 r10).
 *
 * A non-zero count means a binary that does not stamp `remoteAttemptedAt` has handled money rows on
 * this database — a deploy window, an overlapping instance, or a rollback. Those rows are now
 * treated as attempted, so each pays for one ledger read before it is posted again, and each is no
 * longer recyclable. That is worth an operator's attention, hence WARNING rather than INFO.
 *
 * The repair itself is what makes the fence correct; this only reports it.
 */
async function reportMoneyAttemptCustodyRepair(repaired: number, connector: string): Promise<void> {
  if (repaired === 0) return
  await logActivity({
    entityType: 'SYSTEM',
    action: `${connector}_money_attempt_custody_repaired`,
    tag: 'sync',
    level: 'WARNING',
    description: `Stamped ${repaired} accounting money row${repaired === 1 ? '' : 's'} that a version of IMS `
      + 'outside attempt-stamping custody may have posted from (a deploy window, an overlapping instance, '
      + 'or a rollback). They are now treated as attempted, so each will be checked against the ledger '
      + 'before it is posted again.',
    metadata: { repaired, connector },
  })
}

/**
 * WHAT A SUCCESSFUL POST OF EACH SYNC TYPE ACTUALLY DID, and what an operator can do about it
 * (o3d-e2mz r4, Codex finding 3).
 *
 * The fence-loss escalation used to end with one sentence for every type: "The document is in the
 * ledger: reverse or credit-note it there if it should not exist." That is true of an invoice and
 * false of most of the queue. Several types return no external id because they CREATE NO DOCUMENT:
 * INVOICE_PDF saves a file locally, INVOICE_EMAIL sends an email, WC_INVOICE_NOTE writes a note on
 * the WooCommerce order, BILL_ATTACHMENT attaches a file (and is a no-op when uploads are disabled),
 * PURCHASE_CREDIT_NOTE_ALLOCATION applies an existing credit note to a bill. Sending an operator to
 * credit-note a document that does not exist is not merely useless — the nearest matching document
 * is a real receivable or payable, and the instruction points straight at it.
 *
 * Exhaustive over `AccountingSyncType` ON PURPOSE: a `Record<AccountingSyncType, …>` means a new
 * member fails the type-check here rather than silently inheriting the invoice wording, which is
 * exactly how the generic sentence came to cover types nobody had thought about.
 *
 * `effect` completes "…{effect} on attempt N"; `remedy` is a whole sentence.
 */
const POST_EFFECT_LEDGER_DOCUMENT = {
  effect: 'POSTED a document to the Xero ledger',
  remedy: 'The document is in the ledger: void or credit-note it there if it should not exist.',
} as const
const POST_EFFECT_JOURNAL = {
  effect: 'POSTED a manual journal to the Xero ledger',
  remedy: 'The journal is in the ledger: post a reversing journal there if it should not exist.',
} as const
/**
 * o3d-e2mz r5 (Codex finding 2): A DRAFT JOURNAL'S REMEDY IS NOT A REVERSAL — IT IS A DELETION.
 *
 * `_postingMode` is a per-sync-type operator setting, and on `draft` the journal is created in Xero
 * with status DRAFT (see resolveJournalStatus). A draft manual journal has not reached the ledger:
 * no account balance has moved. Telling an operator to "post a reversing journal" for one is the most
 * dangerous line in this table — the reversal WOULD post, so following the advice takes a document
 * that moved nothing and turns it into a real, one-sided movement of exactly the amount they were
 * trying to undo. The draft is then still sitting there as well.
 */
const POST_EFFECT_DRAFT_JOURNAL = {
  effect: 'created a DRAFT manual journal in Xero (nothing posted to the ledger)',
  remedy: 'The journal is a DRAFT — it has not reached the ledger and no balances have moved. DELETE the draft '
    + 'in Xero if it should not exist. Do NOT post a reversing journal: a reversal posts for real, so it would '
    + 'move the accounts by exactly the amount this draft never moved.',
} as const
const POST_EFFECT_PAYMENT = {
  effect: 'APPLIED a payment in Xero',
  remedy: 'A payment is applied against the document named above: remove or reverse THAT PAYMENT in Xero if it '
    + 'should not exist. Do not credit-note the invoice — the invoice itself was not created here.',
} as const
const POST_EFFECT_DOCUMENT_UPDATE = {
  effect: 'MODIFIED an existing Xero document',
  remedy: 'No new document was created — an existing one was changed. Compare it against IMS and correct it in '
    + 'Xero if the change should not stand; there is nothing to void or credit-note.',
} as const

const POST_EFFECT: Record<AccountingSyncType, { effect: string; remedy: string }> = {
  SALES_INVOICE: POST_EFFECT_LEDGER_DOCUMENT,
  PURCHASE_INVOICE: POST_EFFECT_LEDGER_DOCUMENT,
  CREDIT_NOTE: POST_EFFECT_LEDGER_DOCUMENT,
  PURCHASE_CREDIT_NOTE: POST_EFFECT_LEDGER_DOCUMENT,
  SALES_INVOICE_UPDATE: POST_EFFECT_DOCUMENT_UPDATE,
  PURCHASE_INVOICE_UPDATE: POST_EFFECT_DOCUMENT_UPDATE,
  INVOICE_PAYMENT: POST_EFFECT_PAYMENT,
  BILL_PAYMENT: POST_EFFECT_PAYMENT,
  COGS_JOURNAL: POST_EFFECT_JOURNAL,
  COGS_REVERSAL: POST_EFFECT_JOURNAL,
  INVENTORY_ADJUSTMENT: POST_EFFECT_JOURNAL,
  STOCK_IN_TRANSIT: POST_EFFECT_JOURNAL,
  STOCK_RECEIPT: POST_EFFECT_JOURNAL,
  STOCK_ALLOCATION: POST_EFFECT_JOURNAL,
  DAILY_BATCH_REVENUE_DEFERRAL: POST_EFFECT_JOURNAL,
  DAILY_BATCH_INVENTORY_ALLOC: POST_EFFECT_JOURNAL,
  DAILY_BATCH_GROUP_B: POST_EFFECT_JOURNAL,
  DAILY_BATCH_INVENTORY_RECONCILIATION: POST_EFFECT_JOURNAL,
  DAILY_BATCH_COGS_RECONCILIATION: POST_EFFECT_JOURNAL,
  DAILY_BATCH_TRANSIT_RECONCILIATION: POST_EFFECT_JOURNAL,
  UNEARNED_REV_REVERSAL: POST_EFFECT_JOURNAL,
  // Added by the compiler, not by hand: this Record is exhaustive over AccountingSyncType on
  // purpose (o3d-e2mz r4), so a type merged since — o3d-0i5y's allocation reversal — fails the
  // type-check here rather than silently inheriting the invoice wording. It goes through
  // `pushManualJournal` beside the other reversals, so it is a journal.
  ALLOCATION_REVERSAL: POST_EFFECT_JOURNAL,
  REALISED_FX_JOURNAL: POST_EFFECT_JOURNAL,
  UNREALISED_FX_JOURNAL: POST_EFFECT_JOURNAL,
  MANUFACTURING_JOURNAL: POST_EFFECT_JOURNAL,
  MANUFACTURING_RECLASS: POST_EFFECT_JOURNAL,
  PURCHASE_CREDIT_NOTE_ALLOCATION: {
    effect: 'ALLOCATED an existing supplier credit note against a bill in Xero',
    remedy: 'NO document was created — the allocation is a sub-resource of a credit note that already existed. '
      + 'Undo the allocation on that credit note in Xero if it should not stand; there is nothing to reverse or '
      + 'credit-note.',
  },
  BILL_ATTACHMENT: {
    effect: 'ATTACHED the supplier PDF to an existing Xero bill (a no-op when attachment upload is disabled)',
    remedy: 'NO ledger document was created and no money moved. Remove the attachment from the bill in Xero if it '
      + 'should not be there; nothing needs reversing or credit-noting.',
  },
  INVOICE_PDF: {
    effect: 'DOWNLOADED and stored the invoice PDF in IMS',
    remedy: 'NO ledger document was created and nothing in Xero changed — the effect is a file held by IMS. '
      + 'Nothing needs reversing or credit-noting.',
  },
  INVOICE_EMAIL: {
    effect: 'SENT the invoice email to the customer',
    remedy: 'NO ledger document was created, and the email CANNOT be recalled. If the invoice should not have been '
      + 'sent, contact the customer; there is nothing in Xero to reverse or credit-note for this row.',
  },
  WC_INVOICE_NOTE: {
    effect: 'ADDED an invoice note to the WooCommerce order',
    remedy: 'NO ledger document was created and nothing in Xero changed. Remove the note on the WooCommerce order '
      + 'if it should not be there.',
  },
  TAX_RATE_SYNC: {
    effect: 'CREATED or UPDATED a tax rate in Xero',
    remedy: 'NO ledger document was created and no money moved, but the tax rate is now live and documents posted '
      + 'after it will use it. Correct or archive the tax rate in Xero if it should not exist.',
  },
}

/**
 * The table above answers "what does posting this TYPE do"; the posting mode answers "did it actually
 * reach the ledger". Only the journal types have a mode that changes the answer, and the branch is
 * keyed on the shared constant rather than on a type list, so a journal type added to the table gets
 * the draft wording for free. `resolveJournalStatus` is reused rather than re-tested so the remedy
 * cannot drift from the status the request was actually sent with.
 */
function postEffectFor(type: AccountingSyncType, payload: SyncPayload): { effect: string; remedy: string } {
  const effect = POST_EFFECT[type]
  if (effect === POST_EFFECT_JOURNAL && resolveJournalStatus(payload._postingMode) === 'DRAFT') {
    return POST_EFFECT_DRAFT_JOURNAL
  }
  return effect
}

/**
 * THE ONE `referenceType` WHOSE ROW BELONGS TO A SALE THAT CAN BE CANCELLED (o3d-e2mz r8).
 *
 * `referenceId` IS the sales order id for these rows, so the cancellation state is one locked read
 * away. Every other reference the sweep and the recovery carry resolves to something a sales-order
 * cancellation does not speak for, and must NOT be gated on one:
 *
 *  • `PurchaseInvoice` / `PurchaseOrder` — a supplier bill. No sale is involved at all.
 *  • `SalesOrderRefund` (the CREDIT_NOTE rows) — a refund credit note is very often the DIRECT
 *    CONSEQUENCE of the cancellation. Refusing to finish its back-reference because the order is
 *    cancelled would strand exactly the document the cancellation created, which is the opposite of
 *    the harm this gate exists to stop: crediting a cancelled sale is right, invoicing it is wrong.
 *
 * One constant, consumed by the locked read below and by the sweep's gate, for the same reason
 * `BACK_REFERENCE_SWEEP_STATUSES` is one constant: two copies of "which rows belong to a sale" could
 * disagree, and the disagreement would be invisible.
 */
const SALE_SCOPED_REFERENCE_TYPE = 'SalesOrder'

/**
 * IS THERE STILL A SALE FOR THIS WORK TO BELONG TO? (o3d-e2mz r5, Codex finding 1)
 * o3d-e2mz: DID AN OPERATOR DECIDE ABOUT THIS ATTEMPT WHILE IT WAS POSTING?
 *
 * ESCALATION ONLY. It writes NOTHING to the sync row, and that is the whole of this branch's rebase
 * onto o3d-550x. An earlier round fenced the SYNCED write itself on the attempt revision and then
 * recovered from losing that fence by writing the external id anyway — which is a SECOND
 * implementation of the posted-document record. There is exactly one: `recordPostedSyncResult`,
 * reached here through `recordPostedDocumentDurably` / `persistPostedXeroDocument`. It records the
 * post unconditionally, its only precondition being that the row does not already name a DIFFERENT
 * document, precisely because evidence of a post must never be conditional on winning a race — which
 * is the same end state the earlier round's recovery path arrived at by a longer route.
 *
 * WHAT THE REVISION STILL BUYS, AND NOTHING ELSE DOES: an operator who settled attempt N as "did not
 * post" has to be TOLD that attempt N posted. `heldClaimWhere` cannot see that — `applyFencedAttemptDecision`
 * moves the revision, and a decision can leave the claim instant untouched — so this asks the row.
 *
 * One indexed read per posted document, on the post path only. A row that is GONE escalates too:
 * retention deleted the only record of an attempt whose document is in the ledger.
 */
async function readSaleCancellationStateUnderLock(
  tx: Prisma.TransactionClient,
  entry: { referenceType: string; referenceId: string },
): Promise<'LIVE' | 'CANCELLED'> {
  if (entry.referenceType !== SALE_SCOPED_REFERENCE_TYPE) return 'LIVE'
  await lockSalesOrder(tx, entry.referenceId)
  const so = await tx.salesOrder.findUnique({
    where: { id: entry.referenceId },
    select: { status: true },
  })
  // A deleted order cannot have its work continued either, and nothing downstream would find it.
  if (!so) return 'CANCELLED'
  return so.status === 'CANCELLED' ? 'CANCELLED' : 'LIVE'
}

/**
 * o3d-e2mz: DID AN OPERATOR DECIDE ABOUT THIS ATTEMPT WHILE IT WAS POSTING?
 *
 * ESCALATION ONLY. It writes NOTHING to the sync row, and that is this branch's rebase onto o3d-550x.
 * An earlier round fenced the SYNCED write itself on the attempt revision and then recovered from
 * losing that fence by writing the external id anyway — a SECOND implementation of the posted-document
 * record. There is exactly one: `recordPostedSyncResult`, reached here through
 * `recordPostedDocumentDurably` / `persistPostedXeroDocument`. It records the post unconditionally,
 * its only precondition being that the row does not already name a DIFFERENT document, precisely
 * because evidence of a post must never be conditional on winning a race.
 *
 * WHAT THE REVISION STILL BUYS, AND NOTHING ELSE DOES: an operator who settled attempt N as "did not
 * post" has to be TOLD that attempt N posted. `heldClaimWhere` cannot see that — a decision moves the
 * revision and can leave the claim instant untouched — so this asks the row.
 *
 * One indexed read per posted document, on the post path only. A row that is GONE escalates too:
 * retention deleted the only record of an attempt whose document is in the ledger.
 */
async function reportPostOnMovedAttempt(
  attempt: AttemptRef,
  entry: { type: AccountingSyncType; referenceType: string; referenceId: string },
  externalId: string | null,
  /** Read ONLY for `_postingMode` — see postEffectFor, and why a DRAFT journal's remedy differs. */
  payload: SyncPayload,
): Promise<void> {
  const current = await db.accountingSyncLog.findUnique({
    where: { id: attempt.id },
    select: { status: true, attemptRevision: true },
  })
  if (current && current.attemptRevision === attempt.attemptRevision) return
  const effect = postEffectFor(entry.type, payload)
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_sync_post_fenced_out',
    tag: 'sync',
    level: 'ERROR',
    // o3d-e2mz r4 (Codex finding 3): the effect and its remedy are looked up from the SYNC TYPE, not
    // asserted. Several types succeed without creating any ledger document at all, and telling an
    // operator to credit-note one points them at whatever real receivable is nearest.
    description: `Xero ${entry.type} for ${entry.referenceType} ${entry.referenceId} ${effect.effect}`
      + `${externalId === null ? '' : ` (${externalId})`} on attempt ${attempt.attemptRevision}, but sync `
      + `row ${attempt.id} had already moved to attempt ${current?.attemptRevision ?? 'a deleted row'} `
      + `(${current?.status ?? 'gone'}). Anything decided about attempt ${attempt.attemptRevision} was decided `
      + 'without this outcome. The document id IS recorded on the sync row — this runs only after the '
      + `record landed — so anything keyed on that row can see it. ${effect.remedy}`,
    metadata: {
      syncLogId: attempt.id,
      claimedAttemptRevision: attempt.attemptRevision,
      currentAttemptRevision: current?.attemptRevision ?? null,
      currentStatus: current?.status ?? null,
      externalId,
      /** o3d-e2mz r4: what the successful post actually did, so a dashboard can filter on it. */
      postEffect: effect.effect,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
    },
  })
}

export async function processPendingXeroSync(): Promise<ProcessResult> {
  // BEFORE ANY ENTRY IS CLAIMED OR POSTED (round 10). Every money post in this run goes through
  // `authoriseMoneyPost`, whose rival-attempt query is `remoteAttemptedAt: { not: null }` — kept
  // deliberately narrow, and the partial index depends on it — so it is blind to a money row a
  // binary outside stamping custody posted from. This makes those rows visible by stamping them,
  // conservatively, and it is also what makes a forfeited custody PERMANENT before this run's
  // claims can restore it.
  //
  // EVERY RUN, not once per database. Round 9 established its epoch once, which is precisely how a
  // ROLLBACK got underneath it; a repair that re-runs cannot be got underneath, and in steady state
  // it matches nothing through a partial index that is empty.
  //
  // THROWS rather than continuing if the repair fails. Nothing has posted yet, so failing the run
  // costs a five-minute delay, whereas posting into a fence that cannot see its rivals costs a
  // duplicate payment. The cron treats a throw here as it treats any other sync failure.
  await reportMoneyAttemptCustodyRepair(await repairMoneyAttemptsOutsideStampingCustody(), XERO_CONNECTOR)
  if (!isXeroAccountingOutboxEnabled()) {
    return processPendingXeroSyncDirect()
  }
  return processPendingXeroSyncViaOutbox()
}

async function processPendingXeroSyncDirect(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  const pending = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      OR: [
        {
          status: 'PENDING',
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lte: new Date() } },
          ],
        },
        {
          status: 'PROCESSING',
          processingStartedAt: { lt: staleClaimCutoff },
        },
      ],
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_PER_RUN,
  })
  const blockedPaymentEntryIds = await findInvoicePaymentsBlockedByEarlierLiveLogs(db, pending)
  const blockedUpdateEntryIds = await findInvoiceUpdatesBlockedByPendingCreate(db, pending)

  for (const entry of pending) {
    const claimedAt = new Date()
    // The claim, not the bare instant (Codex r2, medium 2). Nothing in this runner renews it, so the
    // holder answers the same instant every time — but every fence below asks the holder rather than
    // closing over a Date, which is what a renewing lease needs and what a merge would otherwise have
    // to find by hand at six call sites.
    const held = claimHeldFrom(claimedAt)
    // o3d-e2mz: the claim is ALSO the compare-and-swap that mints this attempt's identity. `attempt`
    // fences every write below on the revision, so nothing this worker does can land on a different
    // attempt — including one an operator has decided about while this claim was held.
    const attempt: AttemptRef = { id: entry.id, attemptRevision: nextAttemptRevision(entry.attemptRevision) }
    // The claim itself is the exclusion for INVOICE_PAYMENT: taken under the order row lock together
    // with the "is anything else for this order already posting?" test, so two runners working from
    // different snapshots cannot both elect themselves (o3d-a3wx round 4 #3). The attempt is minted
    // INSIDE that one statement rather than beside it — see claimAccountingSyncLog.
    const claim = await claimAccountingSyncLog(entry, claimedAt, staleClaimCutoff, attempt)
    if (claim.outcome === 'deferred') {
      // NOT `deferPaymentUntilEarlierLogsPost`: the locked claim declined, so `held` was never
      // granted and there is nothing to release. See deferUnclaimedPaymentUntilEarlierLogsPost.
      //
      // And no attempt fence either, for the same reason and it is the same fact: `attempt` was
      // MINTED here but never written, so the row is still at the revision we read. Fencing this
      // write on a value nothing ever stamped would match nothing, and because these fences fail
      // closed the symptom would be a deferral that silently never landed.
      await deferUnclaimedPaymentUntilEarlierLogsPost(db, entry, claim)
      result.skipped++
      continue
    }
    if (claim.outcome === 'not-claimable') continue

    result.processed++
    // o3d-5ct: RE-READ the payload now that the claim has succeeded, instead of posting the
    // snapshot taken by the findMany above. That snapshot was read BEFORE the claim, so a corrective
    // writer could have rewritten the row in between and this worker would still post the old
    // figure — and then mirror it into the AccountingEvent as the posted document. No predicate the
    // writer adds can close that: it cannot reach a value already in this process's memory. Claiming
    // first and reading second is what makes the read authoritative, because the claim's status
    // transition stops anyone else claiming the row.
    //
    // The pre-claim snapshot survives only as the seed value: if the re-read itself throws, the
    // catch below records a FAILURE with it. Nothing is posted on that path.
    let payload = (entry.payload ?? {}) as SyncPayload
    // o3d-dzip: and the durable half of the row's origin record — the column, PLUS retention's own
    // record of having emptied the payload, which is what tells a compacted row from a rewritten one
    // (Codex r1 finding 1). Seeded from the row the sweep read — `entry` already carries both — so
    // that if the authoritative re-read below throws, the failure path describes the row with the
    // record it was selected with rather than with a null that would read as "this row records
    // nothing".
    let origin = {
      connectionProvenance: entry.connectionProvenance ?? null,
      backReferenceEvidenceCompactedAt: entry.backReferenceEvidenceCompactedAt ?? null,
    }

    try {
      // ONE read for all of it (o3d-dzip): the payload, the column and the compaction instant are one
      // record, and assembling them from two reads is how a disagreement gets manufactured.
      const claimed = await readClaimedSyncLogOriginRecord(db, entry.id)
      payload = claimed.payload as SyncPayload
      origin = {
        connectionProvenance: claimed.connectionProvenance,
        backReferenceEvidenceCompactedAt: claimed.backReferenceEvidenceCompactedAt,
      }
      // Kept as a cheap pre-filter over the run's snapshot. It is no longer what makes the ordering
      // safe — the locked claim above is — but it still spares a lock round-trip in the ordinary case
      // and its verdict, when it fires, is the same one.
      if (blockedPaymentEntryIds.has(entry.id)) {
        // No `detail`: this is the snapshot PRE-FILTER, which knows only that something earlier was
        // live when the run began — the two conditions a detail names are the ones only the locked
        // claim can tell apart. `undefined` is what makes this read exactly as it always did.
        await deferPaymentUntilEarlierLogsPost(db, entry, held, undefined, attempt)
        result.skipped++
        continue
      }
      if (blockedUpdateEntryIds.has(entry.id)) {
        await deferUpdateUntilCreatePosts(db, entry, held, attempt)
        result.skipped++
        continue
      }

      if (entry.externalTransactionId) {
        // o3d-550x: the evidence write, NOT fenced on the claim — see recordPostedSyncResult. The
        // transaction is owned by recordPostedDocumentDurably, which is also the only thing standing
        // between an unwritable record and the ordinary retry that would erase it (Codex r2, high).
        const record = await recordPostedDocumentDurably(entry, entry.externalTransactionId, payload)
        if (!record.recorded) {
          // No escalation call here: the evidence committed with the transaction that observed the
          // conflict (Codex r1, high). Reaching this line IS the proof it was written.
          result.failed++
          continue
        }
        // o3d-e2mz: the record above is deliberately unfenced, so it lands even when the attempt has
        // moved. Whether it moved is still news for whoever moved it — see reportPostOnMovedAttempt.
        await reportPostOnMovedAttempt(attempt, entry, entry.externalTransactionId, payload)
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          // AFTER the enqueue, and that ORDER IS THE FIX (o3d-nepa r4, Codex finding 1).
          //
          // r3 put the announcement first and then threw when it could not be written, so a failed
          // ACTIVITY-LOG WRITE stopped the enqueue from being called at all — and r3's own reason for
          // still calling it on a tombstone is that SOME follow-ups are rebuilt from columns that
          // survive compaction (an INVOICE_PDF is enqueued from `externalTransactionId` and
          // `referenceId` alone). Those are real, recoverable work, and refusing to settle the row is
          // no reason to withhold them: the retry will just meet the same unwritable log next pass.
          //
          // What the announcement gates is the RELEASE, which is the property r3 was actually
          // defending — the obligation marker must never be discharged on the strength of an enqueue
          // that silently did nothing. That still holds exactly: a throw here skips the release, the
          // catch below returns the row to PENDING still carrying `backReferenceFollowUpsPendingAt`,
          // and the next pass announces. Re-running the enqueue on that pass is a no-op — it is
          // idempotent through `hasExistingSyncLog` and the partial unique index (audit-42co).
          // o3d-peh1: a REFUSED enqueue throws, exactly as a failed one does — the release below must
          // not discharge a marker for work that was never queued. o3d-bqw7 r2: the row's COMPLETE
          // origin record. This is the tombstone path — `payload` here is `{}` — so the durable column
          // is the only half that still names an organisation, and without it the invoice PDF this
          // enqueue raises could never post.
          requireFollowUpsEnqueued(entry.id, await enqueueFollowUps(
            entry.id, entry.type, entry.referenceType, entry.referenceId, payload,
            { externalId: entry.externalTransactionId },
            { payload, ...origin },
          ))
          await announceCompactedFollowUpLoss(entry)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          // NOT released: the follow-ups did not run. The row goes back to PENDING (or FAILED at
          // MAX_RETRIES) still carrying the obligation, so whichever gets there first — this
          // processor's own retry or the repair sweep — knows the work is outstanding.
          await markSyncLogForFollowUpRetry(attempt, entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }
        result.succeeded++
        continue
      }

      // o3d-xl63 r4 #1 / r5 #1: open the lease. Opening it re-takes the claim at the instant the work
      // begins and posts NOTHING if it is gone; from here on every remote mutation inside processEntry
      // fences on it again, and the absolute deadline it fixes covers the preparation calls too.
      const lease = await openRemoteWriteLease(entry.id, claimedAt)
      if (!lease) {
        await logActivity({
          entityType: 'SYSTEM',
          action: 'xero_sync_claim_lost_before_post',
          tag: 'sync',
          level: 'WARNING',
          description: lostClaimMessage(entry.id),
          metadata: { syncLogId: entry.id, type: entry.type, claimedAt: claimedAt.toISOString() },
          resolveUser: false,
        })
        result.skipped++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, origin, lease, attempt)

      // BEFORE `skipped` and before `success` (r5 #1): this row stopped without sending anything, so
      // it must not be failed, must not spend a retry, and must not be persisted.
      if (syncResult.notPosted) {
        const notPosted = syncResult.notPosted
        // The evidence is worded and shaped in ONE place (unsentPostEvidence) and written through
        // one of TWO mechanisms. Which one it takes is the whole of round 5, and it turns on whether
        // this reason also changes the row's state here.
        //
        // o3d-jit6 r4 (Codex HIGH): AND THE ROW IS ACTUALLY GIVEN BACK. r3 left it PROCESSING at the
        // instant the fence had just renewed, so nothing could re-take it for fifteen minutes — past
        // the six-minute window in which the standing dispatch marker still permits a replay. See
        // releaseUnsentTransportRefusal for why `nextAttemptAt` is now, and for why this cannot
        // license a second post: the marker is untouched and still refuses a late attempt.
        //
        // ONLY `transport-refused`. The other three reasons are deliberately unchanged. `claim-lost`
        // has no claim to give back — the release would match nothing, which is correct but pointless
        // — and `lease-expired` and `dispatch-unrecorded` are the outcomes o3d-xl63 and r1 settled on
        // their own terms, with no replay window running against them.
        if (notPosted.reason === 'transport-refused') {
          // o3d-jit6 r5 (Codex HIGH): THE EVIDENCE AND THE RELEASE ARE ONE COMMIT.
          //
          // r4 established the right ORDER — log first, release second, so no worker can meet the
          // marker with the trace missing — and then defeated it with the mechanism. `logActivity`
          // SWALLOWS ITS OWN FAILURES by design, and it sat OUTSIDE the release. So the ordering
          // guaranteed nothing at all: the write could fail silently, the release would commit
          // regardless, and the row would become claimable with the only durable trace of the
          // refusal gone. `logActivityInTransaction` writes THROUGH the transaction and does NOT
          // catch, so evidence and release commit or roll back together.
          //
          // o3d-jit6 r7 (Codex HIGH): AND AN ABORT IS NOW RETRIED, BOUNDEDLY, RATHER THAN CONCEDED.
          // r6 caught the abort, reported best-effort and continued — so a transient serialisation
          // failure or deadlock left the row PROCESSING until the fifteen-minute stale cutoff, past
          // the replay window, which is the defect r5 fixed reached through the abort path. It still
          // does not throw into the per-entry catch (that would spend a retry and FAIL a row that
          // provably sent nothing); it re-runs the COMPLETE atomic hand-back inside a wall-time
          // budget, and says what state the row is left in if the bounds are reached.
          //
          // THE SAME hand-back as the queued runner, not a copy of it. It fences on the LEASE
          // (never on `held`, which the minting fence has since moved), and a zero-row release does
          // not abort it — see recordAndReleaseUnsentTransportRefusal.
          await handBackUnsentTransportRefusal({ entry, notPosted, lease, attempt })
        } else {
          // The other three reasons change nothing about this row here, so no invariant binds the
          // evidence to a state change and the best-effort write is the right default: a failed log
          // must not turn a settled outcome into an unsettled one.
          await logActivity({ ...unsentPostEvidence(entry, notPosted), resolveUser: false })
        }
        result.skipped++
        continue
      }

      if (syncResult.skipped) {
        // processEntry already terminalised this row (e.g. its order was cancelled — o3d-5rs). Nothing
        // was posted, so do NOT mark it SYNCED/POSTED; it is a resolved no-op.
        result.skipped++
        continue
      }
      if (syncResult.success) {
        // POST-REMOTE PERSIST, NOT A PRE-FLIGHT ONE (o3d-xl63 r2 #2, r3 #1-#3). The document is
        // already in Xero; this write is the only thing that will ever say so — and WHAT it writes is
        // o3d-550x's durable record, not a re-spelt SYNCED update. See persistPostedXeroDocument.
        const persisted = await persistPostedXeroDocument({
          entry,
          payload,
          externalId: syncResult.externalId,
          // THE LEASE ITSELF, not `lease.heldFrom()` (r6). The persist's deadline, its own fence, and
          // the claim-fenced terminal write on the give-up path must each use the claim this worker
          // holds AT THE MOMENT THEY RUN. A snapshot taken here would be read minutes before the
          // give-up path's write, and because these fences fail closed the symptom of it being wrong
          // is silence: a document Xero already holds recorded nowhere.
          claim: lease,
          // o3d-cvj9: this attempt DID call the connector, so the revision stamp of the write it
          // made is recorded and orders the document against other writers.
          externalRevisionAt: syncResult.externalRevisionAt ?? null,
        })
        if (!persisted.persisted) {
          // Both reasons end the same way on THIS path, and for the same reason they end differently
          // on the outbox path below: there is no job here to bury or to leave locked. Either the
          // conflict evidence is durable (o3d-550x) or the identifier was reported off-pool
          // (o3d-xl63) — in both cases it has been recorded somewhere an operator can reach, and
          // anything further here would be another transaction against a pool that may have none.
          result.failed++
          continue
        }
        // o3d-e2mz: see reportPostOnMovedAttempt — the persist is unfenced by design, the news is not.
        await reportPostOnMovedAttempt(attempt, entry, syncResult.externalId ?? null, payload)

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          // o3d-peh1: a REFUSED enqueue throws, exactly as a failed one does. The third argument is
          // the record this post was made under, read in the same statement as the payload.
          requireFollowUpsEnqueued(entry.id, await enqueueFollowUps(
            entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult,
            { payload, ...origin },
          ))
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          await markSyncLogForFollowUpRetry(attempt, entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }

        result.succeeded++
      } else {
        const errorMessage = syncResult.error ?? 'Unknown error'
        if (isRateLimitError(errorMessage)) {
          // o3d-550x: the one fenced release — a displaced owner backing off here would hand the
          // row back to PENDING mid-post. o3d-e2mz: and fenced on the attempt, so a backoff cannot
          // reopen a row an operator has decided about.
          await releaseClaimForRetry(db, entry.id, held, {
            errorMessage,
            nextAttemptAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
          }, attempt)
        } else {
          await db.$transaction(async (tx) => {
            await applyMainSyncFailureRetry(tx, attempt, entry, errorMessage, payload, held)
          })
        }
        result.failed++
      }
    } catch (e) {
      if (e instanceof PostedDocumentEvidenceUnwritten) {
        // NEVER into the ordinary retry (Codex r2, HIGH): a retry of this entry finds the row already
        // naming the other document, settles it and reports success, and the identifier this error is
        // carrying is the only copy left. The row is left exactly as its winner left it.
        //
        // AWAITED (Codex r3, HIGH): the escalation now tries to write the record standalone, and a
        // floating promise would let this iteration finish — and the process exit — before it lands.
        await escalateUnwrittenPostedEvidence(e)
        result.failed++
        continue
      }
      const errorMessage = String(e)
      if (isRateLimitError(errorMessage)) {
        // o3d-550x: the one fenced release. o3d-e2mz: on the attempt as well as the claim.
        await releaseClaimForRetry(db, entry.id, held, {
          errorMessage,
          nextAttemptAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
        }, attempt)
      } else {
        await db.$transaction(async (tx) => {
          await applyMainSyncFailureRetry(tx, attempt, entry, errorMessage, payload, held)
        })
      }
      result.failed++
    }
  }

  const skippedCount = await db.accountingSyncLog.count({
    where: { connector: XERO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  // Add, don't overwrite: the loop above already counted per-run skips (e.g. cancelled-order
  // invoice retirements, o3d-5rs) that this exhausted-FAILED count must not erase.
  result.skipped += skippedCount

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_sync_batch',
      tag: 'sync',
      description: `Xero sync: ${result.succeeded} synced, ${result.failed} failed out of ${result.processed} processed`,
      metadata: { ...result, mode: 'direct' },
    })
  }

  return result
}

/**
 * IS AN UNRECORDED POSTED DOCUMENT ON FILE AGAINST THIS SYNC ROW — ASKED NOW, FOR ONE ROW
 * (Codex r3 HIGH; re-shaped by Codex r4, HIGH).
 *
 * The durable half of the burial guarantee. A job whose sync row carries one of these records must not
 * be completed as a success by ANY later run, and "later" includes runs in a process that never saw the
 * incident — the burial's own failure is precisely the case where the deciding run is a different one.
 * The record is the only thing both runs can see.
 *
 * WHY IT IS NO LONGER A BATCH SNAPSHOT (Codex r4, HIGH). Round 3 read every job's evidence once, before
 * the loop, and both doors consulted that Map. A Map read at the top of a run answers with the world as
 * it was BEFORE the run's Xero calls — and the incident this fence exists for is filed by ANOTHER
 * WORKER, mid-run, while it is on the wire. A snapshot cannot contain a row that did not exist when it
 * was taken, so the door it guards reopened under exactly the concurrency it was built for. Round 3
 * patched half of that from inside (`unrecordedPostedDocuments.set(...)` after an in-line burial), which
 * only ever covered incidents THIS run filed — the ones a second process files were never visible.
 *
 * So the question is asked at the moment the verdict is decided, for the one row being decided, and the
 * batch read is gone rather than kept as a fast path: a fast path whose miss is unsafe is not a fast
 * path. It costs one indexed point read on the (entityType, entityId) index, and only on the settled
 * replay branches — the rare ones, not the per-job path.
 *
 * A stale answer here is the safe direction. If an operator has already dealt with the duplicate in
 * Xero, the record still stands (nothing in IMS can observe a void, which is why it has no clearing
 * mechanism), and a later job for that row is permanently failed instead of completed — a visible,
 * harmless verdict on a row that is already SYNCED and that nothing will retry. The opposite mistake is
 * a document nobody knows about.
 */
export async function findUnrecordedPostedDocumentEvidenceFor(syncLogId: string): Promise<string | undefined> {
  const row = await db.activityLog.findFirst({
    where: {
      entityType: 'SYSTEM',
      entityId: syncLogId,
      action: UNRECORDED_POSTED_DOCUMENT_ACTION,
    },
    select: { description: true },
    orderBy: { createdAt: 'desc' },
  })
  return row?.description ?? undefined
}

/**
 * The verdict on a job whose sync row is already settled — the only three answers the doors below have.
 * RETRACTED is BURIED that had to travel through a completion to get there; both are failures, and the
 * caller counts them the same.
 */
type SettledOutboxVerdict =
  | { verdict: 'BURIED'; evidence: string }
  | { verdict: 'RETRACTED'; evidence: string }
  | { verdict: 'COMPLETED' }

/**
 * COMPLETE A SETTLED JOB — BUT ONLY IF NO INCIDENT IS FILED AGAINST ITS ROW, AND ASK TWICE
 * (Codex r4, HIGH).
 *
 * BOTH doors that turn a settled row into a green outbox job come through here, because they are one
 * decision made in two places and round 3 fixed them as two: the settled-replay short circuit at the top
 * of the loop, and the claim-failure branch reached when the row settles BETWEEN the batch read and the
 * claim. One function means one ordering, and a third door added later has somewhere obvious to go.
 *
 * The interleaving this closes, written out, because "read it fresh" alone does not close it:
 *
 *   • BEFORE. `findUnrecordedPostedDocumentEvidenceFor` is the statement immediately preceding the
 *     completion, so any incident committed before that read buries the job instead. That is the whole
 *     of round 4's finding: the snapshot could not see it, this read can.
 *   • AFTER. An incident committed between that read and the completion would still have been laundered,
 *     and the window is small but it is not zero — the displaced worker's insert lands whenever it
 *     lands. So the same question is asked again once the completion is written, and an incident that
 *     appeared in the gap RETRACTS it: the job is put back to PERMANENT_FAILED carrying the incident
 *     wording, which is where it would have gone had the read been a moment later.
 *
 * What is left after both is an incident committed strictly AFTER the confirming read, and that one is
 * not silent by construction: the worker filing it is still running, still holding the displaced
 * identifier, and the record it just committed is durable and exempt from retention. It buries its own
 * job with the same wording, or — if this run stole that job's claim — fails loudly rather than
 * completing anything. Nothing in that path ends in a green verdict with the identifier nowhere.
 *
 * The retraction is fenced on SUCCEEDED, not on the claim: the completion released the claim, and the
 * only row it may touch is the one it just completed. If the retraction cannot be written the run says
 * so on the process log — it does not throw, because the record whose wording it is quoting has already
 * been read out of the durable store, so the incident is on file whatever happens to the job.
 */
export async function completeSettledOutboxJobUnlessIncidentFiled(
  job: IntegrationOutboxRow,
  syncLogId: string,
): Promise<SettledOutboxVerdict> {
  const filed = await findUnrecordedPostedDocumentEvidenceFor(syncLogId)
  if (filed) {
    await markXeroOutboxPermanent(job, filed)
    return { verdict: 'BURIED', evidence: filed }
  }

  await markXeroOutboxSuccess(job)

  const filedSince = await findUnrecordedPostedDocumentEvidenceFor(syncLogId)
  if (!filedSince) return { verdict: 'COMPLETED' }

  const retracted = await db.integrationOutbox.updateMany({
    where: { id: job.id, status: INTEGRATION_OUTBOX_STATUS.SUCCEEDED },
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      lastError: filedSince.slice(0, 1000),
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
    },
  }).catch((cause: unknown) => {
    console.error(
      `[xero-sync] outbox job ${job.id} was completed a moment before an unrecorded posted document was `
      + `filed against sync log ${syncLogId}, and the completion could not be retracted: ${String(cause)}. `
      + filedSince,
    )
    return { count: 0 }
  })
  if (retracted.count === 0) {
    console.error(
      `[xero-sync] outbox job ${job.id} is still recorded as succeeded although an unrecorded posted `
      + `document is on file against sync log ${syncLogId}. ${filedSince}`,
    )
  }
  return { verdict: 'RETRACTED', evidence: filedSince }
}

async function processPendingXeroSyncViaOutbox(): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  await ensureXeroOutboxForPendingSyncLogs(MAX_PER_RUN, staleClaimCutoff)
  const jobs = await claimIntegrationOutboxWork({
    connector: XERO_OUTBOX_CONNECTOR,
    operation: XERO_ACCOUNTING_POST_OPERATION,
    limit: MAX_PER_RUN,
    workerId: XERO_ACCOUNTING_WORKER_ID,
    staleLockMs: CLAIM_STALE_MS,
    maxAttempts: MAX_RETRIES,
  })

  const jobWork: Array<{ job: IntegrationOutboxRow; syncLogId: string }> = []
  for (const job of jobs) {
    if (!job.lockedAt) {
      result.failed++
      continue
    }

    try {
      jobWork.push({ job, syncLogId: parseXeroAccountingOutboxPayload(job).accountingSyncLogId })
    } catch (error) {
      await markXeroOutboxPermanent(job, error instanceof Error ? error.message : String(error))
      result.failed++
      continue
    }
  }

  const entries = jobWork.length > 0
    ? await db.accountingSyncLog.findMany({
        where: { id: { in: [...new Set(jobWork.map((work) => work.syncLogId))] } },
      })
    : []
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  // NO BATCH READ OF THE FILED INCIDENTS (Codex r4, HIGH). One taken here answers with the world as it
  // was before this run made a single Xero call, and the incident the doors below guard against is filed
  // by ANOTHER worker while this one is on the wire. Each door asks at the moment it decides — see
  // completeSettledOutboxJobUnlessIncidentFiled.
  const blockedPaymentEntryIds = await findInvoicePaymentsBlockedByEarlierLiveLogs(db, entries)
  const blockedUpdateEntryIds = await findInvoiceUpdatesBlockedByPendingCreate(db, entries)

  for (const { job, syncLogId } of jobWork) {
    const entry = entriesById.get(syncLogId)
    if (!entry) {
      await markXeroOutboxPermanent(job, `Accounting sync log ${syncLogId} was not found`)
      result.failed++
      continue
    }
    if (entry.status === 'SYNCED' && entry.externalTransactionId) {
      // Ordinarily a replay of settled work. It is ALSO the exact line that used to swallow a lost
      // document (Codex r2, HIGH): when a conflict's record could not be written, the job was left
      // retryable, and the retry arrived here — SYNCED, an id on the row — and completed as a success
      // with the displaced identifier nowhere.
      //
      // Round 3 answered that by burying the job at the point of failure, and said this line no longer
      // sees such a job. It does, by one route round 3 did not follow: WHEN THE BURIAL ITSELF FAILS
      // (Codex r3, HIGH). The throw escaped the run and left the job PROCESSING and locked, so
      // CLAIM_STALE_MS later it is re-claimed as a stale lock and arrives here — SYNCED, an id on the
      // row — to be completed as a success, exactly as before. A guarantee that lives only "where the
      // identifier is still in hand" cannot survive the process that is holding it.
      //
      // So this line now asks the durable record instead of assuming it was acted on. If an incident is
      // filed against this sync row, the job is BURIED with that record's wording — never completed —
      // and the answer comes from the one store that outlives the run, READ AT THIS INSTANT rather than
      // from a snapshot taken before the run's first Xero call (Codex r4, HIGH).
      const settled = await completeSettledOutboxJobUnlessIncidentFiled(job, entry.id)
      if (settled.verdict === 'COMPLETED') result.skipped++
      else result.failed++
      continue
    }

    const claimedAt = new Date()
    // The claim, not the bare instant (Codex r2, medium 2). Nothing in this runner renews it, so the
    // holder answers the same instant every time — but every fence below asks the holder rather than
    // closing over a Date, which is what a renewing lease needs and what a merge would otherwise have
    // to find by hand at six call sites.
    const held = claimHeldFrom(claimedAt)
    // o3d-e2mz: same claim-as-CAS as the direct path — `attempt` fences every write below to the
    // attempt this worker actually holds.
    const attempt: AttemptRef = { id: entry.id, attemptRevision: nextAttemptRevision(entry.attemptRevision) }
    const claim = await claimAccountingSyncLog(entry, claimedAt, staleClaimCutoff, attempt)
    if (claim.outcome === 'deferred') {
      // Same shape as the blocked-payment branch below: the sync row's next attempt moves out and the
      // outbox job is retried, in ONE transaction so the queue and the row cannot disagree about
      // whether this entry is waiting. Unclaimed, so `held` is not used and no attempt fence applies
      // — the claim was declined, so nothing stamped the revision this worker minted.
      await db.$transaction(async (tx) => {
        await deferUnclaimedPaymentUntilEarlierLogsPost(tx, entry, claim)
        await markXeroOutboxRetry(job, invoicePaymentDeferralMessage(claim), tx)
      })
      result.skipped++
      continue
    }
    if (claim.outcome === 'not-claimable') {
      // The claim failed because the row is no longer PENDING/claimable. `entry` is a snapshot, so
      // re-read the live status: it may have been retired (CANCELLED — e.g. its order was cancelled,
      // o3d-5rs) or posted (SYNCED) since. CANCELLED is an INTENTIONAL no-op, not a failure — completing
      // the outbox job as success stops the retry churn / false PERMANENT_FAILED alerts a cancelled sync
      // would otherwise raise.
      const fresh = await db.accountingSyncLog.findUnique({
        where: { id: entry.id },
        select: { status: true },
      })
      const liveStatus = fresh?.status ?? entry.status
      // THE SECOND DOOR TO THE SAME CONVERSION (Codex r3, HIGH). This branch is reached when the row was
      // settled between the batch read and the claim — which is exactly the window a displaced worker's
      // conflict is recorded in. Completing the job then turns a filed incident into a success just as
      // the settled-replay short-circuit above did, so it goes through the SAME function rather than
      // asking the same question a second way (Codex r4, HIGH).
      //
      // CANCELLED asks too, and round 3 did not. A row can be retired while a worker is on the wire, and
      // that worker's post then meets a row it may not write to; the incident is filed against a row
      // whose live status is CANCELLED, and completing green here would launder it exactly as the SYNCED
      // case did. Asking costs one point read on a branch that is already rare.
      if (liveStatus === 'SYNCED' || liveStatus === 'CANCELLED') {
        const settled = await completeSettledOutboxJobUnlessIncidentFiled(job, entry.id)
        if (settled.verdict !== 'COMPLETED') result.failed++
      } else if (liveStatus === 'FAILED' || entry.retryCount >= MAX_RETRIES) {
        await markXeroOutboxPermanent(job, entry.errorMessage ?? `Accounting sync log ${entry.id} is not claimable`)
      } else {
        await markXeroOutboxRetry(job, `Accounting sync log ${entry.id} is not currently claimable`)
      }
      continue
    }

    result.processed++
    // o3d-5ct: RE-READ the payload now that the claim has succeeded, instead of posting the
    // snapshot taken by the findMany above. That snapshot was read BEFORE the claim, so a corrective
    // writer could have rewritten the row in between and this worker would still post the old
    // figure — and then mirror it into the AccountingEvent as the posted document. No predicate the
    // writer adds can close that: it cannot reach a value already in this process's memory. Claiming
    // first and reading second is what makes the read authoritative, because the claim's status
    // transition stops anyone else claiming the row.
    //
    // The pre-claim snapshot survives only as the seed value: if the re-read itself throws, the
    // catch below records a FAILURE with it. Nothing is posted on that path.
    let payload = (entry.payload ?? {}) as SyncPayload
    // o3d-dzip: and the durable half of the row's origin record — the column, PLUS retention's own
    // record of having emptied the payload, which is what tells a compacted row from a rewritten one
    // (Codex r1 finding 1). Seeded from the row the sweep read — `entry` already carries both — so
    // that if the authoritative re-read below throws, the failure path describes the row with the
    // record it was selected with rather than with a null that would read as "this row records
    // nothing".
    let origin = {
      connectionProvenance: entry.connectionProvenance ?? null,
      backReferenceEvidenceCompactedAt: entry.backReferenceEvidenceCompactedAt ?? null,
    }

    try {
      // ONE read for all of it (o3d-dzip): the payload, the column and the compaction instant are one
      // record, and assembling them from two reads is how a disagreement gets manufactured.
      const claimed = await readClaimedSyncLogOriginRecord(db, entry.id)
      payload = claimed.payload as SyncPayload
      origin = {
        connectionProvenance: claimed.connectionProvenance,
        backReferenceEvidenceCompactedAt: claimed.backReferenceEvidenceCompactedAt,
      }
      // Cheap pre-filter over the run's snapshot; the locked claim above is what makes the ordering
      // safe. The claim IS held here, so the deferral gives it back under its own fence.
      if (blockedPaymentEntryIds.has(entry.id)) {
        await db.$transaction(async (tx) => {
          // o3d-550x: THE SAME release as the direct runner, not a copy of it. o3d-e2mz: fenced on
          // the claimed attempt too; the outbox job is released either way, since this worker holds
          // that job regardless of what happened to the sync row.
          await deferPaymentUntilEarlierLogsPost(tx, entry, held, undefined, attempt)
          await markXeroOutboxRetry(job, PAYMENT_ORDERING_DEFERRAL_MESSAGE, tx)
        })
        result.skipped++
        continue
      }

      if (blockedUpdateEntryIds.has(entry.id)) {
        await db.$transaction(async (tx) => {
          // o3d-550x: THE SAME release as the direct runner, not a copy of it. o3d-e2mz: attempt-fenced.
          await deferUpdateUntilCreatePosts(tx, entry, held, attempt)
          await markXeroOutboxRetry(job, UPDATE_ORDERING_DEFERRAL_MESSAGE, tx)
        })
        result.skipped++
        continue
      }

      if (entry.externalTransactionId) {
        // o3d-550x: the evidence write, NOT fenced on the claim — see recordPostedSyncResult.
        const record = await recordPostedDocumentDurably(entry, entry.externalTransactionId, payload)
        if (!record.recorded) {
          // PERMANENT, not retryable: the document is in Xero and cannot be recorded here, so
          // another attempt would only post a second one. SAFE TO BE PERMANENT ONLY BECAUSE THE
          // EVIDENCE IS ALREADY COMMITTED — `record.evidence` exists exactly when the activity row
          // it describes was written in the conflict transaction (Codex r1, high). If that write had
          // failed, the transaction above would have thrown and the job would be retried, not buried.
          //
          // Nothing is cached for later jobs in this batch any more (Codex r4, HIGH): the record is
          // committed, and every door reads the store at the point it decides, so a second job for this
          // row finds it — as it also finds the ones a CONCURRENT process filed, which the cache never
          // could.
          await markXeroOutboxPermanent(job, record.evidence)
          result.failed++
          continue
        }
        // o3d-e2mz: see reportPostOnMovedAttempt — the record above is unfenced by design, the news
        // that an operator's decision about this attempt is now known to be wrong is not.
        await reportPostOnMovedAttempt(attempt, entry, entry.externalTransactionId, payload)
        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          // AFTER the enqueue, and that ORDER IS THE FIX (o3d-nepa r4, Codex finding 1).
          //
          // r3 put the announcement first and then threw when it could not be written, so a failed
          // ACTIVITY-LOG WRITE stopped the enqueue from being called at all — and r3's own reason for
          // still calling it on a tombstone is that SOME follow-ups are rebuilt from columns that
          // survive compaction (an INVOICE_PDF is enqueued from `externalTransactionId` and
          // `referenceId` alone). Those are real, recoverable work, and refusing to settle the row is
          // no reason to withhold them: the retry will just meet the same unwritable log next pass.
          //
          // What the announcement gates is the RELEASE, which is the property r3 was actually
          // defending — the obligation marker must never be discharged on the strength of an enqueue
          // that silently did nothing. That still holds exactly: a throw here skips the release, the
          // catch below returns the row to PENDING still carrying `backReferenceFollowUpsPendingAt`,
          // and the next pass announces. Re-running the enqueue on that pass is a no-op — it is
          // idempotent through `hasExistingSyncLog` and the partial unique index (audit-42co).
          // o3d-peh1: a REFUSED enqueue throws, exactly as a failed one does — the release below must
          // not discharge a marker for work that was never queued. o3d-bqw7 r2: the row's COMPLETE
          // origin record. This is the tombstone path — `payload` here is `{}` — so the durable column
          // is the only half that still names an organisation, and without it the invoice PDF this
          // enqueue raises could never post.
          requireFollowUpsEnqueued(entry.id, await enqueueFollowUps(
            entry.id, entry.type, entry.referenceType, entry.referenceId, payload,
            { externalId: entry.externalTransactionId },
            { payload, ...origin },
          ))
          await announceCompactedFollowUpLoss(entry)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          const retry = await db.$transaction(async (tx) => {
            const nextRetry = await markSyncLogForFollowUpRetry(attempt, entry, followUpError, tx)
            if (nextRetry.finalFailure) {
              await markXeroOutboxPermanent(job, nextRetry.errorMessage, tx)
            } else {
              await markXeroOutboxRetry(job, nextRetry.errorMessage, tx)
            }
            return nextRetry
          })
          await logFollowUpRetry(entry.id, followUpError)
          if (!retry.errorMessage) throw new Error(`Xero sync entry ${entry.id} follow-up failure could not be recorded`)
          result.failed++
          continue
        }
        await markXeroOutboxSuccess(job)
        result.succeeded++
        continue
      }

      // o3d-xl63 r4 #1 / r5 #1: as in the direct path — open the lease, which re-takes the claim at the
      // instant the work begins. The job is passed in, so every fence renews the OUTBOX lock as well:
      // the queue side has its own fifteen-minute staleness and would otherwise hand this job to a
      // second worker while the first is still legitimately working. Handed back for retry rather than
      // failed, because nothing was sent.
      const lease = await openRemoteWriteLease(entry.id, claimedAt, job)
      if (!lease) {
        await markXeroOutboxRetry(job, lostClaimMessage(entry.id))
        await logActivity({
          entityType: 'SYSTEM',
          action: 'xero_sync_claim_lost_before_post',
          tag: 'sync',
          level: 'WARNING',
          description: lostClaimMessage(entry.id),
          metadata: { syncLogId: entry.id, type: entry.type, outboxJobId: job.id, claimedAt: claimedAt.toISOString() },
          resolveUser: false,
        })
        result.skipped++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, origin, lease, attempt)

      if (syncResult.notPosted) {
        const notPosted = syncResult.notPosted
        // LOG FIRST (o3d-jit6 r4) is now LOG IN THE SAME TRANSACTION (r5): this activity row is what
        // the later refusal tells an operator to look for, and the release below makes the row
        // claimable again, so the gap in which another worker can meet the marker with no trace of
        // why it stands must not merely be narrow — it must not exist. r3 handed the JOB back before
        // logging; the row could not move, so the order did not matter. It does now, and ordering
        // alone was never enough to secure it.
        //
        // The lock may itself be what was lost, in which case handing the job back cannot work — say
        // so rather than letting the fence's own throw escape into the generic failure handler and
        // spend a retry on a row that was never posted.
        try {
          if (notPosted.reason === 'transport-refused') {
            // o3d-jit6 r4 (Codex HIGH): ONE TRANSACTION, because on this path the row and the job are
            // two halves of one retry. A released row whose job stayed PROCESSING waits for the
            // queue's own fifteen-minute stale-lock sweep — the same fifteen minutes the release
            // exists to escape — and a requeued job whose row stayed PROCESSING is claimed by the
            // next tick only to find the row unclaimable and skip it. Either half alone re-creates
            // the defect, so neither may commit without the other.
            //
            // And the job is handed back through the deferral that spends NO attempt, at
            // `nextAttemptAt` now, NOT through markXeroOutboxRetry: that one counts the attempt
            // against MAX_RETRIES and its first backoff floor is five minutes, which would burn the
            // replay window it is supposed to be racing.
            // o3d-jit6 r5 (Codex HIGH): AND THE EVIDENCE IS THE THIRD MEMBER OF THAT TRANSACTION.
            //
            // r4 wrote it with `logActivity` — which SWALLOWS ITS OWN FAILURES — from outside this
            // block, so the release and the requeue could commit while the only durable trace of the
            // refusal was silently lost. The ordering r4 chose was the right one and could not
            // enforce itself. THE SAME hand-back as the direct runner now writes all three, and it
            // does not catch: an unwritable record aborts the lot rather than letting two of them
            // proceed without it.
            //
            // o3d-jit6 r7 (Codex HIGH): AND THAT ABORT IS BOUNDEDLY RETRIED. Conceding after one
            // attempt left BOTH halves stranded until their own fifteen-minute stale sweeps — past
            // the replay window — for what is typically a transient serialisation failure. The
            // complete transaction is re-run within a wall-time budget that cannot itself close the
            // window; only when the bounds are reached is the abort reported, naming the state the
            // row is left in. It still never throws into the per-entry catch.
            await handBackUnsentTransportRefusal({ entry, notPosted, lease, attempt, job })
          } else {
            // The other three reasons take the ordinary failure hand-back, which is not the
            // marker-and-replay-window state the invariant is about, so the evidence stays
            // best-effort: a failed log must not stop a job being handed back.
            await logActivity({ ...unsentPostEvidence(entry, notPosted, job.id), resolveUser: false })
            await markXeroOutboxRetry(job, notPosted.message)
          }
        } catch (releaseError) {
          // REACHABLE FROM THE `else` ARM ONLY (r7): the refusal arm handles, retries and reports its
          // own abort and does not throw. What can still land here is the ordinary hand-back for the
          // other three reasons — `markXeroOutboxRetry`'s own fence, say — and it is reported the
          // same way rather than escaping into the generic failure handler and spending a retry on a
          // row that was never posted.
          await reportUnsentHandBackAborted(entry, notPosted, releaseError, job.id)
        }
        result.skipped++
        continue
      }

      if (syncResult.skipped) {
        // processEntry already terminalised this row (e.g. its order was cancelled — o3d-5rs). Complete
        // the outbox job as a successful no-op; nothing was posted, so do NOT mark it SYNCED/POSTED.
        await markXeroOutboxSuccess(job)
        result.skipped++
        continue
      }
      if (syncResult.success) {
        // Same post-remote persist as the direct path (o3d-xl63 r2 #2, r3 #1-#3), and this is the one
        // MOST rows take: losing it loses the external id of a document Xero already holds.
        const persisted = await persistPostedXeroDocument({
          entry,
          payload,
          externalId: syncResult.externalId,
          // The lease itself (r6) — see the direct path.
          claim: lease,
          // o3d-cvj9: this attempt DID call the connector, so the revision stamp of the write it
          // made is recorded and orders the document against other writers.
          externalRevisionAt: syncResult.externalRevisionAt ?? null,
        })
        if (!persisted.persisted) {
          // THE TWO FAILURES ARE NOT THE SAME JOB OUTCOME, and collapsing them would be wrong in
          // whichever direction it collapsed.
          //
          //  • not-recorded (o3d-550x): the row already names a DIFFERENT document and the evidence
          //    is durable. Bury the job PERMANENTLY — a retry could only post a second document —
          //    and the burial is safe to attempt because nothing here says the pool is unavailable.
          //  • pool-exhausted (o3d-xl63 r3): completing OR failing the job needs the very pool that
          //    just refused this persist for the whole deadline. So the job is left locked and lapses
          //    into a stale lock, which is the correct outcome: when it is re-claimed, the row's
          //    recovered external id makes the retry a no-op short-circuit.
          if (persisted.reason === 'not-recorded') {
            await markXeroOutboxPermanent(job, persisted.evidence)
          }
          result.failed++
          continue
        }
        // o3d-e2mz: see reportPostOnMovedAttempt.
        await reportPostOnMovedAttempt(attempt, entry, syncResult.externalId ?? null, payload)

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          // o3d-peh1: a REFUSED enqueue throws, exactly as a failed one does. The third argument is
          // the record this post was made under, read in the same statement as the payload.
          requireFollowUpsEnqueued(entry.id, await enqueueFollowUps(
            entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult,
            { payload, ...origin },
          ))
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          const retry = await db.$transaction(async (tx) => {
            const nextRetry = await markSyncLogForFollowUpRetry(attempt, entry, followUpError, tx)
            if (nextRetry.finalFailure) {
              await markXeroOutboxPermanent(job, nextRetry.errorMessage, tx)
            } else {
              await markXeroOutboxRetry(job, nextRetry.errorMessage, tx)
            }
            return nextRetry
          })
          await logFollowUpRetry(entry.id, followUpError)
          if (!retry.errorMessage) throw new Error(`Xero sync entry ${entry.id} follow-up failure could not be recorded`)
          result.failed++
          continue
        }

        await markXeroOutboxSuccess(job)
        result.succeeded++
      } else {
        const errorMessage = syncResult.error ?? 'Unknown error'
        if (isRateLimitError(errorMessage)) {
          const retryDelayMs = getRateLimitBackoffMs(entry.retryCount, errorMessage)
          await db.$transaction(async (tx) => {
            // o3d-550x: the one fenced release. o3d-e2mz: on the attempt as well as the claim.
            await releaseClaimForRetry(tx, entry.id, held, {
              errorMessage,
              nextAttemptAt: new Date(Date.now() + retryDelayMs),
            }, attempt)
            await deferOutboxWithoutSpendingAnAttempt(tx, job, errorMessage, retryDelayMs)
          })
        } else {
          await db.$transaction(async (tx) => {
            const { finalFailure } = await applyMainSyncFailureRetry(tx, attempt, entry, errorMessage, payload, held)
            if (finalFailure) {
              await markXeroOutboxPermanent(job, errorMessage, tx)
            } else {
              await markXeroOutboxRetry(job, errorMessage, tx)
            }
          })
        }
        result.failed++
      }
    } catch (e) {
      if (e instanceof XeroOutboxCompletionError) throw e
      if (e instanceof PostedDocumentEvidenceUnwritten) {
        // The job is buried, and burying is the SAFE direction here (Codex r2, HIGH). Round 1's defect
        // was burying while claiming an escalation had been filed; this buries BECAUSE nothing could be
        // filed, and it carries the wording that names both documents into the job's own failure column
        // — a different table from the one that just refused the write. Marking it retryable instead
        // would hand the incident to a run that sees a SYNCED row with an external id and completes the
        // job as a success, which is how the identifier disappears.
        const recordFiled = await escalateUnwrittenPostedEvidence(e)
        // And the burial is not assumed to succeed (Codex r3, HIGH) — see
        // buryOutboxJobForUnwrittenPostedEvidence for where a failed one used to end up.
        await buryOutboxJobForUnwrittenPostedEvidence(job, e, recordFiled)
        result.failed++
        continue
      }
      const errorMessage = String(e)
      if (isRateLimitError(errorMessage)) {
        const retryDelayMs = getRateLimitBackoffMs(entry.retryCount, errorMessage)
        await db.$transaction(async (tx) => {
          // o3d-550x: the one fenced release. o3d-e2mz: on the attempt as well as the claim.
          await releaseClaimForRetry(tx, entry.id, held, {
            errorMessage,
            nextAttemptAt: new Date(Date.now() + retryDelayMs),
          }, attempt)
          await deferOutboxWithoutSpendingAnAttempt(tx, job, errorMessage, retryDelayMs)
        })
      } else {
        await db.$transaction(async (tx) => {
          const { finalFailure } = await applyMainSyncFailureRetry(tx, attempt, entry, errorMessage, payload, held)
          if (finalFailure) {
            await markXeroOutboxPermanent(job, errorMessage, tx)
          } else {
            await markXeroOutboxRetry(job, errorMessage, tx)
          }
        })
      }
      result.failed++
    }
  }

  // Log skipped entries (exceeded max retries)
  const skippedCount = await db.accountingSyncLog.count({
    where: { connector: XERO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  // Add, don't overwrite: the loop above already counted per-run skips (e.g. cancelled-order
  // invoice retirements, o3d-5rs) that this exhausted-FAILED count must not erase.
  result.skipped += skippedCount

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_sync_batch',
      tag: 'sync',
      description: `Xero sync: ${result.succeeded} synced, ${result.failed} failed out of ${result.processed} processed`,
      metadata: result,
    })
  }

  return result
}

/** Resolve _postingMode to Xero API status values */
function resolveInvoiceStatus(mode: unknown): string {
  return mode === 'draft' ? 'DRAFT' : 'AUTHORISED'
}
function resolveJournalStatus(mode: unknown): string {
  return mode === 'draft' ? 'DRAFT' : 'POSTED'
}

type EntryResult = {
  success: boolean
  externalId?: string
  invoiceNumber?: string
  /** o3d-cvj9 r3: the external system's revision stamp for the document this write just changed. */
  externalRevisionAt?: Date | null
  error?: string
  skipped?: boolean
  /**
   * Set when the entry stopped BEFORE sending anything (o3d-xl63 r5 #1). Distinct from a failure:
   * a failure may have reached Xero, this provably did not, so the row is handed back rather than
   * having its retry count spent. Callers must test this before `skipped` and before `success`.
   */
  notPosted?: {
    /**
     * o3d-jit6 r3: `transport-refused` is the one of these that happens AFTER the dispatch record was
     * minted — the fence sent nothing because the transport would not. The row is handed back exactly
     * like the other three, and the marker it left behind is a known, named residual (o3d-gvzu).
     */
    reason: 'claim-lost' | 'lease-expired' | 'dispatch-unrecorded' | 'transport-refused'
    operation: string
    message: string
  }
}

/**
 * Post-time backstop for the cancel-time sweep (o3d-5rs), shared by SALES_INVOICE and its UPDATE. A row
 * can be enqueued (Woo import) or re-queued (rate-limit/defer/failure) AFTER the order was cancelled and
 * its then-pending rows swept, so re-read the order status right before posting:
 *  - CANCELLED  → retire THIS claimed row (claim-fenced) and skip; no revenue for a cancelled sale.
 *  - unreadable / missing → FAIL CLOSED (return a retryable failure, do NOT post): a transient read
 *    outage must not become permission to post.
 *  - live → return the customerId and let the caller post.
 * o3d-7o0 — THE READ IS NOW TAKEN UNDER THE ORDER'S ROW LOCK, IN THE TRANSACTION THAT RETIRES.
 *
 * It used to be a bare `findUnique` followed by a separate transaction, so a cancellation could commit
 * between the answer and the external POST and the invoice landed anyway — a lock-less TOCTOU this
 * function's own header could only declare. `cancelSalesOrderFulfillmentState` opens with
 * `lockSalesOrder` on the same row, so taking it here makes the two SERIALISE: either the cancellation
 * commits first and this read sees CANCELLED, or this transaction holds the lock and the cancellation
 * waits — and then finds this worker's PROCESSING claim (committed by the runner BEFORE processEntry)
 * and REFUSES, via assertNoSalesInvoicePostingInFlight. The claim is the posting intent; this lock is
 * what makes reading it binding. Together they close the window rather than narrowing it.
 *
 * LOCK ORDERING: `lockSalesOrder` is the FIRST statement and the ONLY lock this transaction takes,
 * before any accounting_sync_logs write. The cancellation takes the same order lock first, then stock
 * levels, then the sync rows. Nothing can cycle.
 *
 * Fails CLOSED on an unreadable order, exactly as before: the whole transaction is wrapped, so a lock
 * timeout or a read error returns a retryable failure rather than permission to post.
 */
export async function guardCancelledSalesOrderInvoice(
  attempt: AttemptRef,
  referenceType: string,
  referenceId: string,
  held: HeldClaim,
): Promise<{ post: true; customerId?: string } | { post: false; result: EntryResult }> {
  if (referenceType !== 'SalesOrder') return { post: true }
  let outcome:
    | { kind: 'missing' }
    | { kind: 'cancelled' }
    | { kind: 'live'; customerId?: string }
  try {
    outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, referenceId)
      const so = await tx.salesOrder.findUnique({
        where: { id: referenceId },
        select: { customerId: true, status: true },
      })
      if (!so) return { kind: 'missing' as const }
      if (so.status === 'CANCELLED') {
        // Claim-fenced AND attempt-fenced (o3d-550x + o3d-e2mz): only retire if this exact claim
        // still owns the row and THIS attempt is still the current one, and advance the attempt as
        // it retires so nothing else can write back onto it (retire returns false otherwise).
        // Either way nothing was posted, so skip — a lost fence means another attempt owns/posted it.
        await retireSalesInvoiceForCancelledOrder(tx, attempt, referenceId, held)
        return { kind: 'cancelled' as const }
      }
      return { kind: 'live' as const, customerId: so.customerId ?? undefined }
    })
  } catch (error) {
    return { post: false, result: { success: false, error: `Could not read sales order ${referenceId} status before posting: ${String(error)}` } }
  }
  if (outcome.kind === 'missing') {
    return { post: false, result: { success: false, error: `Sales order ${referenceId} not found before posting an invoice` } }
  }
  if (outcome.kind === 'cancelled') {
    return { post: false, result: { success: true, skipped: true } }
  }
  return { post: true, customerId: outcome.customerId }
}

// o3d-k26m.5 round 4 added a SECOND `heldClaimWhere` here, with a note saying it was deliberately
// identical to the sibling branch's and that "if both land, keep one definition". Both have landed,
// so this is that collapse: the definition is the one in `@/lib/domain/accounting/sync-claim-fence`,
// imported at the top of this file and re-exported below, and the copy that stood here is gone.
//
// It is not merely a duplicate. It took a bare `Date`, and this branch's contract is that a claim is
// a HOLDER asked for its instant at the point of use — which is why every consumer of the copy below
// had to be threaded with the claim rather than a snapshot of it, and why the compiler, not a
// reviewer, found them.

/**
 * THE OTHER WRITER IS US: ONE IMS WORKER AT A TIME MAY POST UNDER A GIVEN NUMBER (o3d-k26m.5 r4,
 * rebuilt on a LOCK in round 5).
 *
 * The ledger lookup answers "who holds this number NOW", and between that answer and the POST there
 * is a window. Once xeroom is removed the only thing that can take a number inside that window is
 * another IMS worker holding a DIFFERENT sync row that carries the SAME number — two rows for one
 * order, or two orders WooCommerce numbered alike. Both workers would read "unclaimed", both would
 * post, and because the create is update-or-create on the number the second silently REPLACES the
 * first. One invoice, one survivor, nothing anywhere recording that there had been two.
 *
 * It is the only race that survives the cutover, and unlike a foreign writer it is entirely ours to
 * close.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT ROUND 4 GOT WRONG, AND WHY BOTH HALVES WERE THE SAME MISTAKE (Codex round 4 → round 5)
 * ------------------------------------------------------------------------------------------------
 * Round 4 closed it WITHOUT a lock: each worker wrote its stamp before it read for rivals, and
 * yielded to any rival whose stamp was not strictly later than its own. Two independent defects,
 * and both come from letting something other than the resource itself decide.
 *
 * 1. THE IDENTITY WAS NARROWER THAN THE LEDGER'S. The rival scan matched `attemptedInvoiceNumber`
 *    as an exact string. Xero matches invoice numbers case-insensitively — this module's own lookup
 *    says so and re-compares its response that way — so `INV-1` and `inv-1` are ONE document and one
 *    upsert target, while round 4 gave them two independent slots. Each worker found itself
 *    unopposed; the second post replaced the first. The mutex and the ledger now share ONE
 *    definition of "the same number", `xeroInvoiceNumberIdentity`, so a pair of rows Xero would
 *    collide cannot hold different slots.
 *
 * 2. A CLOCK DECIDED WHO WON, AND CLOCKS DO NOT AGREE. Round 4 already found one clock trap here
 *    (two stamps recording as equal when one genuinely preceded the other, fixed by making a tie
 *    yield both ways). The deeper one it left: the stamps come from DIFFERENT HOSTS. If worker A's
 *    clock runs far enough ahead of worker B's, A reads B's live stamp as older than the lease and
 *    filters it out entirely — while B, seeing A's stamp dated in its own future, reads A as
 *    "strictly later" and posts anyway. BOTH POST. No tie-break can repair that, because the inputs
 *    are not comparable quantities.
 *
 * ------------------------------------------------------------------------------------------------
 * SO THE ORDERING IS A LOCK ORDERING, NOT A CLOCK READING — AND NO HOST PARTICIPATES
 * ------------------------------------------------------------------------------------------------
 * The sibling branch o3d-batch-wcfix reached the same conclusion about its own evidence ordering and
 * replaced a wall clock with a monotonic generation minted under a lock. A generation is the right
 * answer THERE because what that code needs is an ORDER over successive writes to one row. Here
 * there is no order to establish: what is needed is that only one worker at a time may look and then
 * stamp. So the lock is not a way of minting an ordering, it IS the answer — the shared resource is
 * the invoice number, and PostgreSQL will serialize on it directly:
 *
 *   `pg_advisory_xact_lock(XERO_INVOICE_NUMBER_SLOT_LOCK_NAMESPACE, hashtext(<identity>))`
 *
 * taken as the FIRST statement of the transaction that reads the in-flight rows and writes this
 * row's stamp. Under it, look-then-stamp is atomic with respect to every other worker asking about
 * the same number, so:
 *
 *   - there is no tie to break and no stamp comparison anywhere in the decision;
 *   - who gets the slot is decided by the lock manager, which is one arbiter with one view, not by
 *     two hosts comparing readings of two clocks;
 *   - the round-4 write-before-read proof is retired along with the thing it was proving. It was an
 *     argument that two workers could not both miss each other; the lock makes "both look" impossible
 *     rather than merely unprofitable.
 *
 * THE LOCK IS NOT HELD ACROSS THE POST, and could not be: the post is an HTTP request that may take
 * minutes, and an advisory lock spanning it would wedge every other worker behind a crashed one. What
 * fences the number DURING the post is the stamp, and the stamp has a lease.
 *
 * IT IS ALSO EXACTLY ONE LOCK, TAKEN FIRST AND RELEASED BY THE TRANSACTION. Nothing here acquires a
 * second, so there is no acquisition order to get wrong and no deadlock to construct — the hazard the
 * per-SKU product locks have to sort their ids for. A worker blocked behind a rival long enough to
 * exhaust the interactive-transaction timeout ends in the catch below, which REFUSES; waiting too
 * long for the lock costs a retry, never a post.
 *
 * THE ONE REMAINING CLOCK READING IS THAT LEASE, AND IT IS THE DATABASE'S. A stamp fences the number
 * only while it is younger than {@link CLAIM_STALE_MS} — and, since round 7, for the WHOLE of that
 * window whatever becomes of the row. A worker that died mid-post writes no outcome at all, and a
 * worker whose post timed out writes one that is not evidence either way; the lease is what stops
 * either of them fencing a number off for good. That is a duration, not an ordering — nothing about who wins depends on it — and both ends of it are now read from the SAME
 * clock: `now()` inside the transaction supplies the cutoff AND the value written into
 * `attemptedInvoiceNumberAt`. So a stamp lapses exactly one lease after it was written, whatever the
 * workers' own hosts believe the time to be, and two clocks are never compared.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE NUMBER IS COMPARED IN JAVASCRIPT AND NOT IN THE QUERY
 * ------------------------------------------------------------------------------------------------
 * The obvious spelling of a case-insensitive match — Prisma's `mode: 'insensitive'` — compiles to
 * `ILIKE`, which treats the value as a PATTERN. `_wcpdf_invoice_number` is free text an admin can
 * edit (prefix, number and suffix are all settings), so it can contain `%`, `_` or a backslash. The
 * first two only widen the match, which is harmless here; a BACKSLASH does not — `a\_b` as a pattern
 * matches `a_b` and NOT the stored `a\_b`, so the rival would be MISSED. A missed rival is the
 * overwrite. So the query narrows only on things with no pattern semantics (connector, status, the
 * lease window, a non-null stamp) and the identity comparison happens in code, where it is string
 * equality and nothing else.
 *
 * The candidate set that reaches code is every row that has attempted a post under this connector
 * within the last lease — one row per create attempt, so a handful in any ordinary quarter-hour, and
 * bounded in the limit by Xero's own 1,000-call rolling day budget (each create costs several calls,
 * so the cap below cannot be approached except by a burst that is about to exhaust the day). It is
 * served by `accounting_sync_logs_invoice_number_fence_idx`, a partial index on exactly the stamped
 * rows. It is still CAPPED, and a scan that hits the cap REFUSES rather than reporting the fraction
 * it saw: the same rule the ledger lookup applies to a page it cannot prove is complete.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT COUNTS AS A LIVE RIVAL — AND WHY IT IS NO LONGER "STILL PROCESSING" (Codex round 7, #1)
 * ------------------------------------------------------------------------------------------------
 * Stamped within the lease. THAT IS THE WHOLE TEST; the row's status is not part of it, and used to
 * be. Rounds 4-6 also required `status = 'PROCESSING'`, on the reasoning that a loser's row drops
 * back to PENDING as it fails, which frees the number immediately. It does — and that is the defect,
 * because A FAILED ROW IS NOT PROOF THAT NOTHING WAS POSTED.
 *
 * A POST THAT TIMES OUT HAS NO OUTCOME, ONLY AN UNKNOWN ONE. The socket write happened; the reply
 * did not arrive. Xero may have created the document, may not, and this process cannot tell which —
 * that is the same lost-response state the whole fence is built around, and the `Idempotency-Key`
 * that would once have replayed the original answer is retained for six minutes, well inside the
 * fifteen this lease runs for. Past that, a replay is a fresh create, and the create is
 * update-or-create on the number.
 *
 * Under the old predicate that row settled — FAILED, or back to PENDING for the retry ladder — and
 * STOPPED FENCING ITS NUMBER within seconds of the timeout. A second worker whose ledger answer had
 * been taken before the first post left would then find no rival, take the slot, and post under a
 * number a live document may already be carrying. The exclusion evaporated at exactly the moment its
 * subject became uncertain.
 *
 * SO A STAMP IS RETIRED BY ITS LEASE AND BY NOTHING ELSE. It says "this row may already have written
 * this number", and only time can make that stop mattering. Nothing releases it early, because
 * nothing available locally is proof of a remote non-write: not a FAILED status, not a refusal
 * recorded after an earlier attempt in the same call already reached the wire, not a 429 the client
 * gave up on.
 *
 * THAT IS WHAT MAKES THE TWO BOUNDS FIT TOGETHER. A rival's answer may be at most one lease old when
 * it is spent ({@link LEDGER_ANSWER_MAX_AGE_MS}), and a stamp fences for exactly one lease from the
 * instant it was written — which is the instant of the send, since the stamp is re-taken on every
 * attempt. So no answer obtained BEFORE our post left can still be spendable after our fence lapses.
 * With the status filter in place that argument was simply false; the fence could vanish in seconds
 * while the answer it was protecting against stayed valid for fifteen minutes.
 *
 * WHAT THE LEASE DOES NOT COVER, STATED. A rival that asks the ledger AFTER our post left, and posts
 * a full lease later, can outlive our stamp. Its backstop is the ledger question itself: by then a
 * post that landed is a document Xero will report, and the answer is a refusal
 * (NUMBER_HELD_BY_FOREIGN_DOCUMENT) rather than a permission. The local fence covers the window in
 * which the ledger cannot yet know; it does not pretend to cover the one in which it can.
 *
 * THE COST OF THE WIDER SET IS REFUSALS, WHICH IS THE RECOVERABLE DIRECTION. A row that genuinely
 * sent nothing — refused by a later authorisation in the same scope, say — still fences its number
 * for up to a lease, so a different row carrying the SAME number waits and retries. Two rows racing
 * on one number is the situation this fence exists for; making one of them wait fifteen minutes is
 * not a cost worth trading an unrecoverable write for.
 *
 * NOT filtered by sync type. The question is "is another worker about to write this number", and the
 * only writer of this column is this fence, so a type filter could only ever hide a rival.
 *
 * IT LICENSES NOTHING. Finding no rival is not permission to post — the ledger's answer is, and it is
 * asked separately. This can only ever refuse.
 *
 * EXPORTED so the exclusion can be exercised directly, against a database double and with no Xero
 * client anywhere near it — the property being pinned is about two workers and one column, and
 * driving it through `processEntry` would need the whole connector to say nothing more.
 *
 * AND A LOST CLAIM REFUSES. If the stamp updates no row, this worker no longer owns the entry: it was
 * re-claimed after aging out, another worker is on it, and continuing would post from a row whose
 * outcome this worker may no longer write.
 */
export const INVOICE_NUMBER_RIVAL_SCAN_LIMIT = 200

export async function takeInvoiceNumberPostSlot(params: {
  entryId: string
  /** The claim this worker HOLDS, read as each fenced statement is built — never a snapshot. */
  held: HeldClaim
  invoiceNumber: string
  orderLabel: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const identity = xeroInvoiceNumberIdentity(params.invoiceNumber)
  if (!identity) {
    // Unreachable from the fence (an empty number is refused before the ledger is even asked), and
    // kept as a refusal because an empty lock key would serialize every unrelated invoice onto one
    // slot — a mutex that says "yes" to nobody.
    return {
      ok: false,
      reason:
        `Refusing to post ${params.orderLabel}: the invoice number is blank once trimmed, so there is no `
        + 'number to exclude another worker on. NOTHING WAS SENT.',
    }
  }

  try {
    return await db.$transaction(async (tx) => {
      // FIRST, before any read or write. Everything below is a look-then-stamp, and a look-then-stamp
      // is only atomic for as long as this is the statement that precedes it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${XERO_INVOICE_NUMBER_SLOT_LOCK_NAMESPACE}::int4, hashtext(${identity})::int4)`

      // The lease's clock, read once and used at BOTH ends — see the header. Taking it from the
      // database rather than this host is what stops two workers' clocks being compared.
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`
      const now = clock?.[0]?.now
      if (!(now instanceof Date)) {
        return {
          ok: false,
          reason:
            `Could not read the database clock before posting ${params.orderLabel} as invoice number `
            + `${params.invoiceNumber}, so how old another worker's in-flight stamp is cannot be established. `
            + 'NOTHING WAS SENT.',
        }
      }

      const inFlight = await tx.accountingSyncLog.findMany({
        where: {
          id: { not: params.entryId },
          connector: XERO_CONNECTOR,
          // NO STATUS FILTER, and its absence is the round-7 fix — see WHAT COUNTS AS A LIVE RIVAL
          // in the header. A row that has left PROCESSING is not a row whose post did not land.
          attemptedInvoiceNumber: { not: null },
          attemptedInvoiceNumberAt: { gte: new Date(now.getTime() - CLAIM_STALE_MS) },
        },
        // Makes the REFUSAL deterministic when several rows qualify. It decides nothing: any live
        // rival refuses, so which one is named is a diagnostic question, not an ordering one.
        orderBy: { id: 'asc' },
        select: { id: true, referenceId: true, attemptedInvoiceNumber: true },
        take: INVOICE_NUMBER_RIVAL_SCAN_LIMIT,
      })

      if (inFlight.length >= INVOICE_NUMBER_RIVAL_SCAN_LIMIT) {
        return {
          ok: false,
          reason:
            `Refusing to post ${params.orderLabel} as invoice number ${params.invoiceNumber}: the in-flight scan `
            + `filled its ${INVOICE_NUMBER_RIVAL_SCAN_LIMIT}-row limit, so it cannot show that it saw every sync `
            + 'row that might be posting under that number. NOTHING WAS SENT.',
        }
      }

      const rival = inFlight.find(
        (r) => r.attemptedInvoiceNumber !== null && xeroInvoiceNumberIdentity(r.attemptedInvoiceNumber) === identity,
      )
      if (rival) {
        return {
          ok: false,
          reason:
            `Refusing to post ${params.orderLabel} as invoice number ${params.invoiceNumber}: sync row ${rival.id} `
            + `(reference ${rival.referenceId}) is already in flight under that same number `
            + `(${JSON.stringify(rival.attemptedInvoiceNumber)}). The create is update-or-create on the number, so `
            + 'both posts would land on ONE document and the later one would silently replace the earlier. NOTHING '
            + 'WAS SENT — this retries once that row settles, and if both rows genuinely describe the same invoice, '
            + 'cancel the duplicate.',
        }
      }

      // The number is recorded VERBATIM, not as its identity: the column is the record of what this
      // row set out to post, and what it set out to post is the customer's own number. The identity
      // is how the fence compares two of them, never what it stores.
      //
      // BEFORE the post, never after — and a failure to write it REFUSES the post. Not because the
      // record licenses anything (it does not: see invoice-number-ownership.ts), but because a create
      // whose local record cannot be written is a create whose OUTCOME cannot be written either. A
      // database that will not take this row will not take the InvoiceID the response carries, and
      // that is exactly the lost-response state the fence can no longer heal.
      const stamped = await tx.accountingSyncLog.updateMany({
        where: heldClaimWhere(params.entryId, params.held),
        data: { attemptedInvoiceNumber: params.invoiceNumber, attemptedInvoiceNumberAt: now },
      })
      if (stamped.count === 0) {
        return {
          ok: false,
          reason:
            `Refusing to post ${params.orderLabel} as invoice number ${params.invoiceNumber}: this worker no longer `
            + `holds the claim on sync row ${params.entryId} — it aged out and another worker re-claimed it. NOTHING `
            + 'WAS SENT; the worker that holds the row now will post it.',
        }
      }

      return { ok: true }
    })
  } catch (error) {
    // Fails closed like every other read and write on this path: not knowing whether a sibling is
    // mid-post, or failing to record that we are about to be, is not permission to post.
    return {
      ok: false,
      reason:
        `Could not take the exclusive post slot for invoice number ${params.invoiceNumber} on sync row `
        + `${params.entryId} (${params.orderLabel}): ${String(error)}. NOTHING WAS SENT.`,
    }
  }
}

/**
 * HOW OLD THE LEDGER'S ANSWER MAY BE WHEN THE REQUEST FINALLY LEAVES (o3d-k26m.5 round 5, #2).
 *
 * Deliberately the claim's own lease and not a number of its own. Past this point the claim under
 * which the answer was obtained is itself re-takeable by another worker, so the row may no longer be
 * ours to post from — an answer that has outlived the claim it was taken under cannot be authorising
 * anything.
 */
const LEDGER_ANSWER_MAX_AGE_MS = CLAIM_STALE_MS

/**
 * A monotonic, in-process millisecond reader.
 *
 * `Date.now()` would be a wall clock, and a wall clock can step backwards under NTP — which on this
 * particular measurement would report a stale answer as fresh. This measures ONE elapsed interval
 * inside ONE process, which is exactly what `performance.now()` is for; nothing here is compared
 * against a value from another host.
 */
const monotonicNowMs = (): number => performance.now()

/**
 * THE CHECK THAT RUNS IMMEDIATELY BEFORE THE REQUEST LEAVES (o3d-k26m.5 round 5 #2, round 6).
 *
 * THE PROBLEM IT FIXES. Round 4 asked the ledger, then took the post slot, then called
 * `pushSalesInvoice` — and `pushSalesInvoice` does not post first. It PREPARES: `findOrCreateContact`
 * is a Xero round trip, and `findOrCreateItem` is another one per distinct item code, each through
 * the same rate-limited client whose in-request budget is six minutes PER CALL. So an ordinary
 * multi-line invoice could sit in preparation for longer than the fifteen-minute lease that made the
 * slot mean anything, and the sequence was:
 *
 *     ask the ledger → take the slot → [unbounded preparation] → POST
 *
 * By the time the POST left, the slot could have lapsed (so a rival's scan no longer saw it, and a
 * second worker was free to post under the same number), the claim on the row could have aged out and
 * been re-taken (so the row was not even ours), and the ledger's answer was as old as all of it. The
 * answer that authorised the post was stale in every way at once.
 *
 * THE FIX IS PLACEMENT, NOT ANOTHER CHECK. The slot is no longer taken before preparation; it is
 * taken by this closure, which is now scoped around the create and run from inside `performRequest`
 * as the last statement before the socket. So the sequence is now:
 *
 *     ask the ledger → [unbounded preparation] → take the slot → POST
 *
 * and the slot cannot expire during preparation because it does not yet exist during preparation.
 *
 * ROUND 6 MOVED THE EVALUATION ONE LAYER FURTHER DOWN, because "immediately before `xeroPost`" was
 * not immediately before the write: `xeroPost` resolves auth (a token refresh is a network call),
 * then blocks in `waitForBudget` until the tenant's minute window clears, then retries a 429 with
 * sleeps of up to 90 seconds, up to four attempts. The slot is a fifteen-minute lease and A RETRY CAN
 * OUTLIVE IT — so this closure now runs ON EVERY ATTEMPT, immediately before the bytes move, which is
 * also what keeps the lease refreshed for as long as we are still trying. See
 * lib/connectors/accounting-egress-authorization.ts. The gap it has to cover shrinks from "the whole
 * entry" to "the width of one socket write".
 *
 * ROUND 7 ADDED THE ONE THING THE PLACEMENT ALONE DID NOT FIX: WHICH LEDGER THE ANSWER IS ABOUT.
 * `lookupXeroInvoiceNumberClaim` resolves the Xero connection for itself and the create resolves it
 * again; between the two, a reconnect, a tenant re-pin, or a refresh landing on another tenant makes
 * the answer a fact about organisation A and the post a write to organisation B — where nothing was
 * asked, and where the number may well be held by a live document. Age was bounded and identity was
 * not, so a perfectly fresh answer could authorise a post into a ledger it had never seen.
 *
 * The answer therefore travels with the tenant that gave it (`answeredByTenantId`, carried out of the
 * lookup and onto the decision), and this closure re-states it against `request.tenantId` — the
 * `auth` the outgoing request was built from, handed in by the egress seam as the last statement
 * before the socket. This is the ONE place the comparison is sound: anywhere earlier and the post
 * resolves auth again afterwards, which is the stale read being removed rather than a check.
 *
 * It reuses the sibling `o3d-batch-realm`'s seam rather than adding a third: that branch reaches its
 * own tenant verdict at this same point against this same `auth.tenantId`, and DELETED its earlier
 * pre-check on the ground that a refusal from a stale read is as wrong as a permission from one.
 * There is no pre-check here either — the guard binds nothing, it only records which organisation
 * answered. The two questions are different (realm: may this row reach this ledger at all; here: is
 * this the ledger my answer came from), so they are two entries in the accumulating authorisation
 * list, evaluated in scope order, never two evaluation sites.
 *
 * WHAT HAPPENS TO EACH OF THE FOUR THINGS THAT COULD GO STALE:
 *
 *   - THE ORGANISATION THE ANSWER IS ABOUT: re-stated against the outgoing request's own tenant, on
 *     every attempt, and refused on any difference — see above.
 *   - THE SLOT: no longer stale by construction — see above.
 *   - THE CLAIM ON THE ROW: RE-CHECKED, in the database, at the same instant. The stamp is fenced on
 *     `heldClaimWhere`, so a worker whose claim aged out during preparation writes nothing and posts
 *     nothing. That check is not advisory: it is the same statement that takes the slot.
 *   - THE LEDGER'S ANSWER: BOUNDED, and refused past the bound — re-measured on every attempt, so a
 *     retry ladder that sleeps past the bound refuses instead of sending on a lapsed answer. It is
 *     deliberately NOT re-asked. The
 *     fence is costed at ONE lookup per create against a 1,000-call daily budget, and a second call
 *     would buy almost nothing: the only writers that could have taken the number since are another
 *     IMS worker — which the slot excludes, and now excludes at the instant of the post rather than
 *     minutes before it — or a human typing an invoice into Xero by hand, which is unobservable from
 *     inside IMS at any age of answer and is documented as such rather than implied to be covered.
 *     What a bound does buy is that the fence can never post on an answer of unbounded age, which is
 *     the state Codex found.
 *
 * RELATIONSHIP TO THE SIBLING BRANCH o3d-batch-small2, WHICH FOUND THE SAME WINDOW. That branch
 * closes the GENERIC half — a lease over the whole entry, an absolute deadline, and a claim re-take
 * before each of the fourteen remote mutations — and flagged, in its own commit message, exactly the
 * residual it could not reach: "the fence cannot reach INSIDE a connector call, so one call that does
 * two reads then a write is bounded only by the per-call budget — closing that needs a hook threaded
 * through the connector modules". THIS IS THAT HOOK, threaded for the one call where the residual is
 * an irreversible overwrite rather than a duplicate. The two answers do not disagree and are not
 * alternatives: small2 proves the ROW is still ours, this proves the NUMBER is still ours, and after a
 * merge both belong in the same place — `lease.fenceBeforeRemoteWrite('sales-invoice')` should move
 * from the call site into this closure, so the claim re-take and the slot are taken at one instant
 * immediately before the socket rather than one before preparation and one after.
 *
 * RE-ENTRANCY. Because this now runs once per HTTP attempt rather than once per call, everything it
 * does must be safe to repeat: it is. The rival scan is a read; the stamp is an idempotent write of
 * the SAME number with a refreshed database timestamp, fenced on the claim, so a repeat either
 * renews our own lease or discovers the row is no longer ours and refuses.
 *
 * A REFUSAL HERE IS AN ORDINARY FAILURE, like every other refusal this fence produces: nothing was
 * sent, the row runs the normal retry ladder, and the next run re-asks the ledger from scratch. (On
 * small2 the same outcome is additionally marked `notPosted` so it does not spend a retry; that is
 * that branch's field to add and this one must not invent a second spelling of it.)
 */
export function buildInvoiceNumberPostSlotCheck(params: {
  entryId: string
  /** The claim this worker HOLDS — see `takeInvoiceNumberPostSlot`. */
  held: HeldClaim
  invoiceNumber: string
  orderLabel: string
  referenceType: string
  referenceId: string
  /**
   * The organisation the ledger's answer came from — see the ORGANISATION section above. The post is
   * refused unless the request on the point of leaving is addressed to this same one.
   */
  answeredByTenantId: string
  /** Injected only by tests. Monotonic milliseconds — never a wall clock. */
  monotonicNowMs?: () => number
}): BeforeRemoteWrite {
  const readNow = params.monotonicNowMs ?? monotonicNowMs
  // Taken at CONSTRUCTION, which the fence does immediately after the ledger answers. The age this
  // measures is therefore the age of the answer, not the age of this closure.
  const answeredAt = readNow()

  const warn = async (description: string, action: string) => {
    await logActivity({
      entityType: params.referenceType === 'SalesOrder' ? 'SALES_ORDER' : 'SYSTEM',
      entityId: params.referenceType === 'SalesOrder' ? params.referenceId : undefined,
      action,
      tag: 'accounting',
      level: 'WARNING',
      description,
      metadata: { connector: XERO_CONNECTOR, syncLogId: params.entryId, invoiceNumber: params.invoiceNumber },
      resolveUser: false,
    }).catch(() => {})
  }

  return async (request) => {
    // FIRST, because it is the cheapest refusal and the most fundamental one: everything below is
    // about a number, and a number only means anything inside one organisation. Asked here, against
    // the tenant the outgoing request itself carries, because this is the only point at which the
    // ledger that ANSWERED and the ledger that will be WRITTEN TO can be compared with no second
    // token resolution able to slip between them. Nothing is stamped and no slot is taken for a post
    // that is going somewhere the fence never asked about.
    if (request.tenantId !== params.answeredByTenantId) {
      const error =
        `Refusing to post ${params.orderLabel} as invoice number ${params.invoiceNumber}: the ledger that was asked `
        + `who holds that number was organisation ${params.answeredByTenantId}, but this request is addressed to `
        + `organisation ${request.tenantId} — the accounting connection changed between the question and the write. `
        + 'The answer says nothing about the organisation about to receive the post, and the create is '
        + 'update-or-create on the number, so it could silently replace a document there. NOTHING WAS SENT; the '
        + 'next run asks the organisation that is actually connected.'
      await warn(error, 'sales_invoice_number_answer_wrong_tenant')
      return { ok: false, error }
    }

    const ageMs = readNow() - answeredAt
    if (ageMs >= LEDGER_ANSWER_MAX_AGE_MS) {
      const error =
        `Refusing to post ${params.orderLabel} as invoice number ${params.invoiceNumber}: the ledger was asked who `
        + `holds that number ${Math.round(ageMs / 1000)}s ago — longer than the ${Math.round(LEDGER_ANSWER_MAX_AGE_MS / 60_000)} `
        + 'minutes this worker\'s claim on the row is guaranteed for — because building the invoice took that long '
        + '(the contact and every item are separate calls to the accounting system). The answer that would authorise '
        + 'this post is no longer current, and the create is update-or-create on the number. NOTHING WAS SENT; the '
        + 'next run asks again.'
      await warn(error, 'sales_invoice_number_answer_stale')
      return { ok: false, error }
    }

    const slot = await takeInvoiceNumberPostSlot({
      entryId: params.entryId,
      held: params.held,
      invoiceNumber: params.invoiceNumber,
      orderLabel: params.orderLabel,
    })
    if (!slot.ok) {
      await warn(slot.reason, 'sales_invoice_number_in_flight_elsewhere')
      return { ok: false, error: slot.reason }
    }

    return { ok: true }
  }
}

/**
 * THE OWNERSHIP FENCE ON THE SALES-INVOICE CREATE (o3d-k26m.5).
 *
 * `POST /Invoices` is update-or-create on InvoiceNumber. Since o3d-k26m.1 the number is
 * WooCommerce's own `_wcpdf_invoice_number` — which the outgoing xeroom plugin is posting to this
 * same live organisation today — so a create for an order xeroom has already invoiced does not
 * duplicate: it silently REPLACES that invoice. This asks the ledger who holds the number and
 * lets the post through only when the answer is "nobody" or "a document we own". The rule itself
 * is `decideInvoiceNumberPost`; this is its wiring, and it is the last thing between the payload
 * and an irreversible write.
 *
 * APPLIED TO EVERY CREATE, not only to storefront-supplied numbers. The hazard is the VERB, not
 * the number's provenance: an IMS-minted number that collides with anything already in the ledger
 * overwrites it just as quietly. It costs one GET per invoice create, which is real against a
 * 1,000-call rolling daily budget and is bought deliberately — the alternative currency is
 * destroyed documents.
 *
 * NOT applied to SALES_INVOICE_UPDATE: that posts to `Invoices/{InvoiceID}`, an id IMS recorded
 * from the create's own response, so it is already addressing a document we own by identity.
 *
 * FAILS CLOSED on an unreadable order and on an unreachable ledger, the same way
 * guardCancelledSalesOrderInvoice does — a transient read outage must not become permission to
 * post.
 *
 * AND THE ANSWER IS NEVER SEPARATED FROM THE LEDGER THAT GAVE IT (round 7). `lookupXeroInvoiceNumberClaim`
 * reports the tenant that answered, `decideInvoiceNumberPost` carries it onto the permission, and the
 * closure below re-states it against the tenant on the outgoing request. Nothing in THIS function
 * compares tenants: a pre-check here would be a comparison between two separate resolutions of "the
 * current connection", minutes before the write, which is a refusal or a permission produced from a
 * stale read — the sibling branch o3d-batch-realm deleted exactly such a pre-check for exactly that
 * reason. All this function does is refuse to hand on a permission that cannot say where it came from.
 *
 * AND ON THE WORKER NEXT TO IT — BUT NOT FROM HERE (round 5). The ledger's answer is about a moment;
 * {@link takeInvoiceNumberPostSlot} covers the window between that moment and the request, which after
 * the cutover only another IMS worker can occupy. Round 4 took that slot HERE, which put it in front
 * of `pushSalesInvoice`'s preparation — a contact round trip plus one per distinct item code — so the
 * slot, and the claim it was fenced on, could both have lapsed before the request left. This function
 * therefore does not take the slot; it returns {@link buildInvoiceNumberPostSlotCheck}'s closure, which
 * `pushSalesInvoice` runs after the payload is built and immediately before `xeroPost`. The order is
 * unchanged — ledger first, so the common refusals cost no writes — but the slot is now taken as late
 * as it is possible to take it.
 *
 * A REFUSAL IS RETURNED AS AN ORDINARY FAILURE, so the row runs the normal retry ladder and settles
 * as FAILED with the reason on it. That is not wasted budget: the fence re-asks the ledger each
 * time, so the operator's remedy — linking the right document to the order, or voiding the wrong
 * one — is picked up automatically by the next retry instead of needing a re-queue. The ladder is
 * bounded (MAX_RETRIES), so a refusal nobody acts on costs a handful of reads and then stops.
 */
async function guardSalesInvoiceNumberOwnership(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  /**
   * The claim this worker HOLDS — the fence's own writes are conditioned on it. A holder, not the
   * instant: on this branch the claim is RENEWED before every remote mutation, and the slot stamp
   * below is written some way after this guard is entered, so a snapshot taken here would fence on
   * a claim that has since moved and would match nothing at all.
   */
  held: HeldClaim,
): Promise<{ post: true; beforePost: BeforeRemoteWrite } | { post: false; result: EntryResult }> {
  const invoiceNumber = typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber : null

  let ownedInvoiceId: string | null = null
  let orderLabel = `${referenceType} ${referenceId}`
  if (referenceType === 'SalesOrder') {
    try {
      const so = await db.salesOrder.findUnique({
        where: { id: referenceId },
        select: { accountingInvoiceId: true, orderNumber: true, externalOrderNumber: true },
      })
      // A missing order is NOT "unowned". It means the thing we are invoicing cannot be read, and
      // the fence's whole job is to refuse to guess.
      if (!so) {
        return {
          post: false,
          result: { success: false, error: `Sales order ${referenceId} not found before posting an invoice` },
        }
      }
      ownedInvoiceId = so.accountingInvoiceId
      orderLabel = `order ${so.orderNumber ?? so.externalOrderNumber ?? referenceId}`
    } catch (error) {
      return {
        post: false,
        result: { success: false, error: `Could not read sales order ${referenceId} before the invoice-number ownership check: ${String(error)}` },
      }
    }
  }

  // Message material for a refusal, never a licence to post (o3d-k26m.5, Codex round 3). A read
  // failure here still refuses: it is the same unhealthy-database signal that would stop the
  // POST's own outcome from being recorded.
  let attemptedInvoiceNumber: string | null = null
  try {
    const entry = await db.accountingSyncLog.findUnique({
      where: { id: entryId },
      select: { attemptedInvoiceNumber: true },
    })
    attemptedInvoiceNumber = entry?.attemptedInvoiceNumber ?? null
  } catch (error) {
    return {
      post: false,
      result: { success: false, error: `Could not read the invoice-number attempt on sync row ${entryId}: ${String(error)}` },
    }
  }

  const lookup = await lookupXeroInvoiceNumberClaim(invoiceNumber ?? '')
  const decision = decideInvoiceNumberPost({ invoiceNumber, lookup, ownedInvoiceId, attemptedInvoiceNumber, orderLabel })

  if (!decision.post) {
    await logActivity({
      entityType: referenceType === 'SalesOrder' ? 'SALES_ORDER' : 'SYSTEM',
      entityId: referenceType === 'SalesOrder' ? referenceId : undefined,
      action: 'sales_invoice_number_not_ours',
      tag: 'accounting',
      level: 'WARNING',
      description: decision.reason,
      metadata: {
        connector: XERO_CONNECTOR,
        syncLogId: entryId,
        invoiceNumber,
        refusalCode: decision.code,
        retryable: decision.retryable,
      },
      resolveUser: false,
    }).catch(() => {})
    return { post: false, result: { success: false, error: decision.reason } }
  }

  // EVERY post that lands on the number takes the slot — the `unclaimed` create and the
  // `own-document` update alike. Both write to the ledger addressing it BY NUMBER, so both are
  // capable of being the second of two writes that collapse into one document. The stamp is also
  // the durability gate it always was; only its condition has changed (from "the ledger said
  // nobody holds it" to "we are about to post"), which is the honest one for both jobs.
  if (!invoiceNumber) {
    // Unreachable: a missing number is refused by the rule above. Kept as a refusal rather than a
    // non-null assertion, because the one thing that must never happen here is posting unfenced.
    return {
      post: false,
      result: { success: false, error: `No invoice number to fence before posting ${orderLabel}` },
    }
  }

  // Built HERE, so the age it measures starts at the ledger's answer — and RUN by pushSalesInvoice,
  // after preparation, immediately before the request leaves (round 5, finding #2).
  return {
    post: true,
    beforePost: buildInvoiceNumberPostSlotCheck({
      entryId,
      held,
      invoiceNumber,
      orderLabel,
      referenceType,
      referenceId,
      // Not re-read from the connection here, and that is the point (round 7, finding 2). This is the
      // organisation that ANSWERED the question above, carried out of the decision that granted the
      // permission, so the comparison at the socket is between the ledger asked and the ledger
      // written to — never between two separate resolutions of "the current tenant".
      answeredByTenantId: decision.answeredByTenantId,
    }),
  }
}

/**
 * HAS IMS EVER DISPATCHED A CREATE FOR THIS SUPPLIER CREDIT NOTE? (o3d-tfri r3)
 *
 * The question is about the CREDIT NOTE, not this row. `retryCount` alone answers it for the ordinary
 * case — a row that has failed once may have failed AFTER the request left — but a row whose retries
 * exhausted settles as FAILED, and `queueXeroSync` dedupes new enqueues on PENDING/PROCESSING/SYNCED
 * only, so the same credit note can legitimately be re-queued as a BRAND NEW row with `retryCount` 0.
 * Reading this row alone would then call a replay a first attempt, which is the one wrong answer that
 * ends in a second ACCPAYCREDIT.
 *
 * Conservative in the safe direction, and deliberately: a sibling row that never actually sent
 * (cancelled, or refused before the request was built) makes this say "not the first attempt", and
 * the poster then refuses a create the ledger cannot vouch for. That costs an operator a look at
 * Xero. The opposite error costs the ledger a duplicate credit note.
 *
 * FAILS CLOSED. A count that cannot be read is not permission to treat this as a first attempt.
 */
async function isFirstPurchaseCreditNoteAttempt(
  entryId: string,
  referenceType: string,
  referenceId: string,
): Promise<{ ok: true; firstAttempt: boolean } | { ok: false; error: string }> {
  try {
    const row = await db.accountingSyncLog.findUnique({ where: { id: entryId }, select: { retryCount: true } })
    if (!row) {
      return { ok: false, error: `NOTHING WAS SENT. Sync row ${entryId} could not be read back to establish whether a supplier credit-note create has already been dispatched.` }
    }
    if (row.retryCount > 0) return { ok: true, firstAttempt: false }
    const siblings = await db.accountingSyncLog.count({
      where: {
        connector: XERO_CONNECTOR,
        type: 'PURCHASE_CREDIT_NOTE',
        referenceType,
        referenceId,
        id: { not: entryId },
      },
    })
    return { ok: true, firstAttempt: siblings === 0 }
  } catch (error) {
    return {
      ok: false,
      error:
        `NOTHING WAS SENT. IMS could not establish whether a create has already been dispatched for this supplier `
        + `credit note: ${String(error)}. Creating without that answer risks a second ACCPAYCREDIT.`,
    }
  }
}

/**
 * o3d-19gy / o3d-s36z / o3d-gfh: every remote call this entry makes is attributed to this entry's row.
 *
 * WHERE THE PERMISSION IS ACTUALLY GRANTED. Not here. This establishes the INTENT — which row is being
 * posted — and the verdict is reached inside `performRequest`, against the tenant id that will be
 * written into the outgoing `Xero-Tenant-Id` header, immediately before the request leaves. The earlier
 * revision decided it here, from its own read of the `AccountingToken` row, and the request then made a
 * second, independent selection of the tenant when it built its headers; a permission taken at T1 and
 * spent at T2 is not a permission, and that gap is what Codex r1 finding 3 names.
 *
 * The wrap covers the whole entry rather than just its write, because a handler's contact and item
 * lookups CACHE ids from the responses they get: reading organisation C's chart of accounts on behalf of
 * a row raised against B is the same error one step earlier.
 */
async function processEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  /**
   * o3d-dzip: the row's DURABLE origin record — the `connectionProvenance` column and retention's
   * `backReferenceEvidenceCompactedAt` — read in the same statement as `payload`. It travels to the
   * intent, and from there to the verdict taken at the socket, so a retention-compacted row is still
   * checked against the organisation it was raised for instead of refusing as unrecorded, while a row
   * whose payload was merely REWRITTEN is not silently authorised by the column (Codex r1 finding 1).
   */
  origin: { connectionProvenance: string | null; backReferenceEvidenceCompactedAt: Date | null },
  // The LEASE, not a claim timestamp (o3d-xl63 r5 #1). Every remote mutation below fences on it, and
  // the caller reads `lease.heldFrom()` afterwards to anchor the persist to the claim actually held.
  lease: RemoteWriteLease,
  /** o3d-e2mz: the attempt this claim minted — the cancelled-order retirement below fences on it. */
  attempt: AttemptRef,
): Promise<EntryResult> {
  return withAccountingPostingIntent(
    { connector: XERO_CONNECTOR, payload, ...origin, type, referenceType, referenceId },
    () => processClaimedEntry(entryId, type, referenceType, referenceId, payload, lease, attempt),
  )
}

async function processClaimedEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  // THE LEASE (o3d-xl63 r5 #1). Development split this function out of `processEntry` for the
  // posting-intent wrapper (o3d-19gy / o3d-s36z) and gave it a `HeldClaim`; this branch needs more
  // than the holder here, because every remote mutation below calls `lease.fenceBeforeRemoteWrite`
  // to re-take the claim immediately before it sends. `RemoteWriteLease` satisfies `HeldClaim`
  // structurally, so everything downstream that only wants the holder still takes it unchanged.
  lease: RemoteWriteLease,
  attempt: AttemptRef,
): Promise<EntryResult> {
  const postingMode = payload._postingMode

  // THE CONNECTION CHECK USED TO BE HERE, and removing it is the fix rather than a regression.
  //
  // It compared the row's origin stamp against a tenant read from the `AccountingToken` row; the
  // request then resolved the tenant AGAIN, from `getAccessToken()`, when it built its headers. Two
  // independent selections of one thing, and the gap between them is measured in whatever the handler
  // does plus, on a rate-limited entry, tens of seconds asleep on a Retry-After. Keeping it as a
  // "harmless early no" was tempting and is the same mistake one notch quieter: it would still be a
  // second reading of a value that can disagree with the one the request uses, and a refusal produced
  // from a stale read is as wrong as a permission produced from one. `small2`: A PERMISSION IS
  // EVALUATED IN EXACTLY ONE PLACE, IMMEDIATELY BEFORE THE ACT IT AUTHORISES.
  //
  // It is now evaluated in `performRequest`, against the `auth.tenantId` that is going into this
  // request's own `Xero-Tenant-Id` header, and it reaches the row the same way it always did — as the
  // response's `error`, which each arm returns as an ordinary entry failure, so a queue holding one
  // previous-tenant row still does not stop the rows behind it.

  // A MISSING SCOPE IS A CONFIGURATION FAULT, NOT AN API ERROR (o3d-g2i). Adding a scope to the
  // authorization URL only affects future consents, so a connection made before it keeps 401ing
  // AuthorizationUnsuccessful on exactly the calls that scope covers — while every other sync looks
  // healthy. That is how payment registration shipped broken: invoices and bills posted, were marked
  // paid locally, and were never settled in Xero. Refusing here means the row fails with something an
  // operator can act on ("reconnect to grant accounting.payments") rather than a bare 401 that could be
  // any of a dozen causes, and it means nothing is SENT on a call we know cannot succeed.
  //
  // Fails OPEN when the grant was never recorded — see getGrantedScopes.
  const blockingScope = blockingScopeFor(type, await getGrantedScopes())
  if (blockingScope) return { success: false, error: scopeBlockedError(type, blockingScope) }

  switch (type) {
    case 'SALES_INVOICE': {
      // o3d-cyn r3: FIRST, and before any read, let alone any write. A document the importer already
      // computed will not total to its order is refused here rather than posted with a warning
      // attached — see lib/domain/accounting/document-tax-reconciliation.ts.
      const reconciled = refuseUnreconciledDocument(payload)
      if (!reconciled.post) return { success: false, error: reconciled.reason }
      const guard = await guardCancelledSalesOrderInvoice(attempt, referenceType, referenceId, lease)
      if (!guard.post) return guard.result
      const customerId = guard.customerId
      // o3d-k26m.5: the number must be ours to post under. Refusing is recoverable; overwriting a
      // live invoice is not. Runs AFTER the cancelled-order backstop (no point asking the ledger
      // about an order that must not be invoiced at all) and BEFORE anything is sent.
      // THE LEASE, not a snapshot: it satisfies `HeldClaim` structurally, so the slot stamp is fenced
      // on the claim as renewed by the fence immediately before the post (o3d-xl63 r5/r6).
      const numberFence = await guardSalesInvoiceNumberOwnership(entryId, referenceType, referenceId, payload, lease)
      if (!numberFence.post) return numberFence.result
      const invoiceIdempotencyKey = buildXeroIdempotencyKey(entryId, 'invoice', payload)
      // r5 #1: the claim is re-taken HERE, after the scope read and the cancelled-order guard, not once at the top of the entry.
      const fence = await lease.fenceBeforeRemoteWrite('sales-invoice')
      if (!fence.ok) return fence.result
      const invoiceResult = await pushSalesInvoice({
        invoiceNumber: payload.invoiceNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; discountAmount?: number }>,
        shippingAmount: payload.shippingAmount as number | undefined,
        shippingDescription: payload.shippingDescription as string | undefined,
        shippingAccountCode: payload.shippingAccountCode as string | undefined,
        shippingTaxType: payload.shippingTaxType as string | undefined,
        discountAmount: payload.discountAmount as number | undefined,
        discountAccountCode: payload.discountAccountCode as string | undefined,
        discountTaxType: payload.discountTaxType as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
        reference: payload.reference as string | undefined,
        // o3d-k26m.5 round 5/6: the number fence's LAST word. Handed in here, scoped around the
        // create by pushSalesInvoice, and evaluated inside the HTTP client on every attempt as the
        // last statement before the socket. Nothing is sent if it refuses.
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: invoiceIdempotencyKey, customerId, beforePost: numberFence.beforePost })
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, externalRevisionAt: invoiceResult.externalRevisionAt, error: invoiceResult.error }
    }

    case 'SALES_INVOICE_UPDATE': {
      // An UPDATE carrying the stamp would overwrite a good document with the bad one, which is the
      // same damage as the create and one step harder to spot.
      const reconciledUpdate = refuseUnreconciledDocument(payload)
      if (!reconciledUpdate.post) return { success: false, error: reconciledUpdate.reason }
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      if (!accountingInvoiceId) {
        return { success: false, error: 'Missing accountingInvoiceId for SALES_INVOICE_UPDATE' }
      }
      // Same cancelled-order backstop as the create: don't modify an external receivable for an order
      // that has since been cancelled (retire the update instead), and fail closed on an unreadable order.
      const guard = await guardCancelledSalesOrderInvoice(attempt, referenceType, referenceId, lease)
      if (!guard.post) return guard.result
      const customerId = guard.customerId
      const invoiceIdempotencyKey = buildXeroIdempotencyKey(entryId, 'invoice-update', payload)
      const fence = await lease.fenceBeforeRemoteWrite('sales-invoice-update')
      if (!fence.ok) return fence.result
      const invoiceResult = await updateSalesInvoice(accountingInvoiceId, {
        invoiceNumber: payload.invoiceNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; discountAmount?: number }>,
        shippingAmount: payload.shippingAmount as number | undefined,
        shippingDescription: payload.shippingDescription as string | undefined,
        shippingAccountCode: payload.shippingAccountCode as string | undefined,
        shippingTaxType: payload.shippingTaxType as string | undefined,
        discountAmount: payload.discountAmount as number | undefined,
        discountAccountCode: payload.discountAccountCode as string | undefined,
        discountTaxType: payload.discountTaxType as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: invoiceIdempotencyKey, customerId })
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, externalRevisionAt: invoiceResult.externalRevisionAt, error: invoiceResult.error }
    }

    case 'PURCHASE_INVOICE': {
      const supplier = referenceType === 'PurchaseOrder'
        ? await db.purchaseOrder.findUnique({
            where: { id: referenceId },
            select: { supplierId: true, supplier: { select: { email: true } } },
          }).catch(() => null)
        : null
      const billIdempotencyKey = buildXeroIdempotencyKey(entryId, 'bill', payload)
      const fence = await lease.fenceBeforeRemoteWrite('purchase-bill')
      if (!fence.ok) return fence.result
      const billResult = await pushPurchaseBill({
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: billIdempotencyKey, supplierId: supplier?.supplierId, supplierEmail: supplier?.supplier.email ?? undefined })
      return { success: billResult.success, externalId: billResult.invoiceId, externalRevisionAt: billResult.externalRevisionAt, error: billResult.error }
    }

    case 'PURCHASE_INVOICE_UPDATE': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      if (!accountingInvoiceId) {
        return { success: false, error: 'Missing accountingInvoiceId for PURCHASE_INVOICE_UPDATE' }
      }
      const supplier = referenceType === 'PurchaseOrder'
        ? await db.purchaseOrder.findUnique({
            where: { id: referenceId },
            select: { supplierId: true, supplier: { select: { email: true } } },
          }).catch(() => null)
        : null
      const billIdempotencyKey = buildXeroIdempotencyKey(entryId, 'bill-update', payload)
      const fence = await lease.fenceBeforeRemoteWrite('purchase-bill-update')
      if (!fence.ok) return fence.result
      const billResult = await updatePurchaseBill(accountingInvoiceId, {
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: billIdempotencyKey, supplierId: supplier?.supplierId, supplierEmail: supplier?.supplier.email ?? undefined })
      return { success: billResult.success, externalId: billResult.invoiceId, externalRevisionAt: billResult.externalRevisionAt, error: billResult.error }
    }

    case 'INVOICE_PAYMENT': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for INVOICE_PAYMENT' }
      }
      // o3d-0m56 round 6, finding 1: the date is not computed here. The probe that decides whether
      // this document is already settled has to look for the settlement THIS call will create, and
      // the only way that can never drift is for both to ask one function. See moneyPostDate.
      const posting = moneyPostDateToSend(type, payload, new Date())
      if (!posting.ok) return { success: false, error: `Cannot date this INVOICE_PAYMENT: ${posting.reason}` }
      const paymentDate = posting.date
      // OVER-SETTLEMENT IS REFUSED HERE, NOT AT THE ENQUEUE (o3d-cjt8 round 2).
      //
      // The under-lock capacity re-check in registerInvoicePaymentWithLedger only ever covered the
      // enqueue paths someone remembered to list, and that list was already wrong: the imported-order
      // follow-up (`_registerPayment`, enqueueSalesInvoiceFollowUps below) enqueues a payment with no
      // order lock and no arithmetic at all. Rather than add the check to a third call site — the same
      // assumption that has now failed once — it goes where nothing can route around it. Every
      // INVOICE_PAYMENT, whatever enqueued it, must come through this case to reach Xero.
      //
      // Fails CLOSED on anything it cannot measure, and on a genuine refusal retires the row as
      // CANCELLED — accurate, because this runs BEFORE the remote call, so nothing was sent.
      const capacity = await guardInvoicePaymentCapacity(db, {
        connector: XERO_CONNECTOR,
        entryId,
        referenceType,
        referenceId,
        accountingInvoiceId,
        amount,
      })
      if (!capacity.post) {
        if (capacity.kind === 'unmeasurable') return { success: false, error: capacity.message }
        // The LEASE, which is the claim: `heldClaimWhere` reads the instant it holds as the statement
        // is built, so a renewal between the guard and this write cannot make the retirement a no-op.
        const retired = await db.$transaction((tx) => retireOverSettlingInvoicePayment(tx, {
          entryId,
          claim: lease,
          reason: capacity.message,
        }))
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: referenceId,
          // The two refusals need an operator to do DIFFERENT things — reconcile an over-settlement,
          // versus find out whether a failed attempt actually posted — so they are not filed under one
          // action name that would make the second read as the first.
          // o3d-anu8 adds a third: a SYNCED registration an OPERATOR asserted. It is filed with the
          // unknown-ledger-state action rather than the over-settlement one, because what the
          // operator must do is the same — go and find out what the ledger actually holds — and
          // filing it as an over-settlement would tell them a figure IMS is in no position to state.
          action: capacity.refusal === 'AMBIGUOUS_FAILED_REGISTRATION' || capacity.refusal === 'ASSERTED_REGISTRATION'
            ? 'invoice_payment_refused_unknown_ledger_state'
            : 'invoice_payment_refused_over_settlement',
          tag: 'accounting',
          level: 'ERROR',
          description: capacity.message,
          metadata: {
            syncLogId: entryId,
            accountingInvoiceId,
            amount,
            refusal: capacity.refusal,
            alreadyPosted: capacity.alreadyPosted,
            ledgerTotal: capacity.ledgerTotal,
            ambiguousSyncLogIds: capacity.ambiguousIds,
            retired,
          },
        }).catch(() => { /* logging must never turn a safe refusal into a failure */ })
        // Nothing was sent and nothing should be retried: report it as handled, not as a failure that
        // burns retries and ends FAILED (which would then read as "may have posted").
        return { success: true, skipped: true }
      }
      const account = await db.accountingAccount.findFirst({
        where: { connector: XERO_CONNECTOR, OR: [{ externalAccountId: bankAccountId }, { code: bankAccountId }] },
        select: { externalAccountId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      // o3d-0m56: the LAST check before money moves, AND the lock the post is made under. This
      // entry may have posted before — a committed call whose response was lost is FAILED, and
      // the row returns to PENDING for several more attempts. Everything that happens earlier
      // (the retry guard, the revival guard) is operator feedback; this is the reading the POST
      // itself depends on. Round 4: the read and the post are inside one per-document lock, so a
      // competing row cannot slip its own post between them — the post is the callback for
      // exactly that reason.
      return postMoneyUnderLedgerFence({
        connector: XERO_CONNECTOR, entryId, type, referenceType, referenceId, payload, db,
        // The date this post is SENDING, carried rather than re-resolved (round 7, Codex HIGH #1):
        // the fence must authorise against the very day the call below creates, and a second
        // wall-clock read here is a second day whenever the two straddle a UTC midnight.
        postingDate: paymentDate,
      }, async () => {
        try {
          // BOTH FENCES, AND THE CLAIM FENCE IS LAST (o3d-0m56 + o3d-550x/o3d-xl63).
          //
          // The enclosing `postMoneyUnderLedgerFence` answers "has this settlement already reached the
          // ledger?" — a network read, taken under the per-document lock the post is made inside.
          // `lease.fenceBeforeRemoteWrite` answers "do I still hold the claim on this row?" — a local
          // compare-and-set, and it must be the LAST statement before the wire call, because the
          // structural test in xero-claim-before-remote-write asserts nothing awaitable sits between
          // proving the claim and using it. So it goes HERE, inside the ledger fence's callback,
          // rather than outside it: putting it before the ledger read would leave the read itself
          // between the proof and the post, which is precisely what the fence is measured against.
          const fence = await lease.fenceBeforeRemoteWrite('invoice-payment')
          if (!fence.ok) return fence.result
          const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
            Invoice: { InvoiceID: accountingInvoiceId },
            Account: { AccountID: account.externalAccountId },
            Date: paymentDate,
            Amount: amount,
            // o3d-0m56: IMS's own mark, so a later attempt can recognise THIS payment even if its
            // amount or date has since been corrected in Xero. Derived from the same token the
            // Idempotency-Key is built from, so every attempt of this settlement carries one mark.
            Reference: settlementMarkerFor(followUpIdempotencySource(entryId, payload)),
          }, { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'invoice-payment') })
          if (!paymentRes.ok) {
            return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
          }
          const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
          return { success: true, externalId: paymentId }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      })
    }

    case 'BILL_ATTACHMENT': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const supplierInvoicePath = payload.supplierInvoicePath as string | undefined
      if (!accountingInvoiceId || !supplierInvoicePath) {
        return { success: false, error: 'Missing accountingInvoiceId or supplierInvoicePath for BILL_ATTACHMENT' }
      }
      const attachEnabled = await db.setting.findUnique({ where: { key: 'xero_sync_attach_pdf' } })
      if (attachEnabled?.value === 'false') {
        return { success: true }
      }
      try {
        const relPath = supplierInvoicePath.replace(/^\/+/, '')
        const pdfPath = resolveStoredInvoiceUploadPath(relPath)
        if (!pdfPath) {
          return { success: false, error: 'Invalid supplier invoice PDF path' }
        }
        const pdfBuffer = await readFile(pdfPath)
        const filename = relPath.split('/').pop() ?? 'supplier-invoice.pdf'
        // The PDF read above can be slow on a cold disk; fence after it, immediately before the upload.
        const fence = await lease.fenceBeforeRemoteWrite('bill-attachment')
        if (!fence.ok) return fence.result
        const uploadRes = await xeroUploadAttachment('Invoices', accountingInvoiceId, filename, pdfBuffer, 'application/pdf')
        if (!uploadRes.ok) {
          return { success: false, error: uploadRes.error ?? 'Failed to attach supplier invoice PDF' }
        }
        return { success: true }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'INVOICE_PDF': {
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const orderId = payload.referenceId as string | undefined
      if (!accountingInvoiceId || !orderId) {
        return { success: false, error: 'Missing accountingInvoiceId or referenceId for INVOICE_PDF' }
      }
      // NO FENCE, deliberately (o3d-xl63 r5 #1). This branch makes no remote mutation: it GETs the
      // PDF Xero already holds and writes the file path locally. Two workers doing it concurrently
      // produce the same path from the same document — there is no second document to create, so a
      // fence here would renew a claim to protect nothing.
      try {
        const { downloadXeroInvoicePdf, saveInvoicePdf } = await import('./invoice-pdf')
        const pdfBuffer = await downloadXeroInvoicePdf(accountingInvoiceId)
        if (!pdfBuffer) return { success: false, error: 'Failed to download Xero invoice PDF' }
        const pdfPath = await saveInvoicePdf(orderId, pdfBuffer)
        await db.salesOrder.update({
          where: { id: orderId },
          data: { invoicePdfPath: pdfPath },
        })
        return { success: true }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'INVOICE_EMAIL': {
      const orderId = payload.referenceId as string | undefined
      if (!orderId) return { success: false, error: 'Missing referenceId for INVOICE_EMAIL' }
      const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
      // Not a Xero call, but an external side effect all the same: a second worker here means the customer receives the invoice twice.
      const fence = await lease.fenceBeforeRemoteWrite('invoice-email')
      if (!fence.ok) return fence.result
      const emailResult = await sendAccountingInvoiceEmailInternal(orderId)
      return emailResult.success ? { success: true } : { success: false, error: emailResult.error ?? 'Failed to email invoice' }
    }

    case 'WC_INVOICE_NOTE': {
      const orderId = payload.referenceId as string | undefined
      if (!orderId) return { success: false, error: 'Missing referenceId for WC_INVOICE_NOTE' }
      const { pushInvoiceNoteToWc } = await import('@/lib/connectors/woocommerce/sync/invoice-note')
      const fence = await lease.fenceBeforeRemoteWrite('wc-invoice-note')
      if (!fence.ok) return fence.result
      const wcResult = await pushInvoiceNoteToWc(orderId)
      return wcResult.success ? { success: true } : { success: false, error: wcResult.error ?? 'Failed to notify WooCommerce about invoice' }
    }

    case 'BILL_PAYMENT': {
      // Register a payment in Xero against an existing bill (purchase
      // invoice). The bill must already have an accountingInvoiceId set.
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for BILL_PAYMENT' }
      }
      // o3d-0m56 round 6, finding 1: the date is not computed here. The probe that decides whether
      // this document is already settled has to look for the settlement THIS call will create, and
      // the only way that can never drift is for both to ask one function. See moneyPostDate.
      const posting = moneyPostDateToSend(type, payload, new Date())
      if (!posting.ok) return { success: false, error: `Cannot date this BILL_PAYMENT: ${posting.reason}` }
      const paymentDate = posting.date
      // Resolve bank account — accept either Xero AccountID (preferred) or a legacy account code.
      const account = await db.accountingAccount.findFirst({
        where: { connector: XERO_CONNECTOR, OR: [{ externalAccountId: bankAccountId }, { code: bankAccountId }] },
        select: { externalAccountId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      // o3d-0m56: the LAST check before money moves, AND the lock the post is made under. This
      // entry may have posted before — a committed call whose response was lost is FAILED, and
      // the row returns to PENDING for several more attempts. Everything that happens earlier
      // (the retry guard, the revival guard) is operator feedback; this is the reading the POST
      // itself depends on. Round 4: the read and the post are inside one per-document lock, so a
      // competing row cannot slip its own post between them — the post is the callback for
      // exactly that reason.
      return postMoneyUnderLedgerFence({
        connector: XERO_CONNECTOR, entryId, type, referenceType, referenceId, payload, db,
        // The date this post is SENDING, carried rather than re-resolved (round 7, Codex HIGH #1):
        // the fence must authorise against the very day the call below creates, and a second
        // wall-clock read here is a second day whenever the two straddle a UTC midnight.
        postingDate: paymentDate,
      }, async () => {
        try {
          // BOTH FENCES, AND THE CLAIM FENCE IS LAST (o3d-0m56 + o3d-550x/o3d-xl63).
          //
          // The enclosing `postMoneyUnderLedgerFence` answers "has this settlement already reached the
          // ledger?" — a network read, taken under the per-document lock the post is made inside.
          // `lease.fenceBeforeRemoteWrite` answers "do I still hold the claim on this row?" — a local
          // compare-and-set, and it must be the LAST statement before the wire call, because the
          // structural test in xero-claim-before-remote-write asserts nothing awaitable sits between
          // proving the claim and using it. So it goes HERE, inside the ledger fence's callback,
          // rather than outside it: putting it before the ledger read would leave the read itself
          // between the proof and the post, which is precisely what the fence is measured against.
          const fence = await lease.fenceBeforeRemoteWrite('bill-payment')
          if (!fence.ok) return fence.result
          const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
            Invoice: { InvoiceID: accountingInvoiceId },
            Account: { AccountID: account.externalAccountId },
            Date: paymentDate,
            Amount: amount,
            // The operator's reference is KEPT and the mark appended, never replaced: it is what they
            // will look for on the bank reconciliation. See INVOICE_PAYMENT above for the mark.
            Reference: [payload.reference as string | undefined, settlementMarkerFor(followUpIdempotencySource(entryId, payload))]
              .filter(Boolean).join(' '),
          }, { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'bill-payment') })
          if (!paymentRes.ok) {
            return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
          }
          const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
          return { success: true, externalId: paymentId }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      })
    }

    case 'CREDIT_NOTE': {
      const creditCustomerId = referenceType === 'SalesOrderRefund'
        ? (await db.salesOrderRefund.findUnique({
            where: { id: referenceId },
            select: { order: { select: { customerId: true } } },
          }).catch(() => null))?.order.customerId ?? undefined
        : undefined
      const fence = await lease.fenceBeforeRemoteWrite('credit-note')
      if (!fence.ok) return fence.result
      return pushCreditNote({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: buildXeroIdempotencyKey(entryId, 'credit-note'), customerId: creditCustomerId }).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))
    }

    case 'PURCHASE_CREDIT_NOTE': {
      // audit-g5u2: supplier credit note (ACCPAYCREDIT) — e.g. crediting a
      // duplicate freight bill. The payload carries the supplier contact + the
      // expense-account lines (built by recordSupplierFreightCreditNote, g5u2.3).
      //
      // o3d-tfri r3: and the poster must be told whether IMS has EVER dispatched a create for this
      // credit note, because that is the only thing that turns "the ledger shows nothing" into
      // permission to create one. Fails closed — a count we cannot read is not a first attempt.
      const attempt = await isFirstPurchaseCreditNoteAttempt(entryId, referenceType, referenceId)
      if (!attempt.ok) return { success: false, error: attempt.error }
      // o3d-xl63 r5 #1: the fence goes AFTER that read, not before it. The read is awaited, and the whole
      // point of the fence is that NOTHING AWAITABLE happens between proving the claim and using it — a
      // claim proven before an await has had that await to lapse in. Both rules survive in this order:
      // the first-attempt question is still answered before we decide to create, and the claim is still
      // the last thing established before the socket.
      const fence = await lease.fenceBeforeRemoteWrite('purchase-credit-note')
      if (!fence.ok) return fence.result
      return pushPurchaseCreditNote({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
      }, resolveInvoiceStatus(postingMode), {
        firstAttempt: attempt.firstAttempt,
        // o3d-tfri r4: the row's own identity, so the poster can PROVE the number is one IMS minted
        // rather than one that merely starts with the prefix. Without it the replay fence would be
        // asking the ledger about a number that need not be ours.
        creditNote: { referenceType, referenceId },
        idempotencyKey: buildXeroIdempotencyKey(entryId, 'purchase-credit-note'),
        supplierId: payload.supplierId as string | undefined,
      }).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))
    }

    case 'PURCHASE_CREDIT_NOTE_ALLOCATION': {
      // audit-v08m: follow-up that applies a posted ACCPAYCREDIT to the freight
      // bill it offsets, so the bill stops showing as outstanding in Xero's AP
      // aging. Enqueued by enqueuePurchaseCreditNoteFollowUps once the credit note
      // itself has posted (and only when the bill already has an external id).
      const creditNoteId = payload.creditNoteId as string | undefined
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const amount = payload.amount as number | undefined
      if (!creditNoteId || !accountingInvoiceId || amount == null) {
        return { success: false, error: 'Missing creditNoteId, accountingInvoiceId, or amount for PURCHASE_CREDIT_NOTE_ALLOCATION' }
      }
      // o3d-0m56 round 6, finding 1: an allocation dates itself from `date`, NOT `paymentDate` —
      // the difference between this branch and the two payment branches above is exactly what a
      // single shared "mirror" of both got wrong. moneyPostDateToSend knows which is which.
      const posting = moneyPostDateToSend(type, payload, new Date())
      if (!posting.ok) return { success: false, error: `Cannot date this allocation: ${posting.reason}` }
      const allocationDate = posting.date
      // o3d-0m56: the LAST check before money moves, AND the lock the post is made under. This
      // entry may have posted before — a committed call whose response was lost is FAILED, and
      // the row returns to PENDING for several more attempts. Everything that happens earlier
      // (the retry guard, the revival guard) is operator feedback; this is the reading the POST
      // itself depends on. Round 4: the read and the post are inside one per-document lock, so a
      // competing row cannot slip its own post between them — the post is the callback for
      // exactly that reason.
      return postMoneyUnderLedgerFence({
        connector: XERO_CONNECTOR, entryId, type, referenceType, referenceId, payload, db,
        // The date this post is SENDING, carried rather than re-resolved (round 7, Codex HIGH #1):
        // the fence must authorise against the very day the call below creates, and a second
        // wall-clock read here is a second day whenever the two straddle a UTC midnight.
        postingDate: allocationDate,
      }, async () => {
        // BOTH FENCES, CLAIM FENCE LAST — see the INVOICE_PAYMENT case for why it sits inside this
        // callback rather than outside it. Two reads and a write happen inside
        // `allocatePurchaseCreditNote` (the shape the review named), so the claim proof must be the
        // statement immediately before the call.
        const fence = await lease.fenceBeforeRemoteWrite('purchase-credit-note-allocation')
        if (!fence.ok) return fence.result
        const result = await allocatePurchaseCreditNote(
          { creditNoteId, invoiceId: accountingInvoiceId, amount, date: allocationDate },
          { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'purchase-credit-note-allocation') },
        )
        // No externalId to back-reference — the allocation is a sub-resource of the
        // credit note, not a standalone document.
        return { success: result.success, error: result.error }
      })
    }

    case 'COGS_JOURNAL':
    case 'INVENTORY_ADJUSTMENT':
    case 'STOCK_IN_TRANSIT':
    case 'STOCK_RECEIPT':
    case 'COGS_REVERSAL':
    case 'STOCK_ALLOCATION':
    case 'DAILY_BATCH_REVENUE_DEFERRAL':
    case 'DAILY_BATCH_INVENTORY_ALLOC':
    case 'DAILY_BATCH_GROUP_B':
    case 'DAILY_BATCH_INVENTORY_RECONCILIATION':
    case 'DAILY_BATCH_COGS_RECONCILIATION':
    case 'DAILY_BATCH_TRANSIT_RECONCILIATION':
    case 'UNEARNED_REV_REVERSAL':
    // o3d-0i5y r9: the orphaned-allocation reversal. A plain manual journal like every other type
    // in this group — the amount is decided (and evidenced) at staging time, not here.
    case 'ALLOCATION_REVERSAL':
    case 'REALISED_FX_JOURNAL':
    case 'UNREALISED_FX_JOURNAL':
    case 'MANUFACTURING_JOURNAL':
    case 'MANUFACTURING_RECLASS': {
      const idempotencySource = typeof payload._idempotencyKey === 'string'
        ? payload._idempotencyKey
        : type.startsWith('DAILY_BATCH_')
        ? `${type}:${referenceId}`
        : entryId
      const journalIdempotencyKey = buildXeroIdempotencyKey(idempotencySource, 'manual-journal')
      // EVERY GATE THAT CAN REFUSE THIS JOURNAL, ABOVE EVERYTHING THAT RECORDS ANYTHING (o3d-jit6 r2,
      // Codex finding 1).
      //
      // `pushManualJournal` used to build and CHECK the request body itself — a journal with no
      // non-zero lines, or one whose debits and credits do not agree, returns from it without calling
      // Xero. Those returns happened BELOW the fence, so the marker was minted and nothing left the
      // process: the exact shape r1 finding 2 closed for the fence's own refusals, arriving through
      // the payload instead of through the claim. The next legitimate attempt then met a dispatch that
      // never happened.
      //
      // `prepareManualJournal` is that check, extracted whole. It is PURE and SYNCHRONOUS — no clock,
      // no database, no network — so hoisting it costs the adjacency rule nothing: it adds no await
      // anywhere, least of all between proving the claim and using it. What is left below the fence
      // (`postPreparedManualJournal`) has no refusal of its own; it hands an already-checked body to
      // the transport.
      //
      // WHAT IS STILL BELOW THE MINT, SAID PLAINLY: the TRANSPORT's own pre-egress stops — an
      // unresolvable connection, `accountingPostingIntentRefusal`, the egress authorisations, the
      // rate-limit budget. They are not hoistable and must not be pre-evaluated here. Each is
      // evaluated once, immediately before the socket, against the very `auth` the request is built
      // from (see accounting-egress-authorization.ts): an authorisation may read AND WRITE the
      // database and one of them takes an exclusive slot, so asking twice is not free, and o3d-batch-
      // realm deleted precisely such a pre-check on the ground that a refusal produced from a stale
      // read is as wrong as a permission produced from one.
      //
      // r3 (Codex HIGH, round 3 of this finding) — AND MINTING INSIDE THE TRANSPORT IS NOT THE ANSWER
      // EITHER, WHICH IS WHY THE MARKER IS STILL MINTED HERE. Moving the mint to the statement before
      // `connectorFetch` was the obvious repair and it fails on three counts. (1) THE CLAIM PROOF
      // COULD NO LONGER BE ADJACENT: between this fence and that statement lie `waitForBudget`, which
      // SLEEPS up to a minute, and an awaited egress authorisation — so the claim would be proven up
      // to a minute before it was used, which is exactly the o3d-xl63 r5 #1 defect a structural test
      // already forbids. Carrying the lease into the transport instead would put sync-row claim
      // fencing inside the shared HTTP client that every Xero GET, PDF download, attachment upload
      // and tax-rate read goes through. (2) THE RETRY LOOP has no single "the" attempt to mint on.
      // (3) IT WOULD NOT EVEN BE TRUE: `noteRequest` runs before `connectorFetch`, and a connection
      // that is refused, times out or fails TLS sent nothing either — so the mint would still
      // sometimes stand over a create nobody made. There is no point at which "minted" implies "sent";
      // minting before the wire is a deliberate over-claim, and narrowing it is not closing it.
      //
      // SO THE MARKER STANDS AFTER A TRANSPORT REFUSAL, AND WHAT CHANGES IS THAT THE ATTEMPT SAYS SO.
      // `postPreparedManualJournal` reports `reachedTheWire`, measured from the transport's own
      // monotonic attempt counter rather than from a status code or an error string, and an attempt
      // that provably sent nothing is returned as `notPosted` — handed back intact, no retry spent,
      // no FAILED status, and a named WARNING activity row carrying this sync log's id. The refusal a
      // later attempt makes then names BOTH producers of the state instead of asserting the
      // commit-failure story, and points at that activity row (see
      // CREATE_DISPATCH_UNSETTLED_MEANING). CLEARING the marker on that evidence would need a durable
      // column of its own — the trigger deliberately forbids clearing the pair, and rightly so, since
      // this marker is a PROHIBITION and one that tampering clears hands the tamperer what they
      // wanted. That column is o3d-gvzu and is a separate change, not a comment.
      const prepared = prepareManualJournal({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }, resolveJournalStatus(postingMode))
      if (!prepared.ok) return { success: false, error: prepared.error }
      // o3d-jit6: THE DURABLE RECORD THAT A CREATE IS ABOUT TO LEAVE, committed before it does.
      //
      // A manual journal is the one create with nothing else standing behind it: `POST /ManualJournals`
      // deduplicates on no key we own, so if the transaction that settles this row with the returned
      // id fails at COMMIT, the document is real, its id is gone, and the ordinary retry posts a
      // SECOND journal into the accounts. So the dispatch is recorded first — so the retry can tell —
      // and REFUSED rather than guessed at once Xero's six-minute idempotency window has closed.
      //
      // THREE STEPS, AND THE ORDER IS THE WHOLE OF Codex r1 FINDING 2 AND r2 FINDING 1. The journal is
      // VALIDATED above, before anything is read or written. `planCreateDispatch` only READS:
      // it answers "may this create go out at all", refuses here if not, and writes nothing whichever
      // way it answers. It is awaited BEFORE the fence for the same reason
      // `isFirstPurchaseCreditNoteAttempt` is (o3d-xl63 r5 #1) — nothing awaitable may sit between
      // proving the claim and using it.
      //
      // The RECORD is then minted by the fence itself, inside the very statement that re-proves the
      // claim. That is what stops the marker being written on a path that sends nothing: an expired
      // lease or a lost claim returns from `fenceBeforeRemoteWrite` having written neither the claim
      // renewal nor the dispatch, so a later legitimate attempt does not meet a dispatch that never
      // happened. The key is passed exactly as it will be sent, so the replay arm compares what was
      // sent against what is about to be sent rather than two derivations of it.
      const dispatch = await planCreateDispatch(db, {
        entryId,
        type,
        idempotencyKey: journalIdempotencyKey,
        label: `${type} for ${referenceType} ${referenceId}`,
      })
      if (!dispatch.dispatch) return { success: false, error: dispatch.error }
      const fence = await lease.fenceBeforeRemoteWrite('manual-journal', dispatch.mint ?? undefined)
      if (!fence.ok) return fence.result
      const posted = await postPreparedManualJournal(prepared.prepared, { idempotencyKey: journalIdempotencyKey })
      if (!posted.success && !posted.reachedTheWire) {
        // The transport refused after the fence. Nothing left the process, so this is not a failure
        // of the row: failing it spends a retry and drives it to FAILED for a reason that is about
        // the connection, the tenant's posting intent, an egress authorisation or an exhausted rate
        // budget — none of which the row can do anything about. `notPosted` is the channel that
        // already exists for "provably nothing was sent", and it is what writes the durable,
        // named activity row the later refusal tells an operator to look for.
        const message = describeCreateDispatchNotSent({
          label: `${type} for ${referenceType} ${referenceId}`,
          error: posted.error ?? 'the transport gave no reason',
        })
        return {
          success: false,
          error: message,
          notPosted: { reason: 'transport-refused', operation: 'manual-journal', message },
        }
      }
      return { success: posted.success, externalId: posted.journalId, error: posted.error }
    }

    case 'TAX_RATE_SYNC': {
      const { putXeroTaxRate } = await import('./tax-rates')
      const name = payload.name as string | undefined
      const components = payload.components as Array<{ name: string; rate: number; compoundOnPrevious: boolean; accountingTaxType?: string | null }> | undefined
      if (!name || !components || components.length === 0) {
        return { success: false, error: 'TAX_RATE_SYNC payload missing name or components' }
      }
      const idempotencyKey = buildXeroIdempotencyKey(entryId, 'tax-rate', payload)
      const fence = await lease.fenceBeforeRemoteWrite('tax-rate')
      if (!fence.ok) return fence.result
      const result = await putXeroTaxRate({
        name,
        reportTaxType: payload.reportTaxType as string | null | undefined,
        components,
        status: (payload.status as 'ACTIVE' | 'ARCHIVED' | undefined) ?? 'ACTIVE',
      }, { idempotencyKey })
      return { success: result.success, externalId: result.taxType, error: result.error }
    }

    default:
      return { success: false, error: `Unknown sync type: ${type}` }
  }
}

async function updateBackReference(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  externalId?: string,
  invoiceNumber?: string,
): Promise<void> {
  if (!externalId) return
  // audit-H3: do NOT swallow failures here. The external id is already persisted
  // on the sync row (externalTransactionId) before this runs, and the caller's
  // catch marks the row for retry so the next pass re-applies the back-reference
  // from the stored id. Swallowing left the document permanently orphaned.
  const applied = await applyBackReference(db, { connector: XERO_CONNECTOR, type, referenceType, referenceId, externalId, invoiceNumber })
  // o3d-9kek: a legacy PurchaseOrder-keyed row that cannot be attributed to one bill is
  // refused rather than written onto the newest unlinked bill. Surface it — silence here
  // is what let a wrong id look like a successful write.
  if (applied.outcome === 'ambiguous') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_backreference_ambiguous',
      tag: 'sync',
      level: 'WARNING',
      description: `Did not write the Xero back-reference for PO ${referenceId}: its bill cannot be identified `
        + `(${applied.attribution.reason}). Link the bill manually — the external id is on the sync row.`,
      metadata: { referenceType, referenceId, externalId, reason: applied.attribution.reason },
    })
  }
  // o3d-9kek finding 3: the resolved bill gained an external id between the resolve and the
  // compare-and-swap, so nothing was written and nothing was overwritten. Not an error — the
  // repair sweep re-resolves it from the state that actually won.
  if (applied.outcome === 'contended') {
    console.warn(`xero: back-reference for PO ${referenceId} lost the race for bill ${applied.purchaseInvoiceId}; the repair sweep will re-resolve it.`)
  }
}

export type { BackReferenceRepairResult }

/**
 * THE LOCKED HALF OF THE SWEEP'S CANCELLED-SALE GATE (o3d-e2mz r8).
 *
 * The GATE — when it is asked, what the three answers mean, what is counted and logged — is in the
 * shared sweep, once. This is only what that gate cannot do from a connector-agnostic module: read the
 * sale UNDER ITS ROW LOCK and, if it is cancelled, retire the row in the SAME transaction.
 *
 * The lock is the one `cancelSalesOrderFulfillmentState` opens with, so a cancellation either commits
 * first and is seen here, or waits behind the decision it would have invalidated.
 *
 * The retirement's precondition IS THE FACT IT PROTECTS — the row names a document and is in the
 * sweep's candidate status set — so it is self-guarding against a row that moved between the candidate
 * read and here: a row no longer in the shape needs no retiring. And a writer that retires a row must
 * advance the fence, or a concurrent run could still win a compare-and-swap on the revision it read;
 * revision 0 stays 0, because bumping it would forge an attempt a later decision could believe in.
 *
 * ONLY `SalesOrder` rows are gated. `referenceId` IS the sales order id for those, so the state is one
 * locked read away. Every other reference resolves to something a sales-order cancellation does not
 * speak for — a supplier bill is not a sale at all, and a refund CREDIT NOTE is very often the direct
 * CONSEQUENCE of the cancellation, so refusing to finish it would strand the document the cancellation
 * created. Crediting a cancelled sale is right; invoicing it is wrong.
 */
async function decideSaleRelease(row: {
  id: string
  referenceType: string
  referenceId: string
  attemptRevision?: number
}): Promise<BackReferenceSweepRelease> {
  if (row.referenceType !== SALE_SCOPED_REFERENCE_TYPE) return { release: 'RELEASE' }
  try {
    return await db.$transaction(async (tx): Promise<BackReferenceSweepRelease> => {
      if (await readSaleCancellationStateUnderLock(tx, row) !== 'CANCELLED') return { release: 'RELEASE' }
      await tx.accountingSyncLog.updateMany({
        where: {
          id: row.id,
          externalTransactionId: { not: null },
          status: { in: [...BACK_REFERENCE_REPAIRABLE_STATUSES] },
        },
        data: {
          status: 'CANCELLED',
          syncedAt: null,
          ...(row.attemptRevision === undefined || row.attemptRevision === UNCLAIMED_ATTEMPT_REVISION
            ? {}
            : { attemptRevision: { increment: 1 } }),
          errorMessage: 'Retired by the Xero back-reference sweep: the row named a document and was in the sweep\'s '
            + 'candidate shape while THE SALE IT BELONGS TO IS CANCELLED. The document id is kept — the order delete '
            + 'guard reads it whatever the status — but the back-reference was NOT written onto the cancelled order '
            + 'and none of its follow-ups (PDF, email, storefront note, PAYMENT) were enqueued.',
        },
      })
      return { release: 'RETIRED' }
    })
  } catch (error) {
    return { release: 'SALE_UNREADABLE', error: String(error) }
  }
}

/**
 * audit-H3 repair sweep, Xero binding. The implementation is connector-agnostic
 * (lib/domain/accounting/back-reference-sweep) — o3d-9kek fixed its starvation and its
 * page-local PO ambiguity check there, once, so a second connector cannot inherit the
 * old shape by copying this one.
 */
export async function repairXeroBackReferences(limit = DEFAULT_BACK_REFERENCE_SWEEP_LIMIT): Promise<BackReferenceRepairResult> {
  return repairAccountingBackReferences({
    db,
    connector: XERO_CONNECTOR,
    connectorLabel: 'Xero',
    activityActionPrefix: 'xero',
    // Resume behind the rows the last run could not settle (r3 finding 4).
    cursorStore: createBackReferenceSweepCursorStore(db, XERO_CONNECTOR),
    // logActivityPersisted, NOT logActivity: the sweep defers an ambiguous row for 24 hours on
    // the strength of having warned about it, and logActivity cannot tell it whether the warning
    // was written (o3d-9kek r2 finding 3).
    logActivity: logActivityPersisted,
    // o3d-e2mz r8: the sweep is the CONSUMER — the only place a cancelled sale's work is actually
    // released — so the gate lives IN the sweep (see `decideSaleRelease` on BackReferenceSweepDeps).
    // What the connector supplies is only the part the connector-agnostic module cannot hold: the
    // locked read and the retirement, in one transaction on the Xero database handle.
    decideSaleRelease,
    // o3d-bqw7 r2: the sweep now hands over the row's COMPLETE durable origin record, not just its
    // payload — a tombstone's payload is `{}` and its `connectionProvenance` column is the only half
    // left speaking, so without it every follow-up the sweep rebuilds is born unable to post.
    enqueueFollowUps: (entryId, type, referenceType, referenceId, payload, syncResult, origin) =>
      enqueueFollowUps(entryId, type, referenceType, referenceId, payload as SyncPayload, syncResult, origin),
  }, { limit })
}

export type CreditNoteAllocationReenqueueResult = {
  /** Posted credit notes whose bill now has an id but had no allocation row. */
  checked: number
  /** Allocation follow-ups enqueued by this sweep. */
  enqueued: number
  /** Candidates that errored while enqueuing. */
  failed: number
}

export type CreditNoteAllocationCandidate = {
  id: string
  accountingCreditNoteId: string | null
  amountForeign: unknown
  purchaseInvoice: { accountingInvoiceId: string | null } | null
}

/**
 * audit-w77e: pure selection — from POSTED credit notes that have both a posted
 * credit and a bill with an external id, keep those that have NO allocation row
 * yet (the never-enqueued gap). Credit notes that already have a row of any
 * status are owned by the normal retry/repair path and are skipped here. Returns
 * the resolved enqueue inputs so the DB-bound caller is a thin loop. Defensive
 * re-check of the ids guards against a candidate row that lost them.
 */
export function selectCreditNotesNeedingAllocation(
  candidates: CreditNoteAllocationCandidate[],
  refIdsWithAllocation: Set<string>,
): Array<{ supplierCreditNoteId: string; creditNoteId: string; accountingInvoiceId: string; amount: number }> {
  const out: Array<{ supplierCreditNoteId: string; creditNoteId: string; accountingInvoiceId: string; amount: number }> = []
  for (const cn of candidates) {
    if (refIdsWithAllocation.has(cn.id)) continue
    const creditNoteId = cn.accountingCreditNoteId
    const accountingInvoiceId = cn.purchaseInvoice?.accountingInvoiceId
    if (!creditNoteId || !accountingInvoiceId) continue
    // Codex review: don't enqueue a useless allocation row for a non-positive /
    // non-finite amount (the allocation would resolve to a no-op anyway).
    const amount = Number(cn.amountForeign)
    if (!Number.isFinite(amount) || amount <= 0) continue
    out.push({ supplierCreditNoteId: cn.id, creditNoteId, accountingInvoiceId, amount })
  }
  return out
}

/** A `PURCHASE_CREDIT_NOTE` sync row, narrowed to the two columns provenance is resolved from. */
export type CreditNotePostRow = {
  /**
   * The document this row's post RETURNED. This — not the row's status, and not its recency — is what
   * makes a row the issuing post of a particular credit note.
   */
  externalTransactionId: string | null
  /** The stored payload, verbatim. What gets inherited, stamp or no stamp. */
  payload: unknown
}

/** What the rows in hand can say about which organisation issued one specific credit note. */
export type IssuingPostOrigin =
  /** One row named this exact document. Its payload travels verbatim — including carrying no stamp. */
  | { outcome: 'inherited'; payload: unknown }
  /** No row in hand names this document id. Nothing observed the post; record nothing. */
  | { outcome: 'no-issuing-row' }
  /** Two rows claim to have posted this document id against DIFFERENT organisations. Record nothing. */
  | { outcome: 'conflicting-origins'; recorded: string[] }

/**
 * WHICH POST ISSUED THIS CREDIT NOTE? (Codex r4 finding 1, HIGH.)
 *
 * Round 3 stopped the sweep minting an origin from "whatever is connected when the cron fires" and made
 * it INHERIT from the post that issued the id it is carrying. The lookup it shipped, though, matched only
 * (connector, type, referenceType, `referenceId`), filtered to SYNCED, and took the NEWEST row — it never
 * looked at `externalTransactionId` at all. A supplier credit note that was posted, voided and posted
 * again has TWO rows under one `referenceId` naming two different documents, and
 * `SupplierCreditNote.accountingCreditNoteId` holds whichever of them the last back-reference write left
 * there. Taking the newest row therefore inherits from a post that issued a DIFFERENT document — an origin
 * the row being created did not come from, which is the same class of defect as inventing one, and would
 * be believed by the post-time guard exactly as readily.
 *
 * So the pair is the identity: a row is the issuing post only if it names the SAME reference AND carries
 * the SAME `externalTransactionId` as the credit id being allocated.
 *
 * AND STATUS IS NOT A PROXY FOR "HAS POSTED". `status: 'SYNCED'` was too narrow in the other direction.
 * This branch already establishes both halves of that: a row that posted successfully and then failed its
 * FOLLOW-UPS is sent back to PENDING or, at MAX_RETRIES, to FAILED, *keeping* the external id
 * (`markSyncLogForFollowUpRetry`); and a row retired to CANCELLED by the orphan sweep keeps it too — which
 * is precisely why `order-delete-guard` matches on "carries an external id, whatever the status". A row
 * that names a document posted that document. The id is the evidence; the status is where the row ended up
 * afterwards. So no status filter is applied here at all.
 *
 * WHEN SEVERAL ROWS NAME THE SAME DOCUMENT. They are all describing the same post of the same document, so
 * the one that RECORDED an organisation is preferred over one that recorded nothing (a retention-compacted
 * `payload: {}`, or a pre-stamping row). That is not choosing the convenient answer: the rows do not
 * disagree, one of them simply says less. If two of them do genuinely disagree — two readable stamps naming
 * DIFFERENT organisations for one document id — nothing here can say which is right, so this reports
 * `conflicting-origins` and the caller records nothing, exactly as it does for no row at all. "I cannot
 * tell" must not resolve to "take the newest", which is the habit this whole finding is about.
 */
export function selectIssuingPostOriginRecord(rows: CreditNotePostRow[], creditNoteId: string): IssuingPostOrigin {
  const wanted = creditNoteId.trim()
  if (wanted === '') return { outcome: 'no-issuing-row' }
  const issuing = rows.filter((row) => (row.externalTransactionId ?? '').trim() === wanted)
  if (issuing.length === 0) return { outcome: 'no-issuing-row' }

  // Distinct organisations actually NAMED by rows that issued this document. More than one is a
  // contradiction no rule here is entitled to settle.
  const named = new Set<string>()
  // Prefer the row that recorded the most about the post: a comparable stamp, then the observed
  // "raised while disconnected", then silence, then an unreadable payload. Every rank below 0 still
  // refuses at post time — the preference only decides which true statement the operator is shown.
  const rank = (payload: unknown): number => {
    const stamp = readAccountingPayloadConnectionStamp(payload)
    if (stamp.state === 'stamped') {
      named.add(stamp.provenance)
      return 0
    }
    return stamp.state === 'raised-disconnected' ? 1 : stamp.state === 'absent' ? 2 : 3
  }
  const ranked = issuing
    .map((row) => ({ payload: row.payload, rank: rank(row.payload) }))
    .sort((a, b) => a.rank - b.rank)
  if (named.size > 1) return { outcome: 'conflicting-origins', recorded: [...named].sort() }
  return { outcome: 'inherited', payload: ranked[0].payload }
}

/** Which of the ways an origin can be unavailable this row hit — one clause, so the log names the case. */
function describeMissingCreditNoteOrigin(
  origin: IssuingPostOrigin,
  inherited: AccountingConnectionStamp | null,
  creditNoteId: string,
): string {
  if (origin.outcome === 'no-issuing-row') {
    return `no surviving sync row records a post of credit note ${creditNoteId} (retention removed it, or the `
      + 'credit was posted before this instance recorded which organisation it was posting to)'
  }
  if (origin.outcome === 'conflicting-origins') {
    return `two sync rows both claim to have posted credit note ${creditNoteId}, against DIFFERENT accounting `
      + `organisations (${origin.recorded.join(' and ')}), and nothing here can say which of them issued it`
  }
  if (inherited?.state === 'raised-disconnected') {
    return `the sync row that posted credit note ${creditNoteId} records that it was raised while this instance `
      + 'had no accounting connection at all, so nothing vouches for the id even there'
  }
  if (inherited?.state === 'unreadable') {
    return `the sync row that posted credit note ${creditNoteId} has an origin record that cannot be read `
      + `(${inherited.detail})`
  }
  return `the sync row that posted credit note ${creditNoteId} survives but records no organisation itself — it `
    + 'was queued before origins were recorded, or retention compacted its payload away'
}

/**
 * WHAT AN OPERATOR ACTUALLY DOES WITH A ROW WHOSE ORIGIN CANNOT BE ESTABLISHED (Codex r4 finding 2).
 *
 * The previous text ended "re-queue the allocation from the credit note itself if it is still owed", which
 * is not a remedy an operator can perform: re-queueing rebuilds the identical payload out of the identical
 * two local columns, so it refuses identically — and this sweep skips any credit note that already has an
 * allocation row of any status, so it would not even be re-created. A refusal that names a step which
 * cannot work is worse than one that names none, because the operator spends the attempt before finding
 * out. So the remedy named here is the one that exists: do the allocation where the documents are, in the
 * ledger, by the one party who can see which organisation they live in.
 */
function creditNoteAllocationOriginRemedy(item: { creditNoteId: string; accountingInvoiceId: string }): string {
  return 'WHAT TO DO: allocate it in the accounting system by hand — open credit note '
    + `${item.creditNoteId} in the organisation that issued it and apply it to bill ${item.accountingInvoiceId}. `
    + 'That is exactly the effect this row would have had, decided by someone who can see which organisation '
    + 'the two documents live in, which nothing in this instance can. Do NOT retry or re-queue the row: it '
    + 'rebuilds the same payload from the same two local columns (SupplierCreditNote.accountingCreditNoteId '
    + 'and PurchaseInvoice.accountingInvoiceId), which is exactly the evidence that is missing — and the '
    + 'origin must not be back-filled, because writing a marker for a post nobody witnessed is the defect '
    + 'this guard exists to stop. (The refusal on the sync row itself says "cancel and re-queue from the '
    + 'source document". For an allocation that is not a remedy, for the reason just given.) The row is '
    + 'inert meanwhile: it sends nothing, and once its retries are spent it sits FAILED in the sync log '
    + 'carrying the refusal, as a record rather than as outstanding work. Nothing else depends on it, and no '
    + 'second one will be created.'
}

/**
 * audit-w77e: backstop for the audit-v08m gap. postSupplierCreditNote only
 * enqueues the PURCHASE_CREDIT_NOTE_ALLOCATION follow-up when the offset bill
 * already has an external (Xero) id. If the bill's PURCHASE_INVOICE sync hadn't
 * drained yet when the credit posted, the credit nets at the supplier level but
 * the bill is never auto-allocated. This sweep finds POSTED supplier credit notes
 * that now have BOTH a posted credit (accountingCreditNoteId) and a linked bill
 * with an external id, but no PURCHASE_CREDIT_NOTE_ALLOCATION row of any status,
 * and enqueues one. Idempotent: skips any credit note that already has an
 * allocation row (the normal retry/repair path owns those), and the allocation
 * itself re-reads RemainingCredit/AmountDue. Safe to run repeatedly from cron.
 *
 * Note (Codex review): `status = POSTED` is IMS-posted; if the connector is in
 * draft posting mode the Xero credit is DRAFT and can't be allocated yet — the
 * allocation no-ops/retries until it's authorised. This matches the live v08m
 * enqueue path; freight credits are posted authorised in practice.
 *
 * WHERE THIS SWEEP'S ORIGIN RECORD COMES FROM (Codex r3 finding 1, CRITICAL). This is the purest form of
 * the defect that finding names: a cron that witnessed nothing, building a payload out of external ids
 * that were written to local columns at some unknown earlier time, and — until this round — stamping
 * whichever organisation happens to be connected when the cron fires onto it. That is not weak evidence,
 * it is manufactured evidence: the post-time guard would then compare the current tenant against the
 * current tenant and could not fail, on exactly the rows nobody watched being made.
 *
 * So the sweep inherits instead. `creditNoteId` is `SupplierCreditNote.accountingCreditNoteId`, which was
 * written by one specific PURCHASE_CREDIT_NOTE sync row's successful post; THAT row is found by the pair
 * (`referenceId`, `externalTransactionId` = the credit id being carried) and its own origin record is
 * carried onto the allocation verbatim. The pair is the point (Codex r4 finding 1): round 3 matched the
 * reference alone and took the newest SYNCED row, which for a credit posted twice inherits from the post
 * of a DIFFERENT document — an origin the row never came from, which is inventing one by another route.
 * Status is not part of the identity either, because a posted row can be sent back to PENDING/FAILED by a
 * follow-up failure, or retired to CANCELLED, while keeping the id it posted. See
 * `selectIssuingPostOriginRecord`.
 *
 * If no row names that exact document — retention removed it, or the credit predates origin records — or
 * if two rows name it against DIFFERENT organisations, the allocation is created carrying NO record and
 * refuses at post time. That is bounded, one-per-credit-note, since the sweep skips any credit note that
 * already has an allocation row of any status; it is reported as a WARNING rather than left for an
 * operator to discover from a refusal; and the warning carries a remedy that can actually be performed —
 * allocate the credit in the ledger by hand, because re-queueing rebuilds the same evidence-free payload
 * (`creditNoteAllocationOriginRemedy`, Codex r4 finding 2).
 *
 * AND WHAT THAT RECORD DOES NOT COVER, stated rather than implied. It vouches for `creditNoteId`. The
 * bill id (`accountingInvoiceId`) came from a DIFFERENT post — the whole reason this gap exists is that
 * the bill synced after the credit — and no column records that post's tenant, so nothing here can
 * compare the two. If they ever disagreed, the allocation would be addressed to the credit's
 * organisation carrying a foreign bill id, and Xero would reject it: a visible failure, not a silent
 * one. Closing that residual needs a provenance column beside `PurchaseInvoice.accountingInvoiceId`,
 * the same shape `Product.accountingItemProvenance` already has; it is not closed here.
 */
export async function reenqueueMissingCreditNoteAllocations(limit = 200): Promise<CreditNoteAllocationReenqueueResult> {
  const result: CreditNoteAllocationReenqueueResult = { checked: 0, enqueued: 0, failed: 0 }
  const candidates = await db.supplierCreditNote.findMany({
    where: {
      status: 'POSTED',
      accountingCreditNoteId: { not: null },
      purchaseInvoiceId: { not: null },
      purchaseInvoice: { is: { accountingInvoiceId: { not: null } } },
    },
    select: {
      id: true,
      accountingCreditNoteId: true,
      amountForeign: true,
      purchaseInvoice: { select: { accountingInvoiceId: true } },
    },
    orderBy: { postedAt: 'asc' },
    take: limit,
  })
  if (candidates.length === 0) return result

  // A credit note that already has an allocation row (live OR terminal) is owned
  // by the normal retry/repair path — this sweep only fills the never-enqueued gap.
  const existing = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: 'PURCHASE_CREDIT_NOTE_ALLOCATION',
      referenceType: 'SupplierCreditNote',
      referenceId: { in: candidates.map((c) => c.id) },
    },
    select: { referenceId: true },
  })
  const hasAllocation = new Set(existing.map((e) => e.referenceId))
  const toEnqueue = selectCreditNotesNeedingAllocation(candidates, hasAllocation)
  if (toEnqueue.length === 0) return result

  // The rows whose posts ISSUED these credit ids, so the organisation one of them recorded can be carried
  // onto the allocation rather than a fresh read of the token row being invented for it.
  //
  // BOTH HALVES OF THE PAIR ARE FETCHED, AND THE PAIRING IS DONE IN MEMORY (Codex r4 finding 1). The two
  // `in` clauses narrow the scan but do NOT pair anything: a row for credit note A carrying credit note
  // B's document id satisfies both of them, and that cross-match is the whole defect — the id has to be
  // compared against the id THIS allocation is carrying, per candidate. `selectIssuingPostOriginRecord`
  // does that. No status filter: a row that names a document posted that document, whatever status it
  // ended up in (see the header there).
  const creditNotePosts = await db.accountingSyncLog.findMany({
    where: {
      connector: XERO_CONNECTOR,
      type: 'PURCHASE_CREDIT_NOTE',
      referenceType: 'SupplierCreditNote',
      referenceId: { in: toEnqueue.map((item) => item.supplierCreditNoteId) },
      externalTransactionId: { in: toEnqueue.map((item) => item.creditNoteId) },
    },
    // Only for a stable read; the choice among several issuing rows is made by rank, not by order.
    orderBy: [{ syncedAt: 'desc' }, { createdAt: 'desc' }],
    select: { referenceId: true, externalTransactionId: true, payload: true },
  })
  const postsByCreditNote = new Map<string, CreditNotePostRow[]>()
  for (const row of creditNotePosts) {
    const bucket = postsByCreditNote.get(row.referenceId)
    if (bucket) bucket.push(row)
    else postsByCreditNote.set(row.referenceId, [row])
  }

  for (const item of toEnqueue) {
    result.checked++
    try {
      const origin = selectIssuingPostOriginRecord(
        postsByCreditNote.get(item.supplierCreditNoteId) ?? [],
        item.creditNoteId,
      )
      // What the inherited record will MEAN at post time, read from the value actually being carried
      // rather than assumed from the fact that something was found. An issuing row that survives but
      // records nothing itself hands on nothing, and that row refuses too — so it gets the same warning
      // and the same remedy as finding no row at all, with a description that says which it was.
      const inherited = origin.outcome === 'inherited' ? readAccountingPayloadConnectionStamp(origin.payload) : null
      const inheritedProvenance = inherited?.state === 'stamped' ? inherited.provenance : null
      const enqueue = await enqueueFollowUpSyncLog('PURCHASE_CREDIT_NOTE_ALLOCATION', 'SupplierCreditNote', item.supplierCreditNoteId, {
        creditNoteId: item.creditNoteId,
        accountingInvoiceId: item.accountingInvoiceId,
        amount: item.amount,
        sourceEntryId: 'reenqueue-sweep',
      }, origin.outcome === 'inherited'
        // PAYLOAD ONLY HERE, DELIBERATELY, and unchanged by o3d-bqw7 r2. `selectIssuingPostOriginRecord`
        // chooses AMONG several candidate rows by what each payload records, and returns the payload
        // rather than a row, so there is no single row whose durable column this could honestly be
        // paired with. A compacted issuing row therefore still hands on nothing and the allocation
        // refuses at post time — which is what it did yesterday, and is the safe direction. Nothing
        // classifies a PURCHASE_CREDIT_NOTE allocation as REBUILT after compaction, so no claim
        // anywhere depends on it being raisable from a tombstone.
        ? { from: 'postedRow' as const, record: { payload: origin.payload, connectionProvenance: null } }
        : { from: 'unobserved' as const })
      // o3d-peh1: a REFUSED allocation is not an enqueued one. This sweep's whole purpose is to find
      // credit notes the normal path missed, so counting a refusal as `enqueued` — and logging
      // `xero_credit_note_allocation_reenqueued` over the top of the refusal the enqueue just wrote —
      // would report the allocation as recovered while it is still missing, and the credit note stays
      // in this sweep's candidate set for ever with nothing saying why.
      if (!enqueue.enqueued) {
        result.failed++
        console.error(
          'reenqueueMissingCreditNoteAllocations: enqueue refused',
          item.supplierCreditNoteId,
          describeFollowUpEnqueueRefusals(enqueue),
        )
        continue
      }
      result.enqueued++
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_credit_note_allocation_reenqueued',
        tag: 'sync',
        level: inheritedProvenance ? 'INFO' : 'WARNING',
        description: inheritedProvenance
          ? `Enqueued a missing supplier-credit-note allocation for ${item.supplierCreditNoteId} (bill synced after the `
            + `credit posted), carrying the accounting organisation recorded by the sync row that posted credit note `
            + `${item.creditNoteId} — ${inheritedProvenance}.`
          : `Enqueued a missing supplier-credit-note allocation for ${item.supplierCreditNoteId}, but `
            + `${describeMissingCreditNoteOrigin(origin, inherited, item.creditNoteId)}, so the allocation carries no `
            + 'usable record of which accounting organisation issued the credit and WILL be refused at post time '
            + 'rather than sent to whichever organisation happens to be connected. '
            + creditNoteAllocationOriginRemedy(item),
        metadata: {
          supplierCreditNoteId: item.supplierCreditNoteId,
          creditNoteId: item.creditNoteId,
          accountingInvoiceId: item.accountingInvoiceId,
          originRecordInherited: inheritedProvenance !== null,
          originOutcome: origin.outcome,
          originRecordState: inherited?.state ?? null,
          ...(origin.outcome === 'conflicting-origins' ? { conflictingOrigins: origin.recorded } : {}),
        },
      })
    } catch (error) {
      result.failed++
      console.error('reenqueueMissingCreditNoteAllocations: enqueue failed', item.supplierCreditNoteId, error)
    }
  }
  return result
}

async function enqueueSalesInvoiceFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
  origin: AccountingOriginRecord,
): Promise<FollowUpEnqueueOutcome> {
  if (referenceType !== 'SalesOrder' || !syncResult.externalId) return FOLLOW_UPS_ENQUEUED
  // o3d-peh1: the PAYMENT's outcome is kept and folded in at the end. Both follow-ups are still
  // attempted — a refused payment is no reason to withhold the PDF, which is separate work — but the
  // caller must not be told the row is settled while the money half is still owed.
  let paymentOutcome: FollowUpEnqueueOutcome = FOLLOW_UPS_ENQUEUED

  if (payload._registerPayment) {
    const paymentMap = await getPaymentAccountMap()
    const method = payload._paymentMethod as string || ''
    const currency = payload.currency as string || 'GBP'

    if (!paymentMap || Object.keys(paymentMap).length === 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_payment_skipped',
        tag: 'sync',
        level: 'WARNING',
        description: 'Skipped Xero payment registration: no payment account map configured. Go to Settings → Accounting → Payment Account Mapping to set up bank accounts for each payment method.',
      })
    } else {
      const stored = lookupPaymentAccount(paymentMap, method, currency)
      if (!stored) {
        await logActivity({
          entityType: 'SYSTEM',
          action: 'xero_payment_skipped',
          tag: 'sync',
          level: 'WARNING',
          description: `Skipped Xero payment registration: no bank account mapped for method "${method}" / currency "${currency}". Add a mapping in Settings → Accounting → Payment Account Mapping.`,
        })
      } else {
        let amount = payload._paymentAmount as number | undefined
        if (amount == null && typeof payload._paymentAmount === 'string') {
          amount = Number(payload._paymentAmount)
        }
        if (amount == null) {
          amount = (payload.lines as Array<{ quantity: number; unitAmount: number }>).reduce((s, l) => s + l.quantity * l.unitAmount, 0)
            + ((payload.shippingAmount as number) || 0)
            - ((payload.discountAmount as number) || 0)
        }

        if (amount > 0) {
          paymentOutcome = await enqueueFollowUpSyncLog('INVOICE_PAYMENT', referenceType, referenceId, {
            accountingInvoiceId: syncResult.externalId,
            bankAccountId: stored,
            amount,
            paymentDate: (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            currency,
            method,
            sourceEntryId: entryId,
          }, { from: 'postedRow', record: origin })
        }
      }
    }
  }

  const pdfOutcome = await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
    sourceEntryId: entryId,
  }, { from: 'postedRow', record: origin })

  // o3d-ekn8: receipts recorded BEFORE this invoice existed were refused with DOCUMENT_NOT_POSTED and
  // nothing ever came back for them. This is the moment that refusal stops applying — the CREATE has
  // posted and updateBackReference (which runs before enqueueFollowUps) has written accountingInvoiceId
  // — so re-drive the same guarded decision here. Imported orders are unaffected: their receipt is
  // registered by the `_registerPayment` branch above and has no local Payment row to re-drive.
  //
  // Imported dynamically so the connector does not take a static dependency on the sales domain, and
  // awaited but never allowed to throw: the invoice HAS posted, and a receipt that could not be
  // re-registered must not turn that into a failed sync entry.
  const { registerDeferredOrderReceipts } = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  await registerDeferredOrderReceipts(referenceId)
  return combineFollowUpEnqueueOutcomes(paymentOutcome, pdfOutcome)
}

async function enqueuePurchaseInvoiceFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
  origin: AccountingOriginRecord,
): Promise<FollowUpEnqueueOutcome> {
  if ((referenceType !== 'PurchaseInvoice' && referenceType !== 'PurchaseOrder') || !syncResult.externalId || !payload.supplierInvoicePath) {
    return FOLLOW_UPS_ENQUEUED
  }
  return await enqueueFollowUpSyncLog('BILL_ATTACHMENT', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    supplierInvoicePath: payload.supplierInvoicePath,
    sourceEntryId: entryId,
  }, { from: 'postedRow', record: origin })
}

async function enqueuePurchaseCreditNoteFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
  origin: AccountingOriginRecord,
): Promise<FollowUpEnqueueOutcome> {
  // audit-v08m: after the ACCPAYCREDIT posts, allocate it to the bill it offsets.
  // Needs both the credit's new external id and the bill's external id. The bill
  // id is threaded onto the payload at enqueue time (postSupplierCreditNote); if
  // the bill hasn't synced to Xero yet there's nothing to allocate against, so we
  // skip — the credit still posts and nets at the supplier level.
  if (referenceType !== 'SupplierCreditNote' || !syncResult.externalId) return FOLLOW_UPS_ENQUEUED
  const allocateToInvoiceId = payload.allocateToInvoiceId as string | undefined
  const allocateAmount = payload.allocateAmount as number | undefined
  if (!allocateToInvoiceId || allocateAmount == null || allocateAmount <= 0) return FOLLOW_UPS_ENQUEUED
  return await enqueueFollowUpSyncLog('PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType, referenceId, {
    creditNoteId: syncResult.externalId,
    accountingInvoiceId: allocateToInvoiceId,
    amount: allocateAmount,
    // Resolved HERE rather than left undefined for processEntry to fill from the wall
    // clock. An unset date made the allocation body differ on every execution, so a
    // retry of a pinned request was no longer the same request (Codex review, r2 #3).
    date: (payload.date as string | undefined)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    sourceEntryId: entryId,
  }, { from: 'postedRow', record: origin })
}

/**
 * Fan a posted row out into the follow-up work it owes.
 *
 * THE POSTING ROW'S ORIGIN RECORD IS THE EVIDENCE, not just the source of fields (Codex r3 finding 1).
 * It belongs to the row that posted — whether this call comes from the processor moments after the post,
 * or from the back-reference sweep days later for a row whose process died before its follow-ups ran —
 * and it is the only thing that knows which organisation the external ids being handed on belong to.
 * Every `enqueueFollowUpSyncLog` below therefore passes `{ from: 'postedRow', record: origin }`, and none
 * of them reads the live connection.
 *
 * THE RECORD IS BOTH HALVES (o3d-bqw7 r2, Codex HIGH). `payload` alone was the evidence until a
 * retention tombstone showed what that costs: compaction empties the payload and KEEPS
 * `connectionProvenance`, so the rows whose follow-ups this pipeline still claims to rebuild handed on
 * nothing at all, and the rows they created could never post. `origin` carries the payload, the column
 * and retention's compaction instant together, which is the only combination
 * `readAccountingOriginRecord` will decide from.
 *
 * A row whose payload recorded nothing hands nothing on, and the follow-up refuses at post time instead
 * of being addressed to whoever is connected. That is the same answer the parent row itself would now
 * get, which is the property that makes the chain sound: a follow-up can never be MORE permitted than
 * the post it descends from.
 *
 * o3d-peh1: RETURNS WHETHER THE ROW STILL OWES ANYTHING. A type with no branch here owes nothing and
 * says `enqueued` — the marker was a false obligation, which is the correct and long-standing answer.
 * A type that owes work and could not queue it says so, and every caller must act on that before it
 * settles the row or reports a recovery.
 */
async function enqueueFollowUps(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
  /**
   * o3d-bqw7 r2 (Codex HIGH) — THE COMPLETE DURABLE ORIGIN RECORD OF THE POSTING ROW, not just its
   * payload. On a retention tombstone the payload is `{}` and the organisation is recorded only in
   * the `connectionProvenance` column; handing on the payload alone created follow-ups that could
   * never post, which made "the invoice PDF survives compaction" a claim this pipeline did not
   * honour.
   */
  origin: AccountingOriginRecord,
): Promise<FollowUpEnqueueOutcome> {
  if (type === 'SALES_INVOICE') {
    return await enqueueSalesInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult, origin)
  }

  if (type === 'PURCHASE_INVOICE') {
    return await enqueuePurchaseInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult, origin)
  }

  if (type === 'PURCHASE_CREDIT_NOTE') {
    return await enqueuePurchaseCreditNoteFollowUps(entryId, referenceType, referenceId, payload, syncResult, origin)
  }

  if (type === 'INVOICE_PDF' && referenceType === 'SalesOrder') {
    const order = await db.salesOrder.findUnique({
      where: { id: referenceId },
      select: {
        customerEmail: true,
        shoppingLinks: { where: { connector: 'woocommerce' }, select: { id: true }, take: 1 },
      },
    })
    const outcomes: FollowUpEnqueueOutcome[] = []
    if (order?.customerEmail) {
      outcomes.push(await enqueueFollowUpSyncLog(
        'INVOICE_EMAIL', referenceType, referenceId, { referenceId, sourceEntryId: entryId },
        { from: 'postedRow', record: origin },
      ))
    }
    if (order?.shoppingLinks.length) {
      outcomes.push(await enqueueFollowUpSyncLog(
        'WC_INVOICE_NOTE', referenceType, referenceId, { referenceId, sourceEntryId: entryId },
        { from: 'postedRow', record: origin },
      ))
    }
    return combineFollowUpEnqueueOutcomes(...outcomes)
  }

  return FOLLOW_UPS_ENQUEUED
}
