import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { HELD_SHADOW_VOID_BASIS } from '@/lib/domain/accounting/accounting-event-void-basis'
import { updateMirroredAccountingEventStatus } from '@/lib/domain/accounting/accounting-event-mirror'
import { attemptProvenNeverMade } from '@/lib/domain/accounting/money-attempt-provenance'
import { MONEY_MOVING_SYNC_TYPES } from '@/lib/domain/accounting/followup-retry-guard'
import { HELD_SHADOW_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'
import { UNCLAIMED_ATTEMPT_REVISION } from '@/lib/domain/accounting/sync-log-attempt'
import { destinationAndOperationForSyncType } from '@/lib/domain/accounting/xero-producer-seam'
import { wmsConnectorIdsFor } from '@/lib/connectors/wms/producer-seam'
import { ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS } from '@/lib/domain/integrations/outbox-admin'
import { INTEGRATION_OUTBOX_STATUS } from '@/lib/domain/integrations/outbox'
import { outboxInternalOperationsOf } from '@/lib/domain/integrations/outbox-registry'
import { attachShadowSyncLog, recordOutboundShadow } from '@/lib/domain/outbound-shadow/record'
import { explainProducerDisposition, parseProducerCutoff, type ProducerDecision } from '@/lib/security/producer-disposition'
import {
  producerRetiredShadowNotice,
  producerUnknownOutcomeNotice,
  PRODUCER_CUTOFF_ENV,
} from '@/lib/security/producer-disposition-constants'
import { isOutboundWriteHeldText, OUTBOUND_CONNECTORS, type OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import { ACCOUNTING_SYNC_TYPE_EXCLUSIONS, ownershipRowFor, ownershipTargetForOutboxOperation } from '@/lib/security/writer-ownership-map'

/**
 * RETIRING THE HELD BACKLOG: WHAT IS DONE WITH WORK THAT WAS QUEUED BEFORE A DESTINATION WENT LIVE.
 *
 * While the transport hold was the only barrier (the WP1-only window, and any time the producer hold was not enforced), every IMS
 * producer queued its work as if live and the queues retried it for ever without spending an attempt. When a destination goes live that
 * backlog belongs to the writer that owned the destination until then, and the writer-side cut-off (producerCutoffFloor) stops it being
 * delivered. This module does what the cut-off cannot: it takes the rows OUT of the queues, so they stop looking like work that is owed,
 * and it is honest about which of them it can vouch for.
 *
 * TWO DISPOSITIONS, AND THE LINE BETWEEN THEM IS PROOF, NEVER OPINION:
 *
 *   SHADOW  the row ITSELF carries a positive record that no attempt to send it was ever made. It is converted to the same standing a
 *           shadow recorded at the producer has (Xero sync row CANCELLED / HELD_SHADOW; outbox job SHADOWED; queued warehouse order link
 *           removed), with a row in `outbound_shadow_writes`. The sentence it carries says what the proof was, and still says nothing
 *           about the destination.
 *   PARK    anything else. The row stays as evidence, is taken out of the queue, and carries "outcome unknown: check <destination>
 *           before acting". IMS never says nothing was sent about a row it cannot prove that of.
 *
 * Absence of a stamp is not proof, a status is not proof, and "it has been held for months" is not proof: the proofs are exactly the
 * ones the rest of the code already trusts (see classifyXeroSyncRow, classifyOutboxJob, classifyWmsPushLink for each and why).
 *
 * The plan is a read; the apply re-reads and re-classifies EACH row under its own transaction and compare-and-sets on what it observed,
 * so a row that moved since the plan is left alone and reported, never overwritten.
 */

export type RetirementDisposition = 'SHADOW' | 'PARK' | 'SKIP'

export type RetirementClassification = { disposition: RetirementDisposition; reason: string }

export type RetirementKind = 'xero_sync_log' | 'outbox_job' | 'wms_push_link'

export type RetirementItem = {
  destination: OutboundConnector
  kind: RetirementKind
  id: string
  /** What the row is about, for the operator: the document or order reference. */
  subject: string
  createdAt: Date
  status: string
  classification: RetirementClassification
}

export type RetirementScope = {
  destinations: readonly OutboundConnector[]
  /** Per destination: rows queued BEFORE this instant are in scope. Absent: that destination selects nothing unless `allQueued`. */
  cutoffs: Partial<Record<OutboundConnector, Date>>
  /** Everything currently queued is in scope, whatever its age (retiring the held-era backlog before enforcement is switched on). */
  allQueued: boolean
  /** Per kind. The plan reports `truncated` when a kind has more. */
  limit: number
}

export type RetirementPlan = {
  generatedAt: Date
  items: RetirementItem[]
  truncated: Array<{ destination: OutboundConnector; kind: RetirementKind }>
  /** Destinations that selected nothing because no cut-off was given or readable for them (and `allQueued` was off). */
  unscoped: OutboundConnector[]
}

export const RETIREMENT_DEFAULT_LIMIT = 1000

/** The cut-off for each destination: an explicit value wins, otherwise the destination's own live-from variable, if readable. */
export function resolveRetirementCutoffs(
  explicit: Partial<Record<OutboundConnector, Date>>,
  env: Record<string, string | undefined> = process.env,
): Partial<Record<OutboundConnector, Date>> {
  const cutoffs: Partial<Record<OutboundConnector, Date>> = {}
  for (const destination of OUTBOUND_CONNECTORS) {
    const given = explicit[destination]
    if (given) {
      cutoffs[destination] = given
      continue
    }
    const parsed = parseProducerCutoff(env[PRODUCER_CUTOFF_ENV[destination]])
    if (parsed.ok) cutoffs[destination] = parsed.at
  }
  return cutoffs
}

// ---------------------------------------------------------------------------------------------
// Classification: PURE. The proofs live here and nowhere else.
// ---------------------------------------------------------------------------------------------

export type XeroRetirementRow = {
  type: string
  status: string
  externalTransactionId: string | null
  createDispatchedAt: Date | null
  attemptRevision: number
  retryCount: number
  remoteAttemptedAt: Date | null
  attemptStampingCustodyAt: Date | null
  /** When the row was last claimed (the sync log's `processingStartedAt`; renamed here so this module never spells a claim-time write). */
  claimStartedAt: Date | null
}

/** The sync-log columns the retirement reads, in the shape the classifier takes. */
function xeroRetirementRowOf(row: Omit<XeroRetirementRow, 'claimStartedAt'> & Record<'processingStartedAt', Date | null>): XeroRetirementRow {
  const { processingStartedAt, ...rest } = row
  return { ...rest, claimStartedAt: processingStartedAt }
}

/**
 * XERO SYNC ROW. SHADOW only when the row shows no attempt, by one of the two records that can show it:
 *
 *  - NEVER CLAIMED: still PENDING at the revision no claim has ever advanced (a claim mints revision >= 1), created in attempt-stamping
 *    custody (so it was made by a binary that fences its claims; revision 0 on a row an OLD binary handled proves nothing, because the
 *    revision migration left every existing row at 0), with no retry ever counted. This is the proof the cancelled-order retirement
 *    already acts on.
 *  - A MONEY ROW THE FENCE WOULD VOUCH FOR: a payment, bill payment or allocation in custody with `remoteAttemptedAt` unset, which is
 *    the canonical pre-call record (the post stamps it before the call).
 *
 * Both need: no document id, and no create-dispatch marker (written before a create's request leaves). Everything else is PARKED:
 * a claimed row of a type whose attempt stamp is not written, a row with history, a row an old binary may have handled. A fresh claim
 * (a worker may be sending it right now) is SKIPPED: nothing is changed and the operator is told to run again.
 */
export function classifyXeroSyncRow(row: XeroRetirementRow, now: Date): RetirementClassification {
  if (row.status === 'PROCESSING' && row.claimStartedAt
    && now.getTime() - row.claimStartedAt.getTime() < ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS) {
    return { disposition: 'SKIP', reason: 'a worker claimed it recently and may be sending it now; run the retirement again once it has settled' }
  }
  if (row.externalTransactionId) {
    return { disposition: 'PARK', reason: 'a document id is recorded against it, so IMS may have sent it' }
  }
  if (row.createDispatchedAt) {
    return { disposition: 'PARK', reason: 'a create request was recorded as dispatched for it, so IMS may have sent it' }
  }
  if (row.attemptStampingCustodyAt != null
    && row.status === 'PENDING'
    && row.attemptRevision === UNCLAIMED_ATTEMPT_REVISION
    && row.retryCount === 0) {
    return { disposition: 'SHADOW', reason: 'it was queued in attempt-stamping custody and no claim or retry has ever been recorded against it' }
  }
  if (MONEY_MOVING_SYNC_TYPES.has(row.type) && attemptProvenNeverMade(row)) {
    return { disposition: 'SHADOW', reason: 'it is in attempt-stamping custody with no remote attempt recorded' }
  }
  return {
    disposition: 'PARK',
    reason: 'its record does not prove that no attempt to send it was made: it has been claimed or retried, or was handled outside attempt-stamping custody',
  }
}

export type OutboxRetirementRow = {
  status: string
  attempts: number
  lastError: string | null
  lockedAt: Date | null
  lockedBy: string | null
  createdAt: Date
  updatedAt: Date
  /** The durable attempt history: shadowing needs `attemptHistoryTracked` and an empty `firstAttemptedAt`. Unknown is never "never sent". */
  attemptHistoryTracked: boolean
  firstAttemptedAt: Date | null
}

/** A job nobody has touched since it was inserted differs from its creation by at most this much (two clocks, one statement). */
const UNTOUCHED_TOLERANCE_MS = 2000

/**
 * OUTBOX JOB. SHADOW only when the job shows it was never sent, by one of two records:
 *
 *  - NEVER CLAIMED: PENDING, no attempt counted, no error, no lock ever stamped, and not updated since it was inserted. A claim moves
 *    the status and the update time, so a job that was ever claimed does not look like this.
 *  - HELD, AND NOTHING ELSE: RETRYABLE_FAILED with no attempt counted whose last error is a verified outbound-hold refusal. A refusal by
 *    the hold is made before anything leaves, and the hold never spends an attempt, so a job with attempts 0 has no recorded outcome but
 *    that refusal.
 *
 * Every counted attempt, every claimed-and-vanished (stale PROCESSING) job and every job whose history does not look like one of the two
 * is PARKED. A fresh claim is SKIPPED.
 */
export function classifyOutboxJob(row: OutboxRetirementRow, now: Date): RetirementClassification {
  if (row.status === INTEGRATION_OUTBOX_STATUS.PROCESSING) {
    if (row.lockedAt && now.getTime() - row.lockedAt.getTime() < ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS) {
      return { disposition: 'SKIP', reason: 'a worker claimed it recently and may be sending it now; run the retirement again once it has settled' }
    }
    return { disposition: 'PARK', reason: 'a worker claimed it and its outcome was never recorded' }
  }
  if (row.attempts > 0) {
    return { disposition: 'PARK', reason: `${row.attempts} attempt(s) were counted against it and it was not completed` }
  }
  // THE DURABLE HISTORY. `attempts` and `lastError` are reset by an operator replay and by a re-arm, so a job that was attempted, replayed
  // and then refused by the hold looks exactly like one never attempted. Only the first-attempt stamp survives those, and only a row created
  // by a binary that writes it can vouch for itself: a row from before the column (or created by an older binary) is UNKNOWN, and unknown is parked.
  if (!row.attemptHistoryTracked) {
    return { disposition: 'PARK', reason: 'its attempt history was not recorded (it predates the history), so an earlier attempt cannot be ruled out' }
  }
  if (row.firstAttemptedAt !== null) {
    return { disposition: 'PARK', reason: 'a worker has claimed it before, and the claim is not known to have been refused before anything left' }
  }
  if (row.status === INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED && isOutboundWriteHeldText(row.lastError)) {
    return { disposition: 'SHADOW', reason: 'its only recorded outcome is a refusal by the outbound-write hold, which is made before anything leaves' }
  }
  if (row.status === INTEGRATION_OUTBOX_STATUS.PENDING
    && row.lastError === null
    && row.lockedAt === null
    && row.lockedBy === null
    && Math.abs(row.updatedAt.getTime() - row.createdAt.getTime()) <= UNTOUCHED_TOLERANCE_MS) {
    return { disposition: 'SHADOW', reason: 'it has not been claimed or changed since it was queued' }
  }
  return { disposition: 'PARK', reason: 'its record does not show that it was never claimed' }
}

export type WmsLinkRetirementRow = {
  state: string
  attempts: number
  lastAttemptAt: Date | null
  lastError: string | null
  externalOrderId: string | null
  externalOrderNumber: string | null
  pushedAt: Date | null
  /** The durable claim history: shadowing needs `claimHistoryTracked` and an empty `firstClaimedAt`. Resets never touch either. */
  claimHistoryTracked: boolean
  firstClaimedAt: Date | null
}

/**
 * WAREHOUSE (WMS) QUEUED LINK. The link is the push sweep's claim: a bare PENDING_CREATE exists from immediately before the remote create, so
 * the delete guard itself treats ANY link as possibly sent. SHADOW (the link is removed, and a shadow kept) only when the link shows
 * the claim was never taken: no attempt, no attempt time, no error, no warehouse id and number, no push time. Otherwise PARKED as an
 * unknown create (AMBIGUOUS_CREATE), the state whose whole meaning is that a create may have left and an operator must look.
 */
export function classifyWmsPushLink(link: WmsLinkRetirementRow): RetirementClassification {
  if (link.state !== 'PENDING_CREATE') {
    return { disposition: 'SKIP', reason: `the link is ${link.state}, not a queued create` }
  }
  if (link.externalOrderId || link.externalOrderNumber || link.pushedAt) {
    return { disposition: 'SKIP', reason: 'the link names a warehouse order, so it is not an unsent create' }
  }
  if (link.attempts === 0 && link.lastAttemptAt === null && link.lastError === null && link.claimHistoryTracked && link.firstClaimedAt === null) {
    return { disposition: 'SHADOW', reason: 'the link records no attempt, no attempt time and no error, and its durable claim history shows it was never claimed' }
  }
  return { disposition: 'PARK', reason: `a create may have left: the link records ${link.attempts} attempt(s)${link.lastAttemptAt ? ' and an attempt time' : ''}, and its claim history ${link.claimHistoryTracked ? (link.firstClaimedAt ? 'shows it was claimed' : 'shows no claim, but the other record above does not rule one out') : 'was not recorded (a release or replay may have cleared the attempt fields)'}` }
}

// ---------------------------------------------------------------------------------------------
// Plan: READ ONLY.
// ---------------------------------------------------------------------------------------------

type RetirementClient = typeof db | Prisma.TransactionClient

/**
 * THE CUT-OFF THAT ACTUALLY SELECTS ROWS for a destination: none when `allQueued` (every queued row is in scope, so a configured cut-off must
 * NOT narrow the plan or the apply and make a run look complete over a subset), otherwise the destination's own. The plan, the apply and the
 * report all read this one function.
 */
export function effectiveRetirementCutoff(scope: RetirementScope, destination: OutboundConnector): Date | null {
  return scope.allQueued ? null : scope.cutoffs[destination] ?? null
}

/** Is a row created (or, for a link, whose order was paid) at `at` still before the effective cut-off? No cut-off: every queued row is eligible. */
function stillBeforeCutoff(at: Date | null | undefined, cutoff: Date | null, nullCounts = false): boolean {
  if (cutoff === null) return true
  if (!(at instanceof Date)) return nullCounts
  return at.getTime() < cutoff.getTime()
}

const CHANGED_SINCE_PLANNING = 'changed since planning: it is no longer what was classified (re-dated, re-armed, attempted or moved), so it was left alone'

function inScope(scope: RetirementScope, destination: OutboundConnector): { in: true; cutoff: Date | null } | { in: false } {
  if (!scope.destinations.includes(destination)) return { in: false }
  const cutoff = effectiveRetirementCutoff(scope, destination)
  if (cutoff === null && !scope.allQueued) return { in: false }
  return { in: true, cutoff }
}

export async function planHeldBacklogRetirement(
  scope: RetirementScope,
  options: { client?: RetirementClient; now?: Date } = {},
): Promise<RetirementPlan> {
  const client = options.client ?? db
  const now = options.now ?? new Date()
  const items: RetirementItem[] = []
  const truncated: RetirementPlan['truncated'] = []
  const unscoped: OutboundConnector[] = []
  const take = Math.max(1, Math.floor(scope.limit)) + 1

  for (const destination of scope.destinations) {
    const selected = inScope(scope, destination)
    if (!selected.in) {
      unscoped.push(destination)
      continue
    }
    const before = selected.cutoff ? { createdAt: { lt: selected.cutoff } } : {}

    if (destination === 'xero') {
      const rows = await client.accountingSyncLog.findMany({
        // A PDF fetch and an e-mail are not writes to Xero: the cut-off does not govern them, so neither does the retirement.
        where: { connector: 'xero', status: { in: ['PENDING', 'PROCESSING'] }, type: { notIn: Object.keys(ACCOUNTING_SYNC_TYPE_EXCLUSIONS) as never }, ...before },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
        select: {
          id: true, type: true, status: true, referenceType: true, referenceId: true, createdAt: true,
          externalTransactionId: true, createDispatchedAt: true, attemptRevision: true, retryCount: true,
          remoteAttemptedAt: true, attemptStampingCustodyAt: true, processingStartedAt: true,
        },
      })
      if (rows.length === take) truncated.push({ destination, kind: 'xero_sync_log' })
      for (const row of rows.slice(0, take - 1)) {
        items.push({
          destination, kind: 'xero_sync_log', id: row.id, subject: `${row.type} ${row.referenceType} ${row.referenceId}`,
          createdAt: row.createdAt, status: row.status, classification: classifyXeroSyncRow(xeroRetirementRowOf(row), now),
        })
      }
    }

    // Outbox jobs of this destination's connector, except the operations whose effect is local.
    const internal = outboxInternalOperationsOf(destination)
    const jobs = await client.integrationOutbox.findMany({
      where: {
        connector: destination,
        ...(internal.length > 0 ? { operation: { notIn: internal } } : {}),
        status: { in: [INTEGRATION_OUTBOX_STATUS.PENDING, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED, INTEGRATION_OUTBOX_STATUS.PROCESSING] },
        ...before,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      select: { id: true, connector: true, operation: true, status: true, attempts: true, lastError: true, lockedAt: true, lockedBy: true, createdAt: true, updatedAt: true, attemptHistoryTracked: true, firstAttemptedAt: true },
    })
    if (jobs.length === take) truncated.push({ destination, kind: 'outbox_job' })
    for (const job of jobs.slice(0, take - 1)) {
      items.push({
        destination, kind: 'outbox_job', id: job.id, subject: `${job.connector}/${job.operation}`,
        createdAt: job.createdAt, status: job.status, classification: classifyOutboxJob(job, now),
      })
    }

    const wmsConnectorIds = wmsConnectorIdsFor(destination)
    if (wmsConnectorIds.length > 0) {
      const links = await client.wmsOrderPushLink.findMany({
        where: {
          connector: { in: wmsConnectorIds },
          state: 'PENDING_CREATE',
          ...(selected.cutoff ? { order: { OR: [{ paidAt: null }, { paidAt: { lt: selected.cutoff } }] } } : {}),
        },
        orderBy: [{ id: 'asc' }],
        take,
        select: {
          id: true, state: true, attempts: true, lastAttemptAt: true, lastError: true, externalOrderId: true,
          externalOrderNumber: true, pushedAt: true, orderId: true, claimHistoryTracked: true, firstClaimedAt: true,
          order: { select: { orderNumber: true, externalOrderNumber: true, createdAt: true } },
        },
      })
      if (links.length === take) truncated.push({ destination, kind: 'wms_push_link' })
      for (const link of links.slice(0, take - 1)) {
        items.push({
          destination, kind: 'wms_push_link', id: link.id,
          subject: `order ${link.order.orderNumber ?? link.order.externalOrderNumber ?? link.orderId}`,
          createdAt: link.order.createdAt, status: link.state, classification: classifyWmsPushLink(link),
        })
      }
    }
  }

  return { generatedAt: now, items, truncated, unscoped }
}

// ---------------------------------------------------------------------------------------------
// Apply: one transaction per row, re-classified under the write, compare-and-set on what was observed.
// ---------------------------------------------------------------------------------------------

export type RetirementOutcome = {
  item: RetirementItem
  /** What was done, or why nothing was. */
  result: 'shadowed' | 'parked' | 'left_alone' | 'changed_since_plan'
  detail: string
}

function retirementDecision(destination: OutboundConnector, operation: string, scope: RetirementScope, now: Date): ProducerDecision {
  const probe = explainProducerDisposition(destination, operation as never, undefined, { now })
  return {
    disposition: 'SHADOW',
    reason: 'before_cutoff',
    owner: ownershipRowFor(destination, operation)?.owners.P1 ?? probe.owner,
    phase: probe.phase,
    cutoff: effectiveRetirementCutoff(scope, destination) ?? probe.cutoff,
    grant: probe.grant,
  }
}

async function retireXeroSyncLog(tx: Prisma.TransactionClient, item: RetirementItem, scope: RetirementScope, now: Date): Promise<RetirementOutcome> {
  // Under a row lock, and re-derived: the row must still be Xero's, still queued, and still created before the effective cut-off.
  await tx.$queryRaw`SELECT id FROM accounting_sync_logs WHERE id = ${item.id} FOR UPDATE`
  const row = await tx.accountingSyncLog.findUnique({
    where: { id: item.id },
    select: {
      id: true, connector: true, type: true, status: true, referenceType: true, referenceId: true, payload: true, createdAt: true,
      externalTransactionId: true, createDispatchedAt: true, attemptRevision: true, retryCount: true,
      remoteAttemptedAt: true, attemptStampingCustodyAt: true, processingStartedAt: true,
    },
  })
  const xeroCutoff = effectiveRetirementCutoff(scope, 'xero')
  if (!row || row.connector !== 'xero' || (row.status !== 'PENDING' && row.status !== 'PROCESSING') || !stillBeforeCutoff(row.createdAt, xeroCutoff)) {
    return { item, result: 'changed_since_plan', detail: CHANGED_SINCE_PLANNING }
  }
  const verdict = classifyXeroSyncRow(xeroRetirementRowOf(row), now)
  if (verdict.disposition === 'SKIP') return { item, result: 'left_alone', detail: verdict.reason }
  const notice = verdict.disposition === 'SHADOW'
    ? producerRetiredShadowNotice({ connector: 'xero', proof: verdict.reason })
    : producerUnknownOutcomeNotice({ connector: 'xero', why: `The record does not show it was never sent: ${verdict.reason}.` })

  // The compare-and-set: exactly the state that was classified. A claim, a retry or a settlement since the read changes one of these.
  const guard: Prisma.AccountingSyncLogWhereInput = {
    id: row.id,
    connector: 'xero',
    createdAt: row.createdAt,
    status: row.status,
    attemptRevision: row.attemptRevision,
    retryCount: row.retryCount,
    // SHADOW needs the send evidence to be ABSENT. PARK is for a row WITH send evidence (a document id, a create-dispatch marker): its guard is
    // that evidence unchanged since it was classified, never "null", or the park of exactly the rows that need it could never land.
    ...(verdict.disposition === 'SHADOW'
      ? { externalTransactionId: null, createDispatchedAt: null, remoteAttemptedAt: row.remoteAttemptedAt, attemptStampingCustodyAt: { not: null } }
      : { externalTransactionId: row.externalTransactionId, createDispatchedAt: row.createDispatchedAt, remoteAttemptedAt: row.remoteAttemptedAt }),
  }
  if (verdict.disposition === 'SHADOW') {
    const target = destinationAndOperationForSyncType(row.type)
    const operation = target?.operation ?? `unmapped:${row.type}`
    const recorded = await recordOutboundShadow(tx, {
      destination: 'xero',
      operation,
      subjectType: row.referenceType,
      subjectId: row.referenceId,
      payload: { type: row.type, payload: row.payload },
      summary: { type: row.type, connector: 'xero', retired: true },
      decision: retirementDecision('xero', operation, scope, now),
    })
    const updated = await tx.accountingSyncLog.updateMany({
      where: guard,
      data: {
        status: 'CANCELLED',
        settlementBasis: HELD_SHADOW_SETTLEMENT_BASIS,
        abandonedBeforeRemoteCall: true,
        errorMessage: notice,
        attemptRevision: { increment: 1 },
      },
    })
    if (updated.count === 0) throw new RetirementConflict('the row changed while it was being retired')
    await attachShadowSyncLog(tx, recorded.id, row.id)
    await voidMirrorUnlessAnotherAttemptIsLive(tx, row)
    return { item, result: 'shadowed', detail: verdict.reason }
  }
  const updated = await tx.accountingSyncLog.updateMany({
    where: guard,
    data: { status: 'FAILED', errorMessage: notice, attemptRevision: { increment: 1 } },
  })
  if (updated.count === 0) throw new RetirementConflict('the row changed while it was being parked')
  await updateMirroredAccountingEventStatus(tx, {
    connector: 'xero', syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId,
    payload: row.payload, status: 'FAILED', message: notice,
  })
  return { item, result: 'parked', detail: verdict.reason }
}

/**
 * The mirrored accounting event is shared by every attempt at one document. It is retired only when no other attempt is live
 * (queued, claimed or posted) for the same document; otherwise another attempt owns it and it is left exactly as it is.
 */
async function voidMirrorUnlessAnotherAttemptIsLive(
  tx: Prisma.TransactionClient,
  row: { id: string; type: string; referenceType: string; referenceId: string; payload: unknown },
): Promise<void> {
  const siblings = await tx.accountingSyncLog.count({
    where: {
      connector: 'xero', type: row.type as never, referenceType: row.referenceType, referenceId: row.referenceId,
      id: { not: row.id }, status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
  })
  if (siblings > 0) return
  await updateMirroredAccountingEventStatus(tx, {
    connector: 'xero', syncLogId: row.id, type: row.type, referenceType: row.referenceType, referenceId: row.referenceId,
    payload: row.payload, status: 'VOID', voidBasis: HELD_SHADOW_VOID_BASIS,
  })
}

async function retireOutboxJob(tx: Prisma.TransactionClient, item: RetirementItem, scope: RetirementScope, now: Date): Promise<RetirementOutcome> {
  await tx.$queryRaw`SELECT id FROM integration_outbox WHERE id = ${item.id} FOR UPDATE`
  const job = await tx.integrationOutbox.findUnique({ where: { id: item.id } })
  // Re-derived under the row lock from the CURRENT row: same destination, not a local operation, still queued, and STILL created before the
  // effective cut-off. A product's stock job is re-dated and re-armed in place by a live producer; that row is new live work, never a backlog row.
  if (
    !job
    || job.connector !== item.destination
    || outboxInternalOperationsOf(item.destination).includes(job.operation)
    || ![INTEGRATION_OUTBOX_STATUS.PENDING, INTEGRATION_OUTBOX_STATUS.RETRYABLE_FAILED, INTEGRATION_OUTBOX_STATUS.PROCESSING].includes(job.status as never)
    || !stillBeforeCutoff(job.createdAt, effectiveRetirementCutoff(scope, item.destination))
  ) {
    return { item, result: 'changed_since_plan', detail: CHANGED_SINCE_PLANNING }
  }
  const verdict = classifyOutboxJob(job, now)
  if (verdict.disposition === 'SKIP') return { item, result: 'left_alone', detail: verdict.reason }
  const destination = item.destination
  const cleared = { nextAttemptAt: null, lockedAt: null, lockedBy: null }
  const guard = { id: job.id, connector: job.connector, operation: job.operation, createdAt: job.createdAt, status: job.status, attempts: job.attempts, updatedAt: job.updatedAt, attemptHistoryTracked: job.attemptHistoryTracked, firstAttemptedAt: job.firstAttemptedAt }
  if (verdict.disposition === 'SHADOW') {
    // The Xero job is the delivery half of a sync row, whose own retirement records the shadow; every other job is the work itself.
    const target = destination === 'xero' ? null : ownershipTargetForOutboxOperation(`${job.connector}/${job.operation}`)
    if (destination !== 'xero') {
      const operation = target?.operation ?? `unmapped:${job.connector}/${job.operation}`
      await recordOutboundShadow(tx, {
        destination,
        operation,
        subjectType: `${job.connector}/${job.operation}`,
        subjectId: job.idempotencyKey,
        payload: { operation: `${job.connector}/${job.operation}`, payload: job.payloadJson },
        summary: { outboxOperation: `${job.connector}/${job.operation}`, retired: true },
        decision: retirementDecision(destination, operation, scope, now),
      })
    }
    const updated = await tx.integrationOutbox.updateMany({
      where: guard,
      data: { status: INTEGRATION_OUTBOX_STATUS.SHADOWED, lastError: producerRetiredShadowNotice({ connector: destination, proof: verdict.reason }), ...cleared },
    })
    if (updated.count === 0) throw new RetirementConflict('the job changed while it was being retired')
    return { item, result: 'shadowed', detail: verdict.reason }
  }
  const updated = await tx.integrationOutbox.updateMany({
    where: guard,
    data: {
      status: INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
      lastError: producerUnknownOutcomeNotice({ connector: destination, why: `The record does not show it was never sent: ${verdict.reason}.` }),
      ...cleared,
    },
  })
  if (updated.count === 0) throw new RetirementConflict('the job changed while it was being parked')
  return { item, result: 'parked', detail: verdict.reason }
}

async function retireWmsPushLink(tx: Prisma.TransactionClient, item: RetirementItem, scope: RetirementScope, now: Date): Promise<RetirementOutcome> {
  const peek = await tx.wmsOrderPushLink.findUnique({ where: { id: item.id }, select: { orderId: true } })
  if (!peek) return { item, result: 'changed_since_plan', detail: 'the link is gone' }
  // The same row lock the claim and the hard-delete take, so the classification below is of a link nobody can be claiming.
  await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${peek.orderId} FOR UPDATE`
  const link = await tx.wmsOrderPushLink.findUnique({ where: { id: item.id } })
  const order = await tx.salesOrder.findUnique({ where: { id: peek.orderId }, select: { paidAt: true } })
  // Re-derived under the order lock: the destination's link, and its order still paid before the effective cut-off (or not paid at all).
  if (!link || !wmsConnectorIdsFor(item.destination).includes(link.connector as never) || !order || !stillBeforeCutoff(order.paidAt, effectiveRetirementCutoff(scope, item.destination), true)) {
    return { item, result: 'changed_since_plan', detail: CHANGED_SINCE_PLANNING }
  }
  const linkCutoff = effectiveRetirementCutoff(scope, item.destination)
  const linkCutoffWhere = linkCutoff ? { order: { OR: [{ paidAt: null }, { paidAt: { lt: linkCutoff } }] } } : {}
  const verdict = classifyWmsPushLink(link)
  if (verdict.disposition === 'SKIP') return { item, result: 'left_alone', detail: verdict.reason }
  if (verdict.disposition === 'SHADOW') {
    await recordOutboundShadow(tx, {
      destination: item.destination,
      operation: 'order.create',
      subjectType: 'SalesOrder',
      subjectId: link.orderId,
      payload: { orderId: link.orderId, kind: 'retired-queued-create' },
      summary: { retired: true },
      decision: retirementDecision(item.destination, 'order.create', scope, now),
    })
    const removed = await tx.wmsOrderPushLink.deleteMany({
      where: {
        id: link.id, state: 'PENDING_CREATE', attempts: 0, lastAttemptAt: null, lastError: null,
        externalOrderId: null, externalOrderNumber: null, pushedAt: null, claimHistoryTracked: true, firstClaimedAt: null,
        ...linkCutoffWhere,
      },
    })
    if (removed.count === 0) throw new RetirementConflict('the link changed while it was being retired')
    return { item, result: 'shadowed', detail: verdict.reason }
  }
  const parked = await tx.wmsOrderPushLink.updateMany({
    where: { id: link.id, state: 'PENDING_CREATE', attempts: link.attempts, lastAttemptAt: link.lastAttemptAt, firstClaimedAt: link.firstClaimedAt, externalOrderId: null, pushedAt: null, ...linkCutoffWhere },
    data: {
      state: 'AMBIGUOUS_CREATE',
      lastError: producerUnknownOutcomeNotice({ connector: item.destination, why: `The record does not show it was never sent: ${verdict.reason}.` }),
    },
  })
  if (parked.count === 0) throw new RetirementConflict('the link changed while it was being parked')
  return { item, result: 'parked', detail: verdict.reason }
}

class RetirementConflict extends Error {}

export type RetirementApplyResult = {
  outcomes: RetirementOutcome[]
  counts: Record<RetirementOutcome['result'], number>
}

export async function applyHeldBacklogRetirement(
  plan: RetirementPlan,
  scope: RetirementScope,
  options: { client?: typeof db; now?: Date } = {},
): Promise<RetirementApplyResult> {
  const client = options.client ?? db
  const now = options.now ?? new Date()
  const outcomes: RetirementOutcome[] = []
  for (const item of plan.items) {
    if (item.classification.disposition === 'SKIP') {
      outcomes.push({ item, result: 'left_alone', detail: item.classification.reason })
      continue
    }
    try {
      outcomes.push(await client.$transaction(async (tx) => {
        if (item.kind === 'xero_sync_log') return retireXeroSyncLog(tx, item, scope, now)
        if (item.kind === 'outbox_job') return retireOutboxJob(tx, item, scope, now)
        return retireWmsPushLink(tx, item, scope, now)
      }))
    } catch (error) {
      if (error instanceof RetirementConflict) {
        outcomes.push({ item, result: 'changed_since_plan', detail: error.message })
        continue
      }
      throw error
    }
  }
  const counts: RetirementApplyResult['counts'] = { shadowed: 0, parked: 0, left_alone: 0, changed_since_plan: 0 }
  for (const outcome of outcomes) counts[outcome.result] += 1
  return { outcomes, counts }
}
