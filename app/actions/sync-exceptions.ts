'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { mergeStuckDispatchRows } from '@/lib/domain/wms/exception-inbox'
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
} from '@/lib/domain/wms/exception-inbox'
import { syncRefundsForOrder } from '@/lib/connectors/woocommerce/sync/refund-sync'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
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
  orderId: string
  orderNumber: string | null
  externalOrderNumber: string | null
  connector: string
  failureCount: number
  reason: string | null
  deadLetteredAt: string | null
  /**
   * o3d-bjc.9: WHY the link left the sweep. 'dead-letter' — the reconcile kept
   * ERRORING (transport, apply). 'unresolved' — the WMS answered but its record
   * could not be turned into a dispatch state, so the link was quarantined to
   * stop it pinning the delta watermark. Different causes, same remedy here:
   * fix it in the WMS, then replay.
   */
  kind: 'dead-letter' | 'unresolved'
}

export type ProductStructureConflictRow = {
  id: string
  /** The IMS product the WooCommerce object was paired with. */
  productId: string | null
  sku: string | null
  productName: string | null
  productType: string | null
  /** The WooCommerce product id. */
  externalProductId: string | null
  detail: string | null
  foundAt: string
}

export type OrderReconcileDriftRow = {
  orderId: string
  orderNumber: string | null
  externalOrderNumber: string | null
  category: string
  detail: string | null
  foundAt: string | null
}

export type ExceptionInboxSummary = {
  wmsPushDeadLetters: number
  outboxFailures: number
  deadReceiptEvents: number
  refundSyncParks: number
  stuckDispatches: number
  pennyMismatches: number
  orderReconcileDrift: number
  productStructureConflicts: number
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
  orderReconcileDrift: OrderReconcileDriftRow[]
  productStructureConflicts: ProductStructureConflictRow[]
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
  // QUARANTINED (o3d-w00 #2/#5 / o3d-iup): a monetary-only refund deliberately parked because the order
  // isn't uniformly taxed. It has no SalesOrderRefund and the sweep skips it, so the exception inbox is
  // the ONLY way an operator sees and recovers it — it must appear here alongside PENDING/FAILED.
  status: { in: ['PENDING' as const, 'FAILED' as const, 'QUARANTINED' as const] },
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
// 6oyu.2: stuck dispatches are now first-class — the dispatch sweep dead-letters
// a link after DISPATCH_MAX_CONSECUTIVE_FAILURES consecutive reconcile errors
// (dispatchDeadLetteredAt set, link leaves the sweep's candidate set).
// Scoped to the sweep's own candidate states (Codex r4): a link that later goes
// HELD/CANCELLED/push-DEAD_LETTER is no longer a dispatch question — those
// surface through their own flows — so it must not linger here as an exception.
// o3d-bjc.9: a QUARANTINED link belongs here for the same reason a dead-lettered
// one does — it has left the sweep and only an operator can bring it back. It was
// missing, and the quarantine notification points at this page, so the advertised
// workflow simply did not exist for it.
const STUCK_DISPATCH_STATES = {
  state: { in: ['SYNCED' as const, 'MERGED' as const] },
}

const STUCK_DISPATCH_WHERE = {
  ...STUCK_DISPATCH_STATES,
  OR: [
    { dispatchDeadLetteredAt: { not: null } },
    { dispatchUnresolvedAt: { not: null } },
  ],
}

function countStuckDispatches(): Promise<number> {
  return db.wmsOrderPushLink.count({ where: STUCK_DISPATCH_WHERE })
}

async function loadStuckDispatches(): Promise<StuckDispatchRow[]> {
  // Two queries, each capped, then merged and re-capped on the EFFECTIVE held
  // timestamp. A single ordered query cannot do this: sorting by
  // dispatchDeadLetteredAt first puts every dead letter ahead of every
  // unresolved-only row (nulls last), so 50 existing dead letters would hide
  // every new quarantine from the page its own notification links to.
  const select = {
    orderId: true,
    connector: true,
    externalOrderNumber: true,
    dispatchFailureCount: true,
    dispatchLastError: true,
    dispatchDeadLetteredAt: true,
    dispatchUnresolvedCount: true,
    dispatchUnresolvedError: true,
    dispatchUnresolvedAt: true,
    order: { select: { orderNumber: true } },
  } as const

  const [deadLettered, quarantined] = await Promise.all([
    db.wmsOrderPushLink.findMany({
      where: { ...STUCK_DISPATCH_STATES, dispatchDeadLetteredAt: { not: null } },
      orderBy: { dispatchDeadLetteredAt: 'desc' },
      take: SECTION_LIMIT,
      select,
    }),
    db.wmsOrderPushLink.findMany({
      // Dead-lettered rows are reported by the query above (the dead-letter is
      // the stronger statement), so exclude them here rather than de-duplicating.
      where: { ...STUCK_DISPATCH_STATES, dispatchUnresolvedAt: { not: null }, dispatchDeadLetteredAt: null },
      orderBy: { dispatchUnresolvedAt: 'desc' },
      take: SECTION_LIMIT,
      select,
    }),
  ])

  return mergeStuckDispatchRows([...deadLettered, ...quarantined], SECTION_LIMIT)
}

/**
 * o3d-y89x / o3d-fjqk: a WooCommerce product and its IMS twin DISAGREE about the row's shape,
 * so part of the payload could not be applied. One rule, both directions (o3d-y89x r3):
 *
 *   - WooCommerce says VARIABLE and the IMS row cannot be a parent (a KIT, a row that is
 *     itself somebody's child, a live row the editor would refuse to transform): the
 *     variations exist nowhere in IMS;
 *   - WooCommerce says SIMPLE and the IMS row is a VARIABLE parent: its type and price go
 *     unwritten and its IMS variants stay standing;
 *   - or a single variation SKU resolves to an IMS row belonging to a different parent.
 *
 * The connector refuses to flatten the IMS side in every case, because the structure it would
 * destroy is IMS-owned and WooCommerce never asked for it to go. An IMS KIT paired with a
 * WooCommerce SIMPLE product is NOT here: both sides agree the row is not a parent, so nothing
 * went unapplied and that ordinary bundle pairing stays silent.
 *
 * Written by the product sync itself, deduplicated to ONE open row per pairing, and DELETED
 * by the next sync that completes cleanly — so this list is live rather than a log, and the
 * rows need no acknowledge action: resolving the conflict is what removes them. The product
 * reconcile cursor does not advance past a conflicted product, so the retry is automatic.
 */
const PRODUCT_STRUCTURE_CONFLICT_WHERE = {
  connector: 'woocommerce',
  direction: 'FROM_CONNECTOR' as const,
  entityType: 'Product',
  status: 'QUARANTINED' as const,
}

function countProductStructureConflicts(): Promise<number> {
  return db.shoppingSyncLog.count({ where: PRODUCT_STRUCTURE_CONFLICT_WHERE })
}

async function loadProductStructureConflicts(): Promise<ProductStructureConflictRow[]> {
  const rows = await db.shoppingSyncLog.findMany({
    where: PRODUCT_STRUCTURE_CONFLICT_WHERE,
    orderBy: { createdAt: 'desc' },
    take: SECTION_LIMIT,
    select: { id: true, entityId: true, externalId: true, errorMessage: true, createdAt: true },
  })

  const productIds = rows.map((row) => row.entityId).filter((id): id is string => Boolean(id))
  const products = productIds.length > 0
    ? await db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, name: true, type: true },
      })
    : []
  const productById = new Map(products.map((product) => [product.id, product]))

  return rows.map((row) => {
    const product = row.entityId ? productById.get(row.entityId) : undefined
    return {
      id: row.id,
      productId: row.entityId,
      sku: product?.sku ?? null,
      productName: product?.name ?? null,
      productType: product?.type ?? null,
      externalProductId: row.externalId,
      detail: row.errorMessage,
      foundAt: row.createdAt.toISOString(),
    }
  })
}

/**
 * q66in.4.4: drift findings are DURABLE wms_order_discrepancies rows — the
 * capped sweep upserts them and resolves a row only when that specific order
 * re-verifies clean, so a newer (necessarily partial) run never clears truth.
 */
const ORDER_DRIFT_WHERE = { status: 'OPEN' }

function countOrderReconcileDrift(): Promise<number> {
  return db.wmsOrderDiscrepancy.count({ where: ORDER_DRIFT_WHERE })
}

async function loadOrderReconcileDrift(): Promise<OrderReconcileDriftRow[]> {
  const rows = await db.wmsOrderDiscrepancy.findMany({
    where: ORDER_DRIFT_WHERE,
    orderBy: [{ category: 'asc' }, { firstSeenAt: 'asc' }],
    take: SECTION_LIMIT,
    select: {
      orderId: true,
      category: true,
      detail: true,
      externalOrderNumber: true,
      lastSeenAt: true,
      order: { select: { orderNumber: true } },
    },
  })
  return rows.map((row) => ({
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    externalOrderNumber: row.externalOrderNumber,
    category: row.category,
    detail: row.detail,
    foundAt: row.lastSeenAt.toISOString(),
  }))
}

/** True per-source totals — never capped by the display limit (Codex r3/r5). */
async function loadExceptionCounts(): Promise<ExceptionInboxSummary> {
  const [wmsPushDeadLetters, outboxFailures, deadReceipts, deadWebhooks, refundSyncParks, pennyMismatches, stuckDispatches, orderReconcileDrift, productStructureConflicts] = await Promise.all([
    db.wmsOrderPushLink.count({ where: { state: 'DEAD_LETTER' } }),
    db.integrationOutbox.count({ where: { status: { in: OUTBOX_FAILURE_STATUSES } } }),
    db.wmsInboundReceiptEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.wmsWebhookEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.shoppingSyncLog.count({ where: REFUND_PARK_WHERE }),
    db.wmsOrderPushLink.count({ where: { totalMismatchPence: { not: null } } }),
    countStuckDispatches(),
    countOrderReconcileDrift(),
    countProductStructureConflicts(),
  ])

  const deadReceiptEvents = deadReceipts + deadWebhooks
  return {
    wmsPushDeadLetters,
    outboxFailures,
    deadReceiptEvents,
    refundSyncParks,
    stuckDispatches,
    pennyMismatches,
    orderReconcileDrift,
    productStructureConflicts,
    total: wmsPushDeadLetters + outboxFailures + deadReceiptEvents + refundSyncParks + stuckDispatches + pennyMismatches + orderReconcileDrift + productStructureConflicts,
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
  const [pushLinks, outbox, deadReceiptRows, deadWebhookRows, refundLogs, stuckDispatches, mismatchLinks, orderReconcileDrift, productStructureConflicts] = await Promise.all([
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
    loadOrderReconcileDrift(),
    loadProductStructureConflicts(),
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
    orderReconcileDrift,
    productStructureConflicts,
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

    // o3d-w00 #2/#5 / o3d-iup: a QUARANTINED park makes the sweep dedup skip this refund. An explicit
    // operator retry must let the re-fetch re-attempt it — but we must NOT delete the park before the
    // fallible fetch, or a fetch error / a refund missing from the response would leave nothing behind and
    // strand the refund. Instead TRANSITION the quarantine to PENDING atomically: the row stays durable
    // and visible in the inbox, and PENDING is not skipped by the dedup, so the re-fetch re-attempts it.
    // The refund then lands (post-processing marks it SYNCED), or re-parks as a fresh QUARANTINED (the
    // duplicate-dedup below keeps exactly one), or — if the fetch fails — remains a visible PENDING park to
    // retry again. Scoped to this refund's externalId.
    // o3d-7yf: every refund lookup and park transition here MUST be scoped to THIS park's order
    // (entityId = row.entityId). externalRefundId is globally unique and the park index is keyed by
    // (connector, externalId), so an externalId-only query would let another order's refund resolve — and
    // erase — this order's park (and its deletion/rebind guard).
    if (row.externalId && row.entityId) {
      await db.shoppingSyncLog.updateMany({
        where: { ...REFUND_PARK_WHERE, externalId: row.externalId, entityId: row.entityId, status: 'QUARANTINED' },
        data: { status: 'PENDING' },
      })
    }

    await syncRefundsForOrder(Number(orderLink.externalOrderId))

    const refundLanded = row.externalId
      ? await db.salesOrderRefund.findFirst({
          where: { externalRefundId: Number(row.externalId), orderId: row.entityId },
          select: { id: true },
        })
      : null

    if (refundLanded) {
      // Codex r6: repeated webhook deliveries can have parked the SAME refund
      // several times — resolve every park row for this refund AND this order, not just the
      // clicked one, so stale duplicates don't linger as actionable exceptions.
      await db.shoppingSyncLog.updateMany({
        where: row.externalId ? { ...REFUND_PARK_WHERE, externalId: row.externalId, entityId: row.entityId } : { id: row.id },
        data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
      })
    } else if (row.externalId) {
      // o3d-7yf: the refund did not land for THIS order. If a refund with this id exists on ANOTHER order,
      // this is a cross-order anomaly — fail closed WITHOUT resolving the clicked park with a foreign refund.
      const foreignRefund = await db.salesOrderRefund.findFirst({
        where: { externalRefundId: Number(row.externalId), orderId: { not: row.entityId } },
        select: { orderId: true },
      })
      if (foreignRefund) {
        return { success: false, error: `Refund ${row.externalId} belongs to a different order (${foreignRefund.orderId}); this park cannot be resolved by it.` }
      }
      // Codex P2: a still-failing retry re-parks the SAME refund as a fresh row
      // (refund-sync always creates). Keep only the newest park per refund+order —
      // delete the older duplicates so the inbox shows one actionable row with
      // the current error instead of accumulating copies on every retry.
      const parks = await db.shoppingSyncLog.findMany({
        where: { ...REFUND_PARK_WHERE, externalId: row.externalId, entityId: row.entityId },
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
 * Replay a dispatch reconciliation the sweep gave up on: clear the marker and
 * the streak so the next sweep retries the order. Use after fixing the
 * underlying cause — typically the order's IMS stock position (dead-letter), or
 * the WMS record itself (o3d-bjc.9 quarantine).
 */
export async function replayStuckDispatch(orderId: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    const updated = await db.wmsOrderPushLink.updateMany({
      where: {
        orderId,
        OR: [{ dispatchDeadLetteredAt: { not: null } }, { dispatchUnresolvedAt: { not: null } }],
      },
      // BOTH streaks: a link can hold an unresolved quarantine and a dead-letter
      // at once, and replaying one while the other still excludes it from the
      // candidate set would report success and change nothing.
      data: {
        dispatchDeadLetteredAt: null,
        dispatchFailureCount: 0,
        dispatchLastError: null,
        dispatchUnresolvedAt: null,
        dispatchUnresolvedCount: 0,
        dispatchUnresolvedError: null,
      },
    })
    if (updated.count === 0) {
      return { success: false, error: 'The dispatch is no longer held back (already replayed).' }
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      tag: 'sync',
      action: 'wms_dispatch_replay',
      description: 'Re-queued a dead-lettered dispatch reconciliation via the exception inbox',
      metadata: { orderId, userId: session.user.id },
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
 * Re-create a WMS order the WMS no longer knows (MISSING_IN_WMS reconcile
 * finding): compare-and-set the SYNCED/MERGED link back to PENDING_CREATE so
 * the next push sweep re-pushes it. The sweep's own eligibility still applies,
 * so a no-longer-eligible order simply won't re-push.
 */
export async function repushMissingWmsOrder(orderId: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')

    // Codex r17: the durable row may be STALE (order restored/recreated in the
    // WMS since the sweep ran) — a reset would then make the push sweep create
    // a DUPLICATE. Revalidate absence live, and only for the active connector.
    const pluginState = await getIntegrationPluginState()
    const activeConnectorId = WMS_CONNECTOR_IDS.find((id) => pluginState[id])
    const openFinding = await db.wmsOrderDiscrepancy.findFirst({
      where: { orderId, category: 'MISSING_IN_WMS', status: 'OPEN' },
      select: { connector: true },
    })
    if (!openFinding) {
      return { success: false, error: 'No open missing-in-WMS finding for this order (already resolved or re-verified).' }
    }
    if (!activeConnectorId || openFinding.connector !== activeConnectorId) {
      return { success: false, error: 'This finding belongs to a connector that is no longer active — the next reconcile run retires it.' }
    }
    const connector = getWmsConnector(activeConnectorId)
    if (!connector.probeOrderPresence) {
      return { success: false, error: 'The active WMS connector cannot verify order absence, so a safe re-push is not possible.' }
    }
    // Codex r30 P1: the push sweep's create pass only selects ready
    // (PROCESSING/ALLOCATED), paid, not-fully-refunded orders — resetting the
    // link for e.g. a PICKING/PACKING order would resolve the finding while the
    // order is never re-created and silently never fulfils. Refuse; the
    // operator must return the order to a ready status first.
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { status: true, paidAt: true, refundStatus: true },
    })
    if (!order || !['PROCESSING', 'ALLOCATED'].includes(order.status) || !order.paidAt || order.refundStatus === 'FULL') {
      return {
        success: false,
        error: `The push sweep only re-creates paid, ready (Processing/Allocated) orders — this order is ${order?.status ?? 'missing'}. Return it to a ready status (or resolve it manually in the WMS); the finding stays open meanwhile.`,
      }
    }
    const link = await db.wmsOrderPushLink.findUnique({
      where: { orderId },
      select: { externalOrderNumber: true },
    })
    const presence = link?.externalOrderNumber
      ? await connector.probeOrderPresence(link.externalOrderNumber)
      : 'MISSING'
    if (presence === 'FOUND') {
      // The WMS knows the order again — the finding is stale; resolve it instead.
      await db.wmsOrderDiscrepancy.updateMany({
        where: { orderId, category: 'MISSING_IN_WMS', status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
      return { success: false, error: 'The WMS knows this order again — the finding was stale and has been resolved. No re-push needed.' }
    }
    if (presence === 'AMBIGUOUS') {
      return { success: false, error: 'The WMS returned an ambiguous match for this order — re-pushing could create a duplicate. Resolve the ambiguity in the WMS first.' }
    }

    // Codex: an OPEN finding is the AUTHORIZATION for this reset, and the two
    // writes are one transaction — if the link reset doesn't apply, the finding
    // stays OPEN (it must not vanish from the inbox with the order unfixed).
    const outcome = await db.$transaction(async (tx) => {
      const finding = await tx.wmsOrderDiscrepancy.updateMany({
        where: { orderId, category: 'MISSING_IN_WMS', status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
      if (finding.count === 0) {
        return { ok: false as const, error: 'No open missing-in-WMS finding for this order (already resolved or re-verified).' }
      }
      const updated = await tx.wmsOrderPushLink.updateMany({
        // CAS on the exact WMS reference that was probed absent (Codex r20): a
        // concurrent merge repoint changes externalOrderNumber, and clearing
        // the NEW survivor reference off a stale probe would let the push
        // sweep duplicate it.
        where: { orderId, state: { in: ['SYNCED', 'MERGED'] }, externalOrderNumber: link?.externalOrderNumber ?? null },
        data: {
          state: 'PENDING_CREATE',
          externalOrderId: null,
          externalOrderNumber: null,
          attempts: 0,
          lastError: null,
          dispatchFailureCount: 0,
          dispatchLastError: null,
          dispatchDeadLetteredAt: null,
          // The recency belonged to the MISSING order — the replacement must
          // rotate to the front of verification, not inherit it (Codex r9).
          reconcileCheckedAt: null,
        },
      })
      if (updated.count === 0) {
        // Rolls back the finding resolution.
        throw new Error('REPUSH_LINK_NOT_RESETTABLE')
      }
      return { ok: true as const }
    }).catch((error) => {
      if (error instanceof Error && error.message === 'REPUSH_LINK_NOT_RESETTABLE') {
        return { ok: false as const, error: 'The push link is no longer in a re-pushable state.' }
      }
      throw error
    })
    if (!outcome.ok) {
      return { success: false, error: outcome.error }
    }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      tag: 'sync',
      action: 'wms_order_repush',
      description: 'Re-queued a WMS-missing order for re-push via the exception inbox',
      metadata: { orderId, userId: session.user.id },
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
