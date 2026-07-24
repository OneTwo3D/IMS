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

/**
 * Job-outcome mapping (o3d-bjc finding 3a): a delta-fetch failure is a degraded
 * PRIMARY path — the sweep fell back to a bounded per-order reconcile, so it must
 * count as an error and mark the job PARTIAL rather than let a broken delta hide
 * behind a SUCCEEDED / zero-error job. Pure so it's unit-testable.
 */
export function resolveDispatchJobOutcome(
  errors: number,
  deltaError: string | null,
): { status: 'SUCCEEDED' | 'PARTIAL'; effectiveErrors: number } {
  const effectiveErrors = errors + (deltaError ? 1 : 0)
  return { status: effectiveErrors > 0 ? 'PARTIAL' : 'SUCCEEDED', effectiveErrors }
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
  /**
   * The WMS's own STABLE order id for this link (wmsOrderPushLink.externalOrderId).
   * Order NUMBERS are not schema-unique (reused / edited / split across channels),
   * so the delta pass joins a changed delta row to a local link by this id — never
   * by number alone, which could apply one dispatched row to several local orders.
   * May be null on a legacy link whose id was never captured; such a link can't be
   * safely matched from the bulk delta and is left to the per-order reconcile.
   */
  externalOrderId?: string | null
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
  // Active links (same eligibility as listCandidates) whose STABLE
  // externalOrderId is in the given set. This is the primary delta candidate
  // lookup: order numbers can be renamed while the Mintsoft ID remains stable.
  // Optional for connector/test compatibility; without it the sweep falls back
  // to the bounded candidate batch and conservatively holds the watermark when
  // that batch may be incomplete.
  listActiveByExternalOrderIds?(externalOrderIds: string[]): Promise<WmsDispatchCandidate[]>
  // Secondary split-only lookup. A split shares one order number across several
  // part IDs, so the changed delta part ID may differ from the ID stored on the
  // link. The delta pass uses this only for numbers identified as split, then
  // forces an authoritative per-order fetch rather than trusting a number join.
  listActiveByOrderNumbers?(orderNumbers: string[]): Promise<WmsDispatchCandidate[]>
  // o3d-bjc reconcile rotation: the throttled per-order reconcile batch, ordered
  // least-recently-verified first (dispatchReconcileCheckedAt asc NULLS FIRST,
  // then pushedAt asc). Without it the sweep falls back to listCandidates, which
  // is pushedAt-only and re-polls the same oldest batch every tick — links beyond
  // `batchSize` never get their not-found/merge check (Codex round 2).
  listReconcileCandidates?(limit: number): Promise<WmsDispatchCandidate[]>
  // Stamp dispatchReconcileCheckedAt for every link verified this run (delta OR
  // reconcile), so a verified link rotates to the back and un-verified links
  // surface next tick. No-op when unset (keeps pre-rotation behaviour for tests /
  // connectors that don't wire it).
  markReconcileChecked?(linkIds: string[], checkedAt: Date): Promise<void>
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
  // A split-only number lookup is a candidate-enumeration hint, not a join.
  // Require its authoritative primary row to echo the link's stable ID before
  // applying anything, so a reused/colliding number cannot dispatch this link.
  expectedExternalOrderId?: string,
): Promise<{ action: 'dispatched' | 'pending' | 'error'; reason: string }> {
  const status = preloaded ?? (await deps.fetchOrderStatus(candidate.externalOrderNumber))
  if (!status) {
    return { action: 'pending', reason: 'Order not found in the WMS' }
  }
  if (expectedExternalOrderId && status.externalOrderId !== expectedExternalOrderId) {
    return {
      action: 'pending',
      reason: `Order-number lookup returned stable ID ${status.externalOrderId || 'unknown'}; expected ${expectedExternalOrderId}`,
    }
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
): Promise<{ counters: WmsDispatchCounters; logs: WmsDispatchLog[]; deltaError: string | null }> {
  const batchSize = options?.batchSize ?? DISPATCH_SWEEP_DEFAULT_BATCH_SIZE
  const now = options?.now ?? new Date()
  const counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }
  const logs: WmsDispatchLog[] = []

  // --- Inbound Order/List delta (o3d-bjc) ---------------------------------
  // Only engages when the connector supplies a bulk delta AND the flag is on.
  // deltaById keys changed orders by their STABLE externalOrderId (order numbers
  // aren't unique); deltaByNumber is a secondary index used only to preserve
  // split coverage and detect a shared number that must not be preloaded.
  // deltaFetched/ranReconcile gate the clean-pass cursor advance; passClean
  // holds it back on any error.
  const deltaActive = Boolean(deps.fetchDelta) && (options?.deltaEnabled ?? true)
  let deltaById: Map<string, WmsOrderStatus> | null = null
  let deltaByNumber: Map<string, WmsOrderStatus[]> | null = null
  let reconcileDue = true
  let deltaFetched = false
  let ranReconcile = false
  let passClean = true
  // Set when the delta fetch fails: the sweep still fails safe to the per-order
  // reconcile, but the failure is surfaced (job PARTIAL + errors) so a broken
  // primary path can't hide behind a SUCCEEDED job.
  let deltaError: string | null = null

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
      deltaById = new Map<string, WmsOrderStatus>()
      deltaByNumber = new Map<string, WmsOrderStatus[]>()
      for (const row of rows) {
        if (row.externalOrderId) deltaById.set(row.externalOrderId, row)
        const number = row.externalOrderNumber
        if (number) {
          const bucket = deltaByNumber.get(number)
          if (bucket) bucket.push(row)
          else deltaByNumber.set(number, [row])
        }
      }
      deltaFetched = true
      const lastReconcileMs = state.lastReconcile ? Date.parse(state.lastReconcile) : NaN
      reconcileDue = !Number.isFinite(lastReconcileMs) || now.getTime() - lastReconcileMs >= intervalMs
    } catch (error) {
      // Fail SAFE: a fetch error must never masquerade as an empty delta that
      // would silently skip every order. Full per-order poll this run — AND
      // surface the failure so the job reports it (finding 3a).
      deltaError = scrubWmsError(error, 'delta fetch error')
      console.error('[wms-dispatch-sweep] Order/List delta fetch failed — full per-order poll this run:', deltaError)
      deltaById = null
      deltaByNumber = null
      reconcileDue = true
    }
  }

  // Reconcile one candidate + do its failure-tracking bookkeeping. The
  // bookkeeping runs OUTSIDE the reconcile try/catch so a bookkeeping error can
  // never count as another reconcile failure (Codex: recordDispatchError
  // throwing inside the catch would have recursed into itself) nor abort the
  // rest of the pass.
  const processOne = async (
    candidate: WmsDispatchCandidate,
    preload: WmsOrderStatus | null | undefined,
    expectedExternalOrderId?: string,
  ) => {
    counters.totalChecked += 1

    let outcome: { action: 'dispatched' | 'pending' | 'error'; reason: string }
    try {
      outcome = await reconcileOneOrder(deps, candidate, preload, expectedExternalOrderId)
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

  const processedLinkIds = new Set<string>()
  // Whether the delta pass examined EVERY active link the delta touched. Only
  // then is advancing the watermark safe — otherwise a changed order beyond the
  // reconcile batch would be skipped yet aged out of the next window.
  let deltaCoverageComplete = true

  // --- Delta pass: reconcile every active link whose order changed since the
  // watermark. Coverage MUST span the whole delta, not just the reconcile batch.
  // Enumerate by STABLE externalOrderId so a Mintsoft order-number rename cannot
  // hide a linked order. A split-only number lookup supplements it because the
  // changed part ID may be a sibling of the part ID stored on the local link.
  if (deltaById && deltaByNumber && deltaById.size > 0) {
    const changedIds = [...deltaById.keys()]
    let deltaCandidates: WmsDispatchCandidate[]
    if (deps.listActiveByExternalOrderIds) {
      deltaCandidates = await deps.listActiveByExternalOrderIds(changedIds)
    } else {
      const batch = await deps.listCandidates(batchSize)
      // A full batch means there may be active links we never saw — hold the
      // watermark so an out-of-batch changed order isn't aged out.
      deltaCoverageComplete = batch.length < batchSize
      deltaCandidates = batch
    }

    const splitNumbers = [...deltaByNumber.entries()]
      .filter(([, rows]) =>
        rows.length > 1 || rows.some((row) => row.isSplit || (row.partCount ?? 1) > 1),
      )
      .map(([number]) => number)
    if (splitNumbers.length > 0) {
      if (deps.listActiveByOrderNumbers) {
        const splitCandidates = await deps.listActiveByOrderNumbers(splitNumbers)
        const seen = new Set(deltaCandidates.map((candidate) => candidate.linkId))
        for (const candidate of splitCandidates) {
          if (!seen.has(candidate.linkId)) {
            deltaCandidates.push(candidate)
            seen.add(candidate.linkId)
          }
        }
      } else {
        // Stable IDs alone cannot prove split coverage: the changed sibling part
        // may not be the ID stored on the link. Keep the watermark until a later
        // run can enumerate that shared-number group.
        deltaCoverageComplete = false
      }
    }

    for (const candidate of deltaCandidates) {
      // Stable-id join is authoritative. A candidate without one is eligible
      // only through the split-only number lookup and is always force-fetched.
      const idRow = candidate.externalOrderId ? deltaById.get(candidate.externalOrderId) : undefined
      const candidateRows = deltaByNumber.get(candidate.externalOrderNumber)
      const splitByNumber = candidateRows?.some((row) => row.isSplit || (row.partCount ?? 1) > 1)
        || (candidateRows?.length ?? 0) > 1
      if (!idRow && !splitByNumber) continue
      if (!idRow && !candidate.externalOrderId) continue

      const idRows = idRow ? deltaByNumber.get(idRow.externalOrderNumber) : undefined
      const idIsSplit = idRow
        ? idRow.isSplit || (idRow.partCount ?? 1) > 1 || (idRows?.length ?? 0) > 1
        : false
      // A renamed, non-split order is safe to preload by stable ID even though
      // the local number is stale. Splits must be re-read authoritatively so all
      // sibling parts are enumerated; use the delta's current number on an ID
      // match so a renamed split is fetched under its new reference.
      const effectiveCandidate = idRow && idIsSplit && idRow.externalOrderNumber
        ? { ...candidate, externalOrderNumber: idRow.externalOrderNumber }
        : candidate
      const preload = idRow && !idIsSplit ? idRow : null
      await processOne(
        effectiveCandidate,
        preload,
        idRow ? undefined : candidate.externalOrderId ?? undefined,
      )
      processedLinkIds.add(candidate.linkId)
    }
  }

  // --- Throttled reconcile pass: per-order poll a batch of active links to catch
  // not-found strikes + merge detection (orders absent from the delta). This is
  // also the SOLE pass when the delta is inactive/failed (deltaById is null).
  //
  // Rotation (o3d-bjc Codex round 2): the batch is ordered least-recently-verified
  // first (dispatchReconcileCheckedAt NULLS FIRST, then pushedAt) so links beyond
  // the first `batchSize` are not starved — a persistent backlog rotates through
  // the whole active set instead of re-polling the same oldest orders forever.
  if (reconcileDue) {
    ranReconcile = true
    const candidates = deps.listReconcileCandidates
      ? await deps.listReconcileCandidates(batchSize)
      : await deps.listCandidates(batchSize)
    for (const candidate of candidates) {
      if (processedLinkIds.has(candidate.linkId)) continue // already handled from the delta
      await processOne(candidate, undefined) // legacy per-order fetch
      processedLinkIds.add(candidate.linkId)
    }
  }

  // Stamp the reconcile-recency cursor for EVERY link we verified this run (delta
  // preload or per-order reconcile). A verified link rotates to the back; links
  // never verified (NULL) always sort first, so the reconcile pass drains the
  // whole active set over successive ticks even when the delta keeps re-covering
  // the oldest orders. Best-effort — a stamp failure just delays rotation.
  if (processedLinkIds.size > 0 && deps.markReconcileChecked) {
    try {
      await deps.markReconcileChecked([...processedLinkIds], now)
    } catch (stampError) {
      console.error('[wms-dispatch-sweep] reconcile-recency stamp failed:', stampError)
    }
  }

  // Advance the delta cursors only after a fully clean, fully covered pass, so a
  // Mintsoft/WC blip (or a batch-truncated delta pass) can't age a changed row
  // out of the next window before it's applied.
  //  - watermark: advance iff we fetched a delta this run (store UTC ISO);
  //  - lastReconcile: stamp iff the per-order reconcile pass ran, so a skipped
  //    reconcile re-runs next tick instead of waiting a full interval.
  if (deltaActive && passClean && deps.saveDeltaState) {
    const toSave: { watermark?: string; lastReconcile?: string } = {}
    // Watermark advances only when the delta pass covered EVERY changed link
    // (deltaCoverageComplete) — else a changed order beyond the batch would be
    // aged out. lastReconcile just tracks the per-order reconcile cadence.
    if (deltaFetched && deltaCoverageComplete) toSave.watermark = now.toISOString()
    if (ranReconcile) toSave.lastReconcile = now.toISOString()
    if (toSave.watermark !== undefined || toSave.lastReconcile !== undefined) {
      await deps.saveDeltaState(toSave)
    }
  }

  return { counters, logs, deltaError }
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
        select: { id: true, orderId: true, externalOrderNumber: true, externalOrderId: true },
        take: limit,
        orderBy: { pushedAt: 'asc' },
      })
      return rows.flatMap((row) =>
        row.externalOrderNumber
          ? [{ linkId: row.id, orderId: row.orderId, externalOrderNumber: row.externalOrderNumber, externalOrderId: row.externalOrderId }]
          : [],
      )
    },
    // Same eligibility as listCandidates but scoped to STABLE Mintsoft ids and
    // UNBOUNDED — a mutable order-number rename must not hide a changed link.
    // Chunked so a large delta stays within a sane IN() size.
    async listActiveByExternalOrderIds(externalOrderIds) {
      const unique = [...new Set(externalOrderIds.filter((id): id is string => Boolean(id)))]
      if (unique.length === 0) return []
      const CHUNK = 200
      const out: WmsDispatchCandidate[] = []
      for (let i = 0; i < unique.length; i += CHUNK) {
        const rows = await db.wmsOrderPushLink.findMany({
          where: {
            connector: connectorId,
            state: { in: ['SYNCED', 'MERGED'] },
            externalOrderId: { in: unique.slice(i, i + CHUNK) },
            externalOrderNumber: { not: null },
            dispatchDeadLetteredAt: null,
            order: { status: { notIn: [...POST_DISPATCH_STATUSES] } },
          },
          select: { id: true, orderId: true, externalOrderNumber: true, externalOrderId: true },
        })
        for (const row of rows) {
          if (row.externalOrderNumber) {
            out.push({ linkId: row.id, orderId: row.orderId, externalOrderNumber: row.externalOrderNumber, externalOrderId: row.externalOrderId })
          }
        }
      }
      return out
    },
    // Split supplement: a changed sibling part can have a different stable ID
    // from the one stored on the link, while all parts share an order number.
    async listActiveByOrderNumbers(orderNumbers) {
      const unique = [...new Set(orderNumbers.filter((n): n is string => Boolean(n)))]
      if (unique.length === 0) return []
      const CHUNK = 200
      const out: WmsDispatchCandidate[] = []
      for (let i = 0; i < unique.length; i += CHUNK) {
        const rows = await db.wmsOrderPushLink.findMany({
          where: {
            connector: connectorId,
            state: { in: ['SYNCED', 'MERGED'] },
            externalOrderNumber: { in: unique.slice(i, i + CHUNK) },
            dispatchDeadLetteredAt: null,
            order: { status: { notIn: [...POST_DISPATCH_STATUSES] } },
          },
          select: { id: true, orderId: true, externalOrderNumber: true, externalOrderId: true },
        })
        for (const row of rows) {
          if (row.externalOrderNumber) {
            out.push({ linkId: row.id, orderId: row.orderId, externalOrderNumber: row.externalOrderNumber, externalOrderId: row.externalOrderId })
          }
        }
      }
      return out
    },
    // o3d-bjc reconcile rotation: same eligibility as listCandidates, but ordered
    // least-recently-verified first (dispatchReconcileCheckedAt asc NULLS FIRST,
    // then pushedAt asc) so the capped reconcile pass rotates through the whole
    // active set instead of re-polling the oldest `batchSize` every tick.
    async listReconcileCandidates(limit) {
      const rows = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          state: { in: ['SYNCED', 'MERGED'] },
          externalOrderNumber: { not: null },
          dispatchDeadLetteredAt: null,
          order: { status: { notIn: [...POST_DISPATCH_STATUSES] } },
        },
        select: { id: true, orderId: true, externalOrderNumber: true, externalOrderId: true },
        take: limit,
        orderBy: [{ dispatchReconcileCheckedAt: { sort: 'asc', nulls: 'first' } }, { pushedAt: 'asc' }],
      })
      return rows.flatMap((row) =>
        row.externalOrderNumber
          ? [{ linkId: row.id, orderId: row.orderId, externalOrderNumber: row.externalOrderNumber, externalOrderId: row.externalOrderId }]
          : [],
      )
    },
    async markReconcileChecked(linkIds, checkedAt) {
      if (linkIds.length === 0) return
      await db.wmsOrderPushLink.updateMany({
        where: { id: { in: linkIds } },
        data: { dispatchReconcileCheckedAt: checkedAt },
      })
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
  const [deltaEnabledSetting, deltaTimeZoneSetting, deltaClientIdSetting] = await Promise.all([
    getSettingValue('mintsoft_inbound_delta_enabled'),
    getSettingValue('mintsoft_api_timezone'),
    getSettingValue('mintsoft_client_id'),
  ])
  // FAIL CLOSED: the Mintsoft inbound delta returns EVERY client's orders on the
  // shared 3PL tenant unless it's scoped by our ClientId — an order-number
  // collision could otherwise mark OUR order shipped off a FOREIGN despatch.
  // Without a valid, positive mintsoft_client_id we keep the delta INERT (never
  // call it) and fall back to the per-order reconcile (unchanged pre-delta
  // behaviour). Only Mintsoft carries this scope; other WMS connectors have no
  // delta wired, so this gate is a no-op for them. (Mirrors parseMintsoftPositiveId.)
  const clientIdRaw = (deltaClientIdSetting ?? '').trim()
  const clientScoped = connectorId !== 'mintsoft'
    || (/^\d+$/.test(clientIdRaw) && Number.parseInt(clientIdRaw, 10) > 0)
  const coreOptions: WmsDispatchSweepCoreOptions = {
    batchSize: options?.batchSize,
    deltaEnabled: deltaEnabledSetting !== 'false' && clientScoped,
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
    const { logs, deltaError } = core

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

    // Finding 3a: a delta-fetch failure degrades the PRIMARY inbound path — the
    // sweep fell back to a per-order reconcile of a bounded (rotating) batch, so
    // newer dispatched orders may lag until the backlog rotates through. Surface
    // it: mark the job PARTIAL, count it as an error, and log a distinct row so a
    // persistent delta outage can't hide behind a SUCCEEDED/zero-error job.
    if (deltaError) {
      await db.wmsSyncLog.create({
        data: {
          jobId: job.id,
          sku: null,
          productId: null,
          action: 'error',
          reason: `Inbound Order/List delta fetch failed — fell back to the per-order reconcile this run: ${deltaError}`,
          payload: { deltaFailure: true, connector: connectorId } as Prisma.InputJsonValue,
        },
      })
    }

    const { status, effectiveErrors } = resolveDispatchJobOutcome(counters.errors, deltaError)
    await db.wmsSyncJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        totalChecked: counters.totalChecked,
        matched: counters.dispatched,
        mismatched: counters.pending,
        corrected: counters.dispatched,
        errors: effectiveErrors,
      },
    })

    if (counters.dispatched > 0 || effectiveErrors > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: deltaError ? 'wms_dispatch_sync_degraded' : 'wms_dispatch_sync',
        level: deltaError ? 'WARNING' : undefined,
        description: deltaError
          ? `WMS dispatch sync (${connectorId}) DEGRADED — inbound delta failed, ran per-order reconcile fallback: ${counters.totalChecked} checked, ${counters.dispatched} dispatched, ${counters.errors} order errors. Delta error: ${deltaError}`
          : `WMS dispatch sync (${connectorId}): ${counters.totalChecked} checked, ${counters.dispatched} dispatched, ${counters.errors} errors.`,
        metadata: { jobId: job.id, connector: connectorId, deltaError: deltaError ?? undefined, ...counters },
        resolveUser: false,
      })
    }

    return { jobId: job.id, status, totalChecked: counters.totalChecked, dispatched: counters.dispatched, pending: counters.pending, errors: effectiveErrors }
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
