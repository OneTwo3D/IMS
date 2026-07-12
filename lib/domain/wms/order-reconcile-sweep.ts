import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnector, WmsConnectorId, WmsOrderStatus } from '@/lib/connectors/wms/types'
import { notify } from '@/lib/notifications'
import { scrubWmsError } from './error-scrub'

/**
 * Connector-agnostic scheduled ORDER-LEVEL reconciliation (q66in.4.4): compares
 * IMS's fulfilment INTENT against WMS truth, catching drift the incremental
 * sweeps never see because they only walk the push-link happy path.
 *
 * The WMS contract cannot enumerate orders (lookups are strictly by order
 * number), so the reconcile verifies IMS-known truth per order:
 *
 *  A. NOT_PUSHED       — an order that meets the push-sweep's own eligibility
 *                        (ready + paid + not fully refunded + WMS-bound
 *                        warehouse) but has no live push link well past the
 *                        sweep cadence. Catches a dead cron / eligibility bug.
 *  B. MISSING_IN_WMS   — a SYNCED/MERGED link whose WMS order no longer exists
 *                        (deleted on the WMS side): the order will silently
 *                        never fulfil.
 *  C. ACTIVE_AFTER_CANCEL — a CANCELLED/HELD link whose WMS order still looks
 *                        active: the warehouse may ship goods nobody expects.
 *                        The most dangerous direction — admins are belled.
 *
 * Findings are recorded on a WmsSyncJob (type ORDER_RECONCILE) as per-order
 * discrepancy logs; the sync exception inbox reads the latest run.
 */

export type WmsReconcileFindingCategory = 'NOT_PUSHED' | 'MISSING_IN_WMS' | 'ACTIVE_AFTER_CANCEL'

export type WmsReconcileFinding = {
  category: WmsReconcileFindingCategory
  orderId: string
  orderNumber: string | null
  externalOrderNumber: string | null
  detail: string
}

export type WmsReconcileCounters = {
  intentChecked: number
  linksVerified: number
  cancelledVerified: number
  findings: number
  errors: number
}

/**
 * How long an eligible order may sit without a live push link before the
 * reconcile flags it. Generously above the push sweep's default 10-minute
 * cadence so the reconcile never races a healthy sweep.
 */
export const RECONCILE_UNPUSHED_GRACE_MS = 6 * 60 * 60 * 1000

/** Per-run cap on WMS order-status lookups (each is one API call). */
export const RECONCILE_DEFAULT_LOOKUP_LIMIT = 200

/**
 * Pure, connector-lenient "does this WMS status read as cancelled" test for
 * check C. Case-insensitive substring so Mintsoft's "Cancelled" and variants
 * ("Cancel Requested", …) all count as safely cancelled.
 */
export function isLikelyCancelledWmsStatus(status: Pick<WmsOrderStatus, 'status' | 'statusLabel'>): boolean {
  return /cancel/i.test(status.status) || /cancel/i.test(status.statusLabel)
}

export type WmsOrderReconcileDeps = {
  /** Check A: eligible orders with no live push link past the grace window. */
  listUnpushedIntentOrders(limit: number): Promise<Array<{ orderId: string; orderNumber: string | null }>>
  /** Check B: live links whose WMS order should exist. */
  listSyncedLinksToVerify(limit: number): Promise<Array<{ orderId: string; orderNumber: string | null; externalOrderNumber: string }>>
  /** Check C: recently cancelled/held links whose WMS order should be gone or cancelled. */
  listCancelledLinksToVerify(limit: number): Promise<Array<{ orderId: string; orderNumber: string | null; externalOrderNumber: string }>>
  fetchOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null>
}

/** Testable core — pure orchestration over injected deps. */
export async function runWmsOrderReconcileCore(
  deps: WmsOrderReconcileDeps,
  options?: { lookupLimit?: number },
): Promise<{ counters: WmsReconcileCounters; findings: WmsReconcileFinding[]; verifiedOrderIds: string[] }> {
  const lookupLimit = options?.lookupLimit ?? RECONCILE_DEFAULT_LOOKUP_LIMIT
  const counters: WmsReconcileCounters = { intentChecked: 0, linksVerified: 0, cancelledVerified: 0, findings: 0, errors: 0 }
  const findings: WmsReconcileFinding[] = []

  // A — pure IMS SQL, no WMS calls.
  const unpushed = await deps.listUnpushedIntentOrders(lookupLimit)
  counters.intentChecked = unpushed.length
  for (const order of unpushed) {
    findings.push({
      category: 'NOT_PUSHED',
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      externalOrderNumber: null,
      detail: 'Order meets the WMS push eligibility but has had no push link for hours — check the order-push cron and the order itself.',
    })
  }

  // B and C share ONE lookup budget (each fetchOrderStatus is a WMS API call),
  // and C — the ship-goods-nobody-expects direction — is fetched FIRST so a
  // large live-link backlog can never starve the safety-critical check (Codex).
  const verifiedOrderIds: string[] = []
  const cancelledLinks = await deps.listCancelledLinksToVerify(lookupLimit)
  for (const link of cancelledLinks) {
    counters.cancelledVerified += 1
    try {
      const status = await deps.fetchOrderStatus(link.externalOrderNumber)
      verifiedOrderIds.push(link.orderId)
      if (status && !status.dispatched && !isLikelyCancelledWmsStatus(status)) {
        findings.push({
          category: 'ACTIVE_AFTER_CANCEL',
          orderId: link.orderId,
          orderNumber: link.orderNumber,
          externalOrderNumber: link.externalOrderNumber,
          detail: `IMS cancelled/held this order but the WMS still shows it as "${status.statusLabel || status.status}" — the warehouse may ship it. Cancel it in the WMS.`,
        })
      }
    } catch (error) {
      counters.errors += 1
      console.error(`[wms-order-reconcile] status lookup failed for ${link.externalOrderNumber}:`, scrubWmsError(error, 'lookup failed'))
    }
  }

  // B — verify each live link still has a WMS order behind it, within whatever
  // budget C left over.
  const syncedBudget = Math.max(0, lookupLimit - cancelledLinks.length)
  for (const link of await deps.listSyncedLinksToVerify(syncedBudget)) {
    counters.linksVerified += 1
    try {
      const status = await deps.fetchOrderStatus(link.externalOrderNumber)
      verifiedOrderIds.push(link.orderId)
      if (!status) {
        findings.push({
          category: 'MISSING_IN_WMS',
          orderId: link.orderId,
          orderNumber: link.orderNumber,
          externalOrderNumber: link.externalOrderNumber,
          detail: 'The push link is live but the WMS no longer knows this order — it will never fulfil. Replay re-creates it.',
        })
      }
    } catch (error) {
      counters.errors += 1
      console.error(`[wms-order-reconcile] status lookup failed for ${link.externalOrderNumber}:`, scrubWmsError(error, 'lookup failed'))
    }
  }

  counters.findings = findings.length
  return { counters, findings, verifiedOrderIds }
}

/** Prisma + active-connector wiring, mirroring the other WMS sweeps. */
export function createPrismaReconcileDeps(connectorId: WmsConnectorId, connector: WmsConnector): WmsOrderReconcileDeps {
  return {
    async listUnpushedIntentOrders(limit) {
      const bindings = await db.externalWmsBinding.findMany({
        where: { connector: connectorId, active: true, connection: { active: true } },
        select: { warehouseId: true },
      })
      if (bindings.length === 0) return []

      const cutoff = new Date(Date.now() - RECONCILE_UNPUSHED_GRACE_MS)
      // Mirrors order-push-sweep createCandidates, minus the PENDING_CREATE
      // freshness the sweep itself provides: here a missing link OR one still
      // PENDING_CREATE past the grace window is drift.
      const orders = await db.salesOrder.findMany({
        where: {
          status: { in: ['PROCESSING', 'ALLOCATED'] },
          paidAt: { not: null, lt: cutoff },
          // Codex: paidAt alone mis-fires for an order paid long ago that only
          // JUST became PROCESSING/ALLOCATED — any recent change to the order
          // (incl. that status transition) restarts the grace window.
          updatedAt: { lt: cutoff },
          refundStatus: { not: 'FULL' },
          shipFromWarehouseId: { in: bindings.map((b) => b.warehouseId) },
          OR: [
            { wmsOrderPush: null },
            { wmsOrderPush: { state: 'PENDING_CREATE', updatedAt: { lt: cutoff } } },
          ],
        },
        select: { id: true, orderNumber: true },
        take: limit,
        orderBy: { paidAt: 'asc' },
      })
      return orders.map((order) => ({ orderId: order.id, orderNumber: order.orderNumber }))
    },
    async listSyncedLinksToVerify(limit) {
      const links = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          state: { in: ['SYNCED', 'MERGED'] },
          externalOrderNumber: { not: null },
          // Orders already past dispatch don't need existence verification, and
          // dispatch-dead-lettered links are already surfaced exceptions.
          dispatchDeadLetteredAt: null,
          order: { status: { notIn: ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] } },
        },
        select: { orderId: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
        take: limit,
        // Rotate: least-recently-verified first (never-checked links lead), so a
        // corpus larger than the per-run cap still gets full coverage over days.
        orderBy: [{ reconcileCheckedAt: { sort: 'asc', nulls: 'first' } }, { pushedAt: 'asc' }],
      })
      return links.flatMap((link) => (
        link.externalOrderNumber
          ? [{ orderId: link.orderId, orderNumber: link.order.orderNumber, externalOrderNumber: link.externalOrderNumber }]
          : []
      ))
    },
    async listCancelledLinksToVerify(limit) {
      // Recent window only: a long-cancelled order that once verified clean
      // doesn't need re-checking forever.
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const links = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          state: { in: ['CANCELLED', 'HELD'] },
          externalOrderNumber: { not: null },
          updatedAt: { gte: since },
        },
        select: { orderId: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
        take: limit,
        orderBy: { updatedAt: 'desc' },
      })
      return links.flatMap((link) => (
        link.externalOrderNumber
          ? [{ orderId: link.orderId, orderNumber: link.order.orderNumber, externalOrderNumber: link.externalOrderNumber }]
          : []
      ))
    },
    fetchOrderStatus(orderNumber) {
      return connector.fetchOrderStatus ? connector.fetchOrderStatus(orderNumber) : Promise.resolve(null)
    },
  }
}

export type WmsOrderReconcileResult = {
  jobId: string | null
  status: 'SKIPPED' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  counters: WmsReconcileCounters
  skippedReason?: string
}

/** Production entry — WmsSyncJob wrapper, mirroring the other WMS sweeps. */
export async function runWmsOrderReconcileSweep(
  triggeredBy: string,
  options?: { lookupLimit?: number; deps?: WmsOrderReconcileDeps },
): Promise<WmsOrderReconcileResult> {
  const emptyCounters: WmsReconcileCounters = { intentChecked: 0, linksVerified: 0, cancelledVerified: 0, findings: 0, errors: 0 }

  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { jobId: null, status: 'SKIPPED', counters: emptyCounters, skippedReason: 'No WMS connector enabled' }
  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) {
    return { jobId: null, status: 'SKIPPED', counters: emptyCounters, skippedReason: 'Active WMS connector has no order-status support' }
  }

  const deps = options?.deps ?? createPrismaReconcileDeps(connectorId, connector)
  const job = await db.wmsSyncJob.create({
    data: { connector: connectorId, type: 'ORDER_RECONCILE', status: 'RUNNING', startedAt: new Date(), triggeredBy },
    select: { id: true },
  })

  let counters = emptyCounters
  try {
    const core = await runWmsOrderReconcileCore(deps, options)
    counters = core.counters

    if (core.verifiedOrderIds.length > 0) {
      await db.wmsOrderPushLink.updateMany({
        where: { orderId: { in: core.verifiedOrderIds } },
        data: { reconcileCheckedAt: new Date() },
      })
    }

    if (core.findings.length > 0) {
      await db.wmsSyncLog.createMany({
        data: core.findings.map((finding) => ({
          jobId: job.id,
          sku: null,
          productId: null,
          action: 'discrepancy' as const,
          reason: finding.detail,
          payload: {
            category: finding.category,
            orderId: finding.orderId,
            orderNumber: finding.orderNumber,
            externalOrderNumber: finding.externalOrderNumber,
          } as Prisma.InputJsonValue,
        })),
      })
    }

    const status: 'SUCCEEDED' | 'PARTIAL' = counters.errors > 0 ? 'PARTIAL' : 'SUCCEEDED'
    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        totalChecked: counters.intentChecked + counters.linksVerified + counters.cancelledVerified,
        matched: Math.max(0, counters.intentChecked + counters.linksVerified + counters.cancelledVerified - counters.findings),
        mismatched: counters.findings,
        errors: counters.errors,
      },
    })

    if (counters.findings > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_order_reconcile_drift',
        description: `WMS order reconciliation (${connectorId}) found ${counters.findings} drift finding(s) — see the sync exception inbox.`,
        metadata: { jobId: job.id, connector: connectorId, ...counters },
        level: 'WARNING',
        resolveUser: false,
      })
    }

    // Check C is the ship-goods-nobody-expects direction — bell the admins.
    const activeAfterCancel = core.findings.filter((finding) => finding.category === 'ACTIVE_AFTER_CANCEL')
    if (activeAfterCancel.length > 0) {
      const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
      await Promise.all(admins.map((admin) => notify({
        userId: admin.id,
        type: 'error',
        title: 'Cancelled order still active in the WMS',
        message: `${activeAfterCancel.length} cancelled/held order(s) still look active in the WMS and may ship. Review them in the sync exception inbox.`,
        actionUrl: '/sync/exceptions',
      })))
    }

    return { jobId: job.id, status, counters }
  } catch (error) {
    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), errors: counters.errors + 1 },
    }).catch(() => {})
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'sync',
      action: 'wms_order_reconcile_failed',
      description: `WMS order reconciliation failed: ${scrubWmsError(error, 'reconcile failed')}`,
      metadata: { jobId: job.id, connector: connectorId },
      level: 'ERROR',
      resolveUser: false,
    }).catch(() => {})
    return { jobId: job.id, status: 'FAILED', counters }
  }
}
