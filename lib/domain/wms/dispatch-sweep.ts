import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnector, WmsConnectorId, WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { applyExternalFulfillmentUpdate } from '@/lib/fulfillment/external-fulfillment'
import { notify } from '@/lib/notifications'
import { getSettingValue } from '@/lib/settings-store'
import { scrubWmsError } from './error-scrub'
import { recordWmsMutationEvent } from './mutation-audit'

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

/**
 * Inbound Order/List delta defaults (mirrors the woo-mintsoft Python plugin).
 * The delta hot-path fetches every order changed since a persisted watermark in
 * ONE bulk call and processes only those; a throttled full reconcile restores
 * the per-order poll so vanished/merged orders are still noticed.
 */
const DISPATCH_DELTA_DEFAULT_OVERLAP_SECONDS = 900
const DISPATCH_DELTA_DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60
const DISPATCH_DELTA_DEFAULT_RECONCILE_INTERVAL_SECONDS = 30 * 60
/**
 * Mintsoft compares SinceLastUpdated against LastUpdated in the tenant
 * DATABASE's timezone, NOT UTC (verified live: the tenant runs Europe/London,
 * so LastUpdated sits +1h under BST). The UTC cursor is converted into this
 * zone before it's formatted. Overridable per-tenant via the
 * `mintsoft_api_timezone` setting; `"UTC"` (or an invalid zone) disables the
 * conversion.
 */
export const DISPATCH_DELTA_DEFAULT_TIMEZONE = 'Europe/London'

/**
 * Format a UTC instant as a `YYYY-MM-DDTHH:MM:SS` wall-clock string in `timeZone`.
 * Intl handles the GMT/BST DST switch so the delta window is correct year-round.
 * A blank/`"UTC"`/invalid zone yields the UTC wall-clock (no conversion).
 */
export function formatCursorInTimeZone(instant: Date, timeZone?: string | null): string {
  const zone = timeZone && timeZone.trim() ? timeZone.trim() : 'UTC'
  const build = (tz: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(instant)

  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = build(zone)
  } catch {
    // Unknown/invalid IANA zone → send the cursor in UTC (no conversion).
    parts = build('UTC')
  }
  const pick = (type: Intl.DateTimeFormatPart['type']): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  // en-GB renders midnight as hour "24" in some runtimes — normalise to "00".
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}:${pick('second')}`
}

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
  // Inbound Order/List delta (o3d-bjc). Optional so a WMS without a bulk delta
  // (ShipHero) keeps per-order polling exactly as before. fetchDelta returns
  // every order changed since `sinceIso` (already in the tenant timezone) and
  // MUST throw on a truncated/failed delta so the sweep fails safe to a full
  // per-order reconcile. getDeltaState/saveDeltaState persist the watermark +
  // last-reconcile cursors (advanced only on a clean pass).
  fetchDelta?(sinceIso: string): Promise<import('@/lib/connectors/wms/types').WmsOrderStatus[]>
  getDeltaState?(): Promise<{ watermark: string | null; lastReconcile: string | null }>
  saveDeltaState?(state: { watermark?: string; lastReconcile?: string }): Promise<void>
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
  // When a delta row for this order is preloaded (Order/List hot-path), use it
  // instead of a per-order status fetch. `null`/omitted → fetch as before (the
  // caller passes null to force a fetch for an ambiguous split — see the core).
  preloaded?: WmsOrderStatus | null,
): Promise<{ action: 'dispatched' | 'pending' | 'error'; reason: string }> {
  const status = preloaded ?? (await deps.fetchOrderStatus(candidate.externalOrderNumber))
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
export type WmsDispatchSweepCoreOptions = {
  batchSize?: number
  /** Injected clock for deterministic cursor tests; defaults to now. */
  now?: Date
  /** Feature flag — when false, always per-order poll (behaves as pre-delta). */
  deltaEnabled?: boolean
  /** Tenant timezone the delta cursor is converted into before formatting. */
  deltaTimeZone?: string
  deltaOverlapSeconds?: number
  deltaLookbackSeconds?: number
  reconcileIntervalSeconds?: number
}

export async function runWmsDispatchSweepCore(
  deps: WmsDispatchSweepDeps,
  options?: WmsDispatchSweepCoreOptions,
): Promise<{ counters: WmsDispatchCounters; logs: WmsDispatchLog[] }> {
  const batchSize = options?.batchSize ?? DISPATCH_SWEEP_DEFAULT_BATCH_SIZE
  const now = options?.now ?? new Date()
  const counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }
  const logs: WmsDispatchLog[] = []

  // --- Inbound Order/List delta (o3d-bjc) ---------------------------------
  // Only engages when the connector supplies a bulk delta AND the flag is on.
  // deltaMap groups changed orders by their order number (a split shares one
  // number across several part-rows → a list). deltaFetched/ranReconcile gate
  // the clean-pass cursor advance; passClean holds it back on any error.
  const deltaActive = Boolean(deps.fetchDelta) && (options?.deltaEnabled ?? true)
  let deltaMap: Map<string, WmsOrderStatus[]> | null = null
  let reconcileDue = true
  let deltaFetched = false
  let ranReconcile = false
  let passClean = true

  if (deltaActive) {
    const state = deps.getDeltaState
      ? await deps.getDeltaState()
      : { watermark: null, lastReconcile: null }
    const overlapMs = (options?.deltaOverlapSeconds ?? DISPATCH_DELTA_DEFAULT_OVERLAP_SECONDS) * 1000
    const lookbackMs = (options?.deltaLookbackSeconds ?? DISPATCH_DELTA_DEFAULT_LOOKBACK_SECONDS) * 1000
    const intervalMs = (options?.reconcileIntervalSeconds ?? DISPATCH_DELTA_DEFAULT_RECONCILE_INTERVAL_SECONDS) * 1000

    const watermarkMs = state.watermark ? Date.parse(state.watermark) : NaN
    const baseMs = Number.isFinite(watermarkMs) ? watermarkMs : now.getTime() - lookbackMs
    // Bound the window so a watermark held back by a prior dirty pass can't let
    // the query window grow without limit.
    const sinceMs = Math.max(baseMs - overlapMs, now.getTime() - lookbackMs)
    const sinceIso = formatCursorInTimeZone(new Date(sinceMs), options?.deltaTimeZone ?? DISPATCH_DELTA_DEFAULT_TIMEZONE)

    try {
      const rows = await deps.fetchDelta!(sinceIso)
      deltaMap = new Map<string, WmsOrderStatus[]>()
      for (const row of rows) {
        const key = row.externalOrderNumber
        if (!key) continue
        const bucket = deltaMap.get(key)
        if (bucket) bucket.push(row)
        else deltaMap.set(key, [row])
      }
      deltaFetched = true
      const lastReconcileMs = state.lastReconcile ? Date.parse(state.lastReconcile) : NaN
      reconcileDue = !Number.isFinite(lastReconcileMs) || now.getTime() - lastReconcileMs >= intervalMs
    } catch (error) {
      // Fail SAFE: a fetch error must never masquerade as an empty delta that
      // would silently skip every order. Full per-order poll this run.
      console.error('[wms-dispatch-sweep] Order/List delta fetch failed — full per-order poll this run:', scrubWmsError(error, 'delta fetch error'))
      deltaMap = null
      reconcileDue = true
    }
  }

  const candidates = await deps.listCandidates(batchSize)
  for (const candidate of candidates) {
    // Resolve how to process this candidate: prefer the delta row (no per-order
    // call); else per-order poll on a reconcile tick; else skip an unchanged
    // order (no fetch, no counters, no failure bookkeeping).
    const deltaRows = deltaMap?.get(candidate.externalOrderNumber)
    let preload: WmsOrderStatus | null | undefined
    if (deltaMap && deltaRows && deltaRows.length > 0) {
      // A split shares one number across >1 rows — preloading a single row is
      // ambiguous, so force a fetch (which re-reads every part) by passing null.
      preload = deltaRows.length === 1 ? deltaRows[0] : null
    } else if (reconcileDue) {
      preload = undefined // legacy per-order fetch (not-found / merge detection)
      ranReconcile = true
    } else {
      continue
    }

    counters.totalChecked += 1

    // Reconcile first; the failure-tracking bookkeeping below runs OUTSIDE this
    // try/catch so a bookkeeping error can never count as another reconcile
    // failure (Codex: recordDispatchError throwing inside the catch would have
    // recursed into itself) nor abort the rest of the batch.
    let outcome: { action: 'dispatched' | 'pending' | 'error'; reason: string }
    try {
      outcome = await reconcileOneOrder(deps, candidate, preload)
    } catch (error) {
      outcome = { action: 'error', reason: scrubWmsError(error, 'WMS dispatch sweep error') }
    }
    // Any error holds the watermark back so a changed row can't age out of the
    // next window before it's applied.
    if (outcome.action === 'error') passClean = false
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

  // Advance the delta cursors only after a fully clean pass, so a Mintsoft/WC
  // blip can't age a changed row out of the next window before it's applied.
  //  - watermark: advance iff we fetched a delta this run (store UTC ISO);
  //  - lastReconcile: stamp iff the per-order reconcile pass ran, so a skipped
  //    reconcile re-runs next tick instead of waiting a full interval.
  if (deltaActive && passClean && deps.saveDeltaState && (deltaFetched || ranReconcile)) {
    const toSave: { watermark?: string; lastReconcile?: string } = {}
    if (deltaFetched) toSave.watermark = now.toISOString()
    if (ranReconcile) toSave.lastReconcile = now.toISOString()
    await deps.saveDeltaState(toSave)
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
    // Inbound Order/List delta (o3d-bjc). Only wired when the connector supports
    // a bulk delta; the watermark + last-reconcile cursors live in Setting keys.
    ...(connector.fetchOrderDelta
      ? {
          fetchDelta: (sinceIso: string) => connector.fetchOrderDelta!(sinceIso),
          async getDeltaState() {
            const rows = await db.setting.findMany({
              where: { key: { in: ['mintsoft_order_delta_since', 'mintsoft_order_reconcile_at'] } },
              select: { key: true, value: true },
            })
            const map = new Map(rows.map((row) => [row.key, row.value]))
            return {
              watermark: map.get('mintsoft_order_delta_since') || null,
              lastReconcile: map.get('mintsoft_order_reconcile_at') || null,
            }
          },
          async saveDeltaState(state: { watermark?: string; lastReconcile?: string }) {
            const writes: Array<Promise<unknown>> = []
            if (state.watermark !== undefined) {
              writes.push(db.setting.upsert({
                where: { key: 'mintsoft_order_delta_since' },
                create: { key: 'mintsoft_order_delta_since', value: state.watermark },
                update: { value: state.watermark },
              }))
            }
            if (state.lastReconcile !== undefined) {
              writes.push(db.setting.upsert({
                where: { key: 'mintsoft_order_reconcile_at' },
                create: { key: 'mintsoft_order_reconcile_at', value: state.lastReconcile },
                update: { value: state.lastReconcile },
              }))
            }
            await Promise.all(writes)
          },
        }
      : {}),
    async applyDispatch(orderId, tracking) {
      // q66in.4.6 audit timeline: capture the order status pre-image so the
      // dispatch event carries a real before/after, not just the target state.
      const orderBefore = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true, orderNumber: true } }).catch(() => null)
      const result = await applyExternalFulfillmentUpdate({
        source: connectorId,
        lookup: { orderId },
        targetShipmentStatus: 'SHIPPED',
        tracking,
      })
      if (result.success) {
        await recordWmsMutationEvent({
          connector: connectorId, direction: 'INBOUND', action: 'dispatch_applied', outcome: 'SUCCEEDED',
          entityType: 'SALES_ORDER', entityId: orderId,
          summary: `WMS despatch applied to order ${orderBefore?.orderNumber ?? orderId} — shipment marked SHIPPED`,
          before: { orderStatus: orderBefore?.status ?? null },
          after: { shipmentStatus: 'SHIPPED', tracking: tracking.map((entry) => ({ trackingNumber: entry.trackingNumber, shippingService: entry.shippingService ?? null })) },
          triggeredBy: 'dispatch-sweep',
        })
      }
      return result
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
          // The survivor is a DIFFERENT WMS order — reconcile recency resets too.
          reconcileCheckedAt: null,
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
      // Only touch rows with failure state — keeps the happy path write-free.
      // A success also clears dispatchDeadLetteredAt (Codex): an overlapping
      // sweep can dead-letter while THIS run successfully reconciles, and a
      // reconciled order must not linger as a false exception.
      await db.wmsOrderPushLink.updateMany({
        where: {
          id: linkId,
          OR: [
            { dispatchFailureCount: { gt: 0 } },
            { dispatchLastError: { not: null } },
            { dispatchDeadLetteredAt: { not: null } },
          ],
        },
        data: { dispatchFailureCount: 0, dispatchLastError: null, dispatchDeadLetteredAt: null },
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

  // Resolve the inbound Order/List delta config from settings (o3d-bjc). The
  // flag defaults ON; `mintsoft_inbound_delta_enabled === 'false'` turns it off
  // (behaves exactly as pre-delta). The cursor is sent in the tenant timezone.
  const [deltaEnabledSetting, deltaTimeZoneSetting] = await Promise.all([
    getSettingValue('mintsoft_inbound_delta_enabled'),
    getSettingValue('mintsoft_api_timezone'),
  ])
  const coreOptions: WmsDispatchSweepCoreOptions = {
    batchSize: options?.batchSize,
    deltaEnabled: deltaEnabledSetting !== 'false',
    deltaTimeZone: deltaTimeZoneSetting || DISPATCH_DELTA_DEFAULT_TIMEZONE,
  }

  const startedAt = new Date()
  const job = await db.wmsSyncJob.create({
    data: { connector: connectorId, type: 'DISPATCH_SYNC', status: 'RUNNING', startedAt, triggeredBy },
    select: { id: true },
  })

  // Hoisted so a failure during persistence still reports the work the core did.
  let counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }

  try {
    const core = await runWmsDispatchSweepCore(deps, coreOptions)
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
