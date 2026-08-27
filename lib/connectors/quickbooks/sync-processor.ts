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
import { logActivity } from '@/lib/activity-log'
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
import { isUniqueConstraintViolation } from '@/lib/db/prisma-unique-violation'
import {
  applyBackReference,
  backReferenceHolder,
  findExternalDocumentIdClaim,
  followUpObligationClaim,
  isExternalDocumentIdConflict,
  releaseFollowUpObligation,
} from '@/lib/domain/accounting/back-reference'
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
): Promise<void> {
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
  if (plan.action === 'skip') return
  if (plan.action === 'refuse') {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: `Refused to re-enqueue QuickBooks ${type} for ${referenceType} ${referenceId}: ${plan.reason}`,
      metadata: { type, referenceType, referenceId, failedRowIds: failedRows.map((row) => row.id) },
    })
    return
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
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_followup_enqueue_refused',
      tag: 'sync',
      level: 'WARNING',
      description: `Refused to re-enqueue QuickBooks ${type} for ${referenceType} ${referenceId}: `
        + `${evidence.reason}. Re-posting it could duplicate a payment; check the ledger and resolve `
        + 'the row by hand.',
      metadata: { type, referenceType, referenceId, failedRowIds: failedRows.map((row) => row.id) },
    })
    return
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
        await resolveLostFollowUpRevival({
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
        return
      }
      await logFollowUpRevival(QBO_CONNECTOR, type, referenceType, referenceId, plan)
      return
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
      await resolveLostFollowUpRevival({
        connector: QBO_CONNECTOR,
        type,
        referenceType,
        referenceId,
        payload: plan.payload,
        syncLogId: plan.action === 'reuse' ? plan.syncLogId : undefined,
        attempt,
        retry: () => enqueueFollowUpSyncLog(type, referenceType, referenceId, plan.payload, attempt + 1),
      })
      return
    }
    throw error
  }
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
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
              // Claimed in the SYNCED transaction, exactly as Xero does (r10 finding 1). See the
              // block above enqueueFollowUps at the end of this file for why the marker is set here
              // even though the QuickBooks sweep is still unwired.
              ...followUpObligationClaim(),
            },
          })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: entry.externalTransactionId,
          })
        })
        const link = await updateBackReference(entry.id, entry.type, entry.referenceType, entry.referenceId, entry.externalTransactionId, undefined)
        const followUps = await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, { externalId: entry.externalTransactionId })
        // Only reached when the enqueue did NOT throw. This branch has no catch of its own — an
        // exception propagates to the outer handler, which retries the row — so the obligation
        // simply stays claimed, which is the correct state for work that has not run.
        //
        // AND NOT THROWING IS NOT THE SAME AS NOTHING BEING OWED (o3d-ekn8 r5): the back-reference
        // write swallows its failure and the deferred-receipt re-drive is built never to throw, so
        // the discharge asks both of them instead of inferring it from the absence of an exception.
        await settleFollowUpObligation(entry, link, followUps)
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
        await db.$transaction(async (tx) => {
          await tx.accountingSyncLog.update({
            where: { id: entry.id },
            data: {
              status: 'SYNCED',
              externalTransactionId: syncResult.externalId ?? null,
              syncedAt: new Date(),
              errorMessage: null,
              processingStartedAt: null,
              // The external id and the record that follow-ups are owed become durable in ONE
              // write (r10 finding 1) — the comment above is exactly why they have to: everything
              // after this transaction can die without the row ever being re-posted.
              ...followUpObligationClaim(),
            },
          })
          await updateMirroredEventForSyncLog(tx, {
            syncLogId: entry.id,
            type: entry.type,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
            payload,
            status: 'POSTED',
            externalId: syncResult.externalId ?? null,
          })
        })

        // Follow-up work (back-references, enqueue PDF/email/payment).
        // These are best-effort: if they fail, the external post is already
        // safely recorded and won't be replayed.
        try {
          const link = await updateBackReference(entry.id, entry.type, entry.referenceType, entry.referenceId, syncResult.externalId, syncResult.invoiceNumber)
          const followUps = await enqueueFollowUps(entry.id, entry.type, entry.referenceType, entry.referenceId, payload, syncResult)
          // o3d-ekn8 r5, Codex HIGH: released only if the link landed AND the receipts recorded
          // before this invoice reached the ledger. Neither of those failures throws, so both had
          // been arriving here as success and clearing the row's last record of the work.
          await settleFollowUpObligation(entry, link, followUps)
        } catch (followUpError) {
          // ERROR, not WARNING: the external post is committed and this entry is about to be
          // marked succeeded, so nothing will drive these follow-ups again. A payment or PDF
          // that never got enqueued is silently missing until someone notices, and at WARNING
          // nobody does (Codex review, r6).
          //
          // The obligation is deliberately NOT released here (r10 finding 1). This branch marks the
          // entry succeeded regardless, so the row is about to look identical to one whose
          // follow-ups ran — the marker is the only thing left that says otherwise, and it is what
          // lets the QuickBooks sweep pick the work up once o3d-s36z unblocks it.
          await logActivity({
            entityType: 'SYSTEM',
            action: 'quickbooks_followup_error',
            tag: 'sync',
            level: 'ERROR',
            description: `QuickBooks sync entry ${entry.id} posted successfully but its follow-up work was NOT `
              + `enqueued: ${String(followUpError)}. The document is in QuickBooks; its payment, PDF or email `
              + 'follow-ups need to be re-driven manually.',
            metadata: { syncLogId: entry.id, type: entry.type, referenceType: entry.referenceType, referenceId: entry.referenceId },
          })
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
): Promise<{ success: boolean; externalId?: string; invoiceNumber?: string; error?: string; skipped?: boolean }> {
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
        const uploadRes = await qboUploadAttachment('Bill', accountingInvoiceId, filename, pdfBuffer, 'application/pdf')
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
    + '(QuickBooks has no back-reference repair sweep; blocked on realm isolation, o3d-s36z). '
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
 * On this connector the retained marker drives nothing yet — the repair sweep is unwired until
 * o3d-s36z (see the block at the end of this file). It is still the correct state to leave behind:
 * the alternative is not "no marker", it is a row that has forgotten what it owes, and that fact
 * cannot be recovered afterwards.
 */
async function settleFollowUpObligation(
  entry: { id: string; type: AccountingSyncType; referenceType: string; referenceId: string },
  link: BackReferenceLink,
  followUps: FollowUpOutcome,
): Promise<void> {
  const linked = backReferenceLeavesNothingOwed(link)
  if (linked && followUps.deferredReceiptsSettled) {
    await releaseFollowUpObligation(db, { syncLogId: entry.id, connector: QBO_CONNECTOR })
    return
  }
  const outstanding: string[] = []
  if (!linked) outstanding.push(`the local link to the QuickBooks document did not land (${link.linked ? 'linked' : link.reason})`)
  if (!followUps.deferredReceiptsSettled) outstanding.push('a receipt recorded before this invoice is still not registered in the ledger')
  await logActivity({
    entityType: 'SYSTEM',
    action: 'quickbooks_followup_obligation_retained',
    tag: 'sync',
    // ERROR when money is the thing left outstanding, WARNING when it is only the local link — the
    // two need different people to do different things, and at one level the first reads as the
    // second and nobody acts on it.
    level: followUps.deferredReceiptsSettled ? 'WARNING' : 'ERROR',
    description: `QuickBooks sync entry ${entry.id} posted to the ledger, but ${outstanding.join(', and ')}. `
      + 'The row is deliberately left marked as owing follow-ups, because nothing else about it records that: '
      + 'it is SYNCED and carries its external id exactly like a row that completed. Link the document and '
      + 're-run the invoice sync for this reference, or register the receipt in QuickBooks by hand.',
    metadata: {
      syncLogId: entry.id,
      type: entry.type,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      backReference: link.linked ? 'linked' : link.reason,
      deferredReceiptsSettled: followUps.deferredReceiptsSettled,
    },
    // Retaining the marker is ALREADY the safe state, so failing to describe it must not turn a
    // posted invoice into a failed sync entry.
  }).catch(() => { /* the state is on the row; the log is the notification */ })
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
          + 'NOTHING re-checks this automatically: QuickBooks has no back-reference repair sweep (it is blocked on realm '
          + 'isolation, o3d-s36z), so resolving the ambiguity on its own will not link the bill.',
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
    // saying nothing; o3d-s36z is what would make the sweep safe to bind again.
    console.error(`quickbooks: back-reference write failed for ${referenceType} ${referenceId}`, error)
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_backreference_failed',
      tag: 'sync',
      level: 'WARNING',
      description: `Could not write the QuickBooks back-reference for ${referenceType} ${referenceId}: ${String(error)}. `
        + 'The external id is on the sync row, but NOTHING retries this: QuickBooks has no back-reference repair sweep '
        + '(blocked on realm isolation, o3d-s36z). Link the document to that external id by hand.',
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
type FollowUpOutcome = {
  /** False when a receipt recorded before this invoice is still waiting to reach the ledger. */
  deferredReceiptsSettled: boolean
}

async function enqueueSalesInvoiceFollowUps(
  _entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string; invoiceNumber?: string },
): Promise<FollowUpOutcome> {
  if (referenceType !== 'SalesOrder' || !syncResult.externalId) return { deferredReceiptsSettled: true }
  // Captured once, so the id handed to the deferred re-drive below is provably the one THIS post
  // returned rather than a re-read of a narrowed property.
  const postedInvoiceId: string = syncResult.externalId

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

          await enqueueFollowUpSyncLog('INVOICE_PAYMENT', referenceType, referenceId, {
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

  await enqueueFollowUpSyncLog('INVOICE_PDF', referenceType, referenceId, {
    accountingInvoiceId: syncResult.externalId,
    referenceId,
    invoiceNumber: syncResult.invoiceNumber,
  })

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
  const redrive = await registerDeferredOrderReceipts(referenceId, {
    connector: 'quickbooks',
    accountingInvoiceId: postedInvoiceId,
  })
  return { deferredReceiptsSettled: redrive.settled }
}

async function enqueuePurchaseInvoiceFollowUps(
  _entryId: string,
  referenceType: string,
  referenceId: string,
  payload: SyncPayload,
  syncResult: { externalId?: string },
): Promise<void> {
  // Entries can arrive with referenceType 'PurchaseInvoice' or 'PurchaseOrder'
  if ((referenceType !== 'PurchaseInvoice' && referenceType !== 'PurchaseOrder') || !syncResult.externalId || !payload.supplierInvoicePath) return
  await enqueueFollowUpSyncLog('BILL_ATTACHMENT', referenceType, referenceId, {
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
): Promise<FollowUpOutcome> {
  if (type === 'SALES_INVOICE') {
    return enqueueSalesInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult)
  }

  if (type === 'PURCHASE_INVOICE') {
    await enqueuePurchaseInvoiceFollowUps(entryId, referenceType, referenceId, payload, syncResult)
    return { deferredReceiptsSettled: true }
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
      await enqueueFollowUpSyncLog('INVOICE_EMAIL', referenceType, referenceId, { referenceId })
    }
    // b8i6.6: the post-invoice note follow-up is WooCommerce-only BY DESIGN.
    // It is already connector-aware — only enqueued when the order has a
    // WooCommerce link (query above filters connector:'woocommerce'), so a
    // Shopify-only order never gets a no-op note. Shopify has no order-note /
    // invoice-link capability to push to yet; adding one needs a Shopify
    // implementation + live validation before a SHOPPING_INVOICE_NOTE could be
    // generalised here.
    if (order?.shoppingLinks.length) {
      await enqueueFollowUpSyncLog('WC_INVOICE_NOTE', referenceType, referenceId, { referenceId })
    }
  }
  // Every remaining type enqueues rows that carry their own document id in the payload; none of them
  // has a deferred receipt waiting on it.
  return { deferredReceiptsSettled: true }
}

// ---------------------------------------------------------------------------
// THERE IS DELIBERATELY NO QuickBooks BINDING OF THE BACK-REFERENCE REPAIR SWEEP (o3d-9kek r6).
//
// One existed briefly on this branch and was REMOVED on purpose. Do not re-add it without first
// closing o3d-s36z (connector-tenant / realm isolation) — that issue is this binding's precondition,
// not a nice-to-have alongside it.
//
// WHY. repairAccountingBackReferences scopes its candidate query by `connector` and nothing else. A
// QuickBooks external id is a small integer that is only meaningful inside ONE realm (company), and
// disconnecting removes the expected-realm pin entirely — so after reconnecting to realm B, an
// unresolved row that posted to realm A is still a candidate, and the sweep would write realm A's
// integer onto a local document. The payment poller then reads that id as a realm-B document and can
// mark or update the WRONG bill or order.
//
// The global unique index on purchase_invoices.accounting_invoice_id does NOT cover this: it only
// stops a SECOND local row taking an id another row already holds. When no local row holds the
// orphaned id — which is exactly the state a realm switch leaves behind — the write succeeds.
//
// So the choice was between a sweep that can attribute across realms and no sweep at all, and the
// governing principle decides it: failing to repair is acceptable, repairing onto the wrong document
// is not. QuickBooks is the secondary connector; Xero is the priority one and has no realm exposure
// here (its poller builds its match set from Xero itself), so the Xero binding stays.
//
// The cost of the absence is real and is stated honestly rather than papered over: a QuickBooks
// back-reference that fails to write is NOT retried by anything, and updateBackReference's warnings
// above say so in as many words instead of promising a sweep. Whoever closes o3d-s36z should re-add
// the binding here — the connector-agnostic sweep module needs no changes for it, only a trustworthy
// realm boundary underneath.
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
// THE FOLLOW-UP OBLIGATION MARKER IS STILL CLAIMED HERE, AND THAT IS NOT A CONTRADICTION (r10
// finding 1). Recording that work is owed and repairing it are two different acts, and only the
// second one is what o3d-s36z gates. The marker writes nothing to any accounting document and
// crosses no realm boundary — it is a timestamp on the sync row that already carries the external
// id — so none of the reasoning above applies to it.
//
// Claiming it now was the choice over deferring it because the alternative is not "no marker", it
// is "a window that stays silent". A QuickBooks row that dies between its SYNCED write and its
// enqueue is indistinguishable afterwards from one that completed, and nothing can recover that
// distinction later: it has to be recorded at the moment it is true or not at all. Adding it when
// the sweep is wired would leave every row written before then permanently unrecoverable, for the
// same reason there is no backfill for rows written before the column existed. Xero having the
// marker and QuickBooks not having it would also be a difference nobody chose — the two connectors
// drifted once already, on precisely this function's back-reference logic.
// ---------------------------------------------------------------------------
