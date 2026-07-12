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
 * Pure "does this WMS status read as TERMINALLY cancelled" test for check C.
 * Requires a completed cancellation word (cancelled/canceled — both spellings)
 * and rejects in-flight or failed forms ("Cancel Requested", "Cancellation
 * Failed", "Cancel Pending"): those orders may still fulfil, so treating them
 * as safe would suppress the ACTIVE_AFTER_CANCEL finding (Codex r24).
 */
export function isLikelyCancelledWmsStatus(status: Pick<WmsOrderStatus, 'status' | 'statusLabel'>): boolean {
  const combined = `${status.status} ${status.statusLabel}`
  return /\bcancell?ed\b/i.test(combined) && !/request|fail|pending/i.test(combined)
}

export type WmsOrderReconcileDeps = {
  /** Check A: eligible orders with no live push link past the grace window. */
  listUnpushedIntentOrders(limit: number): Promise<Array<{ orderId: string; orderNumber: string | null }>>
  /** Check B: live links whose WMS order should exist. */
  listSyncedLinksToVerify(limit: number): Promise<Array<{ orderId: string; orderNumber: string | null; externalOrderNumber: string; linkState: string }>>
  /**
   * Check C: links whose WMS order OUGHT to be cancelled — CANCELLED/HELD links
   * (propagation done) AND SYNCED/MERGED links whose IMS order is cancelled/
   * on-hold/fully-refunded (propagation NOT yet done — the push cron may be
   * dead or its cancel threw; Codex r23: precisely the case where the WMS may
   * still ship).
   */
  listCancelledLinksToVerify(limit: number): Promise<Array<{ orderId: string; orderNumber: string | null; externalOrderNumber: string; linkState: string }>>
  fetchOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null>
  /** Whether the connector exposes per-part inspection (fetchOrderParts). */
  partsSupported: boolean
  /** All parts of a (possibly split) order — [] when the connector has no part support. */
  fetchOrderParts(orderNumber: string): Promise<import('@/lib/connectors/wms/types').WmsOrderPart[]>
  /**
   * Tri-state presence probe; null when the connector cannot distinguish
   * MISSING from AMBIGUOUS — check B is then skipped entirely (a re-push based
   * on a conflated null could DUPLICATE a live WMS order).
   */
  probeOrderPresence: ((orderNumber: string) => Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'>) | null
}

/** Testable core — pure orchestration over injected deps. */
export async function runWmsOrderReconcileCore(
  deps: WmsOrderReconcileDeps,
  options?: { lookupLimit?: number },
): Promise<{
  counters: WmsReconcileCounters
  findings: WmsReconcileFinding[]
  verifiedOrderIds: string[]
  verifiedSynced: Array<{ orderId: string; externalOrderNumber: string }>
  verifiedCancelled: Array<{ orderId: string; externalOrderNumber: string }>
  attemptedSynced: Array<{ orderId: string; linkState: string; externalOrderNumber: string }>
  attemptedCancelled: Array<{ orderId: string; linkState: string; externalOrderNumber: string }>
}> {
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
  const verifiedSynced: Array<{ orderId: string; externalOrderNumber: string }> = []
  const verifiedCancelled: Array<{ orderId: string; externalOrderNumber: string }> = []
  // ATTEMPTED ids drive the rotation stamp; VERIFIED ids drive resolution
  // (Codex r19 P1): an errored/ambiguous lookup is never verified, but it must
  // still rotate to the back of the queue — otherwise persistently-failing
  // links pin `nulls: first` ordering and starve the rest of the corpus.
  const attemptedSynced: Array<{ orderId: string; linkState: string; externalOrderNumber: string }> = []
  const attemptedCancelled: Array<{ orderId: string; linkState: string; externalOrderNumber: string }> = []
  // Actual WMS CALLS are budgeted (Codex r19 P2): fallback probes and part
  // fetches count too, not just link rows.
  let lookupsUsed = 0
  // C is fetched first (safety priority) but capped at HALF the budget so a
  // large cancellation window can never zero out check B either (Codex r11 —
  // the starvation existed in both directions). Each check's rotation covers
  // its own backlog across runs.
  const cancelledLinks = await deps.listCancelledLinksToVerify(Math.ceil(lookupLimit / 2))
  // C's CALL spend is capped at half the budget too (Codex r20 P1): each row
  // can cost up to two calls (status + fallback probe) or more (parts), so a
  // row cap alone still let C consume the entire call budget.
  const cancelledCallBudget = Math.ceil(lookupLimit / 2)
  for (const link of cancelledLinks) {
    if (lookupsUsed >= cancelledCallBudget) break
    counters.cancelledVerified += 1
    attemptedCancelled.push({ orderId: link.orderId, linkState: link.linkState, externalOrderNumber: link.externalOrderNumber })
    try {
      lookupsUsed += 1
      const status = await deps.fetchOrderStatus(link.externalOrderNumber)
      if (!status) {
        // Null conflates "gone" with "ambiguous merged match" (Codex r15 P1):
        // counting it as verified-clean could resolve a live ACTIVE_AFTER_CANCEL
        // finding. Only the tri-state probe's MISSING verdict verifies absence.
        // Reserve budget BEFORE the fallback call (Codex r25): the status
        // lookup may have consumed the last slot.
        if (deps.probeOrderPresence && lookupsUsed >= cancelledCallBudget) {
          counters.errors += 1
          console.error(`[wms-order-reconcile] budget exhausted before the fallback probe for ${link.externalOrderNumber}; skipping`)
          continue
        }
        const presence = deps.probeOrderPresence
          ? (lookupsUsed += 1, await deps.probeOrderPresence(link.externalOrderNumber))
          : null
        if (presence === 'MISSING') {
          verifiedCancelled.push({ orderId: link.orderId, externalOrderNumber: link.externalOrderNumber })
        } else {
          counters.errors += 1
          console.error(`[wms-order-reconcile] unresolvable cancelled-order lookup for ${link.externalOrderNumber} (${presence ?? 'no probe'}); skipping`)
        }
        continue
      }
      // Split orders on a parts-capable connector: the collapsed top-level
      // status speaks only for Part 1 (Codex r16 P1) — a cancelled Part 1 must
      // not mask an active Part 2 that can still ship. EVERY part must be
      // dispatched or cancelled. A connector WITHOUT part support (Codex r18:
      // its top-level status is computed for the whole order, not collapsed)
      // falls through to the top-level classification below.
      if (deps.partsSupported && (status.isSplit || (status.partCount ?? 1) > 1)) {
        if (lookupsUsed >= cancelledCallBudget) {
          counters.errors += 1
          console.error(`[wms-order-reconcile] budget exhausted before the parts lookup for ${link.externalOrderNumber}; skipping`)
          continue
        }
        lookupsUsed += 1
        const parts = await deps.fetchOrderParts(status.externalOrderNumber || link.externalOrderNumber)
        if (parts.length === 0) {
          // Split but parts not inspectable — fail closed, never verified-clean.
          counters.errors += 1
          console.error(`[wms-order-reconcile] split order ${link.externalOrderNumber} has no inspectable parts; skipping`)
          continue
        }
        verifiedCancelled.push({ orderId: link.orderId, externalOrderNumber: link.externalOrderNumber })
        const activeParts = parts.filter((part) => (
          !part.dispatched && !isLikelyCancelledWmsStatus({ status: part.status, statusLabel: part.status })
        ))
        if (activeParts.length > 0) {
          findings.push({
            category: 'ACTIVE_AFTER_CANCEL',
            orderId: link.orderId,
            orderNumber: link.orderNumber,
            externalOrderNumber: link.externalOrderNumber,
            detail: `IMS cancelled/held this order but ${activeParts.length} of its ${parts.length} WMS parts still look active (${activeParts.map((part) => `part ${part.partNumber}: ${part.status}`).join(', ')}) — the warehouse may ship them. Cancel them in the WMS.`,
          })
        }
        continue
      }

      verifiedCancelled.push({ orderId: link.orderId, externalOrderNumber: link.externalOrderNumber })
      if (!status.dispatched && !isLikelyCancelledWmsStatus(status)) {
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
  // budget C left over. Runs ONLY with a tri-state probe (Codex r14 P1):
  // fetchOrderStatus's null conflates "absent" with "ambiguous merged match",
  // and re-pushing an ambiguous-but-live order would duplicate it in the WMS.
  if (deps.probeOrderPresence) {
    const probe = deps.probeOrderPresence
    const syncedBudget = Math.max(0, lookupLimit - lookupsUsed)
    for (const link of await deps.listSyncedLinksToVerify(syncedBudget)) {
      if (lookupsUsed >= lookupLimit) break
      counters.linksVerified += 1
      attemptedSynced.push({ orderId: link.orderId, linkState: link.linkState, externalOrderNumber: link.externalOrderNumber })
      try {
        lookupsUsed += 1
        const presence = await probe(link.externalOrderNumber)
        if (presence === 'AMBIGUOUS') {
          // Exists but not resolvable — fail closed: neither a finding nor a
          // clean verification.
          counters.errors += 1
          console.error(`[wms-order-reconcile] ambiguous WMS match for ${link.externalOrderNumber}; skipping`)
          continue
        }
        verifiedSynced.push({ orderId: link.orderId, externalOrderNumber: link.externalOrderNumber })
        if (presence === 'MISSING') {
          findings.push({
            category: 'MISSING_IN_WMS',
            orderId: link.orderId,
            orderNumber: link.orderNumber,
            externalOrderNumber: link.externalOrderNumber,
            detail: 'The push link is live but the WMS verifiably has no trace of this order — it will never fulfil. Replay re-creates it.',
          })
        }
      } catch (error) {
        counters.errors += 1
        console.error(`[wms-order-reconcile] presence probe failed for ${link.externalOrderNumber}:`, scrubWmsError(error, 'lookup failed'))
      }
    }
  }

  counters.findings = findings.length
  return {
    counters,
    findings,
    verifiedOrderIds: [...verifiedCancelled, ...verifiedSynced].map((entry) => entry.orderId),
    verifiedSynced,
    verifiedCancelled,
    attemptedSynced,
    attemptedCancelled,
  }
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
    // Deliberately NO order.updatedAt condition (Codex r17 P1): storefront
    // refreshes touch busy orders far more often than the grace window, which
    // would permanently mask a dead push cron. The residual false positive — an
    // old-paid order that became ready moments before the sweep — is narrow
    // (the push cron handles ready orders within minutes when alive) and the
    // durable-finding resolution pass clears it on the next run.
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
      // A ready+paid order parked on a CANCELLED link is unreachable by the
      // push sweep entirely (its release pass only covers HELD) — e.g. an order
      // restored to PROCESSING through a storefront status sync after its WMS
      // order was cancelled (Codex r22). Same stable-timestamp freshness.
      { wmsOrderPush: { state: 'CANCELLED' as const, cancelledAt: { lt: input.cutoff } } },
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
          // ON_HOLD/CANCELLED/fully-refunded orders on SYNCED links belong to
          // check C (their WMS order OUGHT to be cancelled), not here.
          order: {
            status: { notIn: ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED', 'ON_HOLD'] },
            refundStatus: { not: 'FULL' },
          },
        },
        select: { orderId: true, state: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
        take: limit,
        // Rotate: least-recently-verified first (never-checked links lead), so a
        // corpus larger than the per-run cap still gets full coverage over days.
        orderBy: [{ reconcileCheckedAt: { sort: 'asc', nulls: 'first' } }, { pushedAt: 'asc' }],
      })
      return links.flatMap((link) => (
        link.externalOrderNumber
          ? [{ orderId: link.orderId, orderNumber: link.order.orderNumber, externalOrderNumber: link.externalOrderNumber, linkState: link.state }]
          : []
      ))
    },
    async listCancelledLinksToVerify(limit) {
      const toRow = (link: { orderId: string; state: string; externalOrderNumber: string | null; order: { orderNumber: string | null } }) => (
        link.externalOrderNumber
          ? [{ orderId: link.orderId, orderNumber: link.order.orderNumber, externalOrderNumber: link.externalOrderNumber, linkState: link.state }]
          : []
      )

      // Tier 1 — UNPROPAGATED cancellations FIRST (Codex r27 P1): the IMS order
      // is cancelled/on-hold/fully-refunded but the link is still SYNCED/MERGED
      // (dead push cron, or a WMS cancel that keeps throwing). These are the
      // most dangerous and inherently RECENT transitions, and the link often
      // carries a fresh reconcileCheckedAt from its SYNCED life — recency must
      // not push them behind old propagated cancellations.
      // Tier 1 is capped at HALF the C row budget (Codex r29): a saturated
      // unpropagated backlog (push cron down) must not starve tier 2, whose
      // OPEN findings could then never re-verify clean.
      const unpropagated = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          externalOrderNumber: { not: null },
          state: { in: ['SYNCED', 'MERGED'] },
          order: {
            OR: [
              { status: { in: ['CANCELLED', 'ON_HOLD'] } },
              { status: { notIn: ['SHIPPED', 'COMPLETED', 'DELIVERED'] }, refundStatus: 'FULL' },
            ],
          },
        },
        select: { orderId: true, state: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
        take: Math.ceil(limit / 2),
        orderBy: [{ reconcileCheckedAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'desc' }],
      })

      // Tier 2 — propagated CANCELLED/HELD links within the window, never
      // checked at all, or carrying an OPEN finding (verifiable forever).
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const remaining = Math.max(0, limit - unpropagated.length)
      const propagated = remaining === 0 ? [] : await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          externalOrderNumber: { not: null },
          state: { in: ['CANCELLED', 'HELD'] },
          OR: [
            { cancelledAt: { gte: since } },
            { reconcileCheckedAt: null },
            { order: { wmsOrderDiscrepancies: { some: { category: 'ACTIVE_AFTER_CANCEL', status: 'OPEN' } } } },
          ],
        },
        select: { orderId: true, state: true, externalOrderNumber: true, order: { select: { orderNumber: true } } },
        take: remaining,
        orderBy: [{ reconcileCheckedAt: { sort: 'asc', nulls: 'first' } }, { cancelledAt: 'desc' }],
      })

      return [...unpropagated.flatMap(toRow), ...propagated.flatMap(toRow)]
    },
    fetchOrderStatus(orderNumber) {
      return connector.fetchOrderStatus ? connector.fetchOrderStatus(orderNumber) : Promise.resolve(null)
    },
    partsSupported: Boolean(connector.fetchOrderParts),
    fetchOrderParts(orderNumber) {
      return connector.fetchOrderParts ? connector.fetchOrderParts(orderNumber) : Promise.resolve([])
    },
    probeOrderPresence: connector.probeOrderPresence
      ? (orderNumber) => connector.probeOrderPresence!(orderNumber)
      : null,
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
  if (!connectorId) {
    // No connector: every open finding is unactionable and can never re-verify
    // (Codex r27 P2 — the connector-retirement pass below would otherwise be
    // unreachable, and the re-push refusal promises the next run retires them).
    await db.wmsOrderDiscrepancy.updateMany({
      where: { status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    })
    return { jobId: null, status: 'SKIPPED', counters: emptyCounters, skippedReason: 'No WMS connector enabled' }
  }
  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) {
    return { jobId: null, status: 'SKIPPED', counters: emptyCounters, skippedReason: 'Active WMS connector has no order-status support' }
  }

  const deps = options?.deps ?? createPrismaReconcileDeps(connectorId, connector)

  // Connector-switch retirement (Codex r13): findings created for a PREVIOUS
  // connector reference links this sweep never scans again — they could neither
  // re-verify clean nor be acted on. The active connector re-detects its own
  // drift fresh.
  await db.wmsOrderDiscrepancy.updateMany({
    where: { status: 'OPEN', connector: { not: connectorId } },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  })

  const job = await db.wmsSyncJob.create({
    data: { connector: connectorId, type: 'ORDER_RECONCILE', status: 'RUNNING', startedAt: new Date(), triggeredBy },
    select: { id: true },
  })

  let counters = emptyCounters
  try {
    const core = await runWmsOrderReconcileCore(deps, options)
    counters = core.counters

    // Stamp recency ONLY on links still in the state each check verified: a
    // concurrent push sweep may have cancelled/held (or re-created) a link
    // mid-run, deliberately nulling the stamp so the transition rotates to the
    // front — an unconditional overwrite here would undo that (Codex r10 P1).
    // Stamp ATTEMPTS, not verifications (Codex r19 P1): a persistently-failing
    // link must rotate to the back like any other, or `nulls: first` reselects
    // the same failing rows forever. Each stamp is conditional on the link
    // still holding its EXACT snapshot state (Codex r23 P2): any concurrent
    // transition — cancel, hold, merge repoint — deliberately nulls the stamp
    // so the changed link jumps the queue, and must never be overwritten.
    // Per-attempt CAS on state AND the exact WMS reference (Codex r24: a
    // MERGED→MERGED repoint keeps the state but swaps the reference — the old
    // lookup must not stamp the new survivor as checked). Bounded by the run's
    // lookup cap, so a per-row update loop is fine for a daily cron.
    const stampAt = new Date()
    for (const attempt of [...core.attemptedSynced, ...core.attemptedCancelled]) {
      await db.wmsOrderPushLink.updateMany({
        where: {
          orderId: attempt.orderId,
          state: attempt.linkState as never,
          externalOrderNumber: attempt.externalOrderNumber,
        },
        data: { reconcileCheckedAt: stampAt },
      })
    }

    // Revalidate the link state per finding first (Codex r10 P1): with the push
    // sweep running concurrently, a link snapshotted as SYNCED may have been
    // cancelled before its lookup — the null status is then EXPECTED, and a
    // MISSING_IN_WMS row recorded for it could never re-verify clean (check B
    // only rescans SYNCED/MERGED links).
    const EXPECTED_LINK_STATES: Record<WmsReconcileFindingCategory, string[] | null> = {
      NOT_PUSHED: null, // no link precondition; the resolution predicate self-heals races
      MISSING_IN_WMS: ['SYNCED', 'MERGED'],
      // Valid for propagated (CANCELLED/HELD) AND unpropagated (SYNCED/MERGED
      // with a cancelled/on-hold/refunded order — Codex r23) cancellations; the
      // state-scope cleanup below prunes rows that leave BOTH shapes.
      ACTIVE_AFTER_CANCEL: ['CANCELLED', 'HELD', 'SYNCED', 'MERGED'],
    }
    const findingLinks = new Map(
      (await db.wmsOrderPushLink.findMany({
        where: { orderId: { in: core.findings.map((finding) => finding.orderId) } },
        select: {
          orderId: true,
          state: true,
          externalOrderNumber: true,
          order: { select: { status: true, refundStatus: true } },
        },
      })).map((link) => [link.orderId, {
        state: link.state as string,
        externalOrderNumber: link.externalOrderNumber,
        orderStatus: link.order.status as string,
        refundStatus: link.order.refundStatus as string,
      }]),
    )
    const stillOughtToCancel = (link: { orderStatus: string; refundStatus: string }) => (
      ['CANCELLED', 'ON_HOLD'].includes(link.orderStatus)
      || (link.refundStatus === 'FULL' && !['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(link.orderStatus))
    )
    const validFindings = core.findings.filter((finding) => {
      const expected = EXPECTED_LINK_STATES[finding.category]
      if (!expected) return true
      const link = findingLinks.get(finding.orderId)
      if (!link || !expected.includes(link.state)) return false
      // The finding speaks about the reference that was LOOKED UP — a repoint
      // to a different WMS order (even same-state, Codex r24) invalidates it.
      if (finding.externalOrderNumber != null && finding.externalOrderNumber !== link.externalOrderNumber) return false
      // An unpropagated-shape ACTIVE_AFTER_CANCEL also requires the ORDER to
      // still want cancelling (Codex r29): a restore from CANCELLED/ON_HOLD (or
      // a refund reversal) mid-lookup would otherwise bell the admins for a
      // transient state the cleanup resolves moments later.
      if (
        finding.category === 'ACTIVE_AFTER_CANCEL'
        && ['SYNCED', 'MERGED'].includes(link.state)
        && !stillOughtToCancel(link)
      ) return false
      return true
    })

    // Run ledger (per-run history stays on the job) — valid findings only
    // (Codex r12: a race-invalidated finding must appear nowhere, ledger included).
    counters.findings = validFindings.length
    if (validFindings.length > 0) {
      await db.wmsSyncLog.createMany({
        data: validFindings.map((finding) => ({
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
    //
    const now = new Date()
    const newlyOpened: WmsReconcileFinding[] = []
    for (const finding of validFindings) {
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

    // Resolve B/C rows PER CATEGORY (Codex r8): each check only speaks for its
    // own category — an order found ACTIVE_AFTER_CANCEL this run still resolves
    // its old MISSING_IN_WMS row if check B verified it, and vice versa.
    // Keyed on validFindings (Codex r11): a finding dropped by the state
    // revalidation must not block resolving the order's existing open row.
    const foundKey = new Set(validFindings.map((finding) => `${finding.orderId}:${finding.category}`))
    // Resolutions are pinned to the reference THIS run verified clean (Codex
    // r25): an overlapping run may have re-opened the finding for a repointed
    // reference the clean lookup never saw — that row must survive. Bounded by
    // the run's lookup cap, so per-entry updates are fine for a daily cron.
    const resolveVerifiedClean = async (
      entries: Array<{ orderId: string; externalOrderNumber: string }>,
      category: string,
    ) => {
      for (const entry of entries) {
        if (foundKey.has(`${entry.orderId}:${category}`)) continue
        await db.wmsOrderDiscrepancy.updateMany({
          where: { orderId: entry.orderId, category, status: 'OPEN', externalOrderNumber: entry.externalOrderNumber },
          data: { status: 'RESOLVED', resolvedAt: now },
        })
      }
    }
    await resolveVerifiedClean(core.verifiedSynced, 'MISSING_IN_WMS')
    await resolveVerifiedClean(core.verifiedCancelled, 'ACTIVE_AFTER_CANCEL')

    // State-scope cleanup (Codex r11): an open B/C row whose link has LEFT the
    // category's state can never be rescanned by its check (B only walks
    // SYNCED/MERGED, C only CANCELLED/HELD) — the finding is moot in the new
    // state, which surfaces through its own flows. Resolve wholesale.
    await db.wmsOrderDiscrepancy.updateMany({
      where: {
        category: 'MISSING_IN_WMS',
        status: 'OPEN',
        // Mirror check B's FULL verification scope (Codex r28): a finding whose
        // order can never be rescanned — link left SYNCED/MERGED, dispatch
        // dead-lettered, order terminal/cancelled/on-hold/fully-refunded — is
        // moot; those states surface through their own flows.
        OR: [
          { order: { wmsOrderPush: { isNot: { state: { in: ['SYNCED', 'MERGED'] } } } } },
          { order: { wmsOrderPush: { is: { dispatchDeadLetteredAt: { not: null } } } } },
          { order: { status: { in: ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED', 'ON_HOLD'] } } },
          { order: { refundStatus: 'FULL' } },
        ],
      },
      data: { status: 'RESOLVED', resolvedAt: now },
    })
    await db.wmsOrderDiscrepancy.updateMany({
      where: {
        category: 'ACTIVE_AFTER_CANCEL',
        status: 'OPEN',
        // Moot only when NEITHER cancellation shape holds any more: not a
        // propagated CANCELLED/HELD link, and not an unpropagated SYNCED/MERGED
        // link whose order is still cancelled/on-hold/fully-refunded.
        order: {
          wmsOrderPush: { isNot: { state: { in: ['CANCELLED', 'HELD'] } } },
          NOT: {
            wmsOrderPush: { state: { in: ['SYNCED', 'MERGED'] } },
            OR: [
              { status: { in: ['CANCELLED', 'ON_HOLD'] } },
              { status: { notIn: ['SHIPPED', 'COMPLETED', 'DELIVERED'] }, refundStatus: 'FULL' },
            ],
          },
        },
      },
      data: { status: 'RESOLVED', resolvedAt: now },
    })

    // Resolve NOT_PUSHED rows whose drift predicate no longer holds — the order
    // gained a live link, or stopped being eligible. Re-evaluated per open row
    // (bounded set), never by absence from a capped scan.
    // Superseded references (Codex r28): resolutions pin the exact reference,
    // so an OPEN B/C row whose link now points at a DIFFERENT WMS order can
    // never re-verify — retire it; the new reference re-detects fresh if drift
    // persists. Chunked to stay under bind-parameter limits.
    for (let lastId = ''; ;) {
      const openRows = await db.wmsOrderDiscrepancy.findMany({
        where: {
          category: { in: ['MISSING_IN_WMS', 'ACTIVE_AFTER_CANCEL'] },
          status: 'OPEN',
          externalOrderNumber: { not: null },
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 500,
        select: { id: true, externalOrderNumber: true, order: { select: { wmsOrderPush: { select: { externalOrderNumber: true } } } } },
      })
      if (openRows.length === 0) break
      lastId = openRows[openRows.length - 1].id
      const supersededIds = openRows
        .filter((row) => row.order.wmsOrderPush && row.order.wmsOrderPush.externalOrderNumber !== row.externalOrderNumber)
        .map((row) => row.id)
      if (supersededIds.length > 0) {
        await db.wmsOrderDiscrepancy.updateMany({
          where: { id: { in: supersededIds } },
          data: { status: 'RESOLVED', resolvedAt: now },
        })
      }
      if (openRows.length < 500) break
    }

    // Chunked (Codex r18): the OPEN set is unbounded and detection can add up
    // to lookupLimit*5 rows per run — one giant `in` query would eventually
    // exceed Postgres's bind-parameter limit and permanently fail the cron.
    const RESOLUTION_CHUNK = 500
    // Same predicate as detection — including the bound-warehouse condition
    // (Codex: an order whose binding was disabled or that moved to an unbound
    // warehouse is out of WMS scope and must resolve, not linger).
    const resolutionBindings = await db.externalWmsBinding.findMany({
      where: { connector: connectorId, active: true, connection: { active: true } },
      select: { warehouseId: true },
    })
    // Plain id > lastId pagination (NOT Prisma cursor: resolving the cursor row
    // mid-walk would break cursor positioning on the filtered set).
    for (let lastId = ''; ;) {
      const openNotPushed = await db.wmsOrderDiscrepancy.findMany({
        where: { category: 'NOT_PUSHED', status: 'OPEN', ...(lastId ? { id: { gt: lastId } } : {}) },
        orderBy: { id: 'asc' },
        take: RESOLUTION_CHUNK,
        select: { id: true, orderId: true },
      })
      if (openNotPushed.length === 0) break
      lastId = openNotPushed[openNotPushed.length - 1].id
      await resolveNotPushedChunk(openNotPushed)
      if (openNotPushed.length < RESOLUTION_CHUNK) break
    }

    async function resolveNotPushedChunk(openNotPushed: Array<{ id: string; orderId: string }>) {
      const bindings = resolutionBindings
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
        matched: Math.max(0, counters.intentChecked + counters.linksVerified + counters.cancelledVerified - counters.findings - counters.errors),
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
