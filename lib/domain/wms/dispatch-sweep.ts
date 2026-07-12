import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnector, WmsConnectorId, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { applyExternalFulfillmentUpdate } from '@/lib/fulfillment/external-fulfillment'
import { notify } from '@/lib/notifications'
import { scrubWmsError } from './error-scrub'

/**
 * Connector-agnostic WMS dispatch sweep (q66in.1.1/1.5 + G2, hoisted to the generic
 * boundary in q66in.1.3). Reconciles a despatched WMS order into the storefront
 * fulfilment loop via applyExternalFulfillmentUpdate (→ IMS shipment SHIPPED + tracking
 * + storefront despatch email), with per-part partial shipments for split orders and
 * survivor repointing for merges.
 *
 * Everything connector-specific is behind the WmsConnector contract: the connector
 * normalises "dispatched" onto WmsOrderStatus/WmsOrderPart and supplies fetchOrderParts /
 * fetchOrderPartItems. So a second WMS (ShipHero) inherits this by implementing the
 * contract. The per-order step (reconcileOneOrder) is exported so a webhook-primary WMS
 * can reconcile a single order on a shipment event rather than polling.
 */

const DISPATCH_SWEEP_DEFAULT_BATCH_SIZE = 50

/** Lifecycle statuses where the IMS order has already left the dispatch-poll set. */
const POST_DISPATCH_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] as const

/**
 * 6oyu.2: consecutive per-order reconcile failures before the link is
 * dead-lettered out of the sweep. Five failures ≈ five sweep cycles — enough
 * for transient WMS/API wobbles to clear, short enough that a genuinely stuck
 * order (typically dispatched-but-no-IMS-stock) stops re-erroring forever and
 * surfaces in the exception inbox instead.
 */
export const DISPATCH_MAX_CONSECUTIVE_FAILURES = 5

/** Pure dead-letter decision so the threshold semantics are unit-testable. */
export function shouldDeadLetterDispatch(failureCount: number, deadLetteredAt: Date | null): boolean {
  return failureCount >= DISPATCH_MAX_CONSECUTIVE_FAILURES && !deadLetteredAt
}

/** Map WMS tracking entries to the shape applyExternalFulfillmentUpdate expects. */
export function toFulfillmentTracking(
  tracking: WmsOrderTracking[],
): Array<{ trackingNumber: string; shippingService?: string | null }> {
  return tracking
    .filter((entry): entry is WmsOrderTracking & { trackingNumber: string } => Boolean(entry.trackingNumber))
    .map((entry) => ({ trackingNumber: entry.trackingNumber, shippingService: entry.carrier }))
}

export type WmsDispatchCandidate = {
  linkId: string
  orderId: string
  /** The WMS order number to look the live status up by. */
  externalOrderNumber: string
}

export type WmsDispatchCounters = {
  totalChecked: number
  dispatched: number
  pending: number
  errors: number
}

export type WmsDispatchLog = {
  orderId: string
  externalOrderNumber: string
  action: 'dispatched' | 'pending' | 'error'
  reason: string
}

export type WmsDispatchPartialShipmentInput = {
  part: number
  totalParts: number
  trackingNumber?: string | null
  items: Array<{ sku: string; qty: number }>
}

export type WmsDispatchSweepDeps = {
  listCandidates(limit: number): Promise<WmsDispatchCandidate[]>
  fetchOrderStatus(orderNumber: string): Promise<import('@/lib/connectors/wms/types').WmsOrderStatus | null>
  applyDispatch(
    orderId: string,
    tracking: Array<{ trackingNumber: string; shippingService?: string | null }>,
  ): Promise<{ success: boolean; error?: string }>
  // Whether the active connector supports per-part reconciliation (fetchOrderParts). When
  // false, a split order is surfaced as a clear "unsupported" pending rather than silently
  // stalling as "no parts visible".
  partsSupported: boolean
  // Split-order reconciliation: fetch every part, its line items, and push each despatched
  // part to the storefront as a partial shipment.
  fetchOrderParts(orderNumber: string): Promise<import('@/lib/connectors/wms/types').WmsOrderPart[]>
  fetchPartItems(externalPartId: string): Promise<Array<{ sku: string; qty: number }>>
  pushPartialShipment(
    orderId: string,
    input: WmsDispatchPartialShipmentInput,
  ): Promise<{ ok: boolean; error?: string }>
  // Merge handling: repoint the push link to the surviving WMS order when this order was
  // merged into another (its own WMS order is destroyed).
  repointLink(linkId: string, to: { externalOrderId: string; externalOrderNumber: string }): Promise<void>
  // 6oyu.2: consecutive-failure tracking. recordDispatchError increments the link's
  // failure count (dead-lettering at DISPATCH_MAX_CONSECUTIVE_FAILURES — the link then
  // leaves listCandidates); clearDispatchFailures resets it on a success/pending outcome
  // so only CONSECUTIVE failures accumulate.
  recordDispatchError(candidate: WmsDispatchCandidate, reason: string): Promise<{ deadLettered: boolean }>
  clearDispatchFailures(linkId: string): Promise<void>
}

/**
 * Reconcile a SPLIT WMS order: push each despatched part to the storefront as a partial
 * shipment (idempotent per part), and only mark the IMS order SHIPPED once every part has
 * despatched — line-level at the storefront, atomic IMS-side. A partially-despatched order
 * stays pending.
 */
async function reconcileSplitOrder(
  deps: WmsDispatchSweepDeps,
  candidate: WmsDispatchCandidate,
  orderNumber: string,
  expectedParts: number | null,
  // When false (a MERGED survivor), don't push per-part partial shipments — the survivor's
  // parts mix several original orders' items, so they don't map cleanly to this one IMS
  // order. Reconcile atomically: just complete when all parts ship.
  recordPartials: boolean,
): Promise<{ action: 'dispatched' | 'pending' | 'error'; reason: string }> {
  const parts = await deps.fetchOrderParts(orderNumber)
  if (parts.length === 0) {
    return { action: 'pending', reason: 'Split order has no parts visible in the WMS yet' }
  }
  // Trust the WMS's part count when present so we don't complete early off a partial set
  // of part rows (some may not be visible to the search yet).
  const totalParts = Math.max(expectedParts ?? 0, parts.length)
  const dispatchedParts = parts.filter((part) => part.dispatched)

  // Push every despatched part to the storefront. A despatched part with no recordable
  // line items can't become a partial shipment — don't let it count toward completion
  // (that would ship the IMS order with a part never recorded).
  let allRecorded = true
  if (recordPartials) {
    for (const part of dispatchedParts) {
      const items = await deps.fetchPartItems(part.externalId)
      if (items.length === 0) {
        allRecorded = false
        continue
      }
      const push = await deps.pushPartialShipment(candidate.orderId, {
        part: part.partNumber,
        totalParts,
        trackingNumber: part.tracking.find((entry) => entry.trackingNumber)?.trackingNumber ?? null,
        items,
      })
      if (!push.ok) {
        return { action: 'error', reason: push.error ?? `Partial-shipment push failed for part ${part.partNumber}` }
      }
    }
  }

  if (!allRecorded || dispatchedParts.length < totalParts) {
    return {
      action: 'pending',
      reason: !allRecorded
        ? 'A despatched part returned no line items — holding off completion'
        : `${dispatchedParts.length}/${totalParts} parts despatched`,
    }
  }

  // Every part despatched + recorded — mark the IMS order SHIPPED. The IMS order has a
  // single shipment and applyExternalFulfillmentUpdate maps tracking[i]→shipment[i], so
  // aggregate all parts' tracking numbers into ONE entry (the storefront already has
  // per-part tracking via the partial shipments above).
  const allTracking = dispatchedParts.flatMap((part) => part.tracking)
  const trackingNumbers = allTracking.map((entry) => entry.trackingNumber).filter((n): n is string => !!n)
  const aggregated = trackingNumbers.length > 0
    ? [{ trackingNumber: trackingNumbers.join(', '), shippingService: allTracking.find((e) => e.carrier)?.carrier ?? null }]
    : []
  const result = await deps.applyDispatch(candidate.orderId, aggregated)
  if (!result.success) {
    return { action: 'error', reason: result.error ?? 'Dispatch apply failed after all parts despatched' }
  }
  return { action: 'dispatched', reason: `All ${totalParts} parts despatched` }
}

/**
 * Reconcile ONE WMS order's dispatch — the per-order step shared by the poll sweep and a
 * webhook-driven reconcile. Returns the outcome; the caller records counters/logs.
 */
export async function reconcileOneOrder(
  deps: WmsDispatchSweepDeps,
  candidate: WmsDispatchCandidate,
): Promise<{ action: 'dispatched' | 'pending' | 'error'; reason: string }> {
  const status = await deps.fetchOrderStatus(candidate.externalOrderNumber)
  if (!status) {
    return { action: 'pending', reason: 'Order not found in the WMS' }
  }

  // Merge: the WMS merged this order into a survivor (combined "a+b" number); our original
  // WMS order is gone. Repoint the link to the survivor, then process under its number.
  if (status.isMerged && status.externalOrderNumber !== candidate.externalOrderNumber) {
    await deps.repointLink(candidate.linkId, {
      externalOrderId: status.externalOrderId,
      externalOrderNumber: status.externalOrderNumber,
    })
  }
  const effectiveOrderNumber = status.externalOrderNumber || candidate.externalOrderNumber

  // A split order's primary row can read dispatched while only some parts have shipped (or
  // the reverse), so handle split BEFORE the dispatched gate and reconcile per part.
  if (status.isSplit) {
    if (!deps.partsSupported) {
      return { action: 'pending', reason: 'Split order — this WMS connector has no per-part reconciliation yet' }
    }
    // A merged survivor's parts mix several original orders → reconcile atomically.
    return reconcileSplitOrder(deps, candidate, effectiveOrderNumber, status.partCount, !status.isMerged)
  }

  if (!status.dispatched) {
    return { action: 'pending', reason: `Not dispatched (status ${status.status || 'Unknown'})` }
  }

  const result = await deps.applyDispatch(candidate.orderId, toFulfillmentTracking(status.tracking))
  if (!result.success) {
    return { action: 'error', reason: result.error ?? 'Dispatch apply failed' }
  }
  return { action: 'dispatched', reason: status.status || 'DESPATCHED' }
}

/**
 * Testable core — operates purely on the injected deps so the reconciliation can be
 * unit-tested with in-memory fakes (no DB / no HTTP).
 */
export async function runWmsDispatchSweepCore(
  deps: WmsDispatchSweepDeps,
  options?: { batchSize?: number },
): Promise<{ counters: WmsDispatchCounters; logs: WmsDispatchLog[] }> {
  const batchSize = options?.batchSize ?? DISPATCH_SWEEP_DEFAULT_BATCH_SIZE
  const counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }
  const logs: WmsDispatchLog[] = []

  const candidates = await deps.listCandidates(batchSize)
  for (const candidate of candidates) {
    counters.totalChecked += 1

    // Reconcile first; the failure-tracking bookkeeping below runs OUTSIDE this
    // try/catch so a bookkeeping error can never count as another reconcile
    // failure (Codex: recordDispatchError throwing inside the catch would have
    // recursed into itself) nor abort the rest of the batch.
    let outcome: { action: 'dispatched' | 'pending' | 'error'; reason: string }
    try {
      outcome = await reconcileOneOrder(deps, candidate)
    } catch (error) {
      outcome = { action: 'error', reason: scrubWmsError(error, 'WMS dispatch sweep error') }
    }
    counters[outcome.action === 'dispatched' ? 'dispatched' : outcome.action === 'error' ? 'errors' : 'pending'] += 1

    // 6oyu.2: only CONSECUTIVE errors dead-letter — any non-error outcome resets.
    let reason = outcome.reason
    try {
      if (outcome.action === 'error') {
        const { deadLettered } = await deps.recordDispatchError(candidate, outcome.reason)
        if (deadLettered) reason = `${outcome.reason} — dead-lettered after ${DISPATCH_MAX_CONSECUTIVE_FAILURES} consecutive failures`
      } else {
        await deps.clearDispatchFailures(candidate.linkId)
      }
    } catch (bookkeepingError) {
      // Best-effort: the streak just doesn't move this run.
      console.error('[wms-dispatch-sweep] failure-tracking bookkeeping failed:', bookkeepingError)
    }

    logs.push({
      orderId: candidate.orderId,
      externalOrderNumber: candidate.externalOrderNumber,
      action: outcome.action,
      reason,
    })
  }

  return { counters, logs }
}

export type WmsDispatchSweepResult = {
  jobId: string | null
  status: 'SKIPPED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  totalChecked: number
  dispatched: number
  pending: number
  errors: number
  skippedReason?: string
}

/** Prisma + active-connector wiring of the deps. */
export function createPrismaDispatchDeps(connectorId: WmsConnectorId, connector: WmsConnector): WmsDispatchSweepDeps {
  return {
    async listCandidates(limit) {
      const rows = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          // MERGED links are repointed-to-survivor orders that still need despatch
          // tracking; the push-sweep skips them (SYNCED-only) so they aren't re-pushed.
          state: { in: ['SYNCED', 'MERGED'] },
          externalOrderNumber: { not: null },
          // 6oyu.2: dead-lettered links stop re-erroring every sweep; an operator
          // replays them from the exception inbox once the cause is fixed.
          dispatchDeadLetteredAt: null,
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
      return connector.fetchOrderStatus ? connector.fetchOrderStatus(orderNumber) : Promise.resolve(null)
    },
    applyDispatch(orderId, tracking) {
      return applyExternalFulfillmentUpdate({
        source: connectorId,
        lookup: { orderId },
        targetShipmentStatus: 'SHIPPED',
        tracking,
      })
    },
    partsSupported: Boolean(connector.fetchOrderParts),
    fetchOrderParts(orderNumber) {
      return connector.fetchOrderParts ? connector.fetchOrderParts(orderNumber) : Promise.resolve([])
    },
    fetchPartItems(externalPartId) {
      return connector.fetchOrderPartItems ? connector.fetchOrderPartItems(externalPartId) : Promise.resolve([])
    },
    async pushPartialShipment(orderId, input) {
      const { pushPartialShipmentToShopping } = await import('@/lib/shopping')
      const result = await pushPartialShipmentToShopping(orderId, {
        part: input.part,
        totalParts: input.totalParts,
        trackingNumber: input.trackingNumber,
        items: input.items,
      })
      return { ok: result.success, error: result.error }
    },
    async repointLink(linkId, to) {
      // Park as MERGED so the push-sweep's SYNCED-filtered passes skip it (no dual-sync
      // amending the survivor with this order's lines); the dispatch sweep still polls it.
      // The failure streak belonged to the OLD WMS order — the survivor starts clean.
      await db.wmsOrderPushLink.update({
        where: { id: linkId },
        data: {
          externalOrderId: to.externalOrderId,
          externalOrderNumber: to.externalOrderNumber,
          state: 'MERGED',
          dispatchFailureCount: 0,
          dispatchLastError: null,
          dispatchDeadLetteredAt: null,
        },
      })
    },
    async recordDispatchError(candidate, reason) {
      const link = await db.wmsOrderPushLink.update({
        where: { id: candidate.linkId },
        data: {
          dispatchFailureCount: { increment: 1 },
          dispatchLastError: reason,
        },
        select: { dispatchFailureCount: true, dispatchDeadLetteredAt: true },
      })

      if (!shouldDeadLetterDispatch(link.dispatchFailureCount, link.dispatchDeadLetteredAt)) {
        return { deadLettered: false }
      }

      // Compare-and-set so a concurrent run (or replay) can't double dead-letter,
      // AND (Codex) so an overlapping sweep's successful reconcile — which resets
      // the count between our increment/read and this write — vetoes the
      // dead-letter: the count must STILL be at the threshold when we commit.
      const updated = await db.wmsOrderPushLink.updateMany({
        where: {
          id: candidate.linkId,
          dispatchDeadLetteredAt: null,
          dispatchFailureCount: { gte: DISPATCH_MAX_CONSECUTIVE_FAILURES },
        },
        data: { dispatchDeadLetteredAt: new Date() },
      })
      if (updated.count === 0) return { deadLettered: false }

      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: candidate.orderId,
        tag: 'sync',
        action: 'wms_dispatch_dead_lettered',
        description: `Dispatch reconciliation dead-lettered after ${DISPATCH_MAX_CONSECUTIVE_FAILURES} consecutive failures (WMS order ${candidate.externalOrderNumber}): ${reason}`,
        metadata: {
          orderId: candidate.orderId,
          externalOrderNumber: candidate.externalOrderNumber,
          connector: connectorId,
          failureCount: link.dispatchFailureCount,
          lastError: reason,
        },
        level: 'WARNING',
        resolveUser: false,
      })

      // Bell the admins individually — a broadcast (userId null) would expose
      // order details to READONLY/SUPPLIER users.
      const admins = await db.user.findMany({
        where: { role: 'ADMIN', active: true },
        select: { id: true },
      })
      await Promise.all(admins.map((admin) => notify({
        userId: admin.id,
        type: 'error',
        title: 'WMS dispatch stuck',
        message: `Order ${candidate.externalOrderNumber} despatched in the WMS but cannot reconcile into IMS (${DISPATCH_MAX_CONSECUTIVE_FAILURES} consecutive failures). It needs attention in the sync exception inbox.`,
        actionUrl: '/sync/exceptions',
      })))

      return { deadLettered: true }
    },
    async clearDispatchFailures(linkId) {
      // Only touch rows that actually accumulated failures — keeps the happy
      // path write-free.
      await db.wmsOrderPushLink.updateMany({
        where: { id: linkId, dispatchFailureCount: { gt: 0 }, dispatchDeadLetteredAt: null },
        data: { dispatchFailureCount: 0, dispatchLastError: null },
      })
    },
  }
}

/**
 * Production entry — resolves the active WMS connector and wraps the core in a WmsSyncJob
 * record (consistent with the other WMS sync jobs).
 *
 * Known limitations (Phase 11 / q66in.4): candidates aren't row-locked (overlapping runs
 * could both process an order, but applyExternalFulfillmentUpdate is idempotent). A
 * despatched order that can't reconcile (no IMS stock) dead-letters after
 * DISPATCH_MAX_CONSECUTIVE_FAILURES consecutive errors (6oyu.2): the link leaves the
 * candidate set, admins are notified, and the order surfaces in /sync/exceptions for
 * replay once the stock position is fixed.
 */
export async function runWmsDispatchSweep(
  triggeredBy: string,
  options?: { batchSize?: number; deps?: WmsDispatchSweepDeps },
): Promise<WmsDispatchSweepResult> {
  const empty = { jobId: null as string | null, totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }

  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { ...empty, status: 'SKIPPED', skippedReason: 'No WMS connector enabled' }
  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) {
    return { ...empty, status: 'SKIPPED', skippedReason: 'Active WMS connector has no order-status support' }
  }

  const deps = options?.deps ?? createPrismaDispatchDeps(connectorId, connector)

  const startedAt = new Date()
  const job = await db.wmsSyncJob.create({
    data: { connector: connectorId, type: 'DISPATCH_SYNC', status: 'RUNNING', startedAt, triggeredBy },
    select: { id: true },
  })

  // Hoisted so a failure during persistence still reports the work the core did.
  let counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }

  try {
    const core = await runWmsDispatchSweepCore(deps, options)
    counters = core.counters
    const { logs } = core

    if (logs.length > 0) {
      // Map the dispatch outcomes onto the shared WmsSyncLogAction enum; the detail lives
      // in `reason`.
      const actionForLog: Record<WmsDispatchLog['action'], 'corrected' | 'noop' | 'error'> = {
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
        action: 'wms_dispatch_sync',
        description: `WMS dispatch sync (${connectorId}): ${counters.totalChecked} checked, ${counters.dispatched} dispatched, ${counters.errors} errors.`,
        metadata: { jobId: job.id, connector: connectorId, ...counters },
        resolveUser: false,
      })
    }

    return { jobId: job.id, status, totalChecked: counters.totalChecked, dispatched: counters.dispatched, pending: counters.pending, errors: counters.errors }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'WMS dispatch sync failed'
    await db.wmsSyncJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date() } })
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'wms_dispatch_sync_failed',
      level: 'ERROR',
      description: `WMS dispatch sync (${connectorId}) failed after ${counters.dispatched} dispatched / ${counters.totalChecked} checked: ${message}`,
      metadata: { jobId: job.id, connector: connectorId, ...counters },
      resolveUser: false,
    })
    return { jobId: job.id, status: 'FAILED', totalChecked: counters.totalChecked, dispatched: counters.dispatched, pending: counters.pending, errors: counters.errors + 1, skippedReason: message }
  }
}
