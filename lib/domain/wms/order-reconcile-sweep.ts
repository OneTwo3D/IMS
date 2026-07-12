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

  // A — pure IMS SQL, no WMS calls, so it is NOT bound by the lookup budget:
  // scan far wider than the API cap (Codex: the same-oldest-200 would hide
  // newer unpushed orders behind a large backlog).
  const unpushed = await deps.listUnpushedIntentOrders(lookupLimit * 5)
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

/**
 * The ONE NOT_PUSHED drift predicate, shared verbatim by detection and
 * resolution (Codex r6: they diverged twice — grace-window and binding
 * conditions — leaving stale rows open; a single builder makes that
 * structurally impossible). An order drifts when it meets the push sweep's own
 * eligibility, sits in a WMS-bound warehouse, has no live link (or a stale
 * PENDING_CREATE/HELD one), and nothing about it changed within the grace
 * window.
 */
export function buildNotPushedDriftWhere(input: {
  boundWarehouseIds: string[]
  cutoff: Date
  orderIds?: string[]
}) {
  return {
    ...(input.orderIds ? { id: { in: input.orderIds } } : {}),
    status: { in: ['PROCESSING' as const, 'ALLOCATED' as const] },
    paidAt: { not: null, lt: input.cutoff },
    updatedAt: { lt: input.cutoff },
    refundStatus: { not: 'FULL' as const },
    shipFromWarehouseId: { in: input.boundWarehouseIds },
    OR: [
      { wmsOrderPush: null },
      { wmsOrderPush: { state: 'PENDING_CREATE' as const, updatedAt: { lt: input.cutoff } } },
      // A ready+paid order stuck on a HELD link should have been re-created by
      // the push sweep's release pass — if it lingers, that cron is dead.
      // Freshness keys on cancelledAt (stamped when the hold parked the link):
      // the link's own updatedAt is churned by check C's reconcileCheckedAt
      // stamp, which would make a stale HELD finding self-resolve mid-run
      // (Codex r7). cancelledAt only moves when the hold state itself does.
      { wmsOrderPush: { state: 'HELD' as const, cancelledAt: { lt: input.cutoff } } },
    ],
  }
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
      const orders = await db.salesOrder.findMany({
        where: {
          ...buildNotPushedDriftWhere({ boundWarehouseIds: bindings.map((b) => b.warehouseId), cutoff }),
          // Rotation (Codex): findings are durable, so already-flagged orders
          // need no re-scan — every run's slots go to UNDISCOVERED drift, and a
          // backlog larger than the cap is fully reported across runs.
          NOT: { wmsOrderDiscrepancies: { some: { category: 'NOT_PUSHED', status: 'OPEN' } } },
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
      // doesn't need re-checking forever. Windowed on cancelledAt — a STABLE
      // timestamp (both the cancel and hold passes set it). updatedAt would be
      // refreshed by our own reconcileCheckedAt stamp, so checked links would
      // never age out and would eventually consume the whole shared budget,
      // permanently starving check B (Codex P1).
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const links = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          state: { in: ['CANCELLED', 'HELD'] },
          externalOrderNumber: { not: null },
          // Window on the stable cancellation time — but a link with an OPEN
          // finding stays verifiable forever (Codex: otherwise a fix applied in
          // the WMS after the window could never re-verify clean and the
          // durable finding would be permanent).
          OR: [
            { cancelledAt: { gte: since } },
            { order: { wmsOrderDiscrepancies: { some: { category: 'ACTIVE_AFTER_CANCEL', status: 'OPEN' } } } },
          ],
        },
        select: { orderId: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
        take: limit,
        // Rotate like check B: least-recently-verified first, so a window with
        // more cancellations than the cap still gets full coverage over days.
        orderBy: [{ reconcileCheckedAt: { sort: 'asc', nulls: 'first' } }, { cancelledAt: 'desc' }],
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

    // Run ledger (per-run history stays on the job).
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

    // Durable findings (Codex): a capped run is never a complete snapshot, so
    // OPEN rows persist until the SPECIFIC order re-verifies clean — they are
    // never cleared wholesale by a newer run.
    const now = new Date()
    const newlyOpened: WmsReconcileFinding[] = []
    for (const finding of core.findings) {
      const updated = await db.wmsOrderDiscrepancy.updateMany({
        where: { orderId: finding.orderId, category: finding.category, status: 'OPEN' },
        data: { detail: finding.detail, externalOrderNumber: finding.externalOrderNumber, lastSeenAt: now },
      })
      if (updated.count === 0) {
        try {
          await db.wmsOrderDiscrepancy.create({
            data: {
              connector: connectorId,
              orderId: finding.orderId,
              category: finding.category,
              detail: finding.detail,
              externalOrderNumber: finding.externalOrderNumber,
            },
          })
          newlyOpened.push(finding)
        } catch (error) {
          // Partial-unique race with a concurrent run: the row exists now — fine.
          if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
        }
      }
    }

    // Resolve B/C rows for orders this run verified CLEAN (verified, no finding).
    const foundKey = new Set(core.findings.map((finding) => `${finding.orderId}:${finding.category}`))
    const cleanOrderIds = core.verifiedOrderIds.filter((orderId) => (
      !foundKey.has(`${orderId}:MISSING_IN_WMS`) && !foundKey.has(`${orderId}:ACTIVE_AFTER_CANCEL`)
    ))
    if (cleanOrderIds.length > 0) {
      await db.wmsOrderDiscrepancy.updateMany({
        where: { orderId: { in: cleanOrderIds }, category: { in: ['MISSING_IN_WMS', 'ACTIVE_AFTER_CANCEL'] }, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: now },
      })
    }

    // Resolve NOT_PUSHED rows whose drift predicate no longer holds — the order
    // gained a live link, or stopped being eligible. Re-evaluated per open row
    // (bounded set), never by absence from a capped scan.
    const openNotPushed = await db.wmsOrderDiscrepancy.findMany({
      where: { category: 'NOT_PUSHED', status: 'OPEN' },
      select: { id: true, orderId: true },
    })
    if (openNotPushed.length > 0) {
      // Same predicate as detection — including the bound-warehouse condition
      // (Codex: an order whose binding was disabled or that moved to an unbound
      // warehouse is out of WMS scope and must resolve, not linger).
      const bindings = await db.externalWmsBinding.findMany({
        where: { connector: connectorId, active: true, connection: { active: true } },
        select: { warehouseId: true },
      })
      const stillDrifting = new Set(
        bindings.length === 0
          ? []
          : (await db.salesOrder.findMany({
              where: buildNotPushedDriftWhere({
                boundWarehouseIds: bindings.map((b) => b.warehouseId),
                cutoff: new Date(Date.now() - RECONCILE_UNPUSHED_GRACE_MS),
                orderIds: openNotPushed.map((row) => row.orderId),
              }),
              select: { id: true },
            })).map((order) => order.id),
      )
      const resolvableIds = openNotPushed.filter((row) => !stillDrifting.has(row.orderId)).map((row) => row.id)
      if (resolvableIds.length > 0) {
        await db.wmsOrderDiscrepancy.updateMany({
          where: { id: { in: resolvableIds } },
          data: { status: 'RESOLVED', resolvedAt: now },
        })
      }
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

    // Check C is the ship-goods-nobody-expects direction — bell the admins, but
    // only for NEWLY-opened findings (a known open finding must not re-bell daily).
    const activeAfterCancel = newlyOpened.filter((finding) => finding.category === 'ACTIVE_AFTER_CANCEL')
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
