import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { applyExternalFulfillmentUpdate } from '@/lib/fulfillment/external-fulfillment'

/**
 * Phase 8 — Mintsoft dispatch ingestion (q66in.1.1).
 *
 * Polls already-pushed Mintsoft orders (WmsOrderPushLink.state = SYNCED) for a
 * dispatched status and feeds the dispatch into the storefront fulfilment loop
 * via applyExternalFulfillmentUpdate, which progresses the IMS shipment to
 * SHIPPED and carries the Mintsoft tracking number/courier through to the
 * shipment + customer-notification paths. Without this, fetchMintsoftOrderStatus
 * only surfaces dispatch on-demand for the SO chip and the event stays trapped
 * in the connector.
 *
 * Idempotent without extra bookkeeping: a successful apply reconciles the order
 * to SHIPPED, which drops it from the candidate set (POST_DISPATCH_STATUSES);
 * applyExternalFulfillmentUpdate is itself a no-op once shipments are at target.
 *
 * Connector-agnostic except for isMintsoftDispatched (the Mintsoft status names);
 * q66in.1.3 hoists the loop behind the generic WMS contract for ShipHero parity.
 */

const DISPATCH_SYNC_DEFAULT_BATCH_SIZE = 50

/** Lifecycle statuses where the IMS order has already left the dispatch-poll set. */
const POST_DISPATCH_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] as const

/**
 * Raw Mintsoft order statuses that mean the goods have left the warehouse.
 * Mintsoft invoices an order only after it despatches, so INVOICED is strictly
 * post-despatch (the SO status chip likewise treats it as a terminal/green
 * state); the despatchedAt fallback below covers feeds where the status row
 * lags. If a proforma-style pre-despatch INVOICED ever appears, tighten this to
 * DESPATCHED-only and lean on despatchedAt.
 */
export const MINTSOFT_DISPATCHED_STATUSES = new Set(['DESPATCHED', 'INVOICED'])

/**
 * A Mintsoft order counts as dispatched when its status is a known dispatched
 * label, or when any tracking entry carries a despatch timestamp (covers feeds
 * that populate tracking before the status row catches up).
 */
export function isMintsoftDispatched(status: Pick<WmsOrderStatus, 'status' | 'tracking'>): boolean {
  if (MINTSOFT_DISPATCHED_STATUSES.has(status.status.trim().toUpperCase())) return true
  return status.tracking.some((entry) => Boolean(entry.despatchedAt))
}

/** Map WMS tracking entries to the shape applyExternalFulfillmentUpdate expects. */
export function toFulfillmentTracking(
  tracking: WmsOrderTracking[],
): Array<{ trackingNumber: string; shippingService?: string | null }> {
  return tracking
    .filter((entry): entry is WmsOrderTracking & { trackingNumber: string } => Boolean(entry.trackingNumber))
    .map((entry) => ({ trackingNumber: entry.trackingNumber, shippingService: entry.carrier }))
}

export type DispatchSyncCandidate = {
  linkId: string
  orderId: string
  /** The Mintsoft order number to look the live status up by. */
  externalOrderNumber: string
}

export type DispatchSyncCounters = {
  totalChecked: number
  dispatched: number
  pending: number
  errors: number
}

export type DispatchSyncLog = {
  orderId: string
  externalOrderNumber: string
  action: 'dispatched' | 'pending' | 'error'
  reason: string
}

export type MintsoftDispatchSyncDeps = {
  listCandidates(limit: number): Promise<DispatchSyncCandidate[]>
  fetchOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null>
  applyDispatch(
    orderId: string,
    tracking: Array<{ trackingNumber: string; shippingService?: string | null }>,
  ): Promise<{ success: boolean; error?: string }>
}

/**
 * Testable core — operates purely on the injected deps so the dispatch-detection
 * and apply flow can be unit-tested with in-memory fakes (no DB / no HTTP).
 */
export async function runMintsoftDispatchSyncCore(
  deps: MintsoftDispatchSyncDeps,
  options?: { batchSize?: number },
): Promise<{ counters: DispatchSyncCounters; logs: DispatchSyncLog[] }> {
  const batchSize = options?.batchSize ?? DISPATCH_SYNC_DEFAULT_BATCH_SIZE
  const counters: DispatchSyncCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }
  const logs: DispatchSyncLog[] = []

  const candidates = await deps.listCandidates(batchSize)
  for (const candidate of candidates) {
    counters.totalChecked += 1
    try {
      const status = await deps.fetchOrderStatus(candidate.externalOrderNumber)
      if (!status || !isMintsoftDispatched(status)) {
        counters.pending += 1
        logs.push({
          orderId: candidate.orderId,
          externalOrderNumber: candidate.externalOrderNumber,
          action: 'pending',
          reason: status ? `Not dispatched (status ${status.status || 'Unknown'})` : 'Order not found in Mintsoft',
        })
        continue
      }

      // A split order's primary row can read DESPATCHED while only some parts have
      // shipped; applying SHIPPED to the whole IMS order (and index-mapping the
      // primary row's tracking onto every shipment) would be wrong. Per-part
      // reconciliation is q66in.1.5 — leave split orders pending until then.
      if (status.isSplit) {
        counters.pending += 1
        logs.push({
          orderId: candidate.orderId,
          externalOrderNumber: candidate.externalOrderNumber,
          action: 'pending',
          reason: `Split order (${status.partCount ?? '?'} parts) — deferred to partial-ship reconciliation (q66in.1.5)`,
        })
        continue
      }

      const result = await deps.applyDispatch(candidate.orderId, toFulfillmentTracking(status.tracking))
      if (!result.success) {
        counters.errors += 1
        logs.push({
          orderId: candidate.orderId,
          externalOrderNumber: candidate.externalOrderNumber,
          action: 'error',
          reason: result.error ?? 'Dispatch apply failed',
        })
        continue
      }

      counters.dispatched += 1
      logs.push({
        orderId: candidate.orderId,
        externalOrderNumber: candidate.externalOrderNumber,
        action: 'dispatched',
        reason: status.status || 'DESPATCHED',
      })
    } catch (error) {
      counters.errors += 1
      logs.push({
        orderId: candidate.orderId,
        externalOrderNumber: candidate.externalOrderNumber,
        action: 'error',
        reason: error instanceof Error ? error.message : 'Mintsoft dispatch sync error',
      })
    }
  }

  return { counters, logs }
}

export type MintsoftDispatchSyncResult = {
  jobId: string | null
  status: 'SKIPPED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  totalChecked: number
  dispatched: number
  pending: number
  errors: number
  skippedReason?: string
}

function createPrismaDispatchDeps(): MintsoftDispatchSyncDeps {
  const connector = getWmsConnector('mintsoft')
  return {
    async listCandidates(limit) {
      const rows = await db.wmsOrderPushLink.findMany({
        where: {
          connector: 'mintsoft',
          state: 'SYNCED',
          externalOrderNumber: { not: null },
          order: { status: { notIn: [...POST_DISPATCH_STATUSES] } },
        },
        select: { id: true, orderId: true, externalOrderNumber: true },
        take: limit,
        orderBy: { pushedAt: 'asc' },
      })
      return rows.flatMap((row) =>
        row.externalOrderNumber
          ? [{ linkId: row.id, orderId: row.orderId, externalOrderNumber: row.externalOrderNumber }]
          : [],
      )
    },
    fetchOrderStatus(orderNumber) {
      if (!connector.fetchOrderStatus) return Promise.resolve(null)
      return connector.fetchOrderStatus(orderNumber)
    },
    applyDispatch(orderId, tracking) {
      return applyExternalFulfillmentUpdate({
        source: 'mintsoft',
        lookup: { orderId },
        targetShipmentStatus: 'SHIPPED',
        tracking,
      })
    },
  }
}

/**
 * Production entry — wraps the core in a WmsSyncJob record (consistent with the
 * other Mintsoft sync jobs and the Phase 11 health dashboard) and the Prisma +
 * connector wiring.
 *
 * Known limitations deferred to later Phase 8/11 issues, not 1.1:
 * - Candidates are not row-locked, so two overlapping cron runs could both
 *   process the same order before either commits. applyExternalFulfillmentUpdate
 *   is idempotent once shipments reach the target status, so the worst case is a
 *   duplicate no-op apply; row-claim/dead-letter hardening is Phase 11 (q66in.4).
 * - A despatched order that can't reconcile (e.g. no IMS stock / backorder) stays
 *   a candidate and re-errors each run. That is a genuine stock discrepancy that
 *   should keep surfacing; bounded retry / dead-lettering is Phase 11 (q66in.4).
 */
export async function runMintsoftDispatchSync(
  triggeredBy: string,
  options?: { batchSize?: number; deps?: MintsoftDispatchSyncDeps },
): Promise<MintsoftDispatchSyncResult> {
  const deps = options?.deps ?? createPrismaDispatchDeps()

  const startedAt = new Date()
  const job = await db.wmsSyncJob.create({
    data: {
      connector: 'mintsoft',
      type: 'DISPATCH_SYNC',
      status: 'RUNNING',
      startedAt,
      triggeredBy,
    },
    select: { id: true },
  })

  // Hoisted so a failure during persistence still reports the work the core did,
  // rather than collapsing the counters to zero (operator needs to know which
  // orders were already applied in a partially-completed run).
  let counters: DispatchSyncCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }

  try {
    const core = await runMintsoftDispatchSyncCore(deps, options)
    counters = core.counters
    const { logs } = core

    if (logs.length > 0) {
      // Map the dispatch-specific outcomes onto the shared WmsSyncLogAction enum;
      // the human-readable detail (status / failure reason) lives in `reason`.
      const actionForLog: Record<DispatchSyncLog['action'], 'corrected' | 'noop' | 'error'> = {
        dispatched: 'corrected',
        pending: 'noop',
        error: 'error',
      }
      await db.wmsSyncLog.createMany({
        data: logs.map((log) => ({
          jobId: job.id,
          sku: null,
          productId: null,
          action: actionForLog[log.action],
          reason: log.reason,
          payload: { orderId: log.orderId, externalOrderNumber: log.externalOrderNumber } as Prisma.InputJsonValue,
        })),
      })
    }

    const status: 'SUCCEEDED' | 'PARTIAL' = counters.errors > 0 ? 'PARTIAL' : 'SUCCEEDED'
    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        totalChecked: counters.totalChecked,
        matched: counters.dispatched,
        mismatched: counters.pending,
        corrected: counters.dispatched,
        errors: counters.errors,
      },
    })

    if (counters.dispatched > 0 || counters.errors > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'mintsoft_dispatch_sync',
        description: `Mintsoft dispatch sync: ${counters.totalChecked} checked, ${counters.dispatched} dispatched, ${counters.errors} errors.`,
        metadata: { jobId: job.id, ...counters },
        resolveUser: false,
      })
    }

    return {
      jobId: job.id,
      status,
      totalChecked: counters.totalChecked,
      dispatched: counters.dispatched,
      pending: counters.pending,
      errors: counters.errors,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft dispatch sync failed'
    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date() },
    })
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'mintsoft_dispatch_sync_failed',
      level: 'ERROR',
      description: `Mintsoft dispatch sync failed after ${counters.dispatched} dispatched / ${counters.totalChecked} checked: ${message}`,
      metadata: { jobId: job.id, ...counters },
      resolveUser: false,
    })
    return {
      jobId: job.id,
      status: 'FAILED',
      totalChecked: counters.totalChecked,
      dispatched: counters.dispatched,
      pending: counters.pending,
      errors: counters.errors + 1,
      skippedReason: message,
    }
  }
}
