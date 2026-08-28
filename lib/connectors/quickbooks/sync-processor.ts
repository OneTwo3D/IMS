/**
 * Process pending QuickBooks sync entries — called by cron every 5 minutes.
 * Each entry represents one IMS transaction → one QBO API call.
 * Mirrors lib/connectors/xero/sync-processor.ts.
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { activeAccountingIdProvenance, accountingIdProvenanceMatches } from '@/lib/connectors/accounting-id-provenance'
import { retireSalesInvoiceForCancelledOrder } from '@/lib/domain/accounting/cancel-order-invoice-sync'
import { readClaimedSyncLogPayload } from '@/lib/domain/accounting/claimed-sync-payload'
import { claimHeldFrom } from '@/lib/domain/accounting/sync-claim-fence'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'
import { logActivity, logActivityPersisted } from '@/lib/activity-log'
import { pushSalesInvoice } from './invoices'
import { pushPurchaseBill } from './bills'
import { pushCreditMemo } from './credit-notes'
import { pushJournalEntry } from './journals'
import { qboPost, qboUploadAttachment, resolveAccountRef, qboPostIdempotent} from './api'
import { lookupPaymentAccount, getPaymentAccountMap } from '@/lib/accounting'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import {
  liveRowOccupiesFollowUpSlot,
  planFollowUpEnqueue,
  readFollowUpIdempotencyKey,
  type FollowUpPayload,
} from '@/lib/domain/accounting/followup-idempotency'
import { repairMoneyAttemptsOutsideStampingCustody, stampingCustodyOnClaim, stampingCustodyOnCreate } from '@/lib/domain/accounting/money-attempt-provenance'
import { ledgerClearsFollowUpRevival, postMoneyUnderLedgerFence } from '@/lib/connectors/accounting-settlement-probe'
import { moneyPostDateToSend, settlementMarkerFor } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { isOperatorAssertedSettlement } from '@/lib/domain/accounting/sync-row-settlement'
import {
  guardInvoicePaymentCapacity,
  retireOverSettlingInvoicePayment,
} from '@/lib/domain/accounting/invoice-payment-capacity'
import { logFollowUpRevival, resolveLostFollowUpRevival } from '@/lib/domain/accounting/followup-revival'
import {
  FOLLOW_UPS_ENQUEUED,
  combineFollowUpEnqueueOutcomes,
  obligationReleasePrerequisite,
  describeFollowUpEnqueueRefusals,
  refusedFollowUpEnqueue,
  type FollowUpEnqueueOutcome,
} from '@/lib/domain/accounting/followup-enqueue-outcome'
import { isUniqueConstraintViolation } from '@/lib/db/prisma-unique-violation'
import {
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  describeUnpersistedQboPost,
  ledgerTargetIdFromPayload,
  type PostedOperationOutcome,
  type RemoteEffectOutcome,
  type UnpersistedQboPost,
} from '@/lib/domain/accounting/unrecorded-posted-document'
import { redactActivityLogText, sanitizeActivityLogMetadata } from '@/lib/activity-log'
import {
  applyBackReference,
  backReferenceHolder,
  findExternalDocumentIdClaim,
  claimFollowUpObligation,
  isExternalDocumentIdConflict,
  releaseFollowUpObligation,
} from '@/lib/domain/accounting/back-reference'
import { FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN, followUpObligationRecoveryFor } from '@/lib/domain/accounting/follow-up-obligation-registry'
import type { AccountingSyncType, Prisma } from '@/app/generated/prisma/client'
import { resolveStoredInvoiceUploadPath } from '@/lib/upload-storage'

const MAX_RETRIES = 5
const MAX_PER_RUN = 100 // QBO rate limit: 500/min — can handle more than Xero
const CLAIM_STALE_MS = 15 * 60 * 1000
const RATE_LIMIT_BACKOFF_BASE_MS = 10_000
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000
const QBO_CONNECTOR = 'quickbooks'

/**
 * A stored contact id, but ONLY if its provenance matches the active QuickBooks company (o3d-6nd).
 * These payment/follow-up paths read the cached id via a join rather than through
 * contacts.getStoredContactId, so they need the same guard applied here or a former realm's id leaks
 * through. Returns null when there is no id or its provenance does not match — callers already treat a
 * missing id as a clean, retryable failure.
 */
export async function customerContactIdIfCurrent(
  contact: { accountingContactId: string | null; accountingContactProvenance: string | null } | null | undefined,
): Promise<string | null> {
  if (!contact?.accountingContactId) return null
  const active = await activeAccountingIdProvenance(QBO_CONNECTOR)
  return accountingIdProvenanceMatches(contact.accountingContactProvenance, active) ? contact.accountingContactId : null
}

type ProcessResult = {
  processed: number
  succeeded: number
  failed: number
  skipped: number
}

type SyncPayload = Record<string, unknown>

/**
 * Intuit documents a 50-CHARACTER MAXIMUM for a non-batch `requestid`, and error 2130 for an invalid
 * format. A full SHA-256 hex digest is 64, so the value this has always sent was over-length
 * (o3d-nmar) — and invoices, bills and credit notes have used this same builder via
 * qboPostIdempotent all along, not just the payment path o3d-b3gw adds.
 *
 * 32 hex characters = 128 bits, which is far beyond what idempotency needs: the id only has to be
 * unique among documents this system posts, and a 128-bit digest collision is not a scenario worth
 * defending against. It leaves 18 characters of headroom under the documented limit.
 *
 * ON CHANGING AN IDEMPOTENCY KEY, deliberately. One of these was true before, and we could not tell
 * which without asking Intuit:
 *
 *   (a) Intuit tolerated over-length ids, and dedup worked. Then this change alters the key, and a
 *       request that SUCCEEDED at Intuit but whose response we lost would, if retried across the
 *       deploy, post a second time. That window is narrow: we only retry when we did not record
 *       success, and the retry has to straddle the deploy.
 *   (b) Intuit ignored the parameter when over-length. Then NO post has ever been idempotent, and
 *       there is no dedup to lose — this makes it work for the first time.
 *   (c) Intuit rejected it with 2130. Then idempotent posting was failing outright and would be
 *       loudly visible.
 *
 * Under (b) or (c) this is a strict improvement with nothing to regress. Under (a) it trades a
 * narrow one-deploy window for actually satisfying the documented contract. Staying over-length is
 * not the safe option — it is the one where we keep believing in protection we may not have.
 */
export const QBO_REQUEST_ID_MAX_LENGTH = 50
const QBO_REQUEST_ID_HEX_CHARS = 32

export function buildQboRequestId(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, QBO_REQUEST_ID_HEX_CHARS)
}

function getIdempotencySource(
  entryId: string,
  type: AccountingSyncType,
  referenceId: string,
  payload: SyncPayload,
): string {
  // o3d-h2wx: a follow-up stamped with the stable token derives from THAT, so regenerating
  // its row cannot rotate the Request-Id. Ordered above `_idempotencyKey` — which is the
  // generic queue's, set by callers this module does not own — because only the follow-up
  // token is guaranteed to be identical across a re-enqueue.
  const followUpKey = readFollowUpIdempotencyKey(payload)
  if (followUpKey) return followUpKey
  if (typeof payload._idempotencyKey === 'string') return payload._idempotencyKey
  return type.startsWith('DAILY_BATCH_') ? `${type}:${referenceId}` : entryId
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
  message?: string
}): Promise<void> {
  await updateMirroredAccountingEventStatus(client, {
    connector: QBO_CONNECTOR,
    syncLogId: params.syncLogId,
    type: params.type,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    payload: params.payload,
    status: params.status,
    externalId: params.externalId,
    message: params.message,
  })
}

/**
 * o3d-peh1 — the follow-ups this entry owes were REFUSED, so the obligation is not released.
 *
 * The Xero twin of this carries the full argument; the shape here is the same. Thrown rather than
 * branched because both post paths already handle a throw correctly: the obligation marker stays
 * claimed and the entry is retried, which is the right state for work that has not run.
 *
 * A DISTINCT CLASS, not a bare Error (Codex, this branch). "Both post paths handle a throw
 * correctly" was false of the FRESH-POST path, whose local catch treats every follow-up exception as
 * best-effort, logs it and counts the entry SUCCEEDED. That is the o3d-peh1 defect itself: the
 * parent reported settled while the money-moving child was never enqueued. The two cases THAT catch
 * has to tell apart are genuinely different, which is why the type exists rather than a string match
 * on the message:
 *
 * The SHORT-CIRCUIT path needs no such distinction and does not make one (Codex round 2, HIGH). It
 * used to have no catch at all, which sent every follow-up exception — refused or merely failed —
 * into the main-post failure handler, where a final failure stamps the mirrored AccountingEvent
 * FAILED on a document that is demonstrably in the ledger. It now catches both and routes both to
 * `markSyncLogForFollowUpRetry`, which is the transition that keeps the mirror truthful. See the
 * comment on that catch for why catching the plain failure there is not a widening.
 *
 *
 *   • a follow-up enqueue that FAILED — a transient database error. The work is still owed and the
 *     obligation marker records that; QuickBooks deliberately does not fail the entry for it, and
 *     that behaviour is unchanged here.
 *   • a follow-up enqueue that was REFUSED — the planner or the ledger fence declined, deliberately,
 *     and NOTHING WAS QUEUED. Nothing will re-drive it either: the QuickBooks repair sweep is still
 *     unwired (o3d-s36z), so on this connector the marker alone is a note to nobody. The parent must
 *     go back to being unsettled so this processor's own retry returns to it.
 */
class FollowUpEnqueueRefused extends Error {}

function requireFollowUpsEnqueued(entryId: string, outcome: FollowUpEnqueueOutcome): void {
  if (outcome.enqueued) return
  throw new FollowUpEnqueueRefused(
    `QuickBooks sync entry ${entryId} posted, but its follow-ups were REFUSED and nothing was queued: `
    + `${describeFollowUpEnqueueRefusals(outcome)}`,
  )
}

/**
 * RETURN A POSTED PARENT TO ITS UNSETTLED STATE, KEEPING THE TWO FACTS THAT MAKE IT RECOVERABLE.
 *
 * The Xero twin is `markSyncLogForFollowUpRetry`, and this is deliberately the same three-column
 * write rather than a re-use of the QuickBooks main-failure path a few lines below. BOTH posted
 * arms use it (Codex round 2, HIGH): the fresh-post arm for a refusal, the short-circuit arm for
 * every follow-up failure, because on that arm the row is only there at all by virtue of an external
 * id — a document in the ledger — and the main-failure path's terminal write would deny it:
 *
 *   • `externalTransactionId` IS NOT TOUCHED. It is post evidence — the only local record that the
 *     document is in QuickBooks — and it is also what makes the retry safe: the loop's idempotency
 *     guard reads it and short-circuits straight to the follow-ups instead of posting a second
 *     document. Dropping it would turn a retry into a duplicate.
 *   • `backReferenceFollowUpsPendingAt` IS NOT TOUCHED either. The obligation is still owed; the
 *     release runs only on the arm where the enqueue actually happened.
 *   • NO MIRRORED EVENT is written. The main-failure path stamps the mirrored AccountingEvent FAILED
 *     on a final failure, which is right when nothing posted and wrong here: this document POSTED,
 *     the mirror already says so, and overwriting it would make the ledger's own copy of the record
 *     contradict the ledger.
 *
 * Status goes back to PENDING, or FAILED once the retries are exhausted — the same bound every other
 * failure on this loop observes, so a permanently refusable row cannot spin for ever.
 */
function postedRowRetryColumns(entry: { retryCount: number }, errorMessage: string) {
  const retryCount = entry.retryCount + 1
  return {
    status: retryCount >= MAX_RETRIES ? ('FAILED' as const) : ('PENDING' as const),
    retryCount,
    errorMessage,
    processingStartedAt: null,
  }
}

async function markSyncLogForFollowUpRetry(
  entry: { id: string; retryCount: number },
  error: unknown,
): Promise<void> {
  await db.accountingSyncLog.update({
    where: { id: entry.id },
    data: postedRowRetryColumns(
      entry,
      // Covers both callers: the fresh-post arm sends only REFUSALS here, the short-circuit arm
      // sends every follow-up failure. The refusal's own text says "REFUSED and nothing was queued",
      // so the prefix does not need to claim which happened — and claiming it would be wrong for
      // half the rows that now reach this line.
      `QuickBooks follow-up work did not complete after connector post: ${String(error)}`,
    ),
  })
}

/**
 * THE SAME TRANSITION, FOR A CALLER THAT DOES NOT KNOW WHETHER THE ROW IS POSTED (Codex r4, HIGH).
 *
 * THE EXTERNAL ID IS POST EVIDENCE, AND A FAILED MIRROR CONTRADICTS A DOCUMENT THAT EXISTS. That is
 * already the established principle on this branch — {@link markSyncLogForFollowUpRetry} was written
 * for it, and round 2 moved the short-circuit arm's follow-up failures onto it for exactly this
 * reason. What round 2 did not do was make the GENERIC OUTER CATCH obey it. That handler still asked
 * only "have the retries run out?", and on the last one it stamped the mirrored AccountingEvent
 * FAILED — over a row whose `externalTransactionId` says the document is in QuickBooks.
 *
 * AND IT IS UNTRUE FOR A TRANSIENT ERROR EXACTLY AS IT IS FOR A REFUSAL. The reasons are properties
 * of the LEDGER, not of the exception: the document exists, the mirror already says POSTED, and the
 * id is what makes the retry resume at the follow-ups instead of posting a second document. A
 * database blip on a posted row is not evidence the post came undone.
 *
 * THE ROUTES THAT REACH IT. Round 2's inner catch covers the short-circuit arm's follow-up work
 * only. Everything else on that arm still lands here: the payload re-read
 * (`readClaimedSyncLogPayload`), the SYNCED/POSTED transaction itself, `logActivity`, a throw from
 * `markSyncLogForFollowUpRetry`. And on the FRESH-POST arm the row acquires an id mid-iteration —
 * `entry.externalTransactionId` is the PRE-CLAIM snapshot and is still null in memory — so a failure
 * after that transaction commits is a failure on a posted row that no in-memory test can recognise.
 * That is why this asks the DATABASE, in the statement that writes.
 *
 * FENCED, NOT READ-THEN-WRITE. `where: { externalTransactionId: { not: null } }` makes the question
 * and the answer one statement, so a post that lands between them cannot be written over — and its
 * sibling below is fenced the opposite way, so the two are mutually exclusive by construction rather
 * than by the order they are called in. `count === 0` means the row names no document (or is gone),
 * and the caller falls through to the ordinary failure.
 *
 * Writes NO mirrored event. That is the whole point, and it is why this is a separate statement from
 * the main-failure transaction rather than a flag on it.
 */
async function markPostedSyncLogRetryPreservingEvidence(
  client: Pick<Prisma.TransactionClient, 'accountingSyncLog'>,
  entry: { id: string; retryCount: number },
  errorMessage: string,
): Promise<boolean> {
  const updated = await client.accountingSyncLog.updateMany({
    where: { id: entry.id, externalTransactionId: { not: null } },
    data: postedRowRetryColumns(entry, errorMessage),
  })
  return updated.count > 0
}

/**
 * HOW MANY TIMES THE FRESH POST'S EVIDENCE TRANSACTION IS RE-DRIVEN BEFORE THE ID IS DECLARED
 * UNRECORDABLE.
 *
 * The same number and the same reasoning as the Xero side's EVIDENCE_TRANSACTION_ATTEMPTS: each
 * attempt is a WHOLE fresh transaction writing the same two rows from the same in-memory result, so
 * re-driving weakens nothing, and the common failure here is a serialization conflict or a deadlock
 * victim that would commit perfectly well a moment later. No sleep between attempts, deliberately —
 * a cron worker holding a claim is the wrong place to add latency.
 */
const POST_EVIDENCE_TRANSACTION_ATTEMPTS = 3

/**
 * THE ONE WRITE THAT TURNS A RETURNED ID INTO A FACT THE DATABASE KNOWS.
 *
 * Extracted so it can be RE-DRIVEN (below) rather than attempted once. Its contents are unchanged:
 * SYNCED + the external id + the follow-up obligation claim, and the mirrored event stamped POSTED,
 * in ONE transaction — everything after it can die without the row ever being re-posted.
 */
async function persistFreshQboPost(
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  payload: SyncPayload,
  externalId: string | null,
  /**
   * Returns THE OBLIGATION GENERATION THIS PASS MINTED (o3d-0bfh r4), or `null` when the claim did
   * not land. A pass that owns no generation has no standing to say the follow-ups are done, so the
   * value has to travel out of the transaction that took it rather than be re-read afterwards —
   * re-reading gives whichever generation is live NOW, which may be somebody else's.
   */
): Promise<Date | null> {
  return await db.$transaction(async (tx) => {
    await tx.accountingSyncLog.update({
      where: { id: entry.id },
      data: {
        status: 'SYNCED',
        externalTransactionId: externalId,
        syncedAt: new Date(),
        errorMessage: null,
        processingStartedAt: null,
      },
    })
    // The external id and the record that follow-ups are owed become durable in ONE
    // TRANSACTION (r10 finding 1) — the comment above is exactly why they have to: everything
    // after it can die without the row ever being re-posted. o3d-0bfh r4 moved the claim out of
    // the statement above and into this one so it can read the generation it replaces and report
    // the one it minted; both statements commit together, so the window is still zero.
    const claim = await claimFollowUpObligation(tx, { syncLogId: entry.id, connector: QBO_CONNECTOR })
    await updateMirroredEventForSyncLog(tx, {
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      payload,
      status: 'POSTED',
      externalId,
    })
    return claim.claimed ? claim.generation : null
  })
}

/** The one shape of the durable record, so the two places that write it cannot drift apart. */
function unpersistedQboPostRecord(incident: UnpersistedQboPost, description: string) {
  const { entry } = incident
  return {
    userId: null,
    entityType: 'SYSTEM' as const,
    entityId: entry.id,
    action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
    tag: 'sync',
    level: 'ERROR' as const,
    description: redactActivityLogText(description),
    metadata: JSON.parse(JSON.stringify(sanitizeActivityLogMetadata({
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      postedExternalId: incident.postedExternalId,
      // o3d-batch-ret r10: what the ATTEMPT did, which the operation type cannot say. See the Xero
      // builder for why an absent key must read as "not recorded" and never as a live posting.
      postingMode: incident.outcome?.postingMode ?? null,
      externalEffect: incident.outcome?.externalEffect ?? null,
      // o3d-batch-ret r12 (Codex MEDIUM): the ledger document this operation acted ON. See the Xero
      // builder — a remedy that says "open that bill" has to be able to say WHICH bill.
      ledgerTargetId: incident.outcome?.ledgerTargetId ?? null,
    }))),
  }
}

/**
 * PERSIST THE ID THIS WORKER IS HOLDING, OR ESCALATE THE DOCUMENT IT CANNOT WRITE DOWN — AND NEVER
 * FALL THROUGH TO A HANDLER THAT WOULD CALL IT A FAILED POST (Codex r5, HIGH).
 *
 * THE DEFECT. Rounds 2 and 4 fixed the cases where the row ALREADY CARRIED an external id: the
 * database could be asked, so the failure handler could establish there was a document not to
 * contradict. This is the case where it does not carry one yet. The connector returned success —
 * QUICKBOOKS ALREADY HOLDS THE DOCUMENT — and the id is recorded only by the transaction above. If
 * that transaction fails, the database never learns the id, `markPostedSyncLogRetryPreservingEvidence`
 * correctly answers "this row names no document", and the ordinary failure path writes a FAILED
 * MIRROR FOR A DOCUMENT THAT EXISTS. The evidence fence cannot help: there is no evidence, and that
 * is precisely the problem.
 *
 * WHAT THIS IS, NAMED. It is o3d-jit6 on this connector — "a commit failure after a successful post
 * discards the new document id, and the retry posts again". The full answer is a PRE-POST DISPATCH
 * RECORD, so the id has somewhere to live before the call is made; the Xero mechanism for it is in
 * flight on o3d-batch-prov and is not merged, and building a second copy of it here would be a much
 * larger change made in a hurry. The QuickBooks equivalent is filed as o3d-tr2q.
 *
 * SO THIS DOES THE SMALLER, CORRECT THING. At this point the process HOLDS the returned id and KNOWS
 * the post succeeded, so:
 *
 *   • the durable persistence is RE-DRIVEN, because the common failure is a blip, not a verdict;
 *   • if it still cannot be written, the identifier is RECORDED AND ESCALATED — an ERROR ActivityLog
 *     row under the retention exemption (evidence that expires is the same defect one layer out),
 *     plus a console line that cannot fail and cannot be swept;
 *   • and NO MIRRORED EVENT IS WRITTEN AT ALL, on any exit. A FAILED mirror contradicts a document
 *     that exists — the principle this branch has now established twice — and it is untrue here for
 *     exactly the same reason it was there: the fact is about the LEDGER, not about the exception.
 *
 * THE ROW IS LEFT ALONE on the escalation path, deliberately. Writing PENDING/FAILED over it would
 * record a post that failed, which is the falsehood being avoided; and the row still holds this
 * worker's claim, so `CLAIM_STALE_MS` later it is re-claimed and re-attempted. FOR A DOCUMENT POST
 * that re-attempt goes out under the SAME derived Intuit Request-Id, which is what makes it a
 * deduplicated replay rather than a second document. (Not a guarantee, which is why o3d-tr2q exists;
 * the record above is what makes the residual risk visible to a person rather than silent.)
 *
 * FOR THE FOUR NO-IDENTIFIER OPERATIONS IT IS NOT A DEDUPLICATED REPLAY, AND THE RECORD NOW SAYS SO.
 * `BILL_ATTACHMENT`, `INVOICE_PDF`, `INVOICE_EMAIL` and `WC_INVOICE_NOTE` reach this function on
 * exactly the same path — they succeed, they carry no external id, and nothing sent them under a
 * Request-Id — so the stale-claim reclaim REPEATS THE EFFECT: another upload, another PDF write,
 * another email to the customer, another WooCommerce note, once per sweep, unbounded. That is a real
 * open defect, filed as o3d-qn21, and it is NOT fenced here: rounds 6 and 7 built the fence out of a
 * claim-time marker and it was unsound twice over (a claim is not proof of dispatch, and a failure is
 * not proof of no effect), so the machinery was reverted and the hole was filed instead. What
 * `describeUnpersistedQboPost` does is refuse to describe a protection these four do not have — it
 * tells the operator the effect will repeat, what the effect is, and WHAT CAN AND CANNOT BE PRESSED.
 *
 * IT DOES NOT PRESCRIBE SETTLING THE ROW AT ALL (round 7), AND THAT IS A REVERSAL. Rounds 4 to 6
 * built a per-row remedy — retire QuickBooks in favour of Xero, turn `quickbooks_sync_enabled` off,
 * count, settle by adoption, turn it back on — on the premise that the toggle quiesces the
 * connector. It does not: both claim paths READ that setting and then call this processor, so a run
 * admitted before the flip still claims; its claim leaves the row at attempt revision 0, which is
 * what adoption's compare-and-swap matches; and `persistFreshQboPost` above updates the row BY ID
 * with no claim or attempt fence, so its write lands on top of a settlement. The record now says
 * turn the toggle off, LEAVE it off, and escalate the row. Do not re-add a settle instruction here
 * or there until o3d-4b5p gives this connector a real quiescence fence. The single authority on the
 * wording is `describeUnpersistedQboPost`.
 *
 * Returns whether the id is now durable, AND — o3d-0bfh r4 — the obligation generation the durable
 * write claimed. `persisted: false` means the caller must NOT continue into the follow-ups and must
 * NOT let the outer handler see this iteration; there is then no generation, which is correct, since
 * a pass whose post was never recorded has claimed nothing it could later discharge.
 */
type FreshQboPostPersistence =
  | { persisted: true; obligation: Date | null }
  | { persisted: false }

async function persistFreshQboPostOrEscalate(
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  payload: SyncPayload,
  externalId: string | null,
  /** o3d-batch-ret r10: the handler's own answer to "did anything leave this process". */
  externalEffect?: RemoteEffectOutcome,
): Promise<FreshQboPostPersistence> {
  let lastError: unknown
  for (let attempt = 0; attempt < POST_EVIDENCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return { persisted: true, obligation: await persistFreshQboPost(entry, payload, externalId) }
    } catch (error) {
      lastError = error
    }
  }

  // o3d-batch-ret r10 (Codex HIGH): THIS CONNECTOR HAS NO DRAFT FORM OF ANY DOCUMENT. Its invoice
  // module says so in as many words — "No DRAFT/AUTHORISED status distinction on creation" — and no
  // QuickBooks handler reads `_postingMode` or sends a status of any kind. So the mode is LIVE as a
  // FACT about this connector, not as a default, and a test holds the connector to it: the day a
  // draft path appears here, resolving LIVE unconditionally would be the same falsehood the Xero
  // side was corrected for.
  const outcome: PostedOperationOutcome = {
    postingMode: 'LIVE',
    externalEffect,
    // r12: the ledger document this operation acted on, read off the row's own payload.
    ledgerTargetId: ledgerTargetIdFromPayload(payload),
  }
  const incident: UnpersistedQboPost = { entry, postedExternalId: externalId, outcome }
  const description = describeUnpersistedQboPost(incident, lastError)
  // The console line FIRST, because it cannot fail and cannot be swept: at this instant it is the
  // only place the identifier is written down, and a crash inside the durable write below must still
  // leave the incident said out loud.
  console.error(`[quickbooks-sync] ${description}`)
  try {
    await db.activityLog.create({ data: unpersistedQboPostRecord(incident, description) })
  } catch (cause) {
    // Swallowed on purpose: there is nothing further to try, and throwing from here would replace an
    // escalation with a stack trace — landing in the very handler that would then write the FAILED
    // mirror this whole function exists to prevent.
    console.error(
      `[quickbooks-sync] the unrecorded-document record for sync log ${entry.id} could not be `
      + `written either: ${String(cause)}`,
    )
  }
  return { persisted: false }
}

/**
 * o3d-anu8, CROSS-PORTED FROM THE XERO PATH (Codex, this branch) — A LIVE ROW SUPPRESSES THIS WORK,
 * AND ONLY THE CONNECTOR IS ENTITLED TO.
 *
 * The live set is PENDING / PROCESSING / SYNCED, and this answer is what makes `planFollowUpEnqueue`
 * skip — SILENTLY, which is correct when SYNCED means "the ledger was told". It does not always mean
 * that any more: `buildSettlementData` writes SYNCED from a document id an OPERATOR TYPED, with
 * `settlementBasis = OPERATOR_ASSERTION` and no remote call behind it.
 *
 * Counting rows made that indistinguishable. An asserted SYNCED INVOICE_PAYMENT therefore occupied
 * the slot for ever: the real registration was never enqueued, the invoice was never settled in the
 * ledger, and a skip logs nothing to say so. That is the laundering this branch removed on the Xero
 * side, and it survived here because only the Xero lookup was taught to ask.
 *
 * So the basis is SELECTED and returned, and the planner is TOLD — it is the planner that decides
 * (withhold rather than skip-or-enqueue, money-moving types only), so that both connectors reach one
 * rule rather than each implementing their own reading of the same column.
 *
 * WORST-FIRST, as o3d-nf9i established for aggregation: one asserted occupant is enough for the
 * suppression to rest on an assertion, because any of them may be the only reason this is skipped.
 *
 * PORTED HERE (o3d-hbgo, this branch) — AND ONLY A ROW TARGETING THE SAME DOCUMENT OCCUPIES THE SLOT.
 *
 * The o3d-anu8 note that stood here said Xero's `liveRowOccupiesFollowUpSlot` was "deliberately not
 * ported: a different finding about a different defect". That was the right call for THAT branch — it
 * would have changed which rows this returns as well as how they are described — and it is the wrong
 * state to leave behind, because the defect it declined to fix is fully live on this connector:
 *
 *   A SalesOrder's invoice is deleted and re-posted to a NEW QuickBooks invoice. The SYNCED
 *   INVOICE_PAYMENT row from the FIRST invoice still matches (connector, type, referenceType,
 *   referenceId), so `exists` is true, `planFollowUpEnqueue` skips, and the REPLACEMENT invoice is
 *   never settled. Silently — a skip logs nothing. Same shape for INVOICE_PDF: the order keeps the
 *   PDF of the invoice it no longer has.
 *
 * WHAT MAKES IT SAFE TO NARROW NOW, which was not obviously true when it was declined. The partial
 * unique index `accounting_sync_logs_followup_live_unique` is keyed on the `connector` COLUMN, so
 * 20260819120000 made it anchor-scoped for BOTH connectors at once. Since then the database has
 * ALREADY permitted two live QuickBooks rows in this scope that name different documents, and this
 * coarse lookup has been the only thing standing in the way — an application guard stricter than its
 * own backstop, in the direction that loses work. Narrowing it makes the two agree rather than
 * loosening anything the database was enforcing.
 *
 * AND IT DOES NOT OPEN A DOUBLE-PAY. The rows this now lets through name a DIFFERENT invoice from
 * every live row on the order; the payment they post settles a document nothing has settled. A row
 * that records NO anchor still occupies the slot (`liveRowOccupiesFollowUpSlot` treats an unanchored
 * stored payload as matching), so legacy rows written before the payload carried one keep suppressing,
 * exactly as they do today: for money, unknown target has to read as "possibly this one".
 *
 * ONE PREDICATE, NOT A SECOND SPELLING OF IT. The comparison is imported, not copied — the two
 * connectors reach one rule, as they already do for the settlement basis below.
 *
 * `asserted` IS NARROWED WITH IT, and that is not incidental. Judged over every live row, an
 * operator's assertion about the RETIRED invoice would refuse the enqueue for the REPLACEMENT — the
 * o3d-anu8 refusal firing on a document its assertion never named, which is the same category error
 * this fix removes, arriving by the other route.
 */
async function hasExistingSyncLog(
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
): Promise<{ exists: boolean; asserted: boolean }> {
  const liveRows = await db.accountingSyncLog.findMany({
    where: {
      connector: QBO_CONNECTOR,
      type,
      referenceType,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
    // payload, because the anchors that say WHICH DOCUMENT this row settles live inside the JSON; and
    // settlementBasis, because the occupying row is what makes the enqueue a silent skip and a SYNCED
    // row is written by TWO things — the processor's writeback after QuickBooks answered, and an
    // operator typing a document id into the settlement dialog.
    select: { payload: true, settlementBasis: true },
  })
  const occupying = liveRows.filter((row) => liveRowOccupiesFollowUpSlot(row.payload, payload as FollowUpPayload))
  return {
    exists: occupying.length > 0,
    asserted: occupying.some((row) => isOperatorAssertedSettlement(row.settlementBasis)),
  }
}

/**
 * Exported for unit tests, exactly as the Xero twin is: the live-row lookup and the plan it feeds are
 * the two halves of a decision that suppresses money-moving work, and reaching them through a whole
 * post-and-follow-up loop would test the mocks rather than the decision.
 */
export async function enqueueFollowUpSyncLog(
  type: 'INVOICE_PAYMENT' | 'BILL_ATTACHMENT' | 'INVOICE_PDF' | 'INVOICE_EMAIL' | 'WC_INVOICE_NOTE',
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  /** Bounds the re-plan below, so a pathological race cannot recurse forever. */
  attempt = 0,
): Promise<FollowUpEnqueueOutcome> {
  const live = await hasExistingSyncLog(type, referenceType, referenceId, payload)
  const liveRowExists = live.exists
  // o3d-h2wx: a FAILED row is REUSED rather than replaced. The QuickBooks Request-Id is
  // derived from the entry id, so a replacement row posts the retry under a request id
  // Intuit has never seen — and if the failed attempt had actually committed, a SECOND
  // payment lands on the invoice.
  const failedLogs = liveRowExists ? [] : await db.accountingSyncLog.findMany({
    where: { connector: QBO_CONNECTOR, type, referenceType, referenceId, status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    // remoteAttemptedAt is what tells the planner whether a row's payload is the record of a call
    // that reached QuickBooks. A revival OVERWRITES the payload it recycles, so recycling an
    // attempted row rotates that attempt's token and discards its anchors, amount and date — see
    // the recycle note in followup-idempotency.ts. attemptStampingCustodyAt comes with it because
    // an unstamped row only proves anything when nothing but a STAMPING binary has handled it
    // (round 10): it is read off the row rather than resolved from a global epoch, so this path
    // needs no extra query and cannot be given a stale answer.
    select: { id: true, payload: true, remoteAttemptedAt: true, attemptStampingCustodyAt: true },
  })
  const failedRows = failedLogs.map((row) => ({
    id: row.id,
    payload: row.payload,
    // Exactly what getIdempotencySource would have produced for this row, so pinning it
    // reproduces a byte-identical Request-Id even after the row itself is gone. Note this
    // consults the generic `_idempotencyKey`, which QuickBooks has always honoured — unlike
    // Xero, whose payment branches never did.
    effectiveToken: getIdempotencySource(row.id, type, referenceId, (row.payload ?? {}) as SyncPayload),
    remoteAttemptedAt: row.remoteAttemptedAt,
    attemptStampingCustodyAt: row.attemptStampingCustodyAt,
  }))
  const plan = planFollowUpEnqueue({
    connector: QBO_CONNECTOR,
    type,
    referenceType,
    referenceId,
    payload,
    liveRowExists,
    // o3d-anu8: the flag the planner refuses on. Without it an operator's assertion reads as a
    // completed follow-up and the enqueue is skipped for ever.
    liveRowAsserted: live.asserted,
    failedRows,
  })
  // A live row already owns this scope, so the follow-up IS queued — by that row.
  if (plan.action === 'skip') return FOLLOW_UPS_ENQUEUED
  if (plan.action === 'refuse') {
    // o3d-peh1, cross-ported from the Xero side: the refusal is REPORTED TO THE CALLER, not only to
    // the activity log. QuickBooks has no back-reference sweep to be misled (see the note at the end
    // of this file), but its own post path releases the follow-up obligation on the strength of this
    // call returning, and a refusal that returns normally discharges a marker for work never done.
    const message = `Refused to re-enqueue QuickBooks ${type} for ${referenceType} ${referenceId}: ${plan.reason} `
      + 'Nothing was queued and the FAILED rows are unchanged. '
      + 'A RETRY CANNOT CLEAR THIS: the manual retry applies the same rule and refuses for the same reason. Open the '
      + 'document in QuickBooks, establish which attempt actually landed, and record that on each row with Settle on the '
      + 'accounting sync log (\'it posted, here is the id\' / \'it did not post\'). The follow-up is enqueued by the '
      + 'next sweep once the scope is no longer ambiguous.'
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: message,
      metadata: { type, referenceType, referenceId, reason: 'plan_refused', failedRowIds: failedRows.map((row) => row.id) },
    })
    return refusedFollowUpEnqueue({ type, referenceType, referenceId, reason: 'plan_refused', message })
  }

  // o3d-0m56: the AUTOMATIC path carries the identical hazard the manual retry does. Reviving a
  // money row under a PINNED token assumes the remote still recognises that token; Intuit's
  // `requestid` replay is better behaved than Xero's, but this guard exists because a lost
  // response is indistinguishable from a failed call, and "their retention is probably long
  // enough" is not evidence. So the ledger has to say the attempt is not already in it.
  const evidence = await ledgerClearsFollowUpRevival({
    connector: QBO_CONNECTOR,
    type,
    payload: plan.payload,
    tokenDisposition: plan.action === 'reuse' ? plan.tokenDisposition : 'rotated',
    syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
  })
  if (!evidence.clear) {
    const message = `Refused to re-enqueue QuickBooks ${type} for ${referenceType} ${referenceId}: `
      + `${evidence.reason}. Re-posting it could duplicate a payment, so nothing was queued and the row is `
      + 'unchanged. Open the document in QuickBooks: if that settlement IS this attempt, record it with Settle on the '
      + 'accounting sync log so the row stops being retried; if it is not, the follow-up is enqueued by the next '
      + 'sweep once the ledger no longer matches.'
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: message,
      metadata: { type, referenceType, referenceId, reason: 'ledger_not_clear', failedRowIds: failedRows.map((row) => row.id) },
    })
    return refusedFollowUpEnqueue({
      type,
      referenceType,
      referenceId,
      reason: 'ledger_not_clear',
      message,
      syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
    })
  }

  try {
    if (plan.action === 'reuse') {
      // Fenced on status: if another run revived the same row first — or retention deleted
      // it between the read and here (o3d-nepa) — this updates nothing rather than
      // resetting a claim it does not own.
      //
      // In a transaction ONLY to hold the scope lock across it, which serializes this revival
      // against the manual retry's read-then-reset for the same document (o3d-0m56).
      const revived = await db.$transaction(async (tx) => {
        await lockFollowUpScope(tx, { connector: QBO_CONNECTOR, type, referenceType, referenceId })
        return tx.accountingSyncLog.updateMany({
          where: { id: plan.syncLogId, status: 'FAILED' },
          data: {
            status: 'PENDING',
            payload: plan.payload as never,
            retryCount: 0,
            errorMessage: null,
            processingStartedAt: null,
          },
        })
      })
      if (revived.count === 0) {
        // o3d-peh1: the resolver's verdict IS this call's verdict — see the Xero twin.
        return await resolveLostFollowUpRevival({
          connector: QBO_CONNECTOR,
          type,
          referenceType,
          referenceId,
          payload: plan.payload,
          syncLogId: plan.syncLogId,
          attempt,
          // plan.payload carries the PINNED token, and withFollowUpIdempotencyKey never
          // overwrites one — so a row created by the re-plan posts under the same remote
          // key as the row that vanished. That is what makes losing the row survivable.
          retry: () => enqueueFollowUpSyncLog(type, referenceType, referenceId, plan.payload, attempt + 1),
        })
      }
      await logFollowUpRevival(QBO_CONNECTOR, type, referenceType, referenceId, plan)
      return FOLLOW_UPS_ENQUEUED
    }
    await db.$transaction(async (tx) => {
      await lockFollowUpScope(tx, { connector: QBO_CONNECTOR, type, referenceType, referenceId })
      await tx.accountingSyncLog.create({
        data: {
          connector: QBO_CONNECTOR,
          type,
          status: 'PENDING',
          referenceType,
          referenceId,
          payload: plan.payload as never,
          // o3d-0m56 r10: created INSIDE attempt-stamping custody. That is what later lets a revival
          // read this row's unset `remoteAttemptedAt` as proof no remote call ever left it — see
          // money-attempt-provenance.ts. A row created without it is never recycled again.
          ...stampingCustodyOnCreate(),
        },
      })
    })
  } catch (error) {
    // A concurrent run took the live slot and the partial unique index
    // (accounting_sync_logs_followup_live_unique) rejected ours. This used to return as an
    // idempotent no-op, which silently accepted a winner posting under a DIFFERENT token
    // while ours may already have committed (Codex review, r7 #1). It now goes through the
    // same resolver as a lost compare-and-set, which only accepts a live row carrying our
    // token.
    if (isUniqueConstraintViolation(error)) {
      return await resolveLostFollowUpRevival({
        connector: QBO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
        attempt,
        retry: () => enqueueFollowUpSyncLog(type, referenceType, referenceId, plan.payload, attempt + 1),
      })
    }
    throw error
  }
  return FOLLOW_UPS_ENQUEUED
}

/**
 * o3d-0m56 round 10: make a custody forfeit VISIBLE.
 *
 * `repairMoneyAttemptsOutsideStampingCustody` stamps money rows that a binary outside stamping
 * custody may have posted from — rows created during a deploy window, by an overlapping second
 * instance, or by a version this one was rolled back to. Zero on every ordinary run: a non-zero
 * count is the only signal that any of those happened, and it is worth an operator seeing, because
 * each stamped row is a row whose next post now pays for a ledger read.
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

export async function processPendingQuickBooksSync(): Promise<ProcessResult> {
  // Before any entry is CLAIMED or posted — see the note on processPendingXeroSync. The repair is
  // per DATABASE, not per connector: it stamps every money row outside stamping custody whichever
  // connector wrote it, so whichever processor runs first repairs for both.
  await reportMoneyAttemptCustodyRepair(await repairMoneyAttemptsOutsideStampingCustody(), QBO_CONNECTOR)
  const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0 }
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MS)

  const pending = await db.accountingSyncLog.findMany({
    where: {
      connector: QBO_CONNECTOR,
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

  for (const entry of pending) {
    const claimedAt = new Date()
    // The claim, attempt-stamping CUSTODY and the refusal that makes restoring custody safe are ONE
    // `updateMany` argument (o3d-0m56 r10, o3d-anu8 r3). A claim is what precedes a post, so the
    // database reads a claim that does not re-assert custody as one made by a binary that does not
    // stamp, and forfeits it. And custody is not restored to a money row that carries neither
    // custody nor an attempt stamp: that pair means "an old binary had this and may have posted
    // from it", and re-granting custody would rewrite it into proof that nothing was ever sent.
    // See money-attempt-provenance.ts.
    const claim = await db.accountingSyncLog.updateMany(stampingCustodyOnClaim({
      where: {
        id: entry.id,
        connector: QBO_CONNECTOR,
        retryCount: { lt: MAX_RETRIES },
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
      },
      processingStartedAt: claimedAt,
      data: {
        status: 'PROCESSING',
        // Attempt-stamping custody moves with the claim through `stampingCustodyOnClaim` above
        // (o3d-0m56 r10 / o3d-anu8 r3), which wraps this whole argument.
      },
    }))
    if (claim.count === 0) continue

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

    try {
      payload = await readClaimedSyncLogPayload(db, entry.id) as SyncPayload
      // Idempotency guard: if a previous run already posted to QBO but failed
      // during follow-up work, don't re-post. Skip straight to follow-ups.
      if (entry.externalTransactionId) {
        const obligation = await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
            },
          })
          // Claimed in the SYNCED TRANSACTION, exactly as Xero does (r10 finding 1) — and since
          // o3d-0bfh r4 as a second statement inside it rather than a fragment of the first, so the
          // claim can READ the generation it replaces and hand back the one it minted. The update
          // above already holds this row's exclusive lock, which is what makes that read-then-CAS
          // unlosable. See the block above enqueueFollowUps at the end of this file for why the
          // marker is set here even though NOTHING on this connector reads it back.
          const claim = await claimFollowUpObligation(tx, { syncLogId: entry.id, connector: QBO_CONNECTOR })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: entry.externalTransactionId,
          })
          return claim.claimed ? claim.generation : null
        })
        // EVERY FOLLOW-UP FAILURE ON THIS ARM IS CAUGHT HERE, AND NONE OF THEM MAY REACH THE
        // MAIN-POST FAILURE HANDLER (Codex round 2, HIGH).
        //
        // Round 1 gave the refusal its own transition on the FRESH-POST arm and left this one
        // relying on the outer handler, reasoning that it "retries the row with the obligation still
        // claimed". It does retry it — and on the LAST retry it also stamps the mirrored
        // AccountingEvent FAILED, a few lines after this very branch wrote that same event POSTED.
        // A row is only in this branch because `externalTransactionId` is set, i.e. because the
        // document IS in QuickBooks, so the outer handler's terminal write records a live ledger
        // document as a failed post — worse than the defect round 1 closed.
        //
        // Round 1 had already written down why: `markSyncLogForFollowUpRetry` writes NO mirrored
        // event precisely because "this document POSTED, the mirror already says so, and overwriting
        // it would make the ledger's own copy of the record contradict the ledger". That reasoning
        // applies to this arm most of all, and it was the one arm not using the transition.
        //
        // So the follow-up work takes a catch of its own — the same shape as the Xero twin, which
        // has had one since o3d-nepa — routed to the follow-up-only retry transition. Nothing else
        // moves: the entry is still counted FAILED, still bounded by MAX_RETRIES, still keeps its
        // external id and its obligation marker, and still re-enters this short-circuit on the next
        // pass rather than posting a second document.
        //
        // CATCH-ALL, NOT `instanceof FollowUpEnqueueRefused`. The narrow catch belongs to the
        // FRESH-POST arm, where a plain follow-up failure is deliberately best-effort and falls
        // through to `succeeded` (o3d-peh1, and the test that pins it). Nothing on THIS arm was ever
        // best-effort: every exception here already counted FAILED, through the outer handler. So
        // for a plain failure the only thing that changes is WHICH transition records it, and it is
        // the transition that does not contradict the ledger.
        try {
          const link = await updateBackReference(entry.id, entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
          // o3d-0bfh r15: the generation this pass claimed goes DOWN to the deferred-receipt re-drive,
          // so its final re-read and this release commit together under the sales-order lock. It is
          // withheld when the LINK did not land: the marker is then the record of that debt too, and
          // the receipt fence knows nothing about it (`settleFollowUpObligation` keeps it below).
          const followUps = await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId },
            backReferenceLeavesNothingOwed(link) ? obligation : null)
          // o3d-peh1: a REFUSED enqueue throws here for the same reason a failed one does — the
          // release below must not discharge a marker for work that was never queued. It throws into
          // THIS arm's own catch, not the outer handler, which is the whole point of the block above.
          requireFollowUpsEnqueued(entry.id, followUps)
          // Only reached when the enqueue did NOT throw — and on this arm a throw is caught directly
          // above, so the obligation simply stays claimed, which is the correct state for work that
          // has not run.
          //
          // AND NOT THROWING IS NOT THE SAME AS NOTHING BEING OWED (o3d-ekn8 r5): the back-reference
          // write swallows its failure and the deferred-receipt re-drive is built never to throw, so
          // the discharge asks both of them instead of inferring it from the absence of an exception.
          // That is a THIRD silent answer beside the refusal above, and each is invisible to the
          // others: nothing queued, money queued but not landed, and a link that never wrote.
          await settleFollowUpObligation(entry, link, followUps, obligation)
        } catch (followUpError) {
          await logActivity({
            entityType: 'SYSTEM',
            action: 'quickbooks_followup_error',
            tag: 'sync',
            level: 'ERROR',
            description: `QuickBooks sync entry ${entry.id} is already posted (${entry.externalTransactionId}) but its `
              + `follow-up work could not be completed: ${String(followUpError)}. The document is in QuickBooks and the `
              + 'entry keeps its external id, so a retry resumes at the follow-ups rather than posting again.',
            metadata: {
              syncLogId: entry.id,
              type: entry.type,
              referenceType: entry.referenceType,
              referenceId: entry.referenceId,
              externalTransactionId: entry.externalTransactionId,
            },
            // A log write that fails must not throw out of the catch and land in the main-post
            // failure handler — which is the entire hazard this block exists to remove.
          }).catch(() => { /* the announcement is best-effort; the transition below is not */ })
          await markSyncLogForFollowUpRetry(entry, followUpError)
          result.failed++
          continue
        }
        result.succeeded++
        continue
      }

      const syncResult = await processEntry(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, claimedAt)

      if (syncResult.skipped) {
        // processEntry already terminalised this row (its order was cancelled — o3d-5rs/o3d-ejg).
        // Nothing was posted, so do NOT mark it SYNCED/POSTED; it is a resolved no-op.
        result.skipped++
        continue
      }
      if (syncResult.success) {
        // Persist external ID and SYNCED status BEFORE any follow-up work.
        // If follow-ups fail, the next retry will see externalTransactionId
        // and skip the QBO write (idempotency guard above).
        //
        // AND IF THAT PERSISTENCE ITSELF FAILS, THIS ITERATION ENDS HERE (Codex r5, HIGH). The
        // document is in QuickBooks and the id is in this process's memory; letting the throw reach
        // the outer handler would produce a FAILED mirror for a document that exists, and the
        // evidence fence there cannot stop it because the database has no evidence yet. See
        // persistFreshQboPostOrEscalate: the write is re-driven, and an id that still cannot be
        // recorded is escalated rather than denied.
        // o3d-0bfh r4: AND IT HANDS BACK THE GENERATION IT CLAIMED, rather than the claim being a
        // fragment of the SYNCED update. The claim reads the generation it replaces and reports the
        // one it minted, inside the same transaction, so the release below is fenced on a value no
        // overlapping pass can also be holding. Extracting the transaction into the escalating
        // helper is what made it a return value instead of a write nobody could name.
        const persistence = await persistFreshQboPostOrEscalate(
          entry, payload, syncResult.externalId ?? null, syncResult.externalEffect,
        )
        if (!persistence.persisted) {
          result.failed++
          continue
        }
        const obligation = persistence.obligation

        // Follow-up work (back-references, enqueue PDF/email/payment).
        // These are best-effort: if they fail, the external post is already
        // safely recorded and won't be replayed.
        try {
          const link = await updateBackReference(entry.id, entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          // o3d-0bfh r15: see the sibling call above — the generation travels down so the release is
          // fenced by the order lock, and is withheld when the link itself is still owed.
          const followUps = await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult,
            backReferenceLeavesNothingOwed(link) ? obligation : null)
          // o3d-peh1: and a REFUSED enqueue throws, exactly as a failed one does. Distinct from
          // both answers the settle helper reads below — a link that did not land and a receipt
          // that did not reach the ledger — because this one queued nothing at all.
          requireFollowUpsEnqueued(entry.id, followUps)
          // o3d-ekn8 r5, Codex HIGH: released only if the link landed AND the receipts recorded
          // before this invoice reached the ledger. Neither of those failures throws, so both had
          // been arriving here as success and clearing the row's last record of the work.
          await settleFollowUpObligation(entry, link, followUps, obligation)
        } catch (followUpError) {
          // ERROR, not WARNING: the external post is committed and this entry is about to be
          // marked succeeded, so nothing will drive these follow-ups again. A payment or PDF
          // that never got enqueued is silently missing until someone notices, and at WARNING
          // nobody does (Codex review, r6).
          //
          // The obligation is deliberately NOT released here (r10 finding 1). This branch marks the
          // entry succeeded regardless, so the row is about to look identical to one whose
          // follow-ups ran — the marker is the only thing left that says otherwise. It is EVIDENCE,
          // not a work queue: no QuickBooks sweep reads it (o3d-8prh). See the block at the end of
          // this file.
          //
          // THE ERROR BELOW IS NO LONGER THE ONLY NOTICE (o3d-0bfh r6, Codex HIGH). It used to be —
          // written with `logActivity`, which swallows a failed insert and resolves `void`, so a
          // transient failure of that one write left this stalled payment/PDF/email invisible while
          // the entry was counted successful. The retained marker is now surfaced as an operational
          // backlog in the exception inbox, so the operator-visible record of the debt is the ROW,
          // already committed; `reportRetainedObligation` additionally reports a lost notice to
          // stderr instead of discarding it.
          await reportRetainedObligation({
            action: 'quickbooks_followup_error',
            level: 'ERROR',
            // o3d-0bfh r8 (Codex HIGH): this used to say the follow-up work "was NOT enqueued" and
            // that it "needs to be re-driven manually". BOTH are unestablished, and the second is
            // dangerous. `enqueueFollowUps` writes each follow-up as its own local row and enqueues
            // INVOICE_PAYMENT BEFORE INVOICE_PDF, so the ordinary way this branch is reached leaves
            // a payment already PENDING in the queue; telling an operator to re-drive it by hand is
            // telling them to create a second, undeduplicable payment against one invoice.
            description: `QuickBooks sync entry ${entry.id} posted successfully but its follow-up pass stopped `
              + `partway: ${String(followUpError)}. HOW FAR IT GOT IS NOT KNOWN FROM HERE — the follow-ups are `
              + 'enqueued one at a time as separate local rows, so some may already be queued and due to execute. '
              + 'The document is in QuickBooks and the row is listed in the exception inbox at /sync/exceptions '
              + 'under "Accounting follow-ups owed, with nothing to re-drive them". '
              + FOLLOW_UP_OBLIGATION_OUTCOME_IS_UNKNOWN,
            metadata: { syncLogId: entry.id, type: entry.type, referenceType: entry.referenceType, referenceId: entry.referenceId },
            syncLogId: entry.id,
          })
          // o3d-peh1, cross-ported from the Xero side (Codex, this branch) — A REFUSAL IS NOT A
          // BEST-EFFORT FAILURE, AND THIS CATCH WAS ABSORBING BOTH.
          //
          // `requireFollowUpsEnqueued` was added above so that a refused enqueue could not be read as
          // success. On this branch it could: the throw landed here, was logged, and execution fell
          // through to `result.succeeded++` one line down — the parent stamped SYNCED and counted
          // settled while the money-moving child was never queued. That is the exact defect
          // o3d-peh1 exists to fix, surviving on the other connector because only the Xero caller was
          // changed to act on the refusal.
          //
          // So the parent goes back to UNSETTLED, keeping its external id and its obligation marker
          // (see markSyncLogForFollowUpRetry for why each of those is load-bearing), and the entry is
          // counted FAILED. Nothing is re-posted: the retry finds the external id and takes the
          // idempotency short-circuit straight to the follow-ups.
          //
          // A plain follow-up FAILURE still falls through to `succeeded` exactly as before. It is a
          // transient error whose work the obligation marker records, and turning that into a retry
          // here would be a second change wearing this one's clothes.
          if (followUpError instanceof FollowUpEnqueueRefused) {
            await markSyncLogForFollowUpRetry(entry, followUpError)
            result.failed++
            continue
          }
        }

        result.succeeded++
      } else {
        const errorMessage = syncResult.error ?? 'Unknown error'
        if (isRateLimitError(errorMessage)) {
          await db.accountingSyncLog.updateMany(stampingCustodyOnClaim({
            where: { id: entry.id },
            processingStartedAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
            data: {
              status: 'PENDING',
              errorMessage,
            },
          }))
        } else {
          const retryCount = entry.retryCount + 1
          const finalFailure = retryCount >= MAX_RETRIES
          await db.$transaction(async (tx) => {
            await tx.accountingSyncLog.update({
              where: { id: entry.id },
              data: {
                status: finalFailure ? 'FAILED' : 'PENDING',
                retryCount,
                errorMessage,
                processingStartedAt: null,
              },
            })
            if (finalFailure) {
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
          })
        }
        result.failed++
      }
    } catch (e) {
      const errorMessage = String(e)
      if (isRateLimitError(errorMessage)) {
        // Not evidence-aware, and does not need to be: a backoff writes no mirrored event at all, so
        // there is nothing here that could contradict a document in the ledger. It still re-asserts
        // custody on the claim (o3d-anu8), which is a separate rule and not one this may drop.
        await db.accountingSyncLog.updateMany(stampingCustodyOnClaim({
          where: { id: entry.id },
          processingStartedAt: new Date(Date.now() + getRateLimitBackoffMs(entry.retryCount, errorMessage)),
          data: {
            status: 'PENDING',
            errorMessage,
          },
        }))
      } else {
        const retryCount = entry.retryCount + 1
        const finalFailure = retryCount >= MAX_RETRIES
        await db.$transaction(async (tx) => {
          // EVIDENCE FIRST (Codex r4, HIGH). THE EXTERNAL ID IS POST EVIDENCE, AND A FAILED MIRROR
          // CONTRADICTS A DOCUMENT THAT EXISTS — so before this handler may record a failed post it
          // has to establish that there is no post to contradict, and it has to do that against the
          // DATABASE. `entry` is the PRE-CLAIM snapshot: on the fresh-post arm the row acquires its
          // id mid-iteration and `entry.externalTransactionId` is still null in memory, so an
          // in-memory test would answer "not posted" about a document that is in QuickBooks.
          //
          // Round 3 closed the follow-up ROUTE on the short-circuit arm. Everything else on that arm
          // still arrives here — the payload re-read, the SYNCED/POSTED transaction, the activity
          // write, a throw from the follow-up transition itself — and arrived at a handler that, on
          // the last retry, stamped the mirrored event FAILED over the POSTED one written moments
          // earlier. It is untrue for a transient error exactly as it is for a refusal: the reasons
          // are facts about the ledger, not about the exception.
          //
          // TWO MUTUALLY EXCLUSIVE FENCED STATEMENTS, one transaction. Each carries the opposite
          // predicate on `externalTransactionId`, so which one applies is decided by the row at the
          // moment of the write rather than by a read taken before it — a post that commits between
          // them cannot be written over, and neither can both land.
          if (await markPostedSyncLogRetryPreservingEvidence(tx, entry, errorMessage)) return
          const failed = await tx.accountingSyncLog.updateMany({
            where: { id: entry.id, externalTransactionId: null },
            data: {
              status: finalFailure ? 'FAILED' : 'PENDING',
              retryCount,
              errorMessage,
              processingStartedAt: null,
            },
          })
          // AND THE MIRROR FOLLOWS THE WRITE THAT LANDED, not the intention. `count === 0` here means
          // the row named a document by the time this statement ran (or is gone) — either way this
          // handler has recorded nothing, and a FAILED mirror written beside a write that matched
          // nothing would be the same lie by another route.
          if (failed.count > 0 && finalFailure) {
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
        })
      }
      result.failed++
    }
  }

  const skippedCount = await db.accountingSyncLog.count({
    where: { connector: QBO_CONNECTOR, status: 'FAILED', retryCount: { gte: MAX_RETRIES } },
  })
  // Add, don't overwrite: the loop above already counted per-run skips (e.g. cancelled-order invoice
  // retirements, o3d-5rs/o3d-ejg) that this exhausted-FAILED count must not erase.
  result.skipped += skippedCount

  if (result.processed > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_sync_batch',
      tag: 'sync',
      description: `QuickBooks sync: ${result.succeeded} synced, ${result.failed} failed out of ${result.processed} processed`,
      metadata: result,
    })
  }

  return result
}

async function processEntry(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  // o3d-550x: the instant this worker claimed the row. Still needed after o3d-e2mz — this connector
  // mints no attempt revision, so the claim is the ONLY fence its cancelled-order retirement has.
  claimedAt: Date,
): Promise<{
  success: boolean
  externalId?: string
  invoiceNumber?: string
  error?: string
  skipped?: boolean
  /**
   * o3d-batch-ret r10 (Codex MEDIUM): DID THIS HANDLER TOUCH QUICKBOOKS AT ALL? Set only by the
   * handlers that can succeed WITHOUT a remote call — `BILL_ATTACHMENT` returns success and uploads
   * nothing when `quickbooks_sync_attach_pdf` is 'false'. Absent means "not recorded".
   */
  externalEffect?: RemoteEffectOutcome
}> {
  const requestId = buildQboRequestId(getIdempotencySource(entryId, type, referenceId, payload))

  switch (type) {
    case 'SALES_INVOICE': {
      // Cancelled-order backstop, parity with the Xero processor (o3d-5rs / o3d-ejg): re-read the order
      // status before posting. A SALES_INVOICE queued at import can be cancelled before it drains (cancel
      // is only allowed pre-dispatch, so no revenue) — never post an invoice for a cancelled sale. Fail
      // CLOSED on an unreadable/missing order; retire THIS claimed row (claim-fenced) if cancelled.
      // Residual (same as the Xero backstop): cancellation can still commit AFTER this read but before
      // the irreversible QBO POST (a lock-less TOCTOU). Fully closing it needs a posting-intent/lock
      // protocol coordinating cancellation with posting — tracked cross-connector as o3d-7o0.
      let customerId: string | undefined
      if (referenceType === 'SalesOrder') {
        let so: { customerId: string | null; status: string } | null
        try {
          so = await db.salesOrder.findUnique({ where: { id: referenceId }, select: { customerId: true, status: true } })
        } catch (error) {
          return { success: false, error: `Could not read sales order ${referenceId} status before posting: ${String(error)}` }
        }
        if (!so) {
          return { success: false, error: `Sales order ${referenceId} not found before posting an invoice` }
        }
        if (so.status === 'CANCELLED') {
          // o3d-550x (Codex r2, medium 2): the retirement fences on the claim as it reads AT THE WRITE,
          // so it is handed the CLAIM rather than an instant. This connector never renews one, so the
          // holder answers the instant it was given — the behaviour is unchanged, and the day a renewing
          // lease appears here the holder is what changes, not this call.
          //
          // o3d-e2mz: this processor mints NO attempt revision, so it has no attempt to name and stays
          // at UNCLAIMED_ATTEMPT_REVISION permanently. The retirement therefore runs on the claim fence
          // alone and leaves the row at revision 0 rather than forging an attempt that never existed.
          // Fencing this connector is out of scope.
          await db.$transaction((tx) => retireSalesInvoiceForCancelledOrder(
            tx,
            { id: entryId, attemptRevision: UNCLAIMED_ATTEMPT_REVISION },
            referenceId,
            claimHeldFrom(claimedAt),
          ))
          return { success: true, skipped: true }
        }
        customerId = so.customerId ?? undefined
      }
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
      }, undefined, { customerId, requestId })
      return { success: invoiceResult.success, externalId: invoiceResult.invoiceId, invoiceNumber: invoiceResult.invoiceNumber, error: invoiceResult.error }
    }

    case 'PURCHASE_INVOICE': {
      const supplier = referenceType === 'PurchaseOrder'
        ? await db.purchaseOrder.findUnique({
            where: { id: referenceId },
            select: { supplierId: true },
          }).catch(() => null)
        : null
      const billResult = await pushPurchaseBill({
        invoiceNumber: payload.invoiceNumber as string | undefined,
        contactName: payload.contactName as string,
        date: payload.date as string,
        dueDate: payload.dueDate as string | undefined,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
      }, undefined, { supplierId: supplier?.supplierId, requestId })
      return { success: billResult.success, externalId: billResult.invoiceId, error: billResult.error }
    }

    case 'SALES_INVOICE_UPDATE':
    case 'PURCHASE_INVOICE_UPDATE':
      return { success: false, error: `${type} is not supported by the QuickBooks sync processor yet` }

    case 'CREDIT_NOTE': {
      const creditCustomerId = referenceType === 'SalesOrderRefund'
        ? (await db.salesOrderRefund.findUnique({
            where: { id: referenceId },
            select: { order: { select: { customerId: true } } },
          }).catch(() => null))?.order.customerId ?? undefined
        : undefined
      const creditResult = await pushCreditMemo({
        creditNoteNumber: payload.creditNoteNumber as string,
        contactName: payload.contactName as string,
        contactEmail: payload.contactEmail as string | undefined,
        date: payload.date as string,
        currency: payload.currency as string,
        currencyRateToBase: payload.currencyRateToBase as number | undefined,
        lines: payload.lines as Array<{ itemCode?: string; description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string }>,
        reference: payload.reference as string | undefined,
        lineAmountsIncludeTax: payload.lineAmountsIncludeTax as boolean | undefined,
      }, undefined, { customerId: creditCustomerId, requestId })
      return { success: creditResult.success, externalId: creditResult.creditNoteId, error: creditResult.error }
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
      // Resolve customer ref: prefer payload, fall back to order's customer.
      // RESIDUAL (o3d-gfh): payload.customerRef is a naked id stamped at ENQUEUE time and is NOT
      // provenance-checked here — the payment row carries no provenance to check it against. A payment
      // queued under realm A and processed after a disconnect+reconnect to realm B would send A's id (and
      // the equally tenant-owned accountingInvoiceId/bankAccountId) to B. The fallback DB read below IS
      // guarded (o3d-6nd); closing the payload path needs the queued row stamped with its connection and
      // the whole payment context validated at execution, tracked in o3d-gfh.
      let customerRefId = payload.customerRef as string | undefined
      if (!customerRefId && referenceType === 'SalesOrder') {
        const order = await db.salesOrder.findUnique({
          where: { id: referenceId },
          select: { customer: { select: { accountingContactId: true, accountingContactProvenance: true } } },
        })
        // Provenance-guarded (o3d-6nd): a contact id issued by a former realm must not be sent to the
        // active company. A mismatch reads as "no id" and surfaces the existing missing-reference error,
        // so the payment fails cleanly and retries rather than posting against the wrong company.
        customerRefId = (await customerContactIdIfCurrent(order?.customer)) ?? undefined
      }
      if (!customerRefId) {
        return { success: false, error: 'Missing customer reference for INVOICE_PAYMENT — customer has no QuickBooks contact ID' }
      }
      const accountRef = await resolveAccountRef(bankAccountId)
      if (!accountRef) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced QuickBooks chart of accounts` }
      }
      // o3d-cjt8 / o3d-anu8, CROSS-PORTED FROM THE XERO PATH (Codex, this branch) — CAPACITY IS
      // MEASURED HERE, WHERE NO ENQUEUE PATH CAN ROUTE AROUND IT.
      //
      // The Xero INVOICE_PAYMENT case has run `guardInvoicePaymentCapacity` since o3d-cjt8, and
      // o3d-anu8 gave it the ASSERTED_REGISTRATION arm: a sibling registration that is SYNCED only
      // because an OPERATOR asserted it posted carries an `amount` IMS INTENDED to send and never
      // sent, so subtracting it from the invoice total produces a confident number measured from
      // nothing. The QuickBooks branch went straight from validating its own payload to the money
      // fence, so on this connector that sibling was not merely trusted indirectly — it was never
      // looked at.
      //
      // THE SAME GUARD, NOT A QUICKBOOKS-SHAPED ONE. It is already connector-parameterised, and its
      // own header says why a second definition would be wrong: two guards with two readings of "how
      // much of this invoice is already settled" disagree about the question they both exist to
      // answer. A narrower port refusing only on ASSERTED_REGISTRATION would BE that second
      // definition, so the whole verdict is adopted — including WOULD_OVERPAY, LEDGER_AMOUNT_UNKNOWN
      // and AMBIGUOUS_FAILED_REGISTRATION, which this connector had no equivalent of.
      //
      // Immediately before the money fence and AFTER the local validations, so a refusal is reached
      // only by a payment that was otherwise ready to send. Fails CLOSED on anything it cannot
      // measure, and on a genuine refusal retires the row as CANCELLED — provably accurate, because
      // this runs BEFORE the remote call, so nothing was sent. Claim-fenced through `claimHeldFrom`,
      // exactly as this connector's cancelled-order invoice retirement already is.
      const capacity = await guardInvoicePaymentCapacity(db, {
        connector: QBO_CONNECTOR,
        entryId,
        referenceType,
        referenceId,
        accountingInvoiceId,
        amount,
      })
      if (!capacity.post) {
        if (capacity.kind === 'unmeasurable') return { success: false, error: capacity.message }
        const retired = await db.$transaction((tx) => retireOverSettlingInvoicePayment(tx, {
          entryId,
          claim: claimHeldFrom(claimedAt),
          reason: capacity.message,
        }))
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: referenceId,
          // The refusals need an operator to do DIFFERENT things — reconcile an over-settlement,
          // versus find out what the ledger actually holds — so they are not filed under one action
          // name that would make the second read as the first. Same split as the Xero path.
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
      // o3d-0m56: the LAST check before money moves, AND the lock the post is made under. This
      // entry may have posted before — a committed call whose response was lost is FAILED, and
      // the row returns to PENDING for several more attempts. Everything that happens earlier
      // (the retry guard, the revival guard) is operator feedback; this is the reading the POST
      // itself depends on. Round 4: the read and the post are inside one per-document lock, so a
      // competing row cannot slip its own post between them — the post is the callback for
      // exactly that reason.
      return postMoneyUnderLedgerFence({
        connector: QBO_CONNECTOR, entryId, type, referenceType, referenceId, payload, db,
        // The date this post is SENDING, carried rather than re-resolved (round 7, Codex HIGH #1):
        // the fence must authorise against the very day the call below creates, and a second
        // wall-clock read here is a second day whenever the two straddle a UTC midnight.
        postingDate: paymentDate,
      }, async () => {
        try {
          // o3d-b3gw: idempotent, like every other document this connector posts. Without a
          // stable Request-Id, a payment that QuickBooks COMMITS but whose response is lost — or
          // whose local "mark SYNCED" write then fails — is retried and creates a SECOND payment
          // against the same invoice. That over-settles it and needs a manual reversal.
          const paymentRes = await qboPostIdempotent<{ Payment: { Id: string } }>('payment', {
            CustomerRef: { value: customerRefId },
            TotalAmt: amount,
            // o3d-0m56: IMS's own mark, so a later attempt can recognise THIS payment even if its
            // amount or date has since been corrected. PrivateNote is not customer-visible, and it
            // is derived from the same source the Request-Id is built from.
            PrivateNote: settlementMarkerFor(getIdempotencySource(entryId, type, referenceId, payload)),
            TxnDate: paymentDate,
            DepositToAccountRef: accountRef,
            Line: [{
              Amount: amount,
              LinkedTxn: [{ TxnId: accountingInvoiceId, TxnType: 'Invoice' }],
            }],
          }, requestId)
          if (!paymentRes.ok) {
            return { success: false, error: paymentRes.error ?? 'Failed to post QuickBooks payment' }
          }
          return { success: true, externalId: paymentRes.data?.Payment?.Id }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      })
    }

    case 'BILL_PAYMENT': {
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
      // Resolve vendor ref: prefer payload, fall back to PO's supplier.
      // Same residual as INVOICE_PAYMENT above — payload.vendorRef is unchecked; see o3d-gfh.
      let vendorRefId = payload.vendorRef as string | undefined
      if (!vendorRefId && referenceType === 'PurchaseInvoice') {
        const invoice = await db.purchaseInvoice.findUnique({
          where: { id: referenceId },
          select: { po: { select: { supplier: { select: { accountingContactId: true, accountingContactProvenance: true } } } } },
        })
        // Provenance-guarded (o3d-6nd) — see INVOICE_PAYMENT above.
        vendorRefId = (await customerContactIdIfCurrent(invoice?.po?.supplier)) ?? undefined
      }
      if (!vendorRefId) {
        return { success: false, error: 'Missing vendor reference for BILL_PAYMENT — supplier has no QuickBooks contact ID' }
      }
      const accountRef = await resolveAccountRef(bankAccountId)
      if (!accountRef) {
        return { success: false, error: `Bank account ${bankAccountId} not found in synced QuickBooks chart of accounts` }
      }
      // o3d-0m56: the LAST check before money moves, AND the lock the post is made under. This
      // entry may have posted before — a committed call whose response was lost is FAILED, and
      // the row returns to PENDING for several more attempts. Everything that happens earlier
      // (the retry guard, the revival guard) is operator feedback; this is the reading the POST
      // itself depends on. Round 4: the read and the post are inside one per-document lock, so a
      // competing row cannot slip its own post between them — the post is the callback for
      // exactly that reason.
      return postMoneyUnderLedgerFence({
        connector: QBO_CONNECTOR, entryId, type, referenceType, referenceId, payload, db,
        // The date this post is SENDING, carried rather than re-resolved (round 7, Codex HIGH #1):
        // the fence must authorise against the very day the call below creates, and a second
        // wall-clock read here is a second day whenever the two straddle a UTC midnight.
        postingDate: paymentDate,
      }, async () => {
        try {
          // o3d-b3gw: same reasoning as the customer payment above — a lost response must not
          // become a second bill payment.
          const paymentRes = await qboPostIdempotent<{ BillPayment: { Id: string } }>('billpayment', {
            VendorRef: { value: vendorRefId },
            TotalAmt: amount,
            // See INVOICE_PAYMENT above — the same mark, from the same source as the Request-Id.
            PrivateNote: settlementMarkerFor(getIdempotencySource(entryId, type, referenceId, payload)),
            TxnDate: paymentDate,
            // o3d-0m56 round 4: this PayType is why the probe must look for `BillPaymentCheck` —
            // that, not `BillPayment`, is the TxnType QuickBooks records on the bill it settles.
            PayType: 'Check',
            CheckPayment: { BankAccountRef: accountRef },
            Line: [{
              Amount: amount,
              LinkedTxn: [{ TxnId: accountingInvoiceId, TxnType: 'Bill' }],
            }],
          }, requestId)
          if (!paymentRes.ok) {
            return { success: false, error: paymentRes.error ?? 'Failed to post QuickBooks bill payment' }
          }
          return { success: true, externalId: paymentRes.data?.BillPayment?.Id }
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
      const attachEnabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_attach_pdf' } })
      if (attachEnabled?.value === 'false') {
        // NOTHING LEAVES THIS PROCESS, and the record has to be able to say so (r10, Codex MEDIUM).
        return { success: true, externalEffect: 'NONE' }
      }
      try {
        const relPath = supplierInvoicePath.replace(/^\/+/, '')
        const pdfPath = resolveStoredInvoiceUploadPath(relPath)
        if (!pdfPath) {
          return { success: false, error: 'Invalid supplier invoice PDF path' }
        }
        const pdfBuffer = await readFile(pdfPath)
        const filename = relPath.split('/').pop() ?? 'supplier-invoice.pdf'
        const uploadRes = await qboUploadAttachment('Bill', accountingInvoiceId, filename, pdfBuffer, 'application/pdf')
        if (!uploadRes.ok) {
          return { success: false, error: uploadRes.error ?? 'Failed to attach supplier invoice PDF' }
        }
        // An attachment now exists on that bill — no accounting document, but not nothing either.
        return { success: true, externalEffect: 'MADE' }
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
        const { downloadQuickBooksInvoicePdf, saveInvoicePdf } = await import('./invoice-pdf')
        const pdfBuffer = await downloadQuickBooksInvoicePdf(accountingInvoiceId)
        if (!pdfBuffer) return { success: false, error: 'Failed to download QuickBooks invoice PDF' }
        const pdfSavePath = await saveInvoicePdf(orderId, pdfBuffer)
        await db.salesOrder.update({
          where: { id: orderId },
          data: { invoicePdfPath: pdfSavePath },
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

    case 'COGS_JOURNAL':
    case 'INVENTORY_ADJUSTMENT':
    case 'STOCK_IN_TRANSIT':
    case 'STOCK_RECEIPT':
    case 'COGS_REVERSAL':
    case 'STOCK_ALLOCATION':
    case 'DAILY_BATCH_REVENUE_DEFERRAL':
    case 'DAILY_BATCH_INVENTORY_ALLOC':
    case 'DAILY_BATCH_GROUP_B':
    case 'UNEARNED_REV_REVERSAL':
    case 'REALISED_FX_JOURNAL':
    case 'UNREALISED_FX_JOURNAL':
    case 'MANUFACTURING_JOURNAL':
    case 'MANUFACTURING_RECLASS': {
      const journalResult = await pushJournalEntry({
        date: payload.date as string,
        reference: payload.reference as string,
        narration: payload.narration as string,
        lines: payload.lines as Array<{ accountCode: string; description: string; debit?: number; credit?: number; taxType?: string }>,
      }, undefined, { requestId })
      return { success: journalResult.success, externalId: journalResult.journalId, error: journalResult.error }
    }

    default:
      return { success: false, error: `Unknown sync type: ${type}` }
  }
}

/**
 * QUARANTINE a posted document whose back-reference the unique index refused (o3d-9kek r7 finding 1).
 *
 * The remote document exists. The sync row already records that durably — status SYNCED,
 * externalTransactionId set, and retention compacts it to a tombstone that KEEPS the external id
 * rather than deleting it — so nothing is lost. What was missing is a route forward, because the
 * message told the operator to "link it by hand" and the same index refuses a manual link for
 * exactly the same reason. This writes the conflict onto the row, names the document that is
 * blocking, and names the one command that resolves it.
 *
 * STATUS STAYS SYNCED. Moving it to FAILED would surface it in the failed-sync banner, which is
 * tempting and is wrong: queueQuickBooksSync suppresses a duplicate enqueue by looking for a row in
 * `PENDING | PROCESSING | SYNCED`, so a row moved out of SYNCED stops suppressing itself and the
 * document posts to QuickBooks a second time. `SYNCED` with a non-null `errorMessage` is otherwise
 * an unreachable state — the success path nulls it — so it is an unambiguous marker on its own.
 */
async function quarantineRefusedBackReference(params: {
  syncLogId: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalId: string
  error: unknown
}): Promise<void> {
  const holder = backReferenceHolder(params.type, params.referenceType)
  let blockedBy: string | null = null
  if (holder) {
    try {
      blockedBy = (await findExternalDocumentIdClaim(db, { holder, externalId: params.externalId }))?.id ?? null
    } catch (lookupError) {
      // Naming the blocker is an improvement to the message, not a precondition for recording the
      // conflict. A failed lookup must not swallow the quarantine as well.
      console.error('quickbooks: could not identify the holder of external id', params.externalId, lookupError)
    }
  }
  const blockerText = blockedBy
    ? `${holder?.model} ${blockedBy} currently holds it`
    : 'the record holding it could not be identified'
  const remedy = blockedBy
    ? 'If that is a bill/invoice from a QuickBooks company this system is no longer connected to, its id is stale and can be '
      + `released: run \`tsx scripts/release-accounting-external-id-claim.ts --sync-log ${params.syncLogId} `
      + `--holder ${blockedBy} --apply\`, which clears the id from that record and writes it onto this one in a single step. `
      + 'Do NOT release it if that record is a live, correctly linked document — check it first.'
    : 'Find the record carrying that id and, once you have confirmed it is stale, release it with '
      + `\`tsx scripts/release-accounting-external-id-claim.ts --sync-log ${params.syncLogId} --holder <id> --apply\`.`
  const description = `QuickBooks ${params.type} for ${params.referenceType} ${params.referenceId} POSTED SUCCESSFULLY as `
    + `external id ${params.externalId}, but that id could not be recorded locally: ${blockerText}. `
    + 'The document exists in QuickBooks and this sync row is the only local record of it — it is NOT re-posted and NOT retried '
    + '(QuickBooks has no back-reference repair sweep; blocked on o3d-8prh, post-time realm enforcement). '
    + remedy

  await logActivity({
    entityType: 'SYSTEM',
    action: 'quickbooks_backreference_id_conflict',
    tag: 'sync',
    level: 'ERROR',
    description,
    metadata: {
      syncLogId: params.syncLogId,
      type: params.type,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      externalId: params.externalId,
      blockedByModel: holder?.model ?? null,
      blockedById: blockedBy,
      error: String(params.error),
    },
  })
  try {
    // The DURABLE half. The activity log is the notification; this is the state, on the row that
    // carries the external id, so the conflict survives a log that has been pruned or never read.
    await db.accountingSyncLog.update({ where: { id: params.syncLogId }, data: { errorMessage: description } })
  } catch (markError) {
    console.error('quickbooks: could not record the back-reference conflict on the sync row', params.syncLogId, markError)
  }
}

/**
 * WHETHER THE LOCAL LINK LANDED (o3d-ekn8 r5, Codex HIGH).
 *
 * `updateBackReference` swallows its failures on this connector (see the catch below — de-swallowing
 * would change retry semantics for every type at once), and it used to return `void`, so the caller
 * could not tell a written link from a failed one. That silence propagated: the deferred-receipt
 * re-drive then found an order with no invoice id and returned quietly, and the processor released
 * the follow-up obligation marker — the last record that this posted invoice still owed work.
 *
 * The failure is still swallowed. What is no longer swallowed is the FACT of it.
 *
 * `nothing-to-link` is kept apart from the failures on purpose: no external id means no link was
 * ever owed, so it must not hold an obligation open. `ambiguous` and `contended` ARE failures for
 * this purpose even though neither is an error — the link is not on the document, and on this
 * connector nothing retries it.
 */
type BackReferenceLink =
  | { linked: true }
  | { linked: false; reason: 'nothing-to-link' }
  | { linked: false; reason: 'ambiguous' | 'contended' | 'conflict' | 'failed' }

/** Whether a link outcome leaves the row owing nothing further — see BackReferenceLink. */
function backReferenceLeavesNothingOwed(link: BackReferenceLink): boolean {
  return link.linked || link.reason === 'nothing-to-link'
}

/**
 * WHAT RE-DRIVES A RETAINED OBLIGATION ON THIS CONNECTOR: NOTHING (o3d-0bfh r5, Codex HIGH).
 *
 * Passed to every release, so a future QuickBooks caller cannot inherit Xero's "a later sweep will
 * discharge it" by omission. `blockedBy` is the CURRENT blocker — post-time authorization (o3d-8prh)
 * and origin propagation — and it is not the one this file named for three rounds; see the block at
 * the end of this file for why o3d-s36z closing did not unblock anything.
 *
 * READ FROM THE REGISTRY, NOT WRITTEN HERE (o3d-0bfh r6, Codex MEDIUM). r5 declared the recovery as
 * a local literal, and a literal is copyable: a third connector could paste Xero's
 * `{ consumer: 'sweep' }`, have no sweep at all, and compile. The declaration now lives in
 * lib/domain/accounting/follow-up-obligation-registry.ts, where a test requires every `sweep` entry
 * to have both an exported binding and an invocation — and where the backlog that makes THIS
 * connector's retained markers visible to an operator reads the same entry.
 */
const QBO_FOLLOW_UP_RECOVERY = followUpObligationRecoveryFor(QBO_CONNECTOR)

/**
 * The remedy an operator reads, taken from that same registry entry rather than restated here
 * (o3d-0bfh r8). Narrowed rather than reached through a helper so this file takes no extra import:
 * the branch is the type saying that only a connector with NO consumer has a remedy at all, and if
 * QuickBooks ever gains a sweep the message correctly stops telling anyone to do anything by hand.
 */
const QBO_FOLLOW_UP_REMEDY = QBO_FOLLOW_UP_RECOVERY.consumer === 'none'
  ? QBO_FOLLOW_UP_RECOVERY.operatorRemedy
  : 'a later sweep re-reads the marker and re-enqueues the work, so there is nothing to do by hand'

/**
 * DISCHARGE THE FOLLOW-UP OBLIGATION ONLY WHEN NOTHING IS STILL OWED (o3d-ekn8 r5, Codex HIGH).
 *
 * The release used to be unconditional on both post-success paths: `updateBackReference` swallows
 * its failure and `enqueueFollowUps` returned `void`, so the loop cleared the marker whether or not
 * the link had landed and whether or not the receipts recorded before the invoice ever reached the
 * ledger. That marker is the ONLY thing distinguishing this row from one whose follow-ups completed
 * — the row is SYNCED with an external id either way — so clearing it early is not a lost warning,
 * it is a lost debt: a recorded receipt permanently unsettled behind a row that looks finished.
 *
 * The asymmetry is deliberate and is the one followUpObligationClaim was designed around: a marker
 * left set costs one idempotent re-enqueue on a later sweep; a marker cleared early costs the
 * payment. So it is released only when BOTH facts say nothing is outstanding.
 *
 * AND ON THIS CONNECTOR THE RETAINED MARKER DRIVES NOTHING AT ALL — NOT "NOT YET" (o3d-0bfh r5,
 * Codex HIGH). Earlier rounds wrote this as a temporary state waiting on o3d-s36z. o3d-s36z has
 * since CLOSED and nothing here became live, because it was never the blocker for the consumer side;
 * the block at the end of this file states what is. Until that lands, retaining the marker preserves
 * EVIDENCE and schedules NO WORK, and both halves have to be said together:
 *
 *   • it is still the correct state to leave behind. The alternative is not "no marker", it is a row
 *     that has forgotten what it owes — SYNCED, carrying its external id, byte-identical to one that
 *     completed — and that fact is unrecoverable afterwards;
 *   • and it is NOT a repair. The payment, PDF, email or attachment does not run later. The log line
 *     below is the whole of the notification, and a human acting on it is the whole of the recovery.
 */
async function settleFollowUpObligation(
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  link: BackReferenceLink,
  followUps: FollowUpOutcome,
  /**
   * THE GENERATION THIS PASS TOOK IN THE SYNCED TRANSACTION (o3d-0bfh r4, Codex HIGH). Carried down
   * rather than re-read: a re-read is the same race one layer lower. `null` means the claim did not
   * land, and then nothing is cleared — a pass that owns no generation has no standing to say the
   * work is done.
   */
  obligation: Date | null,
): Promise<void> {
  const linked = backReferenceLeavesNothingOwed(link)
  if (linked && followUps.deferredReceiptsSettled) {
    // ALREADY DISCHARGED, UNDER THE ORDER LOCK (o3d-0bfh r15, Codex HIGH). The deferred-receipt pass
    // clears the generation inside the same transaction as its final re-read of the order's
    // receipts, which is the only ordering in which a receipt arriving mid-pass cannot be settled
    // over. Clearing it a second time here would be the unfenced write the fence exists to remove.
    if (followUps.obligationFenced) return
    // Fenced on `obligation`. A `superseded` answer means a newer generation is on the row — a later
    // post's, since no sweep claims on this connector — and it stands. What it does NOT mean here is
    // that somebody else will finish the work: `recovery` is what stops the helper saying so.
    await releaseFollowUpObligation(db, {
      syncLogId: entry.id,
      connector: QBO_CONNECTOR,
      generation: obligation,
      recovery: QBO_FOLLOW_UP_RECOVERY,
    })
    return
  }
  const outstanding: string[] = []
  if (!linked) outstanding.push(`the local link to the QuickBooks document did not land (${link.linked ? 'linked' : link.reason})`)
  if (!followUps.deferredReceiptsSettled) outstanding.push('a receipt recorded before this invoice is still not registered in the ledger')
  await reportRetainedObligation({
    action: 'quickbooks_followup_obligation_retained',
    // ERROR when money is the thing left outstanding, WARNING when it is only the local link — the
    // two need different people to do different things, and at one level the first reads as the
    // second and nobody acts on it.
    level: followUps.deferredReceiptsSettled ? 'WARNING' : 'ERROR',
    description: `QuickBooks sync entry ${entry.id} posted to the ledger, but ${outstanding.join(', and ')}. `
      + 'The row is deliberately left marked as owing follow-ups, because nothing else about it records that: '
      + 'it is SYNCED and carries its external id exactly like a row that completed. NOTHING WILL RE-DRIVE '
      + 'THIS AUTOMATICALLY — QuickBooks has no back-reference repair sweep bound (o3d-8prh), so the marker is '
      + 'evidence rather than scheduled work. It is listed in the exception inbox at /sync/exceptions under '
      + '"Accounting follow-ups owed, with nothing to re-drive them". '
      // o3d-0bfh r8 (Codex HIGH): "re-run the invoice sync, or register the receipt by hand" was a
      // direct re-drive instruction on the money path. Nothing here establishes that the receipt is
      // unregistered — only that THIS pass could not confirm it — and a hand-registered payment
      // cannot be deduplicated against one the local queue is still holding. The remedy comes from
      // the connector's own registry entry, which says read and escalate.
      + QBO_FOLLOW_UP_REMEDY + '.',
    metadata: {
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      backReference: link.linked ? 'linked' : link.reason,
      deferredReceiptsSettled: followUps.deferredReceiptsSettled,
    },
    syncLogId: entry.id,
  })
}

/**
 * ANNOUNCE A RETAINED OBLIGATION — AND SAY SO WHEN THE ANNOUNCEMENT ITSELF DID NOT LAND
 * (o3d-0bfh r6, Codex HIGH).
 *
 * What stood here was `logActivity(...).catch(...)`, under a comment that called the log line the
 * whole of the notification and a human the whole of the recovery. Those two facts do not fit
 * together: `logActivity` swallows a persistence failure and resolves `void`, so the appended
 * `.catch()` could never fire on the failure that matters, the entry was counted successful, the row
 * stayed SYNCED and was never selected again — a payment, PDF, email or attachment permanently
 * stalled with no operator-visible notice at all. A recovery that rests entirely on a human seeing
 * something cannot rest on a write whose failure nobody can observe.
 *
 * TWO CHANGES, AND THE SECOND IS THE LOAD-BEARING ONE:
 *
 *   • `logActivityPersisted` REPORTS whether the row landed, so the failure is at least observable
 *     here rather than silently swallowed, and a lost notice reaches stderr — the one channel that
 *     does not depend on the database this row could not be written to;
 *   • the obligation is no longer announced ONLY in the activity log. The marker left on the sync
 *     row is now surfaced as an operational backlog
 *     (lib/domain/accounting/follow-up-obligation-registry.ts, rendered in the exception inbox), so
 *     the durable, operator-visible record of the debt is THE ROW ITSELF — a state that is already
 *     committed by the time this function is reached, and a view over it that needs no second write
 *     to succeed at the worst possible moment.
 *
 * So this function never throws and its return value is deliberately not a gate: retaining the
 * marker is already the safe state, and failing to describe it must not turn a posted invoice into a
 * failed sync entry.
 */
async function reportRetainedObligation(params: {
  action: string
  level: 'WARNING' | 'ERROR'
  description: string
  metadata: Record<string, unknown>
  syncLogId: string
}): Promise<void> {
  let persisted = false
  try {
    persisted = await logActivityPersisted({
      entityType: 'SYSTEM',
      action: params.action,
      tag: 'sync',
      level: params.level,
      description: params.description,
      metadata: params.metadata,
    })
  } catch {
    // logActivityPersisted is documented not to throw; if it does, it is still not a reason to fail
    // a posted invoice, and the backlog below is unaffected either way.
    persisted = false
  }
  if (persisted) return
  console.error(
    `[quickbooks] the activity-log notice for sync entry ${params.syncLogId} could NOT be written (${params.action}). `
    + 'The obligation itself is NOT lost: the row still carries backReferenceFollowUpsPendingAt and appears in the '
    + 'exception inbox at /sync/exceptions under "Accounting follow-ups owed, with nothing to re-drive them". '
    + params.description,
  )
}

async function updateBackReference(
  syncLogId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  externalId?: string,
  invoiceNumber?: string,
): Promise<BackReferenceLink> {
  if (!externalId) return { linked: false, reason: 'nothing-to-link' }

  try {
    // EVERY type goes through the shared writer, exactly as Xero's does (o3d-9kek). Hand-rolled
    // per-type updates here were how the two connectors drifted: this function kept its own copy of
    // the PurchaseOrder "newest unlinked bill" guess and its own bare `update` for the bill-keyed
    // case, so the resolver's refusal to guess, the compare-and-swap and the unique-index handling
    // all had to be reimplemented — or, in practice, were not. There is exactly one writer now.
    const applied = await applyBackReference(db, { connector: QBO_CONNECTOR, type, referenceType, referenceId, externalId, invoiceNumber })
    // o3d-9kek: a legacy PurchaseOrder-keyed row names the ORDER, not the bill. It used to write
    // the external id onto "the newest bill with no id yet" — which stamps the wrong bill the
    // moment a PO has two, and a wrong id is worse than a missing one because it looks correct
    // (later payments and bill updates then post against the wrong QuickBooks document). The
    // shared resolver decides from the whole population for that PO and refuses to guess.
    if (applied.outcome === 'ambiguous') {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'quickbooks_backreference_ambiguous',
        tag: 'sync',
        level: 'WARNING',
        description: `Did not write the QuickBooks back-reference for PO ${referenceId}: its bill cannot be identified `
          + `(${applied.attribution.reason}). Link the bill manually — the external id is on the sync row. `
          + 'NOTHING re-checks this automatically: no QuickBooks back-reference repair sweep (blocked on o3d-8prh, '
          + 'post-time realm enforcement), so resolving the ambiguity on its own will not link the bill.',
        metadata: { referenceType, referenceId, externalId, reason: applied.attribution.reason },
      })
      return { linked: false, reason: 'ambiguous' }
    }
    // o3d-9kek finding 3: the resolved bill gained an external id between the resolve and
    // the compare-and-swap, so nothing was written and nothing was overwritten. Not an
    // error — the repair sweep re-resolves it from the state that actually won.
    if (applied.outcome === 'contended') {
      console.warn(`quickbooks: back-reference for PO ${referenceId} lost the race for bill ${applied.purchaseInvoiceId}; it must be linked by hand.`)
      return { linked: false, reason: 'contended' }
    }
    // `nothing-to-apply` is a type/reference pair that writes no back-reference at all (or a legacy
    // PO row with no bill to attribute to) — nothing was owed, so nothing is outstanding.
    if (applied.outcome === 'nothing-to-apply') return { linked: false, reason: 'nothing-to-link' }
    return { linked: true }
  } catch (error) {
    // AN EXTERNAL-ID CONFLICT IS NOT A FAILURE TO REPORT AND FORGET (o3d-9kek r7 finding 1). The
    // document is already in the QuickBooks ledger; the index refused only the LOCAL record of it.
    // It gets the quarantine treatment above — the conflict written onto the row, the blocking
    // document named, and the one command that resolves it — because the generic warning below
    // ends in "link it by hand", and for THIS failure that instruction cannot be carried out: the
    // same index refuses a manual link too.
    if (isExternalDocumentIdConflict(error)) {
      await quarantineRefusedBackReference({ syncLogId, type, referenceType, referenceId, externalId, error })
      return { linked: false, reason: 'conflict' }
    }
    // Pre-existing: QuickBooks swallows back-reference failures here (Xero does not — it
    // propagates so the caller retries). Still not changed, because de-swallowing alters QBO's
    // retry semantics for every type at once. What IS changed is the SILENCE: since o3d-9kek made
    // the bill's external id unique, a real attribution conflict — two local bills pointing at one
    // QuickBooks document — arrives here as an exception, and an invisible one is
    // indistinguishable from success.
    //
    // THE WARNING MUST NOT PROMISE A RETRY (o3d-9kek r6). An earlier revision of this branch bound
    // the connector-agnostic repair sweep to QuickBooks and this message said the sweep would retry
    // it. That binding was removed — see the block at the end of this file: the sweep is scoped by
    // connector alone, and a QuickBooks external id only means anything within one realm, so after a
    // realm switch it could attribute a retired company's id to a live document. Nothing retries a
    // failed QuickBooks back-reference now, and the operator is told exactly that instead of being
    // told a sweep exists. Telling someone a retry will happen when nothing retries is worse than
    // saying nothing; o3d-8prh is what would make the sweep safe to bind again (o3d-s36z, which this
    // line used to name, has closed and was never the consumer-side blocker — see the end of file).
    console.error(`quickbooks: back-reference write failed for ${referenceType} ${referenceId}`, error)
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_backreference_failed',
      tag: 'sync',
      level: 'WARNING',
      description: `Could not write the QuickBooks back-reference for ${referenceType} ${referenceId}: ${String(error)}. `
        + 'The external id is on the sync row, but NOTHING retries this: QuickBooks has no back-reference repair sweep '
        + '(blocked on o3d-8prh, post-time realm enforcement). Link the document to that external id by hand.',
      metadata: { type, referenceType, referenceId, externalId },
    })
    return { linked: false, reason: 'failed' }
  }
}

/**
 * WHAT THE FOLLOW-UP WORK LEFT OUTSTANDING (o3d-ekn8 r5, Codex HIGH).
 *
 * `enqueueFollowUps` returned `void`, so "it did not throw" was the only signal the processing loop
 * had — and it released the durable follow-up obligation on that. But the deferred-receipt re-drive
 * is explicitly built never to throw (a receipt that cannot be registered must not fail a sync entry
 * whose invoice HAS posted), so every way it can leave money unregistered arrived at the release as
 * success. This carries the fact back instead of leaving the loop to assume it.
 */
type FollowUpOutcome = FollowUpEnqueueOutcome & {
  /** False when a receipt recorded before this invoice is still waiting to reach the ledger. */
  deferredReceiptsSettled: boolean
  /**
   * TRUE WHEN THE DEFERRED PASS ALREADY TOOK THE MARKER DECISION ITSELF (o3d-0bfh r15, Codex HIGH).
   *
   * The re-drive re-reads the order's receipts UNDER THE SALES-ORDER LOCK and clears the exact
   * obligation generation in that same transaction, because a receipt committing after its snapshot
   * would otherwise read a live marker — and be told its recovery is retained — and then have that
   * marker cleared over it. So when this is true, `settleFollowUpObligation` must clear NOTHING: a
   * second, unfenced clear re-opens the window the fence closes.
   */
  obligationFenced: boolean
}

async function enqueueSalesInvoiceFollowUps(
  /** o3d-0bfh r15: the sync-log row that carries the obligation marker this pass may clear. */
  entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
  /**
   * THE OBLIGATION GENERATION THIS PASS CLAIMED (o3d-0bfh r15, Codex HIGH), threaded down to the
   * deferred-receipt re-drive so its final re-read of the order's receipts and the clearing of this
   * generation commit in ONE transaction under the sales-order lock. `null` means this pass holds
   * nothing this call may clear — either it never claimed a generation, or the back-reference link
   * did not land and the marker is the record of THAT debt as well.
   */
  followUpObligation: Date | null,
): Promise<FollowUpOutcome> {
  if (referenceType !== 'SalesOrder' || !syncResult.externalId) return { enqueued: true, deferredReceiptsSettled: true, obligationFenced: false }
  // Captured once, so the id handed to the deferred re-drive below is provably the one THIS post
  // returned rather than a re-read of a narrowed property.
  const postedInvoiceId: string = syncResult.externalId
  // o3d-peh1: the PAYMENT's outcome is kept and folded in with the PDF's at the end. Both are still
  // attempted; a refused payment is no reason to withhold the PDF.
  let paymentOutcome: FollowUpEnqueueOutcome = FOLLOW_UPS_ENQUEUED

  if (payload._registerPayment) {
    const paymentMap = await getPaymentAccountMap()
    const method = payload._paymentMethod as string || ''
    const currency = payload.currency as string || 'GBP'

    if (!paymentMap || Object.keys(paymentMap).length === 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'quickbooks_payment_skipped',
        tag: 'sync',
        level: 'WARNING',
        description: 'Skipped QuickBooks payment registration: no payment account map configured.',
      })
    } else {
      const stored = lookupPaymentAccount(paymentMap, method, currency)
      if (!stored) {
        await logActivity({
          entityType: 'SYSTEM',
          action: 'quickbooks_payment_skipped',
          tag: 'sync',
          level: 'WARNING',
          description: `Skipped QuickBooks payment registration: no bank account mapped for method "${method}" / currency "${currency}".`,
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
          // Resolve QBO customer ID for the payment request
          let customerRef: string | undefined
          if (referenceType === 'SalesOrder') {
            const order = await db.salesOrder.findUnique({
              where: { id: referenceId },
              select: { customer: { select: { accountingContactId: true, accountingContactProvenance: true } } },
            })
            // Provenance-guarded (o3d-6nd): only enqueue an id that belongs to the active company, so a
            // follow-up queued now cannot carry a former realm's id.
            customerRef = (await customerContactIdIfCurrent(order?.customer)) ?? undefined
          }

          paymentOutcome = await enqueueFollowUpSyncLog('INVOICE_PAYMENT', referenceType, referenceId, {
            accountingInvoiceId: syncResult.externalId,
            bankAccountId: stored,
            amount,
            paymentDate: (payload._paymentDate as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
            currency,
            method,
            customerRef,
          })
        }
      }
    }
  }

  const pdfOutcome = await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
  })

  // o3d-batch-ret (Codex HIGH), CROSS-PORTED WITH THE XERO PATH — THE SAME RELEASE-BEFORE-REQUIRE
  // ORDERING WAS WHOLE HERE TOO. The verdict was built in the `return` below, past the fence that
  // clears the marker, and `requireFollowUpsEnqueued` on this connector's post paths reads it after
  // the generation is already gone. It matters MORE here than on Xero: this connector's recovery
  // registry entry says nothing re-drives a retained marker, so the sweep that Xero relies on to
  // pick the refused work back up does not exist — a marker cleared early is the end of the trail.
  const enqueueOutcome = combineFollowUpEnqueueOutcomes(paymentOutcome, pdfOutcome)
  // This connector states no settlement prerequisite of its own (no sweep hands one down), so this
  // is `undefined` whenever the enqueue succeeded and the fence stays on its single pass.
  const releasePrerequisite = obligationReleasePrerequisite(enqueueOutcome)

  // o3d-ekn8, CROSS-PORTED FROM THE XERO PATH (this branch) — REGISTER THE RECEIPTS THAT WERE
  // RECORDED BEFORE THIS INVOICE EXISTED.
  //
  // `registerInvoicePaymentWithLedger` refuses a receipt with DOCUMENT_NOT_POSTED while the order has
  // no accountingInvoiceId, and nothing ever came back for it once the invoice landed: the receipt
  // stayed recorded, the ledger stayed unsettled, and the only sign was a red NOT_SENT verdict
  // somebody had to notice. The re-drive that closes it shipped on the Xero connector ONLY, and the
  // receipt-registration path it re-drives is connector-agnostic — this processor posts INVOICE_PAYMENT
  // rows itself — so on QuickBooks the defect was still whole.
  //
  // THIS IS THE MOMENT THE REFUSAL STOPS APPLYING, and the ordering that makes it so is the same here
  // as there: `updateBackReference` runs immediately before `enqueueFollowUps`, so the re-read below
  // sees the id this post just wrote. It re-runs the SAME guarded decision — currency, bank-account
  // mapping and invoice capacity are all re-checked per receipt — rather than a second, laxer copy.
  //
  // Imported dynamically so the connector does not take a static dependency on the sales domain, and
  // awaited but never allowed to throw: the invoice HAS posted, and a receipt that could not be
  // re-registered must not turn that into a failed sync entry.
  const { registerDeferredOrderReceipts } = await import('@/lib/domain/accounting/invoice-payment-enqueue')
  // PINNED TO THIS POST (o3d-ekn8 r2, Codex HIGH). Handing over only the order id made the callee
  // re-derive both of the facts this hand-off is about — it asked which connector is active NOW and
  // which document the order points at NOW — while the authoritative answers were sitting right here:
  // this processor made the call, and `syncResult.externalId` is the id the call returned. A connector
  // swap or a delete-and-re-post between the post and the re-drive silently redirected it. Re-resolving
  // after a pin is the race being closed, not a check of it, so the evidence goes IN.
  //
  // AND THE ANSWER IS CARRIED BACK (o3d-ekn8 r5, Codex HIGH). It is awaited but never allowed to
  // throw, which meant "it returned" was indistinguishable from "the receipts reached the ledger" —
  // including the case this whole hand-off is about, where `updateBackReference` failed, the order
  // carries no invoice id, and the re-drive has nothing it is allowed to settle against.
  //
  // AND THE OBLIGATION GOES IN WITH IT (o3d-0bfh r15, Codex HIGH). The re-drive's final re-read of
  // the order's receipts and the clearing of this generation now happen in ONE transaction holding
  // the sales-order lock, because a receipt committing after the re-drive's snapshot would otherwise
  // read a live marker — and be told its recovery is retained — and then have that marker cleared by
  // this caller over it.
  const redrive = await registerDeferredOrderReceipts(referenceId, {
    connector: 'quickbooks',
    accountingInvoiceId: postedInvoiceId,
  }, {
    syncLogId: entryId,
    connector: QBO_CONNECTOR,
    generation: followUpObligation,
    // The same registry answer `settleFollowUpObligation` reads — on this connector it says NOTHING
    // re-drives a retained marker, and that has to reach the operator notice unchanged.
    recovery: QBO_FOLLOW_UP_RECOVERY,
    // o3d-batch-ret: SPREAD for the reason the Xero twin gives — the field's ABSENCE is what keeps
    // this on the single-pass fence, and an explicitly-undefined key would be a second thing to get
    // wrong at every site that reads this object.
    ...(releasePrerequisite ? { settlementPrerequisite: releasePrerequisite } : {}),
  })
  // `unfenced` is the one answer that leaves the marker to this caller: the re-drive returned on a
  // fact no later receipt can change (payments do not post at all; the order is gone).
  // AND THE ENQUEUE'S OWN VERDICT TRAVELS WITH IT (o3d-peh1). Kept SEPARATE from the receipt
  // answer rather than folded into it: a refusal means nothing was queued and an operator has to
  // clear it, an unsettled receipt means money that WAS queued has not landed. One boolean would
  // make each of them the other's blind spot.
  return {
    ...enqueueOutcome,
    deferredReceiptsSettled: redrive.settled,
    obligationFenced: redrive.release !== 'unfenced',
  }
}

async function enqueuePurchaseInvoiceFollowUps(
  _entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<FollowUpEnqueueOutcome> {
  // Entries can arrive with referenceType 'PurchaseInvoice' or 'PurchaseOrder'
  if ((referenceType !== 'PurchaseInvoice' && referenceType !== 'PurchaseOrder') || !syncResult.externalId || !payload.supplierInvoicePath) {
    return FOLLOW_UPS_ENQUEUED
  }
  return await enqueueFollowUpSyncLog('BILL_ATTACHMENT', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    supplierInvoicePath: payload.supplierInvoicePath,
  })
}

async function enqueueFollowUps(
  entryId: string,
  type: AccountingSyncType,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
  /**
   * THE OBLIGATION GENERATION THIS PASS CLAIMED (o3d-0bfh r15, Codex HIGH), threaded down to the
   * deferred-receipt re-drive so its final re-read of the order's receipts and the clearing of this
   * generation commit in ONE transaction under the sales-order lock. `null` means this pass holds
   * nothing this call may clear — either it never claimed a generation, or the back-reference link
   * did not land and the marker is the record of THAT debt as well.
   */
  followUpObligation: Date | null,
): Promise<FollowUpOutcome> {
  if (type === 'SALES_INVOICE') {
    return enqueueSalesInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult, followUpObligation)
  }

  if (type === 'PURCHASE_INVOICE') {
    // o3d-peh1: the sibling enqueue ANSWERS, and its answer is the caller's settle verdict.
    // Discarding the return here would put a refused bill attachment back in the silence
    // this branch exists to end; it has no deferred receipt of its own.
    return {
      ...await enqueuePurchaseInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult),
      deferredReceiptsSettled: true,
      obligationFenced: false,
    }
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
      outcomes.push(await enqueueFollowUpSyncLog('INVOICE_EMAIL', referenceType, referenceId, { referenceId }))
    }
    // b8i6.6: the post-invoice note follow-up is WooCommerce-only BY DESIGN.
    // It is already connector-aware — only enqueued when the order has a
    // WooCommerce link (query above filters connector:'woocommerce'), so a
    // Shopify-only order never gets a no-op note. Shopify has no order-note /
    // invoice-link capability to push to yet; adding one needs a Shopify
    // implementation + live validation before a SHOPPING_INVOICE_NOTE could be
    // generalised here.
    if (order?.shoppingLinks.length) {
      outcomes.push(await enqueueFollowUpSyncLog('WC_INVOICE_NOTE', referenceType, referenceId, { referenceId }))
    }
    return { ...combineFollowUpEnqueueOutcomes(...outcomes), deferredReceiptsSettled: true, obligationFenced: false }
  }
  // Every remaining type enqueues rows that carry their own document id in the payload; none of them
  // has a deferred receipt waiting on it, and none of them refused anything.
  return { enqueued: true, deferredReceiptsSettled: true, obligationFenced: false }
}

// ---------------------------------------------------------------------------
// THERE IS DELIBERATELY NO QuickBooks BINDING OF THE BACK-REFERENCE REPAIR SWEEP, AND THEREFORE NO
// CONSUMER OF THE FOLLOW-UP OBLIGATION MARKER THIS FILE WRITES (o3d-9kek r6; restated and RE-BASED
// on the correct blocker — post-time authorization, o3d-8prh — at o3d-0bfh r5, Codex HIGH).
//
// One binding existed briefly and was REMOVED on purpose. Read the next two sections before adding
// one back; the second is the one three rounds of this branch got wrong.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE ABSENCE COSTS. SAY IT FIRST, BECAUSE IT IS THE PART THAT LOOKS LIKE NOTHING.
//
// This file runs a full follow-up obligation protocol: the SYNCED write and the claim of
// `backReferenceFollowUpsPendingAt` commit in ONE transaction, the release is fenced on the exact
// generation this pass minted, and every way the work can fail to land retains the marker instead of
// clearing it. All of that is correct and all of it is BOOKKEEPING WITH NO READER. A QuickBooks row
// that dies between its SYNCED commit and its enqueue is left SYNCED, carrying its external id, with
// a non-null marker — and nothing ever looks at that marker again:
//
//   • `processPendingQuickBooksSync` selects PENDING and stale-PROCESSING rows. The crashed row is
//     SYNCED, so the processor will not retry it. (Its idempotency branch WOULD re-run the
//     follow-ups correctly if the row were ever selected again — that is the cruel part: the
//     recovery logic exists and is reachable by nothing.)
//   • there is no sweep to select it by its marker instead, which is what this block is about.
//
// So the payment, PDF, email or attachment simply never runs. EVIDENCE IS PRESERVED, THE WORK IS
// NOT LIVE. Everything in this file that describes the marker now says exactly that, and the release
// helper is passed `QBO_FOLLOW_UP_RECOVERY` so it cannot repeat Xero's true-there/false-here promise
// that "a later sweep will discharge it".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE PRECONDITION THIS BLOCK USED TO NAME HAS BEEN MET, AND IT WAS THE WRONG ONE. THE REAL ONE IS
// POST-TIME AUTHORIZATION (o3d-8prh), PLUS ORIGIN PROPAGATION ON THE ROWS A CONSUMER WOULD CREATE.
//
// Every earlier revision said: do not re-add the binding before closing o3d-s36z (connector-tenant /
// realm isolation), because `repairAccountingBackReferences` scopes its candidate query by
// `connector` alone, a QuickBooks external id is a small integer meaningful only inside ONE realm,
// and after a reconnect to company B the sweep could write company A's integer onto a live document.
// That reasoning was sound and the hazard is real.
//
// o3d-s36z CLOSED on 2026-08-21 (PR #632, o3d-batch-realm). A row's realm IS now recorded, durably
// and in a place retention cannot reach:
//
//   • `AccountingSyncLog.connectionProvenance` (o3d-dzip) — minted from the payload stamp in the
//     same INSERT, trigger-protected against any later UPDATE;
//   • `_connectionProvenance` in the payload (o3d-19gy), read TOGETHER with the column by
//     `readAccountingOriginRecord`, because either half alone is a known hole;
//   • `accountingPayloadConnectionVerdict`, which permits exactly one decision — `match` — and
//     refuses absence, disagreement and unreadability alike.
//
// SO THE CANDIDATE FENCE IS NOW DERIVABLE FROM WHAT THE ROW ALREADY RECORDS. A sweep could select
// only rows whose recorded origin equals the QuickBooks realm connected now. That is a genuine
// change since this block was written, and it is exactly why the stale precondition was dangerous
// to leave standing: the next person to read it would check o3d-s36z, find it closed, and wire the
// binding — believing they had satisfied the condition this file set them.
//
// THEY WOULD NOT HAVE. The fence is only the SELECT side. What a repair sweep does is ENQUEUE, and
// what a QuickBooks enqueue leads to is a post that nothing checks:
//
//   • NO POST-TIME ENFORCEMENT ON THIS CONNECTOR (o3d-8prh, OPEN). `accounting-posting-intent` and
//     `accounting-egress-authorization` — the modules that carry the verdict to the last statement
//     before the socket — are imported by `lib/connectors/xero/*` and by nothing under
//     `lib/connectors/quickbooks/`. `lib/accounting.ts` says so where it writes the stamp: "only the
//     Xero processor ENFORCES it today (the QuickBooks half is o3d-8prh)". So does
//     `readClaimedSyncLogPayload`, whose header names this connector as the caller that does not
//     make the connection check. A row correctly fenced AT SWEEP TIME is still posted against
//     whatever is connected AT POST TIME, and the interval between them is where an operator's
//     disconnect-and-reconnect lives — which is the whole of o3d-19gy, unguarded here.
//   • AND THE ROWS A CONSUMER CREATED WOULD RECORD NO ORIGIN AT ALL. This file's own
//     `enqueueFollowUpSyncLog` takes no origin evidence (Xero's takes `FollowUpOriginEvidence` and
//     carries it verbatim) and mints no `connectionProvenance` on the row it creates (Xero's does).
//     Every follow-up a sweep produced here would therefore be born `no-origin-recorded` — the state
//     three rounds of o3d-s36z worked to stop MANUFACTURING — and would refuse the moment o3d-8prh
//     did land, having in the meantime posted unchecked.
//
// The follow-up types are the reason this is a money finding rather than a tidiness one:
// INVOICE_PAYMENT carries an `accountingInvoiceId`, and QuickBooks ids are small sequential
// integers, so the id of an invoice in company A is very likely to name SOME invoice in company B.
// The governing principle decides it in one line, unchanged from the original reasoning: FAILING TO
// REPAIR IS ACCEPTABLE, REPAIRING ONTO THE WRONG DOCUMENT IS NOT.
//
// A realm-pinned durable outbox instead of a fenced sweep does not escape this. An outbox moves
// where the pin is written; it still ends at `processPendingQuickBooksSync` posting with no verdict.
// Carrying a pin all the way to the socket IS `accounting-posting-intent` plus
// `accounting-egress-authorization`, i.e. o3d-8prh — so the outbox is that work plus an outbox,
// never less of it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT TO DO, IN ORDER, WHENEVER SOMEONE PICKS THIS UP (o3d-s4q2 tracks it, blocked on o3d-8prh):
//
//   1. Land o3d-8prh: the connection verdict reached as the last statement before the QuickBooks
//      socket, the same shape Xero has. Nothing below is safe before this.
//   2. Give this file's `enqueueFollowUpSyncLog` an `origin: FollowUpOriginEvidence` parameter and
//      mint `connectionProvenance` on the rows it creates, inheriting verbatim and never reading the
//      live connection — the o3d-19gy rule. Otherwise step 3 manufactures unpostable rows.
//   3. Bind the sweep, fencing its candidate query on the row's recorded origin against the realm
//      connected now, refusing every decision but `match`.
//   4. Change the QUICKBOOKS ENTRY in lib/domain/accounting/follow-up-obligation-registry.ts to the
//      sweep consumer — not a literal here; the registry is where the binding and the invocation are
//      checked, and tests/accounting/follow-up-recovery-registry.test.ts refuses the entry until
//      step 3 above is actually done. Changing it also empties this connector's exception-inbox
//      backlog, because that view is derived from the same entry.
//
// WHEN IT IS RE-ADDED, ITS `enqueueFollowUps` MUST RETURN THIS FILE'S `FollowUpOutcome` (o3d-0bfh).
// The Xero binding wrapped the call in an `async` adapter that awaited it and dropped the outcome to
// satisfy a `Promise<void>` dep, which made the sweep a second release path around the very gate
// `settleFollowUpObligation` installs above: `deferredReceiptsSettled: false` never throws, so it
// arrived as success and the sweep cleared the obligation marker over an unregistered receipt. The
// dep is now `Promise<BackReferenceFollowUpOutcome>`, so the compiler refuses a binding that
// discards it — but only if the outcome is RETURNED rather than awaited-and-swallowed inside an
// adapter, which type-checks just as happily. Return it directly.
//
// AND IT MUST ACCEPT AND FORWARD THE SWEEP'S SETTLEMENT PREREQUISITE (o3d-0bfh r16, Codex HIGH).
// The dep's ninth argument is a condition the SWEEP must have made durable — its terminal warnings —
// before the deferred-receipt fence may clear the obligation generation. `enqueueSalesInvoiceFollowUps`
// below takes no such argument today, and a function with fewer parameters is assignable to a
// signature with more: a binding wired without threading it would compile, run, and clear the marker
// before the warning that permits the settlement was written. That is the r16 finding, and on this
// connector it would arrive silently. Thread it into the `registerDeferredOrderReceipts` obligation
// exactly as the Xero processor does, or do not bind the sweep.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MARKER IS STILL CLAIMED HERE, AND THAT IS STILL NOT A CONTRADICTION (r10 finding 1).
//
// Recording that work is owed and repairing it are two different acts, and only the second is what
// any of the above gates. The marker writes nothing to any accounting document and crosses no realm
// boundary — it is a timestamp on the sync row that already carries the external id.
//
// Claiming it now was the choice over deferring it because the alternative is not "no marker", it
// is "a window that stays silent". A QuickBooks row that dies between its SYNCED write and its
// enqueue is indistinguishable afterwards from one that completed, and nothing can recover that
// distinction later: it has to be recorded at the moment it is true or not at all. Adding it when
// a consumer is wired would leave every row written before then permanently unrecoverable, for the
// same reason there is no backfill for rows written before the column existed. Xero having the
// marker and QuickBooks not having it would also be a difference nobody chose — the two connectors
// drifted once already, on precisely this function's back-reference logic.
//
// What that argument establishes is that the marker is worth WRITING. It does not establish that
// anything reads it, and r5 is the round that stopped this block implying otherwise.
// ---------------------------------------------------------------------------
