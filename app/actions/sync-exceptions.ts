'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { mergeStuckDispatchRows } from '@/lib/domain/wms/exception-inbox'
import {
  buildMaintenanceRecoveryState,
  claimPostMaintenanceRecheck,
  countMaintenanceRecovery,
  endMaintenanceHold,
  MAINTENANCE_RECOVERY_REFUSALS,
  type MaintenanceHoldIdentity,
  type MaintenanceRecoveryState,
} from '@/lib/domain/system/maintenance-recovery'
import {
  MAINTENANCE_ENABLED_KEY,
  MAINTENANCE_HOLD_KEY,
  WMS_BOOKED_IN_RECHECK_DUE_KEY,
} from '@/lib/maintenance-mode'
import { runPostMaintenanceRecheckForActiveConnector } from '@/lib/domain/wms/post-maintenance-recheck'
import { eligibleCohortDigest, isolatableLinkWhere, loadUnresolvedDriftIncidents, readRawDriftState, unresolvedDriftStateKey } from '@/lib/domain/wms/unresolved-drift'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '@/lib/integration-plugins'
import { withDispatchSweepLockOrSkip } from '@/lib/domain/wms/dispatch-sweep-lock'
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
import { wcFetch } from '@/lib/connectors/woocommerce/api'
import {
  RECOVERABLE_REFUND_PARK_STATUSES,
  buildRefundParkDismissData,
  buildRefundParkReassignData,
  describeRefundParkRecoverability,
  normalizeRefundParkRecoveryAssertion,
  refundParkRecoveryNote,
  refuseDismiss,
  refuseOnLookupFailure,
  refuseReassign,
  type RefundParkRecoveryOutcome,
  type RefundParkRecoveryRefusal,
  type RefundParkRecoveryRefusalCode,
  type RefundParkView,
  type WcOrderRefundEvidence,
} from '@/lib/domain/sales/refund-park-recovery'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { getEnabledWmsConnectorId } from '@/lib/connectors/wms/active-connector'
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

/**
 * How many of a drift cohort's orders the page RENDERS.
 *
 * Only a rendering bound — the digest Isolate is bound to always covers the
 * complete eligible set, and the page states the true count whenever this cap
 * bites, so a truncated list can never be mistaken for the blast radius.
 */
const DRIFT_COHORT_PREVIEW_LIMIT = 200

/**
 * Rolls the isolate transaction back with a message fit to show an operator.
 *
 * Thrown from INSIDE the transaction on purpose: these are the conditions that
 * must undo the quarantine rather than report alongside it, so they cannot be
 * `return`s.
 */
class DriftIsolationAborted extends Error {}

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
  /**
   * o3d-54p: the WooCommerce order this park's IMS order is linked to, or null when it has no link.
   * Shown because a cross-order park is only recognisable by comparing the refund against the order
   * it claims to belong to — and because a park whose order has NO WooCommerce link cannot be
   * dismissed (the dismissal is verified against that order's own refund list), so the control has
   * to be able to say so before it is clicked rather than after.
   */
  wcOrderId: string | null
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

/**
 * o3d-bjc.12: a CONNECTOR-level exception, not an order-level one.
 *
 * The dispatch sweep will not mass-quarantine a cohort it cannot prove is
 * record-local — with no healthy control, "these records are broken" and "this
 * connector is broken" look identical, and guessing takes a tenant out of sync
 * for a fault one fix would clear. It holds the cursor and alerts instead. This
 * row is how that decision reaches a human who CAN tell the difference.
 */
export type UnresolvedDriftRow = {
  connector: string
  /** Binds a click to the cohort the page actually showed (o3d-bjc.12). */
  version: string
  linkCount: number
  touched: number
  consecutivePasses: number
  stableFor: number
  firstSeenAt: string | null
  reason: string | null
  /**
   * The orders Isolate would quarantine, capped for rendering
   * (DRIFT_COHORT_PREVIEW_LIMIT). `eligibleCount` is the true size — when the
   * two differ the page says so, because the action takes ALL of them.
   */
  orders: { linkId: string; orderNumber: string | null; externalOrderNumber: string | null }[]
  /** Digest of the COMPLETE eligible set — what Isolate actually writes (o3d-0gzr). */
  eligibleVersion: string
  eligibleCount: number
}

export type ExceptionInboxSummary = {
  /**
   * o3d-hl8l r5: a held maintenance window, and/or a booked-in re-check that a closed one still
   * owes. Counted in the inbox total because a refusal nobody can see is a silent failure, and
   * these are the only surface a refused warehouse callback has.
   */
  maintenanceRecovery: number
  wmsPushDeadLetters: number
  outboxFailures: number
  deadReceiptEvents: number
  refundSyncParks: number
  stuckDispatches: number
  pennyMismatches: number
  orderReconcileDrift: number
  productStructureConflicts: number
  unresolvedDrift: number
  total: number
}

export type ExceptionInboxData = {
  summary: ExceptionInboxSummary
  maintenanceRecovery: MaintenanceRecoveryState
  wmsPushDeadLetters: WmsPushDeadLetterRow[]
  outboxFailures: OutboxFailureRow[]
  deadReceiptEvents: DeadReceiptEventRow[]
  refundSyncParks: RefundSyncParkRow[]
  stuckDispatches: StuckDispatchRow[]
  pennyMismatches: PennyMismatchRow[]
  orderReconcileDrift: OrderReconcileDriftRow[]
  productStructureConflicts: ProductStructureConflictRow[]
  unresolvedDrift: UnresolvedDriftRow[]
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

/**
 * o3d-hl8l r5: the maintenance-recovery state, read unlocked because this is a render. Both actions
 * re-read every one of these rows `FOR UPDATE` before acting, so a stale page can only ever cause a
 * refusal — never a wrong write.
 */
async function loadMaintenanceRecoveryState(): Promise<MaintenanceRecoveryState> {
  const rows = await db.setting.findMany({
    where: { key: { in: [MAINTENANCE_ENABLED_KEY, MAINTENANCE_HOLD_KEY, WMS_BOOKED_IN_RECHECK_DUE_KEY] } },
    select: { key: true, value: true },
  })
  return buildMaintenanceRecoveryState(new Map(rows.map((row) => [row.key, row.value])))
}

/** True per-source totals — never capped by the display limit (Codex r3/r5). */
async function loadExceptionCounts(): Promise<ExceptionInboxSummary> {
  const [wmsPushDeadLetters, outboxFailures, deadReceipts, deadWebhooks, refundSyncParks, pennyMismatches, stuckDispatches, orderReconcileDrift, productStructureConflicts, driftIncidents] = await Promise.all([
    db.wmsOrderPushLink.count({ where: { state: 'DEAD_LETTER' } }),
    db.integrationOutbox.count({ where: { status: { in: OUTBOX_FAILURE_STATUSES } } }),
    db.wmsInboundReceiptEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.wmsWebhookEvent.count({ where: { processingStatus: DEAD_RECEIPT_EVENT_STATUS } }),
    db.shoppingSyncLog.count({ where: REFUND_PARK_WHERE }),
    db.wmsOrderPushLink.count({ where: { totalMismatchPence: { not: null } } }),
    countStuckDispatches(),
    countOrderReconcileDrift(),
    countProductStructureConflicts(),
    // Only the ACTIVE connector: a disabled one's leftover incident is not
    // blocking anything, and showing it would invite an isolate on stale
    // evidence (o3d-bjc.12).
    getEnabledWmsConnectorId().then((id) => (id ? loadUnresolvedDriftIncidents([id]) : [])),
  ])

  const maintenanceRecovery = countMaintenanceRecovery(await loadMaintenanceRecoveryState())
  const deadReceiptEvents = deadReceipts + deadWebhooks
  return {
    maintenanceRecovery,
    wmsPushDeadLetters,
    outboxFailures,
    deadReceiptEvents,
    refundSyncParks,
    stuckDispatches,
    pennyMismatches,
    orderReconcileDrift,
    productStructureConflicts,
    unresolvedDrift: driftIncidents.length,
    total: maintenanceRecovery + wmsPushDeadLetters + outboxFailures + deadReceiptEvents + refundSyncParks
      + stuckDispatches + pennyMismatches + orderReconcileDrift + productStructureConflicts + driftIncidents.length,
  }
}

export async function getExceptionInboxSummary(): Promise<ExceptionInboxSummary> {
  // Codex P1: failure rows carry order ids, connector errors and refund ids —
  // gate reads on the sync permission (READONLY/SUPPLIER must not see them).
  //
  // The /sync banner loader no longer swallows this into a hidden banner: /sync now requires
  // `sync` at the page boundary, so a role without it never gets here, and a denial that DID
  // reach the page is fatal there rather than being rendered as an unavailable panel.
  await requirePermission('sync')
  return loadExceptionCounts()
}

export async function getExceptionInboxData(): Promise<ExceptionInboxData> {
  await requirePermission('sync')

  const counts = await loadExceptionCounts()
  const [pushLinks, outbox, deadReceiptRows, deadWebhookRows, refundLogs, stuckDispatches, mismatchLinks, orderReconcileDrift, productStructureConflicts, driftIncidents] = await Promise.all([
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
    // Only the ACTIVE connector: a disabled one's leftover incident is not
    // blocking anything, and showing it would invite an isolate on stale
    // evidence (o3d-bjc.12).
    getEnabledWmsConnectorId().then((id) => (id ? loadUnresolvedDriftIncidents([id]) : [])),
  ])

  const refundOrderIds = refundLogs.map((log) => log.entityId).filter((id): id is string => Boolean(id))
  const refundOrders = refundOrderIds.length > 0
    ? await db.salesOrder.findMany({
        where: { id: { in: refundOrderIds } },
        select: { id: true, orderNumber: true },
      })
    : []
  const refundOrderNumberById = new Map(refundOrders.map((order) => [order.id, order.orderNumber]))
  // o3d-54p: which WooCommerce order each parked order is linked to. Read for the whole page in one
  // query rather than per row.
  const refundOrderLinks = refundOrderIds.length > 0
    ? await db.shoppingOrderLink.findMany({
        where: { connector: 'woocommerce', orderId: { in: refundOrderIds } },
        select: { orderId: true, externalOrderId: true },
      })
    : []
  const wcOrderIdByOrderId = new Map(refundOrderLinks.map((link) => [link.orderId, link.externalOrderId]))

  // The cohort's orders, for the operator to review before isolating (o3d-51du).
  // Read through the same eligibility predicate the isolate action writes
  // through, so the list is what WOULD be quarantined rather than what the sweep
  // happened to record on an earlier pass.
  const driftCohortOrders = new Map<string, { linkId: string; orderNumber: string | null; externalOrderNumber: string | null }[]>()
  const driftCohortDigests = new Map<string, string>()
  const driftCohortEligible = new Map<string, number>()
  for (const incident of driftIncidents) {
    // The digest covers the WHOLE eligible set; the rendered list is bounded
    // (o3d-0gzr r3). These are different jobs. Binding must be complete or the
    // action is not bound to what it does; rendering must be bounded or the very
    // failure this page exists to recover from — a connector-wide outage, so
    // potentially every open order — makes the page that recovers it unusable.
    // So: ids for the digest (cheap, unbounded), rows for display (capped, and
    // the page says when it capped).
    const eligibleIds = await db.wmsOrderPushLink.findMany({
      where: isolatableLinkWhere(incident),
      select: { id: true },
      orderBy: { pushedAt: 'asc' },
    })
    driftCohortDigests.set(incident.connector, eligibleCohortDigest(eligibleIds.map((row) => row.id)))
    driftCohortEligible.set(incident.connector, eligibleIds.length)

    const links = await db.wmsOrderPushLink.findMany({
      where: { id: { in: eligibleIds.slice(0, DRIFT_COHORT_PREVIEW_LIMIT).map((row) => row.id) } },
      select: { id: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
      orderBy: { pushedAt: 'asc' },
    })
    driftCohortOrders.set(
      incident.connector,
      links.map((link) => ({
        linkId: link.id,
        orderNumber: link.order.orderNumber,
        externalOrderNumber: link.externalOrderNumber,
      })),
    )
  }

  const data: Omit<ExceptionInboxData, 'summary' | 'maintenanceRecovery'> = {
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
      wcOrderId: log.entityId ? wcOrderIdByOrderId.get(log.entityId) ?? null : null,
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
    unresolvedDrift: driftIncidents.map((incident) => ({
      connector: incident.connector,
      version: incident.version,
      linkCount: incident.linkCount,
      touched: incident.touched,
      consecutivePasses: incident.consecutivePasses,
      stableFor: incident.stableFor,
      firstSeenAt: incident.firstSeenAt,
      reason: incident.reason,
      // WHICH orders (o3d-51du). The digest guarantees the operator acts on the
      // same set the page showed them — which is worth nothing if the page
      // showed only a count. Isolate is a bulk quarantine; the orders it will
      // take have to be on screen before it is clicked.
      orders: driftCohortOrders.get(incident.connector) ?? [],
      // What Isolate is bound to. `version` still guards the stored incident;
      // this guards the actual write set.
      eligibleVersion: driftCohortDigests.get(incident.connector) ?? eligibleCohortDigest([]),
      eligibleCount: driftCohortEligible.get(incident.connector) ?? 0,
    })),
  }

  return {
    ...data,
    maintenanceRecovery: await loadMaintenanceRecoveryState(),
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

    const refundSweep = await syncRefundsForOrder(Number(orderLink.externalOrderId))

    const refundLanded = row.externalId
      ? await db.salesOrderRefund.findFirst({
          where: { externalRefundId: Number(row.externalId), orderId: row.entityId },
          select: { id: true },
        })
      : null

    // o3d-ecbj r5: "the refund did not land" is a statement about the STORE'S list, and a list read
    // only in part cannot make it. If the walk was short, the refund may simply be on a page nobody
    // read — so say the store could not be read completely rather than reporting a not-applied
    // outcome the operator would read as WooCommerce's answer. The park stays PENDING and visible,
    // so the retry button is still the whole recovery.
    if (!refundLanded && !refundSweep.complete) {
      return {
        success: false,
        error: `WooCommerce's refund list for that order could not be read in full (${refundSweep.error ?? 'unknown error'}), `
          + 'so this refund cannot be confirmed missing. The park is still open — retry it once the store responds.',
      }
    }

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
 * o3d-54p — OPERATOR RECOVERY for a STALE CROSS-ORDER refund park.
 *
 * WHY RETRY IS NOT ENOUGH, AND WHY THIS IS A SEPARATE ACTION.
 *
 * retryRefundSyncPark re-fetches the refunds of THE PARK'S OWN RECORDED ORDER. For a park sitting on
 * the wrong order that fetch cannot contain the refund, so the retry can never resolve it — and it
 * deliberately refuses to resolve the park with a refund belonging to another order. Meanwhile
 * createSalesOrderRefund and syncWcRefund both fail CLOSED on the foreign park (o3d-ee9/o3d-7yf), so
 * the TRUE owner's refund, credit note and restock are blocked; the park is retention-exempt; and
 * both orders are undeletable. Nothing an operator could do changed any of it.
 *
 * WHAT THIS ASSERTS, AND WHAT VERIFIES IT. WooCommerce is the authority on which order a refund
 * belongs to, so this action does not take the operator's word for the ownership fact — it takes
 * their word for WHICH ORDER TO ASK ABOUT, asks WooCommerce FRESH, and refuses when the answer
 * contradicts them. The decision (move it, or write it off) stays theirs and is recorded with their
 * name on it; the ownership is evidence, not an assertion. The decision vocabulary — every refusal
 * and every patch — lives in lib/domain/sales/refund-park-recovery.ts as pure functions.
 *
 * THE AUDIT. logActivity is best-effort (it swallows its own errors), which is why the recovery note
 * is written onto the PARK ROW ITSELF in the same transaction as the status change: the fact that a
 * human recovered this park, and what WooCommerce said when they did, survives a logging failure.
 * o3d-batch-settle adds logActivityInTransaction for exactly this problem; when that lands, this
 * activity write should move inside the transaction rather than being duplicated here.
 */
export type RecoverRefundSyncParkInput = { observedOrderId: string } & (
  | { outcome: 'REASSIGN'; wcOrderId: number }
  | { outcome: 'DISMISS'; reason?: string }
)

export type RecoverRefundSyncParkResult =
  | { success: true; outcome: RefundParkRecoveryOutcome; targetOrderId: string | null }
  | { success: false; error: string; code: RefundParkRecoveryRefusalCode }
  | FreshAuthFailureResult

/**
 * WooCommerce's default page size for /orders/{id}/refunds is 10, and syncRefundsForOrder never asks
 * for more. Reading only the first page here would be far worse than a missing sync: a refund on
 * page 2 would look ABSENT, and "absent from this order" is precisely what authorises a dismissal.
 * So this pages exhaustively, and refuses rather than guessing when an order carries more refunds
 * than the cap.
 */
const WC_REFUND_PAGE_SIZE = 100
const WC_REFUND_MAX_PAGES = 10

async function readWcOrderRefundIds(
  wcOrderId: number,
): Promise<{ evidence: WcOrderRefundEvidence } | { error: string }> {
  const ids: number[] = []
  let page = 1
  let totalPages = 1
  do {
    const { data, totalPages: reported, error } = await wcFetch(
      `/orders/${wcOrderId}/refunds`,
      { per_page: String(WC_REFUND_PAGE_SIZE), page: String(page) },
    )
    if (error) return { error }
    if (!Array.isArray(data)) return { error: 'WooCommerce returned an unexpected response for this order\'s refunds.' }
    for (const entry of data) {
      const candidate = (entry as { id?: unknown }).id
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) ids.push(candidate)
    }
    totalPages = Math.max(1, reported || 1)
    if (totalPages > WC_REFUND_MAX_PAGES) {
      return {
        error: `that order reports ${totalPages} pages of refunds, more than this check will read`,
      }
    }
    page += 1
  } while (page <= totalPages)
  return { evidence: { wcOrderId, refundIds: ids, fetchedAt: new Date() } }
}

export async function recoverRefundSyncPark(
  id: string,
  input: RecoverRefundSyncParkInput,
): Promise<RecoverRefundSyncParkResult> {
  try {
    // Same guard as retryRefundSyncPark: `sync` is not held by READONLY or SUPPLIER, and a recovery
    // that moves a refund between orders is at least as ledger-affecting as a retry, so it takes the
    // FRESH variant too. A 'use server' export is a public HTTP endpoint; this is the only thing
    // between an authenticated session and a write that reassigns refund evidence.
    const session = await requireFreshPermission('sync')

    const assertion = normalizeRefundParkRecoveryAssertion(input)
    if (!assertion) {
      return {
        success: false,
        code: 'unrecognised_outcome',
        error: 'That recovery was not supplied correctly, so nothing was changed. Reload the exception '
          + 'inbox and recover from what it shows.',
      }
    }
    if (typeof input.observedOrderId !== 'string' || !input.observedOrderId) {
      return {
        success: false,
        code: 'unrecognised_outcome',
        error: 'The order this recovery was made about was not supplied, so nothing was changed. Reload '
          + 'the exception inbox and recover from what it shows.',
      }
    }

    const row = await db.shoppingSyncLog.findFirst({
      where: { id, ...REFUND_PARK_WHERE },
      select: { id: true, status: true, entityId: true, externalId: true },
    })
    const recoverability = describeRefundParkRecoverability(row ?? { status: 'SYNCED', entityId: null, externalId: null })
    if (!row || !recoverability.recoverable) {
      return {
        success: false,
        code: 'park_not_actionable',
        error: row
          ? recoverability.notRecoverableReason ?? 'This park cannot be recovered.'
          : 'That refund park no longer exists or is already resolved, so nothing was changed. Reload the '
            + 'exception inbox.',
      }
    }
    // Non-null by describeRefundParkRecoverability, which refuses a park with no order or no refund id.
    const parkedOrderId = row.entityId as string
    const externalRefundId = Number(row.externalId)
    if (!Number.isSafeInteger(externalRefundId) || externalRefundId <= 0) {
      return {
        success: false,
        code: 'park_not_actionable',
        error: `This park records "${row.externalId}" as its WooCommerce refund id, which is not a refund `
          + 'id WooCommerce can be asked about. Nothing was changed.',
      }
    }
    // The fence's first half, checked before WooCommerce is troubled: the operator judged a park
    // sitting on a particular order, and a park that has since moved is a different question.
    if (parkedOrderId !== input.observedOrderId) {
      return {
        success: false,
        code: 'park_moved',
        error: 'This park is no longer on the order it was shown against, so the recovery you asked for '
          + 'was not made. Reload the exception inbox and look again.',
      }
    }

    const park: RefundParkView = { id: row.id, status: row.status, entityId: parkedOrderId, externalId: row.externalId as string }

    // The refund as IMS currently records it, wherever it landed. Read again INSIDE the transaction
    // under the per-refund lock — this copy only lets a refusal be reported before WooCommerce is
    // asked and before any lock is taken.
    const landedBefore = await db.salesOrderRefund.findFirst({
      where: { externalRefundId },
      select: { orderId: true },
    })

    let refusal: RefundParkRecoveryRefusal | null = null
    let evidence: WcOrderRefundEvidence
    let targetOrderId: string | null = null

    if (assertion.outcome === 'REASSIGN') {
      const lookup = await readWcOrderRefundIds(assertion.wcOrderId)
      if ('error' in lookup) {
        const refused = refuseOnLookupFailure(assertion.wcOrderId, lookup.error)
        return { success: false, error: refused.message, code: refused.code }
      }
      evidence = lookup.evidence
      const targetLink = await db.shoppingOrderLink.findFirst({
        where: { connector: 'woocommerce', externalOrderId: String(assertion.wcOrderId) },
        select: { orderId: true },
      })
      targetOrderId = targetLink?.orderId ?? null
      refusal = refuseReassign({
        park,
        externalRefundId,
        targetEvidence: evidence,
        targetOrderId,
        landedOnOrderId: landedBefore?.orderId ?? null,
      })
    } else {
      const parkedLink = await db.shoppingOrderLink.findFirst({
        where: { orderId: parkedOrderId, connector: 'woocommerce' },
        select: { externalOrderId: true },
      })
      const parkedWcOrderId = parkedLink ? Number(parkedLink.externalOrderId) : NaN
      let parkedEvidence: WcOrderRefundEvidence | null = null
      if (parkedLink && Number.isSafeInteger(parkedWcOrderId) && parkedWcOrderId > 0) {
        const lookup = await readWcOrderRefundIds(parkedWcOrderId)
        if ('error' in lookup) {
          const refused = refuseOnLookupFailure(parkedWcOrderId, lookup.error)
          return { success: false, error: refused.message, code: refused.code }
        }
        parkedEvidence = lookup.evidence
      }
      refusal = refuseDismiss({
        park,
        externalRefundId,
        parkedEvidence,
        landedOnOrderId: landedBefore?.orderId ?? null,
      })
      // refuseDismiss returns parked_order_not_linked when there is no evidence, so past it the
      // evidence is present.
      evidence = parkedEvidence as WcOrderRefundEvidence
    }
    if (refusal) return { success: false, error: refusal.message, code: refusal.code }

    const now = new Date()
    const note = refundParkRecoveryNote(assertion, evidence, externalRefundId)

    const applied = await db.$transaction(async (tx) => {
      // o3d-ee9's key, and its ordering: the per-refund advisory lock FIRST, then any order row lock,
      // matching createSalesOrderRefund and upsertRefundPark so none of the three can deadlock. Held
      // to commit, so a refund create for this id either happens entirely before this recovery (and
      // is seen by the re-read below) or entirely after it (and sees the recovered park).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${externalRefundId}`}))`

      // Re-read under the lock. Between the WooCommerce fetch above and this transaction the refund
      // may have landed — on this park's order (the park is then a leftover, not a foreign one) or on
      // another. Both are refusals with their own remedy, not something to write through.
      const landed = await tx.salesOrderRefund.findFirst({ where: { externalRefundId }, select: { orderId: true } })
      const lateRefusal = assertion.outcome === 'REASSIGN'
        ? refuseReassign({ park, externalRefundId, targetEvidence: evidence, targetOrderId, landedOnOrderId: landed?.orderId ?? null })
        : refuseDismiss({ park, externalRefundId, parkedEvidence: evidence, landedOnOrderId: landed?.orderId ?? null })
      if (lateRefusal) return { ok: false as const, refusal: lateRefusal }

      if (assertion.outcome === 'REASSIGN') {
        // The same FOR UPDATE re-verify upsertRefundPark does before writing a park, and for the same
        // reason: deleteSalesOrder takes this lock, so without it the target order could be deleted
        // between the link lookup and this write, leaving an orphaned park on a gone order that
        // retryRefundSyncPark could never resolve.
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "sales_orders" WHERE id = ${targetOrderId as string} FOR UPDATE`
        if (rows.length === 0) {
          return {
            ok: false as const,
            refusal: {
              code: 'target_order_missing' as const,
              message: 'The order you named was deleted while this recovery was being made, so nothing was '
                + 'changed — a park must never be written onto an order that no longer exists.',
            },
          }
        }
      }

      // The fence's second half, and the only write. Conditioned on the park still being on the order
      // the operator judged AND still actionable, so a concurrent resolve, retry or re-park is not
      // overwritten by a conclusion formed about the row as it was.
      const updated = await tx.shoppingSyncLog.updateMany({
        where: {
          id: park.id,
          connector: 'woocommerce',
          direction: 'FROM_CONNECTOR',
          entityType: 'SalesOrder',
          externalId: park.externalId,
          entityId: park.entityId,
          status: { in: [...RECOVERABLE_REFUND_PARK_STATUSES] },
        },
        data: assertion.outcome === 'REASSIGN'
          ? buildRefundParkReassignData(targetOrderId as string, note, now)
          : buildRefundParkDismissData(note, now),
      })
      if (updated.count !== 1) {
        return {
          ok: false as const,
          refusal: {
            code: 'park_moved' as const,
            message: 'This park changed while the recovery was being made — it was resolved, retried or '
              + 'moved by something else — so nothing was changed. Reload the exception inbox and look again.',
          },
        }
      }
      return { ok: true as const }
    })

    if (!applied.ok) return { success: false, error: applied.refusal.message, code: applied.refusal.code }

    await logActivity({
      entityType: 'SYNC',
      entityId: parkedOrderId,
      tag: 'sync',
      action: 'wc_refund_park_recovered',
      // WARNING, not INFO: a human correcting an order association on a refund whose money has
      // already left the business, on evidence the system could not act on by itself.
      level: 'WARNING',
      description: assertion.outcome === 'REASSIGN'
        ? `Reassigned parked WooCommerce refund ${externalRefundId} from order ${parkedOrderId} to order `
          + `${targetOrderId} after WooCommerce confirmed it on WC order ${evidence.wcOrderId}`
        : `Dismissed the parked WooCommerce refund ${externalRefundId} on order ${parkedOrderId} after `
          + `WooCommerce order ${evidence.wcOrderId} did not list it`,
      metadata: {
        shoppingSyncLogId: park.id,
        externalRefundId,
        outcome: assertion.outcome,
        parkedOrderId,
        targetOrderId,
        // What was asked, and what came back — so the recovery can be re-judged later against the
        // evidence it was actually made on rather than against WooCommerce as it is by then.
        wcOrderId: evidence.wcOrderId,
        wcRefundIds: [...evidence.refundIds],
        wcFetchedAt: evidence.fetchedAt.toISOString(),
        priorStatus: park.status,
        userId: session.user.id,
      },
    })
    revalidatePath('/sync/exceptions')
    return { success: true, outcome: assertion.outcome, targetOrderId }
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

/**
 * o3d-bjc.12: isolate the orders in an indeterminate drift cohort.
 *
 * THE OPERATOR'S CALL, deliberately. The sweep refuses to take it: with no
 * healthy control to compare against, "these records are broken" and "this
 * connector is broken" are indistinguishable, and guessing wrong quarantines a
 * whole tenant for a fault one fix would have cleared. A human who has looked at
 * the WMS can tell, and this is how they say so.
 *
 * It applies the SAME quarantine the sweep would have: the links leave the
 * candidate set (so the delta watermark is released for everyone else) and each
 * one appears in this inbox as an ordinary replayable row.
 */
export async function isolateUnresolvedDriftCohort(connector: string, version: string, eligibleVersion: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    // The ACTIVE connector, not merely a registered one (o3d-bjc.12). A
    // connector that has since been switched off leaves its last incident
    // behind; acting on that would quarantine dormant links on evidence nothing
    // is refreshing.
    const enabledConnector = await getEnabledWmsConnectorId()
    if (!enabledConnector || connector !== enabledConnector) {
      return { success: false, error: 'That WMS connector is not enabled — its incident is no longer being updated by any sweep.' }
    }
    // The SAME lock the sweep takes (o3d-bjc.12). Without it this reads cohort A
    // while a sweep commits cohort B, then deletes B's incident — isolating one
    // set of orders and silently retracting the offer for another.
    const outcome = await withDispatchSweepLockOrSkip(connector, async (): Promise<MutationResult> => {
      // Re-read UNDER the lock (o3d-0gzr). The check above happened before we
      // held anything, and connector enablement is not serialized by this lock,
      // so it can flip in between. Reading it again here shrinks the window to
      // the transaction, and the transaction closes the rest.
      const stillEnabled = await getEnabledWmsConnectorId()
      if (stillEnabled !== connector) {
        return { success: false, error: 'That WMS connector was switched off while this page was open — nothing was isolated.' }
      }
      const raw = await readRawDriftState(connector)
      const [incident] = await loadUnresolvedDriftIncidents([connector])
      if (!incident || !raw) {
        return { success: false, error: 'That connector is no longer reporting an unresolved cohort — nothing to isolate.' }
      }
      // The decision was taken against what the PAGE showed. A sweep can replace
      // the cohort between render and click, and isolating whatever happens to
      // be current would quarantine orders nobody reviewed.
      if (incident.version !== version) {
        return { success: false, error: 'These orders changed since the page loaded — reload and review the current set before isolating.' }
      }
      const isolatedAt = new Date()
      const reason = `Isolated by an operator: ${incident.linkCount} order(s) unreadable on ${connector} since `
        + `${incident.firstSeenAt ?? 'an earlier pass'}${incident.reason ? ` — ${incident.reason}` : ''}`

      // ONE transaction: quarantining the links and retracting the incident are
      // the same decision. Split across two commits, a failure between them
      // leaves orders quarantined while the action reports failure and the
      // stale offer stays on screen.
      let isolated: number
      try {
        isolated = await db.$transaction(async (tx) => {
          // Enablement is part of the WRITE (o3d-0gzr), and reading it is not
          // enough (r2): under READ COMMITTED a plain SELECT takes no lock, so a
          // disable can commit between this read and our own commit and nothing
          // ever conflicts. Lock the row FOR UPDATE — a concurrent disable then
          // blocks until this transaction ends, and sees the quarantine.
          const pluginKey = INTEGRATION_PLUGIN_SETTING_KEYS[connector as keyof typeof INTEGRATION_PLUGIN_SETTING_KEYS]
          const pluginRows = await tx.$queryRaw<{ value: string }[]>`
            SELECT value FROM settings WHERE key = ${pluginKey} FOR UPDATE
          `
          if (pluginRows[0]?.value !== 'true') {
            throw new DriftIsolationAborted('That WMS connector was switched off while this page was open — nothing was isolated.')
          }
          // The set the operator reviewed must still be the set we are about to
          // write (o3d-0gzr r2). `version` guards the STORED cohort; eligibility
          // is re-evaluated here and can have moved without the store changing,
          // which would quarantine an order nobody saw.
          const eligibleNow = await tx.wmsOrderPushLink.findMany({
            where: isolatableLinkWhere(incident),
            select: { id: true },
          })
          if (eligibleCohortDigest(eligibleNow.map((row) => row.id)) !== eligibleVersion) {
            throw new DriftIsolationAborted('These orders changed since the page loaded — reload and review the current set before isolating.')
          }
          // An empty eligible set is not "isolate nothing", it is "isolate
          // whatever the predicate matches by the time the write runs"
          // (o3d-0gzr r3). The action is directly invocable, so refuse it here
          // rather than relying on the UI not to offer it.
          if (eligibleNow.length === 0) {
            throw new DriftIsolationAborted('Those orders have already resolved, shipped or been isolated — nothing left to do.')
          }
          const reviewedIds = eligibleNow.map((row) => row.id)
          // Write the ids we MATERIALISED, not the predicate again (o3d-0gzr r3).
          // Re-running the predicate looks equivalent and is not: these are two
          // statements in a READ COMMITTED transaction, so they see different
          // snapshots, and a link that becomes eligible in between would be
          // quarantined without ever appearing in the digest or on the page.
          // Naming the ids removes the second evaluation entirely.
          const updated = await tx.wmsOrderPushLink.updateMany({
            where: { ...isolatableLinkWhere(incident), id: { in: reviewedIds } },
            data: { dispatchUnresolvedAt: isolatedAt, dispatchUnresolvedError: reason },
          })
          // ...and the set must not have SHRUNK under us either: fewer rows than
          // reviewed means something changed mid-write, which is a re-review,
          // not a partial success.
          if (updated.count !== reviewedIds.length) {
            throw new DriftIsolationAborted('These orders changed while the isolation was being applied — reload and review the current set.')
          }
          {
            // Compare-and-set: only retract the incident we actually acted on. A
            // sweep that wrote a NEWER one while we worked keeps its offer.
            const retracted = await tx.setting.deleteMany({ where: { key: unresolvedDriftStateKey(connector), value: raw } })
            // ...and the CAS has to be able to FAIL the whole thing (o3d-0gzr).
            // Ignoring this count is what made "one transaction" only half true:
            // a sweep that replaced the state between our read and this delete
            // matches zero rows, and the quarantine would still commit — orders
            // isolated against an offer that no longer existed, reported as
            // success, with the newer incident still on screen. Rolling back is
            // the only outcome consistent with the claim.
            if (retracted.count !== 1) {
              throw new DriftIsolationAborted('That incident was replaced while you were deciding — reload and review the current set.')
            }
          }
          return updated.count
        })
      } catch (error) {
        // A rolled-back isolation is a normal outcome here, not a crash: the
        // operator's offer went stale mid-write. Nothing was quarantined.
        if (error instanceof DriftIsolationAborted) return { success: false, error: error.message }
        throw error
      }

      if (isolated === 0) {
        return { success: false, error: 'Those orders have already resolved, shipped or been isolated — nothing left to do.' }
      }
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_dispatch_drift_isolated',
        description: `Operator isolated ${isolated} unreadable ${connector} order(s) from the dispatch sweep`,
        metadata: { connector, requested: incident.linkCount, isolated, userId: session.user.id, reason },
        level: 'WARNING',
        resolveUser: false,
      })
      revalidatePath('/sync/exceptions')
      return { success: true }
    })
    if ('lockSkipped' in outcome) {
      return { success: false, error: 'A dispatch sweep is running right now — try again in a moment.' }
    }
    return outcome
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * o3d-bjc.12: drop the drift state so the next sweep re-evaluates from scratch.
 *
 * For the other half of the decision — "I fixed the connector". It clears the
 * incident and the escalation counter WITHOUT touching any link, so nothing is
 * isolated and the next pass either finds everything readable (and the cursor
 * moves) or raises the incident again with a fresh first-seen.
 */
export async function retryUnresolvedDriftCohort(connector: string, version: string): Promise<MutationResult> {
  try {
    const session = await requireFreshPermission('sync')
    // The ACTIVE connector, not merely a registered one (o3d-bjc.12). A
    // connector that has since been switched off leaves its last incident
    // behind; acting on that would quarantine dormant links on evidence nothing
    // is refreshing.
    const enabledConnector = await getEnabledWmsConnectorId()
    if (!enabledConnector || connector !== enabledConnector) {
      return { success: false, error: 'That WMS connector is not enabled — its incident is no longer being updated by any sweep.' }
    }
    const outcome = await withDispatchSweepLockOrSkip(connector, async (): Promise<MutationResult> => {
      const raw = await readRawDriftState(connector)
      if (!raw) {
        return { success: false, error: 'That connector is no longer reporting an unresolved cohort.' }
      }
      const [current] = await loadUnresolvedDriftIncidents([connector])
      if (!current || current.version !== version) {
        return { success: false, error: 'The incident changed since the page loaded — reload and check the new one.' }
      }
      // Compare-and-set for the same reason as isolate: a sweep that raised a
      // NEWER incident while we worked must keep it, or the operator would be
      // told "cleared" about evidence they never saw.
      const deleted = await db.setting.deleteMany({
        where: { key: unresolvedDriftStateKey(connector), value: raw },
      })
      if (deleted.count === 0) {
        return { success: false, error: 'The incident changed while you were looking at it — reload and check the new one.' }
      }
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_dispatch_drift_retry',
        description: `Operator cleared the ${connector} unresolved-drift incident for re-evaluation`,
        metadata: { connector, userId: session.user.id },
        level: 'INFO',
        resolveUser: false,
      })
      revalidatePath('/sync/exceptions')
      return { success: true }
    })
    if ('lockSkipped' in outcome) {
      return { success: false, error: 'A dispatch sweep is running right now — try again in a moment.' }
    }
    return outcome
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

// -------------------------------------------------------------------------------------------------
// o3d-hl8l r5 (Codex r4 finding 1) — WHAT AN OPERATOR CAN DO ABOUT A REFUSED CALLBACK.
//
// The maintenance fence refuses inbound booked-in callbacks with a 503 and writes no row, which is
// deliberate and unavoidable: it runs before signature verification, and rows written into the
// window are being replayed over. Round 4 made the ordinary window recover itself — the close is
// stamped and a five-minute cron drains the stamp by re-checking every open ASN. But the branch the
// fence exists FOR, a restore whose backend could not be confirmed gone, never closes that way: it
// holds the flag, never calls `disableMaintenanceMode`, and so never stamps anything. The remedy was
// an UPDATE typed at a database prompt by hand, which ends the window and schedules nothing.
// (Deliberately not naming the client binary: tests/accounting/plugin-selection-lock.test.ts scans
// for that name to find files that SHELL OUT to it, and this file does not — every statement here
// runs inside an app transaction. Classifying it there would assert a database-execution path that
// does not exist.)
//
// These two actions are that branch's remedy, and neither trusts the button that invoked it: each
// re-reads the settings rows `FOR UPDATE` and refuses, by name, when the precondition it depends on
// does not hold at the moment of the click.
// -------------------------------------------------------------------------------------------------

/** Human wording for each refusal, so the operator is told what to do rather than what failed. */
const MAINTENANCE_REFUSAL_MESSAGES: Record<string, string> = {
  [MAINTENANCE_RECOVERY_REFUSALS.notInMaintenance]:
    'Maintenance mode is already off — the window has been ended already (possibly by someone else). Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.noHoldRecorded]:
    'Maintenance mode is on but no held restore was recorded, which is what a restore that is still RUNNING looks like. '
    + 'Ending it now would let scheduled jobs and webhooks write into a live restore. Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.holdUnreadable]:
    'The recorded hold does not name a database backend, so there is nothing to verify before clearing the flag. '
    + 'Confirm by hand that the restore backend is gone, then clear `system_maintenance_mode` in `settings`.',
  [MAINTENANCE_RECOVERY_REFUSALS.backendStillRunning]:
    'The restore’s database backend is STILL ATTACHED — it may still be writing. Terminate it and try again. Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.backendIndeterminate]:
    'Could not determine whether the restore’s database backend is still attached, so the hold was left in place. Nothing was changed.',
  [MAINTENANCE_RECOVERY_REFUSALS.maintenanceModeOn]:
    'Maintenance mode is still on. A re-check run now is fenced at the same gate the callbacks were, so it would do nothing. '
    + 'End the maintenance window first.',
  [MAINTENANCE_RECOVERY_REFUSALS.noRecheckDue]:
    'No maintenance window is waiting to be re-checked — either none has closed since the last run, or the re-check has already drained.',
  [MAINTENANCE_RECOVERY_REFUSALS.holdSuperseded]:
    'The held restore recorded now is NOT the one this page showed you — another restore has been recorded since. '
    + 'Nothing was changed. Reload the exception inbox and read the new hold before ending it.',
  [MAINTENANCE_RECOVERY_REFUSALS.recheckMarkerMoved]:
    'The re-check ran, but the window it was recorded against changed while it was running, so the marker was left in '
    + 'place for the newer window. Nothing was lost — the next run re-checks it.',
}

/**
 * END A HELD MAINTENANCE WINDOW.
 *
 * Refuses unless, re-read under the lock: the flag is on, a hold really was recorded, the record
 * names a backend, and that backend is GONE from `pg_stat_activity` by `(pid, backend_start)` — the
 * same pair the restore endpoint identified it by, because a pid alone is reused and
 * `application_name` is a GUC the replayed SQL can change.
 *
 * When it does clear the flag it stamps `wms_booked_in_recheck_due_since` in the SAME transaction,
 * so this window finally gets the automatic re-check every normally-closed one has had since round
 * 4. That is the half a hand-written UPDATE always missed, and it is why this action exists at all
 * rather than a line of documentation telling someone which row to edit.
 */
export async function endHeldMaintenanceWindow(
  /**
   * o3d-hl8l r6: WHICH hold the operator was looking at. Not a convenience — without it the action
   * ends whatever hold happens to be recorded at the moment of the click, which after a second
   * restore is a different window with a different backend and a different reason.
   */
  shown: MaintenanceHoldIdentity,
): Promise<MutationResult & { recheckDueSince?: string }> {
  try {
    const session = await requireFreshPermission('sync')

    // Server actions take their arguments over the wire, so the shape is checked here rather than
    // assumed from the component that renders the button.
    const expected: MaintenanceHoldIdentity | null =
      shown
        && typeof shown.backendPid === 'number'
        && Number.isInteger(shown.backendPid)
        && shown.backendPid > 0
        && typeof shown.backendStart === 'string'
        && shown.backendStart.trim() !== ''
        && typeof shown.heldAt === 'string'
        ? { backendPid: shown.backendPid, backendStart: shown.backendStart, heldAt: shown.heldAt }
        : null
    if (!expected) {
      return {
        success: false,
        error: 'The hold this page was showing could not be identified, so nothing was changed. Reload the exception inbox and try again.',
      }
    }

    const result = await db.$transaction(async (tx) => endMaintenanceHold(tx, {
      isRestoreBackendAttached: async ({ pid, backendStart }) => {
        try {
          // Matched on the pair, and on `backend_start` as TEXT: the restore endpoint captured the
          // server's own rendering of it and never parsed it into a Date, precisely so this
          // comparison cannot be lost to a timezone or a rounded microsecond.
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity WHERE pid = ${pid} AND backend_start::text = ${backendStart}`
          return rows.length > 0
        } catch (error) {
          console.error('[maintenance-recovery] could not read pg_stat_activity:', error)
          return null
        }
      },
    }, expected))

    if (!result.ended) {
      return {
        success: false,
        error: MAINTENANCE_REFUSAL_MESSAGES[result.reason]
          ?? `The maintenance hold was not ended (${result.reason}). Nothing was changed.`,
      }
    }

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'maintenance_hold_ended',
      level: 'WARNING',
      description:
        `Ended the held maintenance window from the exception inbox — restore backend pid ${result.hold.backendPid} `
        + `(started ${result.hold.backendStart}) confirmed gone; a warehouse booked-in re-check is now due`,
      metadata: {
        userId: session.user.id,
        backendPid: result.hold.backendPid,
        backendStart: result.hold.backendStart,
        applicationName: result.hold.applicationName,
        heldAt: result.hold.heldAt,
        recheckDueSince: result.recheckDueSince,
      },
      resolveUser: false,
    })
    revalidatePath('/sync/exceptions')
    return { success: true, recheckDueSince: result.recheckDueSince }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

/**
 * RUN THE POST-MAINTENANCE BOOKED-IN RE-CHECK NOW.
 *
 * The automatic drain lives on the warehouse webhook sweeper's five-minute cron. That cron is
 * `defaultEnabled: true`, but an installation that has disabled it — or whose scheduler is down,
 * which is not a rare state on the day a restore was needed — has no other way to run it, and "wait
 * five minutes and see" is not something an operator can verify.
 *
 * Refuses while maintenance mode is on (a re-check issued into the window is stopped at the same
 * gate the callbacks were) and when no window is actually pending. The marker is NOT cleared by the
 * claim: `runPostMaintenanceBookedInRecheck` clears it only once every open ASN has been attempted,
 * so claiming it here would drop the retry a truncated page depends on.
 */
export async function runPostMaintenanceRecheckNow(): Promise<MutationResult & {
  attempted?: number
  failed?: number
  drained?: boolean
}> {
  try {
    const session = await requireFreshPermission('sync')

    const claim = await db.$transaction((tx) => claimPostMaintenanceRecheck(tx))
    if (!claim.due) {
      return {
        success: false,
        error: MAINTENANCE_REFUSAL_MESSAGES[claim.reason] ?? `The re-check did not run (${claim.reason}).`,
      }
    }

    // Resolved behind the WMS boundary: null means no enabled connector performs a booked-in
    // re-check, in which case the marker is left alone because it is still owed.
    const result = await runPostMaintenanceRecheckForActiveConnector()
    if (!result) {
      return {
        success: false,
        error: 'No enabled warehouse connector performs a booked-in re-check, so nothing was run. '
          + 'The re-check is still recorded as due.',
      }
    }

    // o3d-hl8l r6: the claim above proved a re-check was owed at the instant of the click and
    // nothing about the minutes the pass takes. The pass re-reads the gate as it goes and names why
    // it stopped; reporting "done" over that would tell an operator the window was recovered when a
    // restore had just fenced it.
    if (result.refusal === 'maintenance_mode_on' || result.refusal === 'window_reopened') {
      return {
        success: false,
        error: `A maintenance window is in force, so the re-check ${result.attempted > 0 ? `stopped after ${result.attempted} ASN(s)` : 'did not start'}. `
          + 'It is still recorded as due and will run once the window ends. Nothing was lost.',
      }
    }

    await logActivity({
      entityType: 'SYNC',
      tag: 'sync',
      action: 'wms_post_maintenance_recheck_manual',
      level: result.failed > 0 ? 'WARNING' : 'INFO',
      description:
        `Ran the post-maintenance warehouse re-check by hand for the window that ended ${claim.windowEndedAt} — `
        + `${result.attempted} open ASN(s) attempted`
        + (result.failed > 0 ? `, ${result.failed} failed and will be retried` : '')
        + (result.drained ? '' : ' — more remain and the marker was kept'),
      metadata: {
        userId: session.user.id,
        connector: result.connector,
        windowEndedAt: claim.windowEndedAt,
        attempted: result.attempted,
        failed: result.failed,
        drained: result.drained,
      },
      resolveUser: false,
    })
    revalidatePath('/sync/exceptions')
    return { success: true, attempted: result.attempted, failed: result.failed, drained: result.drained }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
