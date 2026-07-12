'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import {
  IntegrationOutboxAdminError,
  listIntegrationOutboxAdminRows,
  replayIntegrationOutboxAdminRow,
} from '@/lib/domain/integrations/outbox-admin'
import { INTEGRATION_OUTBOX_STATUS } from '@/lib/domain/integrations/outbox'
import {
  DEAD_RECEIPT_EVENT_STATUS,
  buildDeadReceiptEventReplayData,
  buildDeadReceiptEventReplayWhere,
  parseDispatchErrorPayload,
} from '@/lib/domain/wms/exception-inbox'
import { syncRefundsForOrder } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'

// q66in.4.2: the dead-letter / exception inbox. One aggregated read model over
// every terminal failure state that previously had no (or a buried) surface:
// WMS order-push dead-letters, integration-outbox failures, DEAD receipt
// events, parked WooCommerce refund-sync rows, stuck dispatch reconciliations,
// and the advisory order-total penny-mismatch flags. Replay actions reuse the
// existing domain transitions so the original payload + idempotency key are
// preserved — a replay re-attempts the SAME work, never forges a new attempt.

const SECTION_LIMIT = 50

export type WmsPushDeadLetterRow = {
  orderId: string
  orderNumber: string | null
  connector: string
  attempts: number
  lastError: string | null
  lastAttemptAt: string | null
}

export type PennyMismatchRow = {
  orderId: string
  orderNumber: string | null
  connector: string
  totalMismatchPence: number
  externalOrderNumber: string | null
}

export type OutboxFailureRow = {
  id: string
  connector: string
  operation: string
  status: string
  attempts: number
  lastError: string | null
  updatedAt: string
}

export type DeadReceiptEventRow = {
  id: string
  connector: string
  /** booked-in = wms_inbound_receipt_events (ASN goods-in); webhook = wms_webhook_events (order/inventory). */
  kind: 'booked-in' | 'webhook'
  externalEventId: string
  /** ASN id for booked-in rows; the event type for webhook rows. */
  reference: string | null
  processingAttempts: number
  lastError: string | null
  deadLetteredAt: string | null
}

export type RefundSyncParkRow = {
  id: string
  status: string
  externalRefundId: string | null
  orderId: string | null
  orderNumber: string | null
  errorMessage: string | null
  createdAt: string
}

export type StuckDispatchRow = {
  orderId: string | null
  orderNumber: string | null
  externalOrderNumber: string | null
  reason: string | null
  jobFinishedAt: string | null
}

export type ExceptionInboxSummary = {
  wmsPushDeadLetters: number
  outboxFailures: number
  deadReceiptEvents: number
  refundSyncParks: number
  stuckDispatches: number
  pennyMismatches: number
  total: number
}

export type ExceptionInboxData = {
  summary: ExceptionInboxSummary
  wmsPushDeadLetters: WmsPushDeadLetterRow[]
  outboxFailures: OutboxFailureRow[]
  deadReceiptEvents: DeadReceiptEventRow[]
  refundSyncParks: RefundSyncParkRow[]
  stuckDispatches: StuckDispatchRow[]
  pennyMismatches: PennyMismatchRow[]
}

// Codex r4: only PERMANENT_FAILED rows are actionable exceptions — a
// RETRYABLE_FAILED row is still on the processor's automatic retry ladder and
// either recovers or lands here as PERMANENT_FAILED. Listing mid-backoff rows
// would surface self-resolving noise, and "acknowledging" them (flipping to
// PERMANENT_FAILED) would not have removed them from this same list.
const OUTBOX_FAILURE_STATUSES = [
  INTEGRATION_OUTBOX_STATUS.PERMANENT_FAILED,
]

// Codex P2: order-import writes FROM_CONNECTOR/SalesOrder rows too (failed
// imports have NO entityId; the missing-FX queue rows have NO entityId and a
// payload.reason marker). Refund-sync rows always carry entityId = the IMS
// order id, so require it — and exclude the FX-queue marker defensively so a
// future entityId-carrying FX row can never be "retried" as a refund. The
// exclusion must explicitly admit SQL-NULL payloads (refund-sync's FAILED rows
// carry none): a JSON-path NOT predicate silently drops NULL rows.
const REFUND_PARK_WHERE = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR' as const,
  entityType: 'SalesOrder',
  status: { in: ['PENDING' as const, 'FAILED' as const] },
  entityId: { not: null },
  OR: [
    { payload: { equals: Prisma.DbNull } },
    { NOT: { payload: { path: ['reason'], equals: 'missing_fx_rate' } } },
  ],
}

/**
 * Stuck dispatch reconciliations have no first-class entity (dispatch-sweep.ts
 * "re-errors each run"): derive them from the error logs of the most recent
 * finished DISPATCH_SYNC sweep. Anything listed here failed on the latest run
 * and will keep failing until an operator intervenes.
 */
async function findLatestDispatchSweepJob(): Promise<{ id: string; finishedAt: Date | null } | null> {
  return db.wmsSyncJob.findFirst({
    where: { type: 'DISPATCH_SYNC', finishedAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, finishedAt: true },
  })
}

/** Codex P2: the banner count must not inherit the 50-row display limit. */
async function countStuckDispatches(): Promise<number> {
  const latestJob = await findLatestDispatchSweepJob()
  if (!latestJob) return 0
  return db.wmsSyncLog.count({ where: { jobId: latestJob.id, action: 'error' } })
}

async function loadStuckDispatches(): Promise<StuckDispatchRow[]> {
  const latestJob = await findLatestDispatchSweepJob()
  if (!latestJob) return []

  const errorLogs = await db.wmsSyncLog.findMany({
    where: { jobId: latestJob.id, action: 'error' },
    take: SECTION_LIMIT,
    select: { reason: true, payload: true },
  })
  if (errorLogs.length === 0) return []

  const parsed = errorLogs.map((log) => ({
    ...parseDispatchErrorPayload(log.payload),
    reason: log.reason,
  }))

  const orderIds = parsed.map((row) => row.orderId).filter((id): id is string => Boolean(id))
  const orders = orderIds.length > 0
    ? await db.salesOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderNumber: true },
      })
    : []
  const orderNumberById = new Map(orders.map((order) => [order.id, order.orderNumber]))

  return parsed.map((row) => ({
    orderId: row.orderId,
    orderNumber: row.orderId ? orderNumberById.get(row.orderId) ?? null : null,
    externalOrderNumber: row.externalOrderNumber,
    reason: row.reason,
    jobFinishedAt: latestJob.finishedAt?.toISOString() ?? null,
  }))
}

/** True per-source totals — never capped by the display limit (Codex r3/r5). */
async function loadExceptionCounts(): Promise<ExceptionInboxSummary> {
  const [wmsPushDeadLetters, outboxFailures, deadReceipts, deadWebhooks, refundSyncParks, pennyMismatches, stuckDispatches] = await Promise.all([
    db.wmsOrderPushLink.count({ where: { state: 'DEAD_LETTER' } }),
    db.integrationOutbox.count({ where: { status: { in: OUTBOX_FAILURE_STATUSES } } }),
    db.wmsInboundReceiptEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.wmsWebhookEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.shoppingSyncLog.count({ where: REFUND_PARK_WHERE }),
    db.wmsOrderPushLink.count({ where: { totalMismatchPence: { not: null } } }),
    countStuckDispatches(),
  ])

  const deadReceiptEvents = deadReceipts + deadWebhooks
  return {
    wmsPushDeadLetters,
    outboxFailures,
    deadReceiptEvents,
    refundSyncParks,
    stuckDispatches,
    pennyMismatches,
    total: wmsPushDeadLetters + outboxFailures + deadReceiptEvents + refundSyncParks + stuckDispatches + pennyMismatches,
  }
}

export async function getExceptionInboxSummary(): Promise<ExceptionInboxSummary> {
  // Codex P1: failure rows carry order ids, connector errors and refund ids —
  // gate reads on the sync permission (READONLY/SUPPLIER must not see them).
  // The /sync banner loader .catch()es, so the banner just hides for them.
  await requirePermission('sync')
  return loadExceptionCounts()
}

export async function getExceptionInboxData(): Promise<ExceptionInboxData> {
  await requirePermission('sync')

  const counts = await loadExceptionCounts()
  const [pushLinks, outbox, deadReceiptRows, deadWebhookRows, refundLogs, stuckDispatches, mismatchLinks] = await Promise.all([
    db.wmsOrderPushLink.findMany({
      where: { state: 'DEAD_LETTER' },
      orderBy: { lastAttemptAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        orderId: true,
        connector: true,
        attempts: true,
        lastError: true,
        lastAttemptAt: true,
        order: { select: { orderNumber: true } },
      },
    }),
    // The admin list filter takes a single status, so query each failure status
    // and merge — filtering one mixed recent page would hide failures older
    // than the newest 50 rows of ANY status.
    Promise.all(OUTBOX_FAILURE_STATUSES.map((status) => listIntegrationOutboxAdminRows({ status, limit: SECTION_LIMIT })))
      .then((results) => results
        .flatMap((result) => result.rows)
        .sort((left, right) => new Date(right.updatedAt as never).getTime() - new Date(left.updatedAt as never).getTime())
        .slice(0, SECTION_LIMIT)),
    db.wmsInboundReceiptEvent.findMany({
      where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS },
      orderBy: { deadLetteredAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        id: true,
        connector: true,
        externalEventId: true,
        externalAsnId: true,
        processingAttempts: true,
        lastError: true,
        deadLetteredAt: true,
      },
    }),
    // Codex r5: order/inventory webhooks dead-letter in their own table
    // (wms_webhook_events) with the same retry machinery — include them.
    db.wmsWebhookEvent.findMany({
      where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS },
      orderBy: { deadLetteredAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        id: true,
        connector: true,
        eventType: true,
        externalEventId: true,
        processingAttempts: true,
        lastError: true,
        deadLetteredAt: true,
      },
    }),
    db.shoppingSyncLog.findMany({
      where: REFUND_PARK_WHERE,
      orderBy: { createdAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        id: true,
        status: true,
        entityId: true,
        externalId: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
    loadStuckDispatches(),
    db.wmsOrderPushLink.findMany({
      where: { totalMismatchPence: { not: null } },
      orderBy: { lastAttemptAt: 'desc' },
      take: SECTION_LIMIT,
      select: {
        orderId: true,
        connector: true,
        totalMismatchPence: true,
        externalOrderNumber: true,
        order: { select: { orderNumber: true } },
      },
    }),
  ])

  const refundOrderIds = refundLogs.map((log) => log.entityId).filter((id): id is string => Boolean(id))
  const refundOrders = refundOrderIds.length > 0
    ? await db.salesOrder.findMany({
        where: { id: { in: refundOrderIds } },
        select: { id: true, orderNumber: true },
      })
    : []
  const refundOrderNumberById = new Map(refundOrders.map((order) => [order.id, order.orderNumber]))

  const data: Omit<ExceptionInboxData, 'summary'> = {
    wmsPushDeadLetters: pushLinks.map((link) => ({
      orderId: link.orderId,
      orderNumber: link.order.orderNumber,
      connector: link.connector,
      attempts: link.attempts,
      lastError: link.lastError,
      lastAttemptAt: link.lastAttemptAt?.toISOString() ?? null,
    })),
    outboxFailures: outbox.map((row) => ({
      id: row.id,
      connector: row.connector,
      operation: row.operation,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    })),
    deadReceiptEvents: [
      ...deadReceiptRows.map((event) => ({
        id: event.id,
        connector: event.connector,
        kind: 'booked-in' as const,
        externalEventId: event.externalEventId,
        reference: event.externalAsnId,
        processingAttempts: event.processingAttempts,
        lastError: event.lastError,
        deadLetteredAt: event.deadLetteredAt?.toISOString() ?? null,
      })),
      ...deadWebhookRows.map((event) => ({
        id: event.id,
        connector: event.connector,
        kind: 'webhook' as const,
        externalEventId: event.externalEventId,
        reference: event.eventType,
        processingAttempts: event.processingAttempts,
        lastError: event.lastError,
        deadLetteredAt: event.deadLetteredAt?.toISOString() ?? null,
      })),
    ]
      .sort((left, right) => (right.deadLetteredAt ?? '').localeCompare(left.deadLetteredAt ?? ''))
      .slice(0, SECTION_LIMIT),
    refundSyncParks: refundLogs.map((log) => ({
      id: log.id,
      status: log.status,
      externalRefundId: log.externalId,
      orderId: log.entityId,
      orderNumber: log.entityId ? refundOrderNumberById.get(log.entityId) ?? null : null,
      errorMessage: log.errorMessage,
      createdAt: log.createdAt.toISOString(),
    })),
    stuckDispatches,
    pennyMismatches: mismatchLinks.map((link) => ({
      orderId: link.orderId,
      orderNumber: link.order.orderNumber,
      connector: link.connector,
      totalMismatchPence: link.totalMismatchPence ?? 0,
      externalOrderNumber: link.externalOrderNumber,
    })),
  }

  return {
    ...data,
    // Codex r5: real totals, not the capped list lengths — the client renders
    // "showing N of M" when a section is capped at SECTION_LIMIT.
    summary: counts,
  }
}

type MutationResult = { success: boolean; error?: string } | FreshAuthFailureResult

/**
 * Replay a failed integration-outbox row (accounting post / WC stock push /
 * booked-in / landed-cost journal). Resets to PENDING with the ORIGINAL payload
 * and idempotency key — the compare-and-set inside the domain transition 409s
 * if the row changed underneath the operator.
 */
export async function replayOutboxException(id: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const result = await replayIntegrationOutboxAdminRow({ id })
    await logActivity({
      entityType: 'SYNC',
      entityId: id,
      tag: 'sync',
      action: 'integration_outbox_replay',
      description: `Re-queued integration outbox row (${result.row.connector}/${result.row.operation}) from ${result.priorStatus} via the exception inbox`,
      metadata: { outboxId: id, priorStatus: result.priorStatus, priorLastError: result.priorLastError, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    if (error instanceof IntegrationOutboxAdminError) return { success: false, error: error.message }
    throw error
  }
}

/**
 * Replay a DEAD (retry-exhausted) inbound receipt event: compare-and-set back
 * to PENDING so the webhook sweeper re-processes it with the ORIGINAL payload
 * and externalEventId idempotency. Attempts reset so the retry ladder restarts.
 */
export async function replayDeadReceiptEvent(id: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const updated = await db.wmsInboundReceiptEvent.updateMany({
      where: buildDeadReceiptEventReplayWhere(id),
      data: buildDeadReceiptEventReplayData(),
    })
    if (updated.count === 0) {
      return { success: false, error: 'The receipt event is no longer dead-lettered (already replayed or processed).' }
    }
    await logActivity({
      entityType: 'SYNC',
      entityId: id,
      tag: 'sync',
      action: 'wms_receipt_event_replay',
      description: 'Re-queued a dead-lettered WMS receipt event via the exception inbox',
      metadata: { receiptEventId: id, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Replay a DEAD order/inventory webhook event (wms_webhook_events): same
 * compare-and-set reset as the booked-in replay; the webhook sweeper
 * re-processes the ORIGINAL payload under its externalEventId idempotency, and
 * the monotonic status-rank guard makes a stale replay a no-op.
 */
export async function replayDeadWebhookEvent(id: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const updated = await db.wmsWebhookEvent.updateMany({
      where: buildDeadReceiptEventReplayWhere(id),
      data: buildDeadReceiptEventReplayData(),
    })
    if (updated.count === 0) {
      return { success: false, error: 'The webhook event is no longer dead-lettered (already replayed or processed).' }
    }
    await logActivity({
      entityType: 'SYNC',
      entityId: id,
      tag: 'sync',
      action: 'wms_webhook_event_replay',
      description: 'Re-queued a dead-lettered WMS webhook event via the exception inbox',
      metadata: { webhookEventId: id, userId: session.user.id },
    })
    revalidatePath('/sync/exceptions')
    return { success: true }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Retry a parked WooCommerce refund-sync row by re-running refund sync for the
 * whole order — a FRESH fetch from WooCommerce (already-synced refunds dedupe by
 * externalRefundId), so a since-corrected refund now applies instead of
 * replaying the stale parked payload. The row is marked SYNCED only when the
 * specific refund verifiably landed.
 */
export async function retryRefundSyncPark(id: string): Promise<MutationResult & { synced?: boolean }> {
  try {
    const session = await requireFreshPermission('sync')
    const row = await db.shoppingSyncLog.findFirst({
      where: { id, ...REFUND_PARK_WHERE },
      select: { id: true, entityId: true, externalId: true },
    })
    if (!row || !row.entityId) {
      return { success: false, error: 'The sync log row is no longer pending (already resolved or removed).' }
    }

    const orderLink = await db.shoppingOrderLink.findFirst({
      where: { orderId: row.entityId, connector: 'woocommerce' },
      select: { externalOrderId: true },
    })
    if (!orderLink) {
      return { success: false, error: 'The order has no WooCommerce link, so its refunds cannot be re-fetched.' }
    }

    await syncRefundsForOrder(Number(orderLink.externalOrderId))

    const refundLanded = row.externalId
      ? await db.salesOrderRefund.findFirst({
          where: { externalRefundId: Number(row.externalId) },
          select: { id: true },
        })
      : null

    if (refundLanded) {
      await db.shoppingSyncLog.update({
        where: { id: row.id },
        data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
      })
    } else if (row.externalId) {
      // Codex P2: a still-failing retry re-parks the SAME refund as a fresh row
      // (refund-sync always creates). Keep only the newest park per refund —
      // delete the older duplicates so the inbox shows one actionable row with
      // the current error instead of accumulating copies on every retry.
      const parks = await db.shoppingSyncLog.findMany({
        where: { ...REFUND_PARK_WHERE, externalId: row.externalId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      const staleIds = parks.slice(1).map((park) => park.id)
      if (staleIds.length > 0) {
        await db.shoppingSyncLog.deleteMany({ where: { id: { in: staleIds } } })
      }
    }

    await logActivity({
      entityType: 'SYNC',
      entityId: row.entityId,
      tag: 'sync',
      action: 'wc_refund_sync_retry',
      description: refundLanded
        ? `Retried parked WooCommerce refund ${row.externalId} via the exception inbox — refund applied`
        : `Retried parked WooCommerce refund ${row.externalId} via the exception inbox — still not applied (see the row's error)`,
      metadata: { shoppingSyncLogId: row.id, externalRefundId: row.externalId, userId: session.user.id },
      level: refundLanded ? undefined : 'WARNING',
    })
    revalidatePath('/sync/exceptions')
    return { success: true, synced: Boolean(refundLanded) }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * Clear the advisory order-total penny-mismatch flag once an operator has
 * reviewed the order (the push itself already went through; the flag only
 * records that IMS and WMS totals drifted by more than a penny).
 */
export async function clearPennyMismatchFlag(orderId: string): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission('sync')
  const updated = await db.wmsOrderPushLink.updateMany({
    where: { orderId, totalMismatchPence: { not: null } },
    data: { totalMismatchPence: null },
  })
  if (updated.count === 0) {
    return { success: false, error: 'The flag was already cleared.' }
  }
  await logActivity({
    entityType: 'SYNC',
    entityId: orderId,
    tag: 'sync',
    action: 'wms_push_total_mismatch_cleared',
    description: 'Cleared the WMS push order-total mismatch flag via the exception inbox',
    metadata: { orderId, userId: session.user.id },
  })
  revalidatePath('/sync/exceptions')
  return { success: true }
}
