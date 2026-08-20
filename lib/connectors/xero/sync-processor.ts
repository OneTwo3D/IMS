/**
 * Process pending XeroSyncLog entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one Xero API call.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { db, POST_REMOTE_PERSIST_TX_OPTIONS } from '@/lib/db'
import { XERO_INVOICE_NUMBER_SLOT_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import {
  persistAfterRemoteWrite,
  postRemotePersistDeadlineMs,
  reportUnrecordedRemoteWrite,
  UnrecordedRemoteWriteError,
} from '@/lib/db/post-remote-persist'
import { logActivity, logActivityPersisted, redactActivityLogText, sanitizeActivityLogMetadata } from '@/lib/activity-log'
import { pushSalesInvoice, updateSalesInvoice, type BeforeRemoteWrite } from './invoices'
import { pushPurchaseBill, updatePurchaseBill } from './bills'
import { allocatePurchaseCreditNote, pushCreditNote, pushPurchaseCreditNote } from './credit-notes'
import { pushManualJournal } from './journals'
import { getGrantedScopes } from './auth'
import { blockingScopeFor, scopeBlockedError } from './scopes'
import {
  carryAccountingOriginRecord,
  readAccountingPayloadConnectionStamp,
  type AccountingConnectionStamp,
} from '@/lib/connectors/accounting-connection-provenance'
import { withAccountingPostingIntent } from '@/lib/connectors/accounting-posting-intent'
import { xeroUploadAttachment, xeroPost } from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { decideInvoiceNumberPost, xeroInvoiceNumberIdentity } from '@/lib/domain/accounting/invoice-number-ownership'
import { lookupXeroInvoiceNumberClaim } from './invoice-number-claim'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { applyBackReference, followUpObligationClaim, releaseFollowUpObligation } from '@/lib/domain/accounting/back-reference'
import { stampSyncedAtFromDatabaseClock } from './synced-at-clock'
import { claimHeldFrom, heldClaimWhere, releaseClaimForRetry, type HeldClaim } from '@/lib/domain/accounting/sync-claim-fence'
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
} from '@/lib/domain/accounting/back-reference-sweep'
import { planFollowUpEnqueue, readFollowUpIdempotencyKey } from '@/lib/domain/accounting/followup-idempotency'
import {
  buildCompactedFollowUpLossActivity,
  isCompactedFollowUpEvidence,
} from '@/lib/domain/accounting/compacted-followup-loss'
import { logFollowUpRevival, resolveLostFollowUpRevival } from '@/lib/domain/accounting/followup-revival'
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
 */
async function announceCompactedFollowUpLoss(entry: {
  id: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  backReferenceEvidenceCompactedAt: Date | null
}): Promise<void> {
  if (!isCompactedFollowUpEvidence(entry)) return
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

export async function markSyncLogForFollowUpRetry(

  entry: { id: string; retryCount: number },
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
  const updated = await conn.accountingSyncLog.updateMany({
    where: { id: entry.id, retryCount: entry.retryCount },
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
    where: { id: entry.id },
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
  entry: { id: string; retryCount: number; type: AccountingSyncType; referenceType: string; referenceId: string },
  errorMessage: string,
  payload: SyncPayload,
  /** The claim THIS worker holds. Required: an unfenced release is the o3d-550x defect. */
  held: HeldClaim,
): Promise<{ finalFailure: boolean }> {
  const retryCount = entry.retryCount + 1
  const computedFinal = retryCount >= MAX_RETRIES
  const updated = await tx.accountingSyncLog.updateMany({
    where: { ...heldClaimWhere(entry.id, held), retryCount: entry.retryCount },
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
        syncLogId: entry.id,
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
    where: { id: entry.id },
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

async function hasExistingSyncLog(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
): Promise<boolean> {
  const count = await db.accountingSyncLog.count({
    where: {
      connector: XERO_CONNECTOR,
      type,
      referenceType,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
  })
  return count > 0
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
   * The stored payload of the row whose post issued the ids in this follow-up. Its record is carried
   * VERBATIM — including its absence, which then refuses.
   */
  | { from: 'postedRow'; payload: unknown }
  /** Nothing in hand observed the origin. The row is created carrying no record, and cannot post. */
  | { from: 'unobserved' }

async function enqueueFollowUpSyncLog(
  type: FollowUpSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  origin: FollowUpOriginEvidence,
  /** Bounds the re-plan below, so a pathological race cannot recurse forever. */
  attempt = 0,
): Promise<void> {
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
  payload = carryAccountingOriginRecord(
    payload,
    origin.from === 'postedRow' ? origin.payload : undefined,
  ) as SyncPayload
  // Fast-path check; the partial unique index (audit-42co) is the atomic backstop
  // for the check-then-create race between concurrent sync runs.
  const liveRowExists = await hasExistingSyncLog(type, referenceType, referenceId)
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
    where: { connector: XERO_CONNECTOR, type, referenceType, referenceId, status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  })
  const failedRows = failedLogs.map((row) => ({
    id: row.id,
    payload: row.payload,
    // Exactly what followUpIdempotencySource would have produced for this row, so pinning it
    // reproduces a byte-identical Idempotency-Key even after the row itself is gone.
    effectiveToken: followUpIdempotencySource(row.id, (row.payload ?? {}) as SyncPayload),
  }))
  const plan = planFollowUpEnqueue({
    connector: XERO_CONNECTOR,
    type,
    referenceType,
    referenceId,
    payload,
    liveRowExists,
    failedRows,
  })
  if (plan.action === 'skip') return
  if (plan.action === 'refuse') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: `Refused to re-enqueue Xero ${type} for ${referenceType} ${referenceId}: ${plan.reason}`,
      metadata: { type, referenceType, referenceId, failedRowIds: failedRows.map((row) => row.id) },
    })
    return
  }
  try {
    const outcome = await db.$transaction(async (tx) => {
      if (plan.action === 'reuse') {
        // Fenced on status: if another run revived the same row first — or retention
        // deleted it between the read and here (o3d-nepa) — this updates nothing rather
        // than resetting a claim it does not own.
        const revived = await tx.accountingSyncLog.updateMany({
          where: { id: plan.syncLogId, status: 'FAILED' },
          data: {
            status: 'PENDING',
            payload: plan.payload as never,
            retryCount: 0,
            errorMessage: null,
            processingStartedAt: null,
          },
        })
        if (revived.count === 0) return 'cas-lost' as const
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
        },
      })
      await scheduleXeroAccountingOutbox(tx, {
        accountingSyncLogId: log.id,
      })
      return 'done' as const
    })
    if (outcome === 'cas-lost' && plan.action === 'reuse') {
      await resolveLostFollowUpRevival({
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
            { from: 'postedRow', payload: plan.payload }, attempt + 1,
          ),
      })
      return
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
      await resolveLostFollowUpRevival({
        connector: XERO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
        attempt,
        retry: () => enqueueFollowUpSyncLog(
          type, referenceType, referenceId, plan.payload,
          { from: 'postedRow', payload: plan.payload }, attempt + 1,
        ),
      })
      return
    }
    throw error
  }
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
    select: { id: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const earliestLiveByReference = new Map<string, { id: string; createdAt: Date }>()
  for (const log of liveLogs) {
    const key = invoicePaymentReferenceKey(log)
    if (!earliestLiveByReference.has(key)) {
      earliestLiveByReference.set(key, log)
    }
  }

  const blocked = new Set<string>()
  for (const entry of paymentEntries) {
    const earliest = earliestLiveByReference.get(invoicePaymentReferenceKey(entry))
    if (earliest && earliest.id !== entry.id && earliest.createdAt < entry.createdAt) {
      blocked.add(entry.id)
    }
  }
  return blocked
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

/** o3d-550x: the caller holds the claim, so this gives it back through the one fenced release. */
export async function deferPaymentUntilEarlierLogsPost(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entry: { id: string },
  held: HeldClaim,
): Promise<boolean> {
  return releaseClaimForRetry(client, entry.id, held, {
    errorMessage: PAYMENT_ORDERING_DEFERRAL_MESSAGE,
    nextAttemptAt: new Date(Date.now() + ORDERING_DEFERRAL_MS),
  })
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

/** o3d-550x: fenced on the claim this worker holds, through the one release, like every other. */
export async function deferUpdateUntilCreatePosts(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entry: { id: string },
  held: HeldClaim,
): Promise<boolean> {
  return releaseClaimForRetry(client, entry.id, held, {
    errorMessage: UPDATE_ORDERING_DEFERRAL_MESSAGE,
    nextAttemptAt: new Date(Date.now() + ORDERING_DEFERRAL_MS),
  })
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

function accountingSyncLogClaimWhere(id: string, staleClaimCutoff: Date) {
  return {
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
  }
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
export async function renewClaimForRemoteWrite(entryId: string, heldFrom: Date): Promise<Date | null> {
  const renewedAt = new Date()
  const renewed = await db.accountingSyncLog.updateMany({
    where: {
      id: entryId,
      connector: XERO_CONNECTOR,
      status: 'PROCESSING',
      processingStartedAt: heldFrom,
    },
    data: { processingStartedAt: renewedAt },
  })
  return renewed.count === 1 ? renewedAt : null
}

/**
 * What to say when a claim was lost before anything was sent. Nothing is wrong with the row — it is
 * being worked on by somebody else — so this is a re-drive, not a failure.
 */
function lostClaimMessage(entryId: string): string {
  return `Xero sync log ${entryId} was not posted: this worker's claim on it had been taken by another `
    + `worker before the remote write began, so posting would have created a second document. The row `
    + `belongs to whoever holds it now.`
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
  claimedAt: Date
  /**
   * o3d-cvj9 (merged into development as o3d-batch-cvj9): the revision stamp Xero put on the document
   * as it applied THIS write. Supplied by the call sites where a connector write actually landed; a
   * site that called nothing omits it, and the ABSENCE — not `null` — is what the mirror's ordering
   * rule decides such a path on.
   */
  externalRevisionAt?: Date | null
}): Promise<PostedDocumentPersistOutcome> {
  const { entry, payload, claimedAt } = input
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
      { claim: { heldFrom: claimedAt, staleAfterMs: CLAIM_STALE_MS } },
    )
    // Not a pool problem and not this branch's to report: a newer claim posted its own document while
    // this attempt was on the wire, and o3d-550x has already made both identifiers durable.
    if (!record.recorded) return { persisted: false, reason: 'not-recorded', evidence: record.evidence }
    return { persisted: true }
  } catch (error) {
    // Only the pool's own give-up is handled here. Everything else — including the unwritten-evidence
    // throw o3d-550x raises when it cannot file a conflict — is left to the runner, untouched.
    if (!(error instanceof UnrecordedRemoteWriteError)) throw error
    await reportUnrecordedXeroWrite({ entry, externalId, claimedAt, error })
    return { persisted: false, reason: 'pool-exhausted' }
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
  claimedAt: Date
  error: UnrecordedRemoteWriteError
}): Promise<void> {
  const { entry, externalId, claimedAt, error } = input
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
        id: entry.id,
        connector: XERO_CONNECTOR,
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
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

async function deferOutboxForRateLimit(
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

export async function processPendingXeroSync(): Promise<ProcessResult> {
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
    const claim = await db.accountingSyncLog.updateMany({
      where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff),
      data: {
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
      },
    })
    if (claim.count === 0) continue

    result.processed++
    const payload = (entry.payload ?? {}) as SyncPayload

    try {
      if (blockedPaymentEntryIds.has(entry.id)) {
        await deferPaymentUntilEarlierLogsPost(db, entry, held)
        result.skipped++
        continue
      }
      if (blockedUpdateEntryIds.has(entry.id)) {
        await deferUpdateUntilCreatePosts(db, entry, held)
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
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
          await announceCompactedFollowUpLoss(entry)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          // NOT released: the follow-ups did not run. The row goes back to PENDING (or FAILED at
          // MAX_RETRIES) still carrying the obligation, so whichever gets there first — this
          // processor's own retry or the repair sweep — knows the work is outstanding.
          await markSyncLogForFollowUpRetry(entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }
        result.succeeded++
        continue
      }

      // o3d-xl63 r4 #1: re-take the claim at the instant the remote write begins, and post NOTHING if
      // it is gone. Everything downstream fences on the timestamp this returns, not on the one taken
      // before the deferral checks above.
      const postClaimedAt = await renewClaimForRemoteWrite(entry.id, claimedAt)
      if (!postClaimedAt) {
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

            // THE RENEWED CLAIM IS THE ONE EVERYTHING DOWNSTREAM FENCES ON. `held` above was built from the
      // instant taken before the deferral checks; the row now carries `postClaimedAt`, so a fence
      // built from the older holder would match NOTHING — and these fences fail closed, so the
      // symptom would be silence rather than an error. Wrapped rather than passed raw because
      // o3d-550x's contract (merged as #639) is that a claim is a HOLDER asked for its instant at the
      // point of use, and a bare `Date` is a compile error.
      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, claimHeldFrom(postClaimedAt))

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
          // The RENEWED claim (r4 #1): the persist's deadline, and the claim-fenced terminal write on
          // the give-up path, must both fence on the claim this worker actually holds.
          claimedAt: postClaimedAt,
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

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          await markSyncLogForFollowUpRetry(entry, followUpError)
          await logFollowUpRetry(entry.id, followUpError)
          result.failed++
          continue
        }

        result.succeeded++
      } else {
        const errorMessage = syncResult.error ?? 'Unknown error'
        if (isRateLimitError(errorMessage)) {
          // o3d-550x: the one fenced release — a displaced owner backing off here would hand the
          // row back to PENDING mid-post.
          await releaseClaimForRetry(db, entry.id, held, {
            errorMessage,
            nextAttemptAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
          })
        } else {
          await db.$transaction(async (tx) => {
            await applyMainSyncFailureRetry(tx, entry, errorMessage, payload, held)
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
        // o3d-550x: the one fenced release.
        await releaseClaimForRetry(db, entry.id, held, {
          errorMessage,
          nextAttemptAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
        })
      } else {
        await db.$transaction(async (tx) => {
          await applyMainSyncFailureRetry(tx, entry, errorMessage, payload, held)
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
    const claim = await db.accountingSyncLog.updateMany({
      where: accountingSyncLogClaimWhere(entry.id, staleClaimCutoff),
      data: {
        status: 'PROCESSING',
        processingStartedAt: claimedAt,
      },
    })
    if (claim.count === 0) {
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
    const payload = (entry.payload ?? {}) as SyncPayload

    try {
      if (blockedPaymentEntryIds.has(entry.id)) {
        await db.$transaction(async (tx) => {
          // o3d-550x: THE SAME release as the direct runner, not a copy of it.
          await deferPaymentUntilEarlierLogsPost(tx, entry, held)
          await markXeroOutboxRetry(job, PAYMENT_ORDERING_DEFERRAL_MESSAGE, tx)
        })
        result.skipped++
        continue
      }

      if (blockedUpdateEntryIds.has(entry.id)) {
        await db.$transaction(async (tx) => {
          // o3d-550x: THE SAME release as the direct runner, not a copy of it.
          await deferUpdateUntilCreatePosts(tx, entry, held)
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
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
          await announceCompactedFollowUpLoss(entry)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          const retry = await db.$transaction(async (tx) => {
            const nextRetry = await markSyncLogForFollowUpRetry(entry, followUpError, tx)
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

      // o3d-xl63 r4 #1: as in the direct path — re-take the claim at the instant the remote write
      // begins. The outbox job is handed back for retry rather than failed: nothing was sent, and by
      // the time it is re-claimed the row is either SYNCED (skipped at the top) or free again.
      const postClaimedAt = await renewClaimForRemoteWrite(entry.id, claimedAt)
      if (!postClaimedAt) {
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

            // THE RENEWED CLAIM IS THE ONE EVERYTHING DOWNSTREAM FENCES ON. `held` above was built from the
      // instant taken before the deferral checks; the row now carries `postClaimedAt`, so a fence
      // built from the older holder would match NOTHING — and these fences fail closed, so the
      // symptom would be silence rather than an error. Wrapped rather than passed raw because
      // o3d-550x's contract (merged as #639) is that a claim is a HOLDER asked for its instant at the
      // point of use, and a bare `Date` is a compile error.
      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, claimHeldFrom(postClaimedAt))

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
          // The RENEWED claim (r4 #1): the persist's deadline, and the claim-fenced terminal write on
          // the give-up path, must both fence on the claim this worker actually holds.
          claimedAt: postClaimedAt,
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

        try {
          await updateBackReference(entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
          await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: XERO_CONNECTOR })
        } catch (followUpError) {
          const retry = await db.$transaction(async (tx) => {
            const nextRetry = await markSyncLogForFollowUpRetry(entry, followUpError, tx)
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
            // o3d-550x: the one fenced release.
            await releaseClaimForRetry(tx, entry.id, held, {
              errorMessage,
              nextAttemptAt: new Date(Date.now() + retryDelayMs),
            })
            await deferOutboxForRateLimit(tx, job, errorMessage, retryDelayMs)
          })
        } else {
          await db.$transaction(async (tx) => {
            const { finalFailure } = await applyMainSyncFailureRetry(tx, entry, errorMessage, payload, held)
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
          // o3d-550x: the one fenced release.
          await releaseClaimForRetry(tx, entry.id, held, {
            errorMessage,
            nextAttemptAt: new Date(Date.now() + retryDelayMs),
          })
          await deferOutboxForRateLimit(tx, job, errorMessage, retryDelayMs)
        })
      } else {
        await db.$transaction(async (tx) => {
          const { finalFailure } = await applyMainSyncFailureRetry(tx, entry, errorMessage, payload, held)
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
  entryId: string,
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
        // Claim-fenced: only retire if this exact claim still owns the row (retire returns false
        // otherwise). Either way nothing was posted, so skip — a lost fence means another worker
        // owns/posted it.
        await retireSalesInvoiceForCancelledOrder(tx, entryId, referenceId, held)
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
   * The claim this worker HOLDS — the fence's own writes are conditioned on it. A holder rather than
   * the instant (o3d-550x): the slot stamp below is written some way after this guard is entered,
   * and a snapshot taken here would fence on a claim that may since have moved.
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
  held: HeldClaim,
): Promise<EntryResult> {
  return withAccountingPostingIntent(
    { connector: XERO_CONNECTOR, payload, type, referenceType, referenceId },
    () => processClaimedEntry(entryId, type, referenceType, referenceId, payload, held),
  )
}

async function processClaimedEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  // o3d-550x: the HELD CLAIM, not a snapshot instant. Development split this function out of
  // `processEntry` (o3d-19gy / o3d-s36z posting intent) while this branch was replacing the carried
  // `claimedAt: Date` with a holder read at the point of use — the two changes merged textually and
  // the parameter kept the old name and type. A bare `Date` is a compile error at every fence below,
  // which is exactly what `HeldClaim` exists to force.
  held: HeldClaim,
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
      const guard = await guardCancelledSalesOrderInvoice(entryId, referenceType, referenceId, held)
      if (!guard.post) return guard.result
      const customerId = guard.customerId
      // o3d-k26m.5: the number must be ours to post under. Refusing is recoverable; overwriting a
      // live invoice is not. Runs AFTER the cancelled-order backstop (no point asking the ledger
      // about an order that must not be invoiced at all) and BEFORE anything is sent.
      const numberFence = await guardSalesInvoiceNumberOwnership(entryId, referenceType, referenceId, payload, held)
      if (!numberFence.post) return numberFence.result
      const invoiceIdempotencyKey = buildXeroIdempotencyKey(entryId, 'invoice', payload)
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
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      if (!accountingInvoiceId) {
        return { success: false, error: 'Missing accountingInvoiceId for SALES_INVOICE_UPDATE' }
      }
      // Same cancelled-order backstop as the create: don't modify an external receivable for an order
      // that has since been cancelled (retire the update instead), and fail closed on an unreadable order.
      const guard = await guardCancelledSalesOrderInvoice(entryId, referenceType, referenceId, held)
      if (!guard.post) return guard.result
      const customerId = guard.customerId
      const invoiceIdempotencyKey = buildXeroIdempotencyKey(entryId, 'invoice-update', payload)
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
      const paymentDate = (payload.paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for INVOICE_PAYMENT' }
      }
      const account = await db.accountingAccount.findFirst({
        where: { connector: XERO_CONNECTOR, OR: [{ externalAccountId: bankAccountId }, { code: bankAccountId }] },
        select: { externalAccountId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      try {
        const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
          Invoice: { InvoiceID: accountingInvoiceId },
          Account: { AccountID: account.externalAccountId },
          Date: paymentDate,
          Amount: amount,
        }, { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'invoice-payment') })
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
        }
        const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
        return { success: true, externalId: paymentId }
      } catch (e) {
        return { success: false, error: String(e) }
      }
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
      const emailResult = await sendAccountingInvoiceEmailInternal(orderId)
      return emailResult.success ? { success: true } : { success: false, error: emailResult.error ?? 'Failed to email invoice' }
    }

    case 'WC_INVOICE_NOTE': {
      const orderId = payload.referenceId as string | undefined
      if (!orderId) return { success: false, error: 'Missing referenceId for WC_INVOICE_NOTE' }
      const { pushInvoiceNoteToWc } = await import('@/lib/connectors/woocommerce/sync/invoice-note')
      const wcResult = await pushInvoiceNoteToWc(orderId)
      return wcResult.success ? { success: true } : { success: false, error: wcResult.error ?? 'Failed to notify WooCommerce about invoice' }
    }

    case 'BILL_PAYMENT': {
      // Register a payment in Xero against an existing bill (purchase
      // invoice). The bill must already have an accountingInvoiceId set.
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const bankAccountId = payload.bankAccountId as string | undefined
      const amount = payload.amount as number | undefined
      const paymentDate = (payload.paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!accountingInvoiceId || !bankAccountId || amount == null) {
        return { success: false, error: 'Missing accountingInvoiceId, bankAccountId, or amount for BILL_PAYMENT' }
      }
      // Resolve bank account — accept either Xero AccountID (preferred) or a legacy account code.
      const account = await db.accountingAccount.findFirst({
        where: { connector: XERO_CONNECTOR, OR: [{ externalAccountId: bankAccountId }, { code: bankAccountId }] },
        select: { externalAccountId: true },
      })
      if (!account) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced Xero chart of accounts` }
      }
      try {
        const paymentRes = await xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments', {
          Invoice: { InvoiceID: accountingInvoiceId },
          Account: { AccountID: account.externalAccountId },
          Date: paymentDate,
          Amount: amount,
          Reference: (payload.reference as string | undefined) ?? undefined,
        }, { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'bill-payment') })
        if (!paymentRes.ok) {
          return { success: false, error: paymentRes.error ?? 'Failed to post Xero payment' }
        }
        const paymentId = paymentRes.data?.Payments?.[0]?.PaymentID
        return { success: true, externalId: paymentId }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    case 'CREDIT_NOTE': {
      const creditCustomerId = referenceType === 'SalesOrderRefund'
        ? (await db.salesOrderRefund.findUnique({
            where: { id: referenceId },
            select: { order: { select: { customerId: true } } },
          }).catch(() => null))?.order.customerId ?? undefined
        : undefined
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
      }, resolveInvoiceStatus(postingMode), { idempotencyKey: buildXeroIdempotencyKey(entryId, 'purchase-credit-note'), supplierId: payload.supplierId as string | undefined }).then(r => ({ success: r.success, externalId: r.creditNoteId, error: r.error }))
    }

    case 'PURCHASE_CREDIT_NOTE_ALLOCATION': {
      // audit-v08m: follow-up that applies a posted ACCPAYCREDIT to the freight
      // bill it offsets, so the bill stops showing as outstanding in Xero's AP
      // aging. Enqueued by enqueuePurchaseCreditNoteFollowUps once the credit note
      // itself has posted (and only when the bill already has an external id).
      const creditNoteId = payload.creditNoteId as string | undefined
      const accountingInvoiceId = payload.accountingInvoiceId as string | undefined
      const amount = payload.amount as number | undefined
      const allocationDate = (payload.date as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10)
      if (!creditNoteId || !accountingInvoiceId || amount == null) {
        return { success: false, error: 'Missing creditNoteId, accountingInvoiceId, or amount for PURCHASE_CREDIT_NOTE_ALLOCATION' }
      }
      const result = await allocatePurchaseCreditNote(
        { creditNoteId, invoiceId: accountingInvoiceId, amount, date: allocationDate },
        { idempotencyKey: buildXeroIdempotencyKey(followUpIdempotencySource(entryId, payload), 'purchase-credit-note-allocation') },
      )
      // No externalId to back-reference — the allocation is a sub-resource of the
      // credit note, not a standalone document.
      return { success: result.success, error: result.error }
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
    case 'REALISED_FX_JOURNAL':
    case 'UNREALISED_FX_JOURNAL':
    case 'MANUFACTURING_JOURNAL':
    case 'MANUFACTURING_RECLASS': {
      const idempotencySource = typeof payload._idempotencyKey === 'string'
        ? payload._idempotencyKey
        : type.startsWith('DAILY_BATCH_')
        ? `${type}:${referenceId}`
        : entryId
      return pushManualJournal({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }, resolveJournalStatus(postingMode), { idempotencyKey: buildXeroIdempotencyKey(idempotencySource, 'manual-journal') }).then(r => ({ success: r.success, externalId: r.journalId, error: r.error }))
    }

    case 'TAX_RATE_SYNC': {
      const { putXeroTaxRate } = await import('./tax-rates')
      const name = payload.name as string | undefined
      const components = payload.components as Array<{ name: string; rate: number; compoundOnPrevious: boolean; accountingTaxType?: string | null }> | undefined
      if (!name || !components || components.length === 0) {
        return { success: false, error: 'TAX_RATE_SYNC payload missing name or components' }
      }
      const idempotencyKey = buildXeroIdempotencyKey(entryId, 'tax-rate', payload)
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
    enqueueFollowUps: (entryId, type, referenceType, referenceId, payload, syncResult) =>
      enqueueFollowUps(entryId, type, referenceType, referenceId, payload as SyncPayload, syncResult),
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
      await enqueueFollowUpSyncLog('PURCHASE_CREDIT_NOTE_ALLOCATION', 'SupplierCreditNote', item.supplierCreditNoteId, {
        creditNoteId: item.creditNoteId,
        accountingInvoiceId: item.accountingInvoiceId,
        amount: item.amount,
        sourceEntryId: 'reenqueue-sweep',
      }, origin.outcome === 'inherited'
        ? { from: 'postedRow', payload: origin.payload }
        : { from: 'unobserved' })
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
): Promise<void> {
  if (referenceType !== 'SalesOrder' || !syncResult.externalId) return

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
          await enqueueFollowUpSyncLog('INVOICE_PAYMENT', referenceType, referenceId, {
            accountingInvoiceId: syncResult.externalId,
            bankAccountId: stored,
            amount,
            paymentDate: (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            currency,
            method,
            sourceEntryId: entryId,
          }, { from: 'postedRow', payload })
        }
      }
    }
  }

  await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
    sourceEntryId: entryId,
  }, { from: 'postedRow', payload })
}

async function enqueuePurchaseInvoiceFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<void> {
  if ((referenceType !== 'PurchaseInvoice' && referenceType !== 'PurchaseOrder') || !syncResult.externalId || !payload.supplierInvoicePath) return
  await enqueueFollowUpSyncLog('BILL_ATTACHMENT', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    supplierInvoicePath: payload.supplierInvoicePath,
    sourceEntryId: entryId,
  }, { from: 'postedRow', payload })
}

async function enqueuePurchaseCreditNoteFollowUps(
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<void> {
  // audit-v08m: after the ACCPAYCREDIT posts, allocate it to the bill it offsets.
  // Needs both the credit's new external id and the bill's external id. The bill
  // id is threaded onto the payload at enqueue time (postSupplierCreditNote); if
  // the bill hasn't synced to Xero yet there's nothing to allocate against, so we
  // skip — the credit still posts and nets at the supplier level.
  if (referenceType !== 'SupplierCreditNote' || !syncResult.externalId) return
  const allocateToInvoiceId = payload.allocateToInvoiceId as string | undefined
  const allocateAmount = payload.allocateAmount as number | undefined
  if (!allocateToInvoiceId || allocateAmount == null || allocateAmount <= 0) return
  await enqueueFollowUpSyncLog('PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType, referenceId, {
    creditNoteId: syncResult.externalId,
    accountingInvoiceId: allocateToInvoiceId,
    amount: allocateAmount,
    // Resolved HERE rather than left undefined for processEntry to fill from the wall
    // clock. An unset date made the allocation body differ on every execution, so a
    // retry of a pinned request was no longer the same request (Codex review, r2 #3).
    date: (payload.date as string | undefined)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    sourceEntryId: entryId,
  }, { from: 'postedRow', payload })
}

/**
 * Fan a posted row out into the follow-up work it owes.
 *
 * `payload` IS THE ORIGIN EVIDENCE, not just the source of fields (Codex r3 finding 1). It is the stored
 * payload of the row that posted — whether this call comes from the processor moments after the post, or
 * from the back-reference sweep days later for a row whose process died before its follow-ups ran — and
 * the record it carries is the only thing that knows which organisation the external ids being handed on
 * belong to. Every `enqueueFollowUpSyncLog` below therefore passes `{ from: 'postedRow', payload }`, and
 * none of them reads the live connection.
 *
 * A row whose payload recorded nothing hands nothing on, and the follow-up refuses at post time instead
 * of being addressed to whoever is connected. That is the same answer the parent row itself would now
 * get, which is the property that makes the chain sound: a follow-up can never be MORE permitted than
 * the post it descends from.
 */
async function enqueueFollowUps(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
): Promise<void> {
  if (type === 'SALES_INVOICE') {
    await enqueueSalesInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult)
    return
  }

  if (type === 'PURCHASE_INVOICE') {
    await enqueuePurchaseInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult)
    return
  }

  if (type === 'PURCHASE_CREDIT_NOTE') {
    await enqueuePurchaseCreditNoteFollowUps(entryId, referenceType, referenceId, payload, syncResult)
    return
  }

  if (type === 'INVOICE_PDF' && referenceType === 'SalesOrder') {
    const order = await db.salesOrder.findUnique({
      where: { id: referenceId },
      select: {
        customerEmail: true,
        shoppingLinks: { where: { connector: 'woocommerce' }, select: { id: true }, take: 1 },
      },
    })
    if (order?.customerEmail) {
      await enqueueFollowUpSyncLog(
        'INVOICE_EMAIL', referenceType, referenceId, { referenceId, sourceEntryId: entryId },
        { from: 'postedRow', payload },
      )
    }
    if (order?.shoppingLinks.length) {
      await enqueueFollowUpSyncLog(
        'WC_INVOICE_NOTE', referenceType, referenceId, { referenceId, sourceEntryId: entryId },
        { from: 'postedRow', payload },
      )
    }
  }
}
