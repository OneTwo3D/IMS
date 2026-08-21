import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import {
  MINTSOFT_DELTA_GENERATION_KEY,
  decodeMintsoftDeltaCursor,
  encodeMintsoftDeltaCursor,
  mintsoftDeltaScopeToken,
  nextMintsoftDeltaGeneration,
  parseMintsoftDeltaGeneration,
  type MintsoftDeltaScope,
} from '@/lib/connectors/mintsoft/settings/schema'
import {
  lockMintsoftDispatchSettings,
  type MintsoftDispatchSettingsLockTx,
} from '@/lib/connectors/mintsoft/settings/dispatch-settings-lock'
import type { WmsConnector, WmsConnectorId, WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { isWmsUnresolvableRecordError } from '@/lib/connectors/wms/errors'
import { withDispatchSweepLockOrSkip } from '@/lib/domain/wms/dispatch-sweep-lock'
// o3d-rbyg r4: the identity rule lives in its own module so the operator remedy in
// `app/actions/sync-exceptions.ts` can apply THE SAME ONE without importing the sweep's world.
import { bindWmsStatusToCandidate } from '@/lib/domain/wms/status-binding'
export { bindWmsStatusToCandidate } from '@/lib/domain/wms/status-binding'
export type { WmsStatusBinding } from '@/lib/domain/wms/status-binding'
import { unresolvedDriftStateKey } from '@/lib/domain/wms/unresolved-drift'
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
/**
 * Statuses past the point a dispatch sweep cares about. Exported (o3d-bjc.12)
 * because the operator's isolate action must apply the SAME eligibility the
 * sweep does — a link that shipped since the incident was recorded is no longer
 * a dispatch candidate and must not be quarantined as if it were.
 */
export const POST_DISPATCH_STATUSES = ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] as const

/**
 * What makes a link a dispatch candidate — the ONE definition (o3d-0gzr).
 *
 * The operator-facing isolate path has to quarantine exactly the set the sweep
 * would have, so it must ask the same question. It used to ask a hand-copied
 * version of it: equal at the time, and free to drift apart afterwards, since
 * nothing failed if one side gained a state the other did not. Both sides now
 * call this, so a change to eligibility is a change to both by construction.
 */
/**
 * o3d-rbyg: this is HALF the eligibility. The withdrawal fence is the other half, and it cannot
 * live in this clause — see `screenWithdrawnOrders` in the core. A link parked by that fence sets
 * `dispatchDeadLetteredAt`, which IS excluded here, so the exclusion is durable once it has fired.
 */
export function dispatchCandidateWhere(connectorId: string) {
  return {
    connector: connectorId,
    // MERGED links are repointed-to-survivor orders that still need despatch
    // tracking; the push-sweep skips them (SYNCED-only) so they aren't re-pushed.
    state: { in: ['SYNCED' as const, 'MERGED' as const] },
    externalOrderNumber: { not: null },
    // 6oyu.2: dead-lettered links stop re-erroring every sweep; an operator
    // replays them from the exception inbox once the cause is fixed.
    dispatchDeadLetteredAt: null,
    // o3d-bjc.9: a QUARANTINED link is out of the sweep for the same reason a
    // dead-lettered one is — its record cannot be read, so re-polling it every
    // tick only pins the watermark. It comes back when an operator acts.
    dispatchUnresolvedAt: null,
    order: { status: { notIn: [...POST_DISPATCH_STATUSES] } },
  }
}

/**
 * 6oyu.2: consecutive per-order reconcile failures before the link is
 * dead-lettered out of the sweep. Five failures ≈ five sweep cycles — enough
 * for transient WMS/API wobbles to clear, short enough that a genuinely stuck
 * order (typically dispatched-but-no-IMS-stock) stops re-erroring forever and
 * surfaces in the exception inbox instead.
 */
export const DISPATCH_MAX_CONSECUTIVE_FAILURES = 5

/**
 * o3d-bjc.12: what the sweep knows about an ongoing drift, persisted so an
 * OPERATOR can act on it.
 *
 * The sweep will not mass-quarantine a cohort it cannot prove is record-local —
 * that decision belongs to a human — but a decision nobody can see is not a
 * decision offered. This is the evidence behind the offer: who is stuck, since
 * when, how long it has been going on, and what the failure actually said.
 */
export type WmsUnresolvedDriftState = {
  consecutive: number
  cohortKey: string | null
  stableFor: number
  /** When this cohort was FIRST seen (ISO). Null while there is no drift. */
  firstSeenAt?: string | null
  /** The links in the cohort, so the operator's "isolate these" acts on THIS set. */
  linkIds?: string[]
  /** How many links the pass decided an outcome for — the ratio's denominator. */
  touched?: number
  /** A sample of what the WMS actually said, so the offer shows the defect. */
  reason?: string | null
  /**
   * When the sweep last RE-CONFIRMED this drift (ISO). The operator-facing offer
   * expires on it: a clear that fails to persist would otherwise leave an
   * incident inviting someone to quarantine orders the sweep has since read
   * perfectly well.
   */
  lastSeenAt?: string | null
}

/** Pure dead-letter decision so the threshold semantics are unit-testable. */
export function shouldDeadLetterDispatch(failureCount: number, deadLetteredAt: Date | null): boolean {
  return failureCount >= DISPATCH_MAX_CONSECUTIVE_FAILURES && !deadLetteredAt
}

/**
 * o3d-bjc.9: how many CONSECUTIVE unresolved reads quarantine one link.
 *
 * An unresolved read is not a failure — the WMS answered — so it deliberately
 * does not touch dispatchFailureCount and cannot dead-letter the link. But
 * "never isolate it" is the other extreme, and that is where this sweep sat: an
 * order whose record is permanently unreadable never reaches the exception
 * inbox, keeps passClean false on every tick, and so pins the delta watermark
 * indefinitely. Once the window clamps, deltaWindowTruncated blocks the advance
 * and truncation recovery cannot fire either (recovery needs a fully clean,
 * fully covered pass, which this link fails every time) — the delta stays
 * degraded on the per-order fallback for as long as the record exists.
 */
export const DISPATCH_MAX_CONSECUTIVE_UNRESOLVED = 5

/**
 * ...and the other side of it: how many links must be unresolved AT ONCE before
 * the pass is read as connector-wide drift rather than N broken records.
 *
 * A vocabulary change, a schema change or a degraded endpoint makes every
 * record unreadable simultaneously. Quarantining them one at a time would
 * isolate the whole tenant, each with its own alert, and demand a manual
 * release after the dependency recovers — the mass-dead-letter outcome an
 * earlier strike-based attempt produced here, and the reason it was reverted.
 *
 * Both a floor AND a ratio, because either alone misfires: the ratio calls a
 * quiet tick with one failing order systemic; the floor calls three broken
 * records in a busy tenant systemic. Mirrors the Python sweep's
 * MINTSOFT_SYSTEMIC_FAILURE_MIN_ORDERS / _RATIO so the two halves of this epic
 * classify the same event the same way.
 */
export const DISPATCH_UNRESOLVED_SYSTEMIC_MIN_LINKS = 3
export const DISPATCH_UNRESOLVED_SYSTEMIC_RATIO = 0.5

/** How many healthy links to read as a control when the cohort looks systemic. */
export const DISPATCH_UNRESOLVED_CONTROL_PROBES = 3

/**
 * Is this pass's unresolved cohort connector-wide drift, or N broken records?
 * Pure so the threshold semantics are unit-testable without a sweep harness.
 */
export function isUnresolvedDriftSystemic(unresolvedLinks: number, linksTouched: number): boolean {
  if (unresolvedLinks < DISPATCH_UNRESOLVED_SYSTEMIC_MIN_LINKS) return false
  return unresolvedLinks / Math.max(1, linksTouched) >= DISPATCH_UNRESOLVED_SYSTEMIC_RATIO
}

/**
 * Round-5 #3: on the shared Mintsoft tenant every per-order lookup (Search /
 * detail / parts) requires a ClientId and throws without one — so an unscoped
 * Mintsoft dispatch sweep can only fail every candidate and dead-letter every
 * link. This gate lets the wrapper SKIP the whole run instead. A positive
 * integer `mintsoft_client_id` is required; other WMS connectors carry no such
 * scope and are always considered scoped.
 */
export function isDispatchClientScoped(connectorId: string, clientIdRaw: string | null | undefined): boolean {
  if (connectorId !== 'mintsoft') return true
  const raw = (clientIdRaw ?? '').trim()
  return /^\d+$/.test(raw) && Number.parseInt(raw, 10) > 0
}

/**
 * Job-outcome mapping (o3d-bjc finding 3a): a delta-fetch failure is a degraded
 * PRIMARY path — the sweep fell back to a bounded per-order reconcile, so it must
 * count as an error and mark the job PARTIAL rather than let a broken delta hide
 * behind a SUCCEEDED / zero-error job. Pure so it's unit-testable.
 */
/**
 * Per-sweep budget for the stable-ID split probe (o3d-bjc.5). Each probe is one
 * fetchOrderParts + one link query, run only for split groups the cheap indexes
 * missed, so in practice it fires rarely. The cap exists because a cold window
 * with many unlinked split groups would otherwise storm Order/Search
 * sequentially with no bound.
 */
export const SPLIT_PROBE_BUDGET_PER_SWEEP = 25

/**
 * Validate that a WMS part set is ONE coherent split group before anything is
 * trusted to it.
 *
 * Order numbers are not unique — not even within our own client — so a part set
 * fetched by number can silently be two different splits stapled together. Any
 * ambiguity here has to mean "do not use it", because the caller goes on to
 * enumerate links by these ids and then dispatch against them: a wrong group
 * would push one order's parts onto another's, which is far worse than the
 * aging-out this probe exists to prevent.
 *
 * Returns the part ids when the set is coherent, or null when it is not:
 *   - no parts at all;
 *   - a duplicate part NUMBER (two records claiming to be part 2);
 *   - a duplicate external id;
 *   - a count that disagrees with the delta row's own partCount;
 *   - a missing/blank external id on any part.
 */
export function coherentSplitPartIds(
  parts: import('@/lib/connectors/wms/types').WmsOrderPart[],
  expectedPartCount: number | null,
): string[] | null {
  if (!Array.isArray(parts) || parts.length === 0) return null

  const ids = new Set<string>()
  const numbers = new Set<number>()
  for (const part of parts) {
    const id = String(part?.externalId ?? '').trim()
    const num = Number(part?.partNumber)
    if (!id || !Number.isInteger(num) || num < 1) return null
    if (ids.has(id) || numbers.has(num)) return null
    ids.add(id)
    numbers.add(num)
  }

  // The delta row tells us how many parts the split has. A set that disagrees is
  // either incomplete or contaminated by another split sharing the number.
  if (expectedPartCount != null && expectedPartCount > 0 && ids.size !== expectedPartCount) {
    return null
  }

  return [...ids]
}

export function resolveDispatchJobOutcome(
  errors: number,
  deltaError: string | null,
  // Codex round 7: an order whose dispatch state could NOT be established, and a
  // delta window clamped so it can't cover its own backlog, are both degraded
  // states that must not hide behind a SUCCEEDED / zero-error job. They are
  // counted for the job outcome but deliberately never dead-letter a link.
  //
  // deltaCoverageIncomplete (o3d-bjc.5) belongs here for the same reason: when
  // the sweep cannot prove it enumerated every changed order — a full candidate
  // batch, or a shared-number/split group it could not resolve — it PINS the
  // watermark. That is the correct safe behaviour, but it was invisible: the
  // job still reported SUCCEEDED with zero errors while the delta made no
  // forward progress, so a pinned watermark could repeat every sweep
  // indefinitely with nothing to alert on.
  //
  // o3d-rbyg round 2: withdrawalScreenFailures joins them. A screen the sweep cannot read now
  // DEFERS every candidate in that list rather than shipping it, which is the safe answer — and a
  // safe answer repeated every tick is a warehouse that has quietly stopped reconciling. It must
  // be visible from the job, not only from a console line.
  degraded?: {
    unresolved?: number
    deltaWindowTruncated?: boolean
    deltaCoverageIncomplete?: boolean
    withdrawalScreenFailures?: number
  },
): { status: 'SUCCEEDED' | 'PARTIAL'; effectiveErrors: number } {
  const effectiveErrors =
    errors
    + (deltaError ? 1 : 0)
    + (degraded?.unresolved ?? 0)
    + (degraded?.deltaWindowTruncated ? 1 : 0)
    + (degraded?.deltaCoverageIncomplete ? 1 : 0)
    + (degraded?.withdrawalScreenFailures ?? 0)
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
  /** o3d-rbyg: links this pass refused to fulfil because a withdrawal stands against the order. */
  withheld: number
  /**
   * o3d-rbyg round 2: links this pass could not screen, so did not fulfil. Distinct from `withheld`
   * — nothing is known against these orders and nothing durable was written; they are simply not
   * dispatched on unread evidence, and the next sweep decides them.
   */
  deferred: number
}

export type WmsDispatchLog = {
  orderId: string
  externalOrderNumber: string
  action: 'dispatched' | 'pending' | 'error' | 'withheld' | 'deferred'
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
  /**
   * o3d-bjc.9: unresolved-record streak, kept SEPARATE from the transport
   * failure counter above. `recordUnresolvedRead` increments and returns the new
   * consecutive count; the sweep decides in BULK at the end of the pass whether
   * that cohort is N broken records (quarantine each) or connector-wide drift
   * (quarantine none, one incident). `quarantineUnresolved` performs the
   * isolation; `clearUnresolvedReads` resets the streak on the first resolved
   * read, exactly as clearDispatchFailures does for errors.
   *
   * Optional so a connector or test that predates the quarantine keeps its
   * previous behaviour (streak never advances, nothing is ever quarantined).
   */
  /**
   * o3d-rbyg: which of these orders has a withdrawal standing against it?
   *
   * THE FIFTH FULFILMENT PATH. The withdrawal fence guards the four moments at which an order is
   * PUSHED — the batch screen, the pre-claim fence, the post-create recheck and the verify pass's
   * promotion. None of them ever looks at an order again once its link is SYNCED, and this sweep is
   * what carries a SYNCED link the rest of the way: `applyDispatch` writes the IMS shipment SHIPPED,
   * relieves the stock and sends the storefront's despatch email. So an order withdrawn AFTER it was
   * pushed — with its webhook missed, which is the whole premise of the fence — was fulfilled in
   * full by this pass with nothing having asked.
   *
   * A LOCAL read, deliberately: the IMS markers and the durable suppression tombstone, never the
   * storefront. This runs against every active link on every tick, so a per-order API call is out of
   * the question, and a batched storefront screen would make a WooCommerce outage able to interfere
   * with dispatch reconciliation for the whole shop. The tombstone exists precisely so the fence
   * survives without a live read.
   *
   * Optional so a connector or test that predates the fence keeps its previous behaviour.
   */
  screenWithdrawnOrders?(orderIds: string[]): Promise<ReadonlySet<string>>
  /**
   * Take a withdrawn link OUT of the sweep and put it in front of a human.
   *
   * Not merely skipped: a skip repeats every tick, fulfils nothing, alerts nobody and leaves the
   * order's stock reserved forever. Parking sets the link's dead-letter stamp — the same durable
   * exclusion `dispatchCandidateWhere` already honours — so the link stops being polled, appears in
   * the sync exception inbox, and an operator decides between cancelling it at the WMS, releasing
   * the hold, or replaying the link once the withdrawal is resolved.
   *
   * Reports whether the park actually committed: a park that did not reach disk must not let the
   * pass claim it decided this link.
   */
  parkWithdrawn?(candidate: WmsDispatchCandidate, reason: string): Promise<{ parked: boolean }>
  recordUnresolvedRead?(candidate: WmsDispatchCandidate, reason: string): Promise<{ count: number }>
  quarantineUnresolved?(
    candidate: WmsDispatchCandidate,
    reason: string,
    count: number,
  ): Promise<{ quarantined: boolean }>
  clearUnresolvedReads?(linkId: string): Promise<void>
  /**
   * Drift state across passes: how many CONSECUTIVE passes were read as
   * connector-wide, and WHICH links they were.
   *
   * The identity matters as much as the count. "Everything we touched was
   * unreadable" is ambiguous when the only orders that changed are the broken
   * ones — 3 of 3 looks exactly like a tenant-wide fault, forever, and those
   * three records would never be isolated while the watermark stayed pinned.
   * Real drift sweeps in DIFFERENT orders as they change; a stable set of the
   * same links, pass after pass, is a set of broken records. `cohortKey` is
   * what lets the two be told apart.
   *
   * Persisted because production runs one sweep per tick. The writer reports
   * whether the value reached disk.
   */
  /**
   * Read a few ACTIVE links that are NOT in the unresolved cohort, to settle the
   * question the ratio cannot: is the connector broken, or are these records?
   *
   * It is the only decisive evidence available. "Everything we touched failed"
   * is ambiguous when the only orders that changed are the broken ones — and
   * both readings are dangerous (isolate a healthy tenant / never isolate a
   * broken record). Costs a couple of reads, and only in the ambiguous case.
   *
   * `representative` is the number that resolved AND exercised the SAME
   * invariant the cohort failed: a complete DISPATCHED record. Merely resolving
   * is not enough — the completeness guard only rejects records that read as
   * dispatched, so a connector-wide change that mangles every despatch would
   * leave pending orders reading perfectly while every dispatched one breaks.
   * Counting those as healthy evidence is precisely how the breaker would come
   * to mass-quarantine the tenant it exists to protect.
   */
  probeControlLinks?(excludeLinkIds: string[], limit: number): Promise<{
    probed: number
    resolved: number
    representative: number
  }>
  getUnresolvedDriftState?(): Promise<WmsUnresolvedDriftState>
  saveUnresolvedDriftState?(state: WmsUnresolvedDriftState): Promise<boolean>
  /**
   * Alert admins ONCE about connector-wide unresolved drift (deduplicated).
   * `consecutivePasses` escalates a drift that is not clearing — which is what
   * a long streak is FOR. It deliberately does not change the verdict: a
   * still-drifting connector is never converted into per-link quarantine.
   */
  reportUnresolvedDrift?(input: {
    linkCount: number
    touched: number
    reason: string
    consecutivePasses: number
  }): Promise<void>
  // Inbound Order/List delta (o3d-bjc). Optional so a WMS without a bulk delta
  // (ShipHero) keeps per-order polling exactly as before. fetchDelta returns
  // every order changed since `sinceIso` (already in the tenant timezone) and
  // MUST throw on a truncated/failed delta so the sweep fails safe to a full
  // per-order reconcile. getDeltaState/saveDeltaState persist the watermark +
  // last-reconcile cursors (advanced only on a clean pass).
  fetchDelta?(sinceIso: string): Promise<import('@/lib/connectors/wms/types').WmsOrderStatus[]>
  //
  // q66in.7.2 r3 (Codex r2 finding 2): `scope` is an OPAQUE identity of the delta's configured
  // scope, read with the cursors at the start of the run and handed straight back to
  // `saveDeltaState`. It exists because the cursor RESET and the cursor WRITE happen in different
  // processes: `saveMintsoftOrderDispatchSettings` deletes both cursors when the scope moves, and a
  // sweep already running under the OLD scope then re-upserts them from its own run — restoring an
  // old-scope watermark over the reset, so the first query after the correction starts from a stale
  // point and outstanding new-scope orders predating it never enter the delta. The reset was
  // undone by a writer that had never heard of it. Handing the token back lets the implementation
  // refuse its own write when the scope has moved underneath it; a `getDeltaState` that returns no
  // token asks for no such check, which is what keeps a connector with no scope (or a test double)
  // working unchanged.
  //
  // o3d-hl8l r5 (Codex r4 finding 2): `generation` is carried the same way and is now the thing the
  // write is actually judged against. The token answers "is the scope different now?", which a
  // scope changed and changed back answers with NO while both resets really happened; the
  // generation is minted once per committed reset under the dispatch row lock, so a sweep that
  // spanned either of them is refused. It is round-tripped rather than re-read at save time for the
  // same reason the token is: the value being compared has to be the one the run's cursors came
  // from, and only the run knows that.
  getDeltaState?(): Promise<{ watermark: string | null; lastReconcile: string | null; scope?: string | null; generation?: number | null }>
  saveDeltaState?(state: { watermark?: string; lastReconcile?: string; scope?: string | null; generation?: number | null }): Promise<void>
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
  /**
   * How many links on this connector claim each order number — counted across ALL
   * of them, with NO eligibility filter (Codex round 7). The merge relaxation
   * repoints a link on number evidence alone, so "is this number unique?" must be
   * answered from the complete set: a shipped, cancelled or dead-lettered link
   * sharing the number is still a competing claimant to the survivor, and the
   * reconcile-candidate set excludes exactly those. When this dep is absent the
   * relaxation is refused outright rather than inferred from the candidate set.
   */
  countLinksByOrderNumber?(orderNumbers: string[]): Promise<Map<string, number>>
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
  // True when the delta named this order as changed: every "not yet" below then
  // means "we could not establish the part state", which must hold the watermark.
  requireResolution: boolean,
): Promise<WmsDispatchOutcome> {
  const parts = await deps.fetchOrderParts(orderNumber)
  if (parts.length === 0) {
    return {
      action: 'pending',
      reason: 'Split order has no parts visible in the WMS yet',
      unresolved: requireResolution,
    }
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
    // A part set we could not fully account for is UNRESOLVED, not merely "not all
    // parts shipped yet": a despatched part's items were unreadable, fewer part rows
    // are visible than the WMS says exist, or a visible part's own dispatch state is
    // blank (an unmapped part status — Codex round 8: one dispatched part plus one
    // unknown-status part read as "genuinely part-way", advancing the watermark
    // without ever knowing the second part). Any of those means unknown.
    const anyPartStateUnknown = parts.some((entry) => !dispatchStateEstablished(entry))
    const incompleteEnumeration = !allRecorded || parts.length < totalParts || anyPartStateUnknown
    return {
      action: 'pending',
      reason: !allRecorded
        ? 'A despatched part returned no line items — holding off completion'
        : `${dispatchedParts.length}/${totalParts} parts despatched`,
      unresolved: requireResolution && incompleteEnumeration,
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
 * Whether a connector actually TOLD us this order/part's dispatch state, as opposed
 * to handing back a blank it normalised to "not dispatched". A blank status with no
 * despatch evidence is unknown, not negative — the lenient per-order path yields
 * exactly that when an OrderStatusId is missing or unmapped (the bulk delta path
 * throws instead). Treating it as a clean "pending" is how an order silently ages
 * out of the delta window (Codex round 8).
 *
 * A NON-BLANK status counts as established, deliberately. Codex round 9 asked for an
 * allowlist of understood statuses instead, so that an unrecognised label stayed
 * UNKNOWN — but that trades this bug for a worse one: any legitimate Mintsoft status
 * missing from our list would make every ordinary pending order "unresolved", which
 * pins the watermark and wedges the delta permanently. A non-blank name here can
 * only have come from Mintsoft's own /api/Order/Statuses map, which is strictly
 * validated (o3d-bjc.2.2), so it IS a status Mintsoft recognises — garbage cannot
 * reach this point. What remains is a *connector semantics* risk: a real status that
 * means "gone" but is absent from MINTSOFT_DISPATCHED_STATUSES would read as pending
 * on every path, delta or not. That is tracked separately (o3d-bjc.7) and needs the
 * live status vocabulary to settle, not a guessed allowlist here.
 */
function dispatchStateEstablished(state: {
  status: string
  dispatched: boolean
  tracking: WmsOrderTracking[]
}): boolean {
  if (state.dispatched) return true
  if (state.status.trim() !== '') return true
  return state.tracking.some((entry) => Boolean(entry.despatchedAt))
}

/**
 * The result of reconciling one order. `unresolved` marks a `pending` that means
 * "we could NOT determine this order's state", as opposed to "we determined it is
 * not despatched yet". Only the latter is safe to advance the delta watermark
 * over — an unresolved order must stay in the next delta window (o3d-bjc.2.1).
 */
export type WmsDispatchOutcome = {
  action: 'dispatched' | 'pending' | 'error'
  reason: string
  unresolved?: boolean
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
  // A number-only lookup is a candidate-enumeration hint, not a join.
  // Require its authoritative primary row to echo the link's stable ID before
  // applying anything, so a reused/colliding number cannot dispatch this link.
  expectedExternalOrderId?: string,
  // Set by the DELTA pass: the delta asserted this order changed, so any outcome
  // short of "state established" must hold the watermark rather than read as a
  // clean pending (o3d-bjc.2.1, Codex round 7). The throttled reconcile pass
  // leaves it false — it re-polls every tick, so nothing can age out there.
  requireResolution = false,
  // Whether this link's order number is claimed by EXACTLY ONE link on the
  // connector. A merge is only ever proven by number (the survivor names the
  // numbers it absorbed), so repointing on a number several links claim could
  // repoint — and dispatch — the wrong order. `undefined` = the connector cannot
  // count claimants, which preserves the pre-guard behaviour for connectors that
  // never report merges.
  mergeNumberUnique?: boolean,
): Promise<WmsDispatchOutcome> {
  const status = preloaded ?? (await deps.fetchOrderStatus(candidate.externalOrderNumber))
  if (!status) {
    // A lookup that resolves to NOTHING is not "we checked and it is pending" —
    // the delta named this link's order and we could not read it, so the pass must
    // not advance the watermark past that change (o3d-bjc.2.1).
    return {
      action: 'pending',
      reason: 'Order not found in the WMS',
      unresolved: requireResolution || Boolean(expectedExternalOrderId),
    }
  }
  // o3d-rbyg r4: the binding rule lives in `bindWmsStatusToCandidate`, called rather than copied,
  // because the operator's "record the despatch" remedy has to apply exactly this one. UNRESOLVED
  // rather than pending-and-clean: the lookup handed back a record we cannot bind to this link, so
  // its real state is unknown and the watermark must hold.
  const binding = bindWmsStatusToCandidate(
    status,
    { externalOrderNumber: candidate.externalOrderNumber, externalOrderId: expectedExternalOrderId ?? null },
    mergeNumberUnique,
  )
  if (!binding.bound) {
    return { action: 'pending', reason: binding.reason, unresolved: true }
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
      // We know it split and we cannot read its parts — the dispatch state is
      // unknown, so a delta-triggered pass must not advance past it.
      return {
        action: 'pending',
        reason: 'Split order — this WMS connector has no per-part reconciliation yet',
        unresolved: requireResolution,
      }
    }
    // A merged survivor's parts mix several original orders → reconcile atomically.
    return reconcileSplitOrder(deps, candidate, effectiveOrderNumber, status.partCount, !status.isMerged, requireResolution)
  }

  if (!status.dispatched) {
    // A BLANK status is "we don't know", not "not shipped" (Codex round 8): the
    // forced per-order lookup on a merge/split supplement uses the lenient path, so
    // an unmapped OrderStatusId arrives here as status '' + dispatched false.
    return {
      action: 'pending',
      reason: `Not dispatched (status ${status.status || 'Unknown'})`,
      unresolved: requireResolution && !dispatchStateEstablished(status),
    }
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
): Promise<{
  counters: WmsDispatchCounters
  logs: WmsDispatchLog[]
  deltaError: string | null
  /** Orders served straight from the bulk delta (no per-order fetch). */
  deltaPreloadServed: number
  /** Delta rows the connector had to re-read authoritatively before applying. */
  deltaAuthoritativeRereads: number
  /** Rows the delta returned this run. */
  deltaRowCount: number
  /** Orders whose real dispatch state could not be established this pass. */
  unresolved: number
  /** o3d-bjc.9: links isolated this pass because their record stayed unreadable. */
  unresolvedQuarantined: number
  /** o3d-bjc.9: the unresolved cohort was read as connector drift — nothing isolated. */
  unresolvedSystemic: boolean
  /** The delta window was clamped and could not cover its held-back backlog. */
  deltaWindowTruncated: boolean
  /** True when the sweep pinned the watermark because it could not prove full coverage. */
  deltaCoverageIncomplete: boolean
  /** o3d-rbyg round 2: candidate lists whose withdrawal screen could not be read (their links were deferred). */
  withdrawalScreenFailures: number
}> {
  // At least 1: a batchSize of 0 would poll nothing yet still look like "covered
  // the whole eligible set", which the truncation recovery below relies on.
  const batchSize = Math.max(1, options?.batchSize ?? DISPATCH_SWEEP_DEFAULT_BATCH_SIZE)
  const now = options?.now ?? new Date()
  const counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0, withheld: 0, deferred: 0 }
  const logs: WmsDispatchLog[] = []
  // o3d-rbyg: orders this pass must not fulfil because a withdrawal stands against them. Filled by
  // screenWithdrawn() below, once per candidate list, before anything is reconciled.
  const withdrawnOrderIds = new Set<string>()
  // o3d-rbyg round 2: orders whose screen FAILED. Not "clean" and not "withdrawn" — unknown, and an
  // unknown must not be fulfilled irreversibly. Deferred by processOne, retried next tick.
  const unscreenedOrderIds = new Set<string>()
  let screenFailures = 0

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
  // Component numbers folded into a merge survivor this delta (o3d-bjc.2.1) —
  // links still holding one of these can only be found by NUMBER, never by the
  // stable-ID join, so they must also drive the number supplement below.
  const mergedComponentNumbers = new Set<string>()
  let reconcileDue = true
  let deltaFetched = false
  // How many orders the delta HOT PATH actually served (a preloaded row, no per-order
  // fetch). Reported rather than assumed: o3d-9vv shipped a page Limit the API
  // rejected, so every delta 400'd and the sweep fell back to the per-order poll on
  // every tick - correct sync, zero errors, nothing to see. A fail-safe fallback hides
  // the very failure it protects against, so the fast path must say it engaged.
  let deltaPreloadServed = 0
  // Delta rows the connector had to re-read per order before they were safe to apply.
  let deltaAuthoritativeRereads = 0
  // How many rows the delta returned at all — a delta that returns rows yet serves
  // none fetch-free is the shape of a silently dead fast path.
  let deltaRowCount = 0
  let ranReconcile = false
  let passClean = true
  // True when the query window had to be clamped to the lookback floor, so it
  // could not cover everything a held-back watermark owes (see below).
  let deltaWindowTruncated = false
  // Orders the pass could not establish a dispatch state for. Reported so the job
  // goes PARTIAL instead of looking like a clean success.
  let unresolvedCount = 0
  // o3d-bjc.9: the unresolved cohort, decided in BULK after the loop. Collected
  // rather than acted on inline because a record-local defect and connector-wide
  // drift look identical one record at a time — and the two want opposite
  // remedies (isolate this one / isolate nothing).
  const unresolvedLinks: Array<{ candidate: WmsDispatchCandidate; reason: string; count: number }> = []
  // How many links this pass actually decided an outcome for — the denominator
  // for the drift ratio. counters.totalChecked is not it: it also counts links
  // the delta served without any outcome decision.
  let linksDecided = 0
  let unresolvedQuarantined = 0
  let unresolvedSystemic = false
  const quarantinedNumbers = new Set<string>()
  // True when the reconcile pass drained the WHOLE eligible set this tick (a short
  // batch). Every active link was then authoritatively per-order verified, which is
  // the only sound basis for reseeding a watermark whose window had been truncated.
  let reconcileCoveredAllActive = false
  // The identity of the delta SCOPE this run read its cursors under, handed back at save time so an
  // in-flight old-scope pass cannot re-write cursors a scope change has since discarded
  // (q66in.7.2 r3). Null when the deps expose no scope — no check is then asked for.
  let deltaScopeToken: string | null = null
  // The RESET GENERATION the cursors were read at, handed back at save time (o3d-hl8l r5). Null when
  // the deps expose none — a connector with no delta scope, which asks for no check at all.
  let deltaGeneration: number | null = null
  // Set when the delta fetch fails: the sweep still fails safe to the per-order
  // reconcile, but the failure is surfaced (job PARTIAL + errors) so a broken
  // primary path can't hide behind a SUCCEEDED job.
  let deltaError: string | null = null

  if (deltaActive) {
    const state: { watermark: string | null; lastReconcile: string | null; scope?: string | null; generation?: number | null } =
      deps.getDeltaState
        ? await deps.getDeltaState()
        : { watermark: null, lastReconcile: null }
    // Carried for the whole run and handed back at save time — see `getDeltaState` on the deps.
    deltaScopeToken = state.scope ?? null
    deltaGeneration = state.generation ?? null
    const overlapMs = (options?.deltaOverlapSeconds ?? DISPATCH_DELTA_DEFAULT_OVERLAP_SECONDS) * 1000
    const lookbackMs = (options?.deltaLookbackSeconds ?? DISPATCH_DELTA_DEFAULT_LOOKBACK_SECONDS) * 1000
    const intervalMs = (options?.reconcileIntervalSeconds ?? DISPATCH_DELTA_DEFAULT_RECONCILE_INTERVAL_SECONDS) * 1000

    const watermarkMs = state.watermark ? Date.parse(state.watermark) : NaN
    const baseMs = Number.isFinite(watermarkMs) ? watermarkMs : now.getTime() - lookbackMs
    // Bound the window so a watermark held back by a prior dirty pass can't let
    // the query window grow without limit.
    const wantedSinceMs = baseMs - overlapMs
    const floorMs = now.getTime() - lookbackMs
    const sinceMs = Math.max(wantedSinceMs, floorMs)
    // ...but a CLAMPED window no longer covers everything the held-back watermark
    // owes us: rows that changed between the watermark and the floor are simply
    // not in the response. Advancing on such a pass is how a row held back by a
    // failure (e.g. an unresolvable status) silently ages out after the lookback
    // elapses — the delta comes back empty, looks clean, and the gap is skipped
    // forever. Only a REAL watermark can be truncated; a cold start legitimately
    // begins at the floor.
    deltaWindowTruncated = Number.isFinite(watermarkMs) && wantedSinceMs < floorMs
    if (deltaWindowTruncated) {
      console.warn(
        '[wms-dispatch-sweep] delta watermark is older than the lookback window — ' +
          'the window is clamped and cannot cover the gap; holding the watermark until the backlog clears',
      )
    }
    const sinceIso = formatCursorInTimeZone(new Date(sinceMs), options?.deltaTimeZone ?? DISPATCH_DELTA_DEFAULT_TIMEZONE)

    try {
      const rows = await deps.fetchDelta!(sinceIso)
      deltaById = new Map<string, WmsOrderStatus>()
      deltaByNumber = new Map<string, WmsOrderStatus[]>()
      const indexByNumber = (number: string, row: WmsOrderStatus) => {
        const bucket = deltaByNumber!.get(number)
        if (!bucket) deltaByNumber!.set(number, [row])
        else if (!bucket.includes(row)) bucket.push(row)
      }
      for (const row of rows) {
        if (row.externalOrderId) deltaById.set(row.externalOrderId, row)
        if (row.externalOrderNumber) indexByNumber(row.externalOrderNumber, row)
        // o3d-bjc.2.1: a merge survivor's row is keyed by the COMBINED number
        // ("WC-1001+WC-1002") and carries the survivor's stable id, while our
        // links still hold an ORIGINAL component number and the ABSORBED order's
        // id until repointLink runs — so neither index would find them. Index the
        // survivor under every component number too, or the component link is
        // never reconciled and the watermark ages the merge out of the window.
        for (const component of row.mergedOrderNumbers) {
          if (!component || component === row.externalOrderNumber) continue
          indexByNumber(component, row)
          mergedComponentNumbers.add(component)
        }
      }
      deltaFetched = true
      deltaRowCount = rows.length
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
      mergedComponentNumbers.clear()
      reconcileDue = true
    }
  }

  // Reconcile one candidate + do its failure-tracking bookkeeping. The
  // bookkeeping runs OUTSIDE the reconcile try/catch so a bookkeeping error can
  // never count as another reconcile failure (Codex: recordDispatchError
  // throwing inside the catch would have recursed into itself) nor abort the
  // rest of the pass.
  //
  // Returns whether this pass DECIDED the link. A deferral (see below) returns false, so the caller
  // does not mark it processed: the reconcile pass screens its own list moments later, and a link
  // the delta could not screen must be allowed a second, working screen in the same tick rather than
  // waiting a whole interval on the first bad query.
  const processOne = async (
    candidate: WmsDispatchCandidate,
    preload: WmsOrderStatus | null | undefined,
    expectedExternalOrderId?: string,
    requireResolution = false,
    mergeNumberUnique?: boolean,
  ): Promise<boolean> => {
    counters.totalChecked += 1

    // o3d-rbyg round 2, Codex finding 2: this candidate was never screened, so DEFER it.
    //
    // Round 1 let an unscreened candidate through and merely held the watermark. That is the trade
    // the PUSH screen makes, and it is right there: an unreadable storefront says nothing about the
    // order, and refusing would idle the warehouse on somebody else's outage — while the act it
    // guards (a create) is reversible by the hold and cancel passes.
    //
    // NEITHER HALF OF THAT HOLDS HERE. The screen is a read of our OWN database, so its failure is
    // not an independent outage the fence should absorb — it is the sweep being partly blind (an
    // unmigrated suppression table, a statement timeout on the join) while the rest of the pass
    // works perfectly and ships. And what it guards is not reversible: applyDispatch marks the
    // shipment SHIPPED, consumes FIFO stock and sends the customer a despatch email that cannot be
    // unsent. Deferral costs one sweep interval on an order the WMS has already despatched; the
    // failure it prevents cannot be undone at any price.
    //
    // A defer is NOT a park: nothing durable is written, the link stays a candidate, and the very
    // next tick with a working screen dispatches it. The pass is dirty either way, so the watermark
    // is held and the job reports PARTIAL rather than a silent success.
    if (unscreenedOrderIds.has(candidate.orderId)) {
      counters.deferred += 1
      logs.push({
        orderId: candidate.orderId,
        externalOrderNumber: candidate.externalOrderNumber,
        action: 'deferred',
        reason: 'The withdrawal screen could not be read, so this pass could not prove no withdrawal stands '
          + 'against this order. Dispatch was NOT applied — no shipment, no stock relief and no despatch '
          + 'email — and the link is retried on the next sweep. Nothing durable was written.',
      })
      // Deliberately NOT counted in linksDecided: the pass decided nothing about this link, and
      // that counter is the denominator the unresolved-drift ratio is judged against.
      passClean = false
      return false
    }

    // o3d-rbyg: the fifth fulfilment path, fenced BEFORE the status is even looked at.
    //
    // Ahead of reconcileOneOrder rather than beside applyDispatch, because a split order dispatches
    // through a different function (reconcileSplitOrder → pushPartialShipment) and a fence that
    // guarded only the whole-order call would leave every split order unfenced. Nothing downstream
    // of here may run for a withdrawn order: not the dispatch, not the partial shipments, not the
    // merge repoint.
    if (withdrawnOrderIds.has(candidate.orderId)) {
      const reason = 'A withdrawal request stands against this order, so its WMS dispatch was NOT applied '
        + '— no shipment, no stock relief and no despatch email. Cancel it at the WMS while the withdrawal '
        + 'stands; if the warehouse has ALREADY despatched it, record the despatch from the sync exception '
        + 'inbox (IMS confirms it with the WMS first). Once the withdrawal itself is resolved, replay this link.'
      let parked = false
      try {
        parked = (await deps.parkWithdrawn?.(candidate, reason))?.parked ?? false
      } catch (parkError) {
        console.error('[wms-dispatch-sweep] withdrawal park failed:', parkError)
      }
      // A park that did not commit leaves the link a candidate again next tick, so this pass has
      // NOT decided it — hold the watermark rather than let the change age out of the window.
      if (!parked) passClean = false
      counters.withheld += 1
      linksDecided += 1
      logs.push({
        orderId: candidate.orderId,
        externalOrderNumber: candidate.externalOrderNumber,
        action: 'withheld',
        reason: parked ? reason : `${reason} (the link could not be parked — it will be refused again next sweep)`,
      })
      return true
    }

    let outcome: WmsDispatchOutcome
    try {
      outcome = await reconcileOneOrder(deps, candidate, preload, expectedExternalOrderId, requireResolution, mergeNumberUnique)
    } catch (error) {
      // A record the WMS gave us that we cannot ACT on (o3d-6j8: dispatched but
      // missing the fulfilment fields) is UNRESOLVED, not a per-link error. It is
      // connector-level drift, not damage to this order — counting it as an error
      // would strike the link and, under systemic drift, dead-letter every active
      // link in turn: excluded from the candidate queries, one admin notification
      // each, and manual replay needed even after the WMS recovers. Unresolved holds
      // the watermark and marks the job PARTIAL while links stay eligible.
      outcome = isWmsUnresolvableRecordError(error)
        ? { action: 'pending', reason: scrubWmsError(error, 'WMS record unusable'), unresolved: true }
        : { action: 'error', reason: scrubWmsError(error, 'WMS dispatch sweep error') }
    }
    // Any error — or a pending we could not actually RESOLVE — holds the watermark
    // back so a changed row can't age out of the next window before it's applied.
    // `unresolved` deliberately does NOT count as a dead-lettering error: an
    // ambiguous order would otherwise dead-letter itself after five sweeps for a
    // condition the operator has to fix in the WMS, not in IMS. It IS counted for
    // the job outcome (below) so it can never hide behind a SUCCEEDED job.
    if (outcome.action === 'error') passClean = false
    if (outcome.unresolved) unresolvedCount += 1
    counters[outcome.action === 'dispatched' ? 'dispatched' : outcome.action === 'error' ? 'errors' : 'pending'] += 1
    linksDecided += 1

    // 6oyu.2: only CONSECUTIVE errors dead-letter — any RESOLVED non-error outcome
    // resets. An unresolved outcome resets nothing: it is not evidence the link is
    // healthy, and clearing the streak on it would let a link alternate between a
    // real error and an unresolved read and never reach the exception inbox.
    let reason = outcome.reason
    try {
      if (outcome.action === 'error') {
        const { deadLettered } = await deps.recordDispatchError(candidate, outcome.reason)
        if (deadLettered) reason = `${outcome.reason} — dead-lettered after ${DISPATCH_MAX_CONSECUTIVE_FAILURES} consecutive failures`
      } else if (!outcome.unresolved) {
        await deps.clearDispatchFailures(candidate.linkId)
      }
      // o3d-bjc.9: the unresolved streak is its own, and it advances HERE while
      // the isolate-or-not decision waits for the end of the pass — that is the
      // only point where a record-local defect and connector-wide drift are
      // distinguishable. A resolved read (dispatched or a genuine pending)
      // clears it; an ERROR leaves it alone, because an error says nothing
      // about whether the record is readable.
      if (outcome.unresolved) {
        // NOT counted here. The streak is committed in the bulk decision, AFTER
        // the cohort is classified: a systemic pass is explicitly not evidence
        // that any individual record is broken, so spending its quarantine
        // budget would isolate the stragglers the moment a connector outage
        // partially recovers — records that would have recovered by themselves.
        unresolvedLinks.push({ candidate, reason: outcome.reason, count: 0 })
      } else if (outcome.action !== 'error') {
        await deps.clearUnresolvedReads?.(candidate.linkId)
      }
    } catch (bookkeepingError) {
      // Best-effort: the streak just doesn't move this run. An unresolved read
      // whose streak could not be recorded must still hold the cursor, so it is
      // registered with a count of 0 (below the cap ⇒ never quarantined here).
      console.error('[wms-dispatch-sweep] failure-tracking bookkeeping failed:', bookkeepingError)
      if (outcome.unresolved && !unresolvedLinks.some((entry) => entry.candidate.linkId === candidate.linkId)) {
        unresolvedLinks.push({ candidate, reason: outcome.reason, count: 0 })
      }
    }

    logs.push({
      orderId: candidate.orderId,
      externalOrderNumber: candidate.externalOrderNumber,
      action: outcome.action,
      reason,
    })
    return true
  }

  // "Is this order number claimed by exactly one link?" — `undefined` when we never
  // counted it, which reconcileOneOrder reads as "no opinion" (pre-guard behaviour)
  // rather than as "not unique". A counted-but-absent number yields 0 (see
  // countLinksByOrderNumber), so undefined unambiguously means "not counted".
  const claimantUniqueness = (
    counts: Map<string, number> | null,
    orderNumber: string,
  ): boolean | undefined => {
    const count = counts?.get(orderNumber)
    return count === undefined ? undefined : count === 1
  }

  /**
   * o3d-rbyg: screen a candidate list against the durable withdrawal evidence, once, in bulk.
   *
   * A FAILURE HERE IS NOT SILENT AND IS NOT WAVED THROUGH (round 2, Codex finding 2). This is a
   * read of our own database, so its failure is the sweep going partly blind rather than an outage
   * somewhere else — and what the screen guards is irreversible. Every order in a list that could
   * not be screened is DEFERRED by processOne: no dispatch, nothing durable written, the pass marked
   * dirty so the watermark is held, and the whole list retried next tick.
   *
   * The failure is remembered PER ORDER rather than for the pass, so the second pass's own screen
   * can clear it: the delta list and the reconcile list are screened separately, and one bad query
   * against a 200-id chunk must not idle a candidate the other pass screened cleanly moments later.
   */
  const screenWithdrawn = async (list: WmsDispatchCandidate[]) => {
    if (!deps.screenWithdrawnOrders || list.length === 0) return
    const orderIds = [...new Set(list.map((entry) => entry.orderId))]
    try {
      const fenced = await deps.screenWithdrawnOrders(orderIds)
      for (const orderId of fenced) withdrawnOrderIds.add(orderId)
      // Screened cleanly: retract any earlier pass's failure for these same orders.
      for (const orderId of orderIds) unscreenedOrderIds.delete(orderId)
    } catch (screenError) {
      passClean = false
      screenFailures += 1
      for (const orderId of orderIds) unscreenedOrderIds.add(orderId)
      console.error(
        `[wms-dispatch-sweep] withdrawal screen failed for ${orderIds.length} candidate(s) — their dispatch `
        + 'is DEFERRED (nothing shipped, nothing parked) and the watermark is held, because this pass '
        + 'cannot prove no withdrawal stands against them:',
        screenError,
      )
    }
  }

  const processedLinkIds = new Set<string>()
  // Whether the delta pass examined EVERY active link the delta touched. Only
  // then is advancing the watermark safe — otherwise a changed order beyond the
  // reconcile batch would be skipped yet aged out of the next window.
  let deltaCoverageComplete = true
  // o3d-bjc.9: WHY coverage was incomplete, attributed to the order number that
  // caused it. A quarantined record must stop pinning the watermark, and the
  // pass-clean flag is only half of that — an unreadable split row also spoils
  // COVERAGE, which is a separate gate. Anything we cannot attribute to a
  // specific order is recorded as UNATTRIBUTABLE and can never be forgiven.
  const UNATTRIBUTABLE = '\u0000unattributable'
  const coverageSpoilers = new Set<string>()
  const holdCoverage = (attribution: string | null | undefined) => {
    deltaCoverageComplete = false
    coverageSpoilers.add(attribution || UNATTRIBUTABLE)
  }

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
      if (!deltaCoverageComplete) coverageSpoilers.add(UNATTRIBUTABLE)
      deltaCandidates = batch
    }

    // Numbers the stable-ID join cannot be trusted to cover on its own:
    //  - shared/split numbers: the changed sibling part's id may not be the one
    //    stored on the link;
    //  - merged components (o3d-bjc.2.1): the link still holds the ABSORBED
    //    order's id, which the survivor's row no longer carries at all.
    // Links reached via the stable-ID split probe (o3d-bjc.5). Tracked so the
    // processing loop below can tell them apart from a bare number match.
    // linkId -> the CURRENT order number the probe found the group under. A
    // probe-discovered link has no idRow, so without this the reconcile would
    // look the status up by the link's STALE number — which is precisely what
    // the rename broke, so the probe would find the order and the lookup would
    // then fail anyway.
    const probeDiscovered = new Map<string, string>()
    const supplementNumbers = new Set<string>(
      [...deltaByNumber.entries()]
        .filter(([, rows]) => rows.length > 1 || rows.some((row) => row.isSplit || (row.partCount ?? 1) > 1))
        .map(([number]) => number),
    )
    for (const number of mergedComponentNumbers) supplementNumbers.add(number)
    if (supplementNumbers.size > 0) {
      if (deps.listActiveByOrderNumbers) {
        const supplementCandidates = await deps.listActiveByOrderNumbers([...supplementNumbers])
        const seen = new Set(deltaCandidates.map((candidate) => candidate.linkId))
        for (const candidate of supplementCandidates) {
          if (!seen.has(candidate.linkId)) {
            deltaCandidates.push(candidate)
            seen.add(candidate.linkId)
          }
        }
        // A RENAMED split is still invisible here (o3d-bjc.5). The supplement
        // looks up links by the delta row's CURRENT number, but the link stores
        // the number the split had when we created it — so if Mintsoft renamed
        // it and only a SIBLING part changed, neither the stable-ID join (wrong
        // part id) nor this number lookup (wrong number) finds the link, and the
        // order ages out when the watermark advances.
        //
        // Resolve the group's CURRENT part ids from the WMS and enumerate by
        // those. Coverage is then claimed on STABLE-ID evidence, never on a
        // number match — which is the constraint that sank the first attempt at
        // this fix: order numbers are not unique even within our own client, so
        // "some link has this number" proves nothing about THIS group.
        if (deps.partsSupported && deps.fetchOrderParts && deps.listActiveByExternalOrderIds) {
          // A group needs probing only when NOTHING already enumerated a link
          // for it. Note this is a check for "do I need to spend a probe",
          // not a claim that coverage is proven — the design's rule that
          // coverage may only be CLAIMED on stable-ID evidence still holds
          // below, where an incoherent or unprobed group sets
          // deltaCoverageComplete = false.
          //
          // Both forms count, because a split link legitimately stores a
          // DIFFERENT part's id than the one that changed: the link's own
          // number, and any of the group's delta-row ids.
          const enumeratedNumbers = new Set(
            deltaCandidates.map((candidate) => candidate.externalOrderNumber).filter(Boolean),
          )
          const coveredIds = new Set(
            deltaCandidates.map((candidate) => candidate.externalOrderId).filter(Boolean) as string[],
          )
          let probes = 0
          for (const [number, rows] of deltaByNumber.entries()) {
            const splitRow = rows.find((row) => row.isSplit || (row.partCount ?? 1) > 1)
            if (!splitRow) continue
            // Already covered by a stable id we hold: nothing to probe.
            if (enumeratedNumbers.has(number)) continue
            if (rows.some((row) => coveredIds.has(row.externalOrderId))) continue
            if (probes >= SPLIT_PROBE_BUDGET_PER_SWEEP) {
              // Budgeted, and the shortfall is REPORTED rather than silent: the
              // job goes PARTIAL and the watermark holds, so the remaining
              // groups are retried instead of aged out.
              holdCoverage(null)
              console.warn(
                `[wms-dispatch-sweep] split probe budget (${SPLIT_PROBE_BUDGET_PER_SWEEP}) ` +
                  'exhausted; holding the watermark so unprobed split groups are not aged out',
              )
              break
            }
            probes += 1
            let parts: import('@/lib/connectors/wms/types').WmsOrderPart[]
            try {
              parts = await deps.fetchOrderParts(number)
            } catch (error) {
              // Stop on the FIRST failure rather than hammering a degraded
              // dependency for every remaining group.
              holdCoverage(number)
              console.warn(
                `[wms-dispatch-sweep] split probe for ${number} failed (${String(error)}); ` +
                  'stopping further probes this sweep and holding the watermark',
              )
              break
            }
            const partIds = coherentSplitPartIds(parts, splitRow.partCount ?? null)
            if (!partIds) {
              // Ambiguous or contaminated group. Do NOT enumerate against it —
              // hold the watermark and let a later sweep (or an operator) see a
              // coherent group.
              holdCoverage(number)
              console.warn(
                `[wms-dispatch-sweep] split group for ${number} is not coherent ` +
                  '(duplicate parts, or a count that disagrees with the delta row); ' +
                  'refusing to enumerate links against it',
              )
              continue
            }
            const byPartId = await deps.listActiveByExternalOrderIds(partIds)
            for (const candidate of byPartId) {
              // Eligible on STABLE-ID evidence: this link's stored id is one of
              // the ids the WMS itself lists for this coherent split group. The
              // processing loop's own eligibility test is number/id-keyed
              // against the DELTA, which is exactly what a rename defeats — so
              // record the discovery here rather than let it fall through.
              probeDiscovered.set(candidate.linkId, number)
              if (!seen.has(candidate.linkId)) {
                deltaCandidates.push(candidate)
                seen.add(candidate.linkId)
              }
            }
          }
        }
      } else {
        // Stable IDs alone cannot prove split/merge coverage. Keep the watermark
        // until a later run can enumerate that shared-number group — attributed
        // to the numbers we could not enumerate, so an isolated record can later
        // release its own hold (o3d-bjc.9) while a genuine gap keeps it.
        for (const number of supplementNumbers) holdCoverage(number)
      }
    }

    // Order numbers are NOT unique across links (there is no unique constraint on
    // externalOrderNumber). The merge relaxation below repoints a link on
    // number-based evidence alone, so it must never fire when several links share
    // the number — one merged lookup would otherwise repoint and dispatch ALL of
    // them off a survivor that absorbed only one.
    //
    // The count MUST come from the complete link set, not from deltaCandidates:
    // those are filtered to non-dead-lettered, pre-dispatch links, and a shipped or
    // dead-lettered link sharing the number is still a competing claimant to the
    // survivor (Codex round 7). With no way to count, the relaxation is refused.
    let linksPerNumber: Map<string, number> | null = null
    if (mergedComponentNumbers.size > 0 && deps.countLinksByOrderNumber) {
      linksPerNumber = await deps.countLinksByOrderNumber([...mergedComponentNumbers])
    }

    await screenWithdrawn(deltaCandidates)

    for (const candidate of deltaCandidates) {
      // Stable-id join is authoritative. A candidate without one is eligible
      // only through the split-only number lookup and is always force-fetched.
      const idRow = candidate.externalOrderId ? deltaById.get(candidate.externalOrderId) : undefined
      const candidateRows = deltaByNumber.get(candidate.externalOrderNumber)
      const splitByNumber = candidateRows?.some((row) => row.isSplit || (row.partCount ?? 1) > 1)
        || (candidateRows?.length ?? 0) > 1
      // o3d-bjc.2.1: this link's number was folded into a merge survivor in this
      // delta. Its stored id is the absorbed order's, so the stable-ID join can
      // never match — reconcile it by number so the link is repointed.
      const mergedByNumber = candidateRows?.some(
        (row) => row.isMerged && row.mergedOrderNumbers.includes(candidate.externalOrderNumber),
      ) ?? false
      // probeDiscovered: the split probe matched this link's stored id against
      // the WMS's own coherent part set for the changed group. A RENAMED split
      // has neither a matching delta id (the sibling changed) nor a matching
      // number (the link holds the old one), so without this it is skipped here
      // and ages out — which is the whole bug.
      const probedNumber = probeDiscovered.get(candidate.linkId)
      const probed = probedNumber !== undefined
      if (!idRow && !splitByNumber && !mergedByNumber && !probed) continue
      if (!idRow && !candidate.externalOrderId) continue

      // Ambiguous merge: the survivor names this number, but nothing ties it to a
      // specific absorbed stable id. Only proceed when the number provably belongs
      // to exactly ONE link on this connector. Otherwise fail closed — hold the
      // watermark and surface it rather than guess which order was absorbed.
      if (!idRow && mergedByNumber) {
        const claimants = linksPerNumber?.get(candidate.externalOrderNumber) ?? null
        if (claimants === null || claimants > 1) {
          holdCoverage(candidate.externalOrderNumber)
          counters.totalChecked += 1
          counters.pending += 1
          unresolvedCount += 1
          logs.push({
            orderId: candidate.orderId,
            externalOrderNumber: candidate.externalOrderNumber,
            action: 'pending',
            reason: claimants === null
              ? `Merge into a survivor naming ${candidate.externalOrderNumber}, but this connector cannot prove the `
                + 'number is unique — refusing to repoint on number evidence alone'
              : `Ambiguous merge: ${claimants} links share order number ${candidate.externalOrderNumber} `
                + '— refusing to repoint on number evidence alone',
          })
          // Route it through the SAME bookkeeping as any other unresolved read
          // (o3d-bjc.9). Left outside it, this branch pinned the watermark on
          // every pass while never accruing a streak, never reaching the
          // exception inbox and never being replayable — an invisible permanent
          // hold, which is precisely the shape the quarantine exists to end.
          unresolvedLinks.push({
            candidate,
            reason: claimants === null
              ? `Cannot prove order number ${candidate.externalOrderNumber} is unique — merge not repointed`
              : `Ambiguous merge: ${claimants} links share order number ${candidate.externalOrderNumber}`,
            count: 0,
          })
          linksDecided += 1
          processedLinkIds.add(candidate.linkId)
          continue
        }
      }

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
        // o3d-bjc.5: a probe-discovered link has no idRow, so it would otherwise
        // keep its STALE number here — and the production adapter exact-matches
        // OrderNumber, so a genuine rename would return no status, go
        // unresolved, and pin the watermark. Use the number the probe actually
        // found the group under.
        : probedNumber
          ? { ...candidate, externalOrderNumber: probedNumber }
          : candidate
      const preload = idRow && !idIsSplit ? idRow : null
      // Only a row the connector took STRAIGHT off the bulk feed counts as fetch-free.
      // A row it had to re-read authoritatively (o3d-6j8) cost a per-order request, and
      // counting it here would mask exactly the slow path this metric exists to expose.
      if (preload && !preload.authoritativeReread) deltaPreloadServed += 1
      if (preload?.authoritativeReread) deltaAuthoritativeRereads += 1
      const decidedByDelta = await processOne(
        effectiveCandidate,
        preload,
        idRow ? undefined : candidate.externalOrderId ?? undefined,
        // Delta-triggered: this order is KNOWN to have changed, so an outcome that
        // fails to establish its state must hold the watermark.
        true,
        claimantUniqueness(linksPerNumber, candidate.externalOrderNumber),
      )
      if (decidedByDelta) processedLinkIds.add(candidate.linkId)
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
    // Ask for ONE more than we intend to process and use the extra row purely as a
    // has-more sentinel (Codex round 8): `length < batchSize` can never be true when
    // the eligible count happens to EQUAL batchSize, so a stale watermark could
    // never recover for a set of exactly 50 (or exactly 1 at batchSize 1).
    const fetched = deps.listReconcileCandidates
      ? await deps.listReconcileCandidates(batchSize + 1)
      : await deps.listCandidates(batchSize + 1)
    const candidates = fetched.slice(0, batchSize)
    // No sentinel row ⇒ this batch WAS the whole eligible set, so every active link
    // is verified this tick — the basis for recovering a truncated watermark.
    reconcileCoveredAllActive = fetched.length <= batchSize
    // Codex round 7: the reconcile pass repoints a merge on order-NUMBER evidence
    // with no id check, so a reused-number link the delta pass had refused as an
    // ambiguous merge could simply be accepted here once the delta row aged out.
    // Resolve claimant uniqueness for this batch (one grouped query) and let
    // reconcileOneOrder refuse the repoint on a shared number. Deliberately NOT by
    // passing expectedExternalOrderId: that guard runs before the split branch, and
    // a link storing a non-primary part's id would then be rejected outright.
    const reconcileClaimants = deps.countLinksByOrderNumber
      ? await deps.countLinksByOrderNumber(candidates.map((entry) => entry.externalOrderNumber))
      : null
    await screenWithdrawn(candidates)

    for (const candidate of candidates) {
      if (processedLinkIds.has(candidate.linkId)) continue // already handled from the delta
      const decided = await processOne(
        candidate,
        undefined,
        undefined,
        // When this pass is the recovery mechanism for a truncated window, its
        // verdicts are what CERTIFY the un-queryable gap — so they must be held to
        // the same standard as the delta pass (Codex round 8: otherwise a null or
        // blank lookup read as clean pending and reseeded the watermark anyway).
        deltaWindowTruncated,
        claimantUniqueness(reconcileClaimants, candidate.externalOrderNumber),
      )
      if (decided) processedLinkIds.add(candidate.linkId)
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

  // --- Unresolved cohort: isolate the record, or name the drift (o3d-bjc.9) ---
  //
  // Decided ONCE, here, because this is the only point in the pass where the two
  // are distinguishable. Parking is isolation, and isolation only means anything
  // when the thing isolated is the exception:
  //   • a lone unreadable record in a healthy tenant  ⇒ quarantine it, so it
  //     stops pinning the watermark for everyone else;
  //   • most of what the pass touched unreadable at once ⇒ connector-wide drift:
  //     ONE incident, NOTHING quarantined, every link still eligible to recover
  //     automatically when the dependency does.
  if (unresolvedLinks.length > 0) {
    const cohortKey = unresolvedLinks.map((entry) => entry.candidate.linkId).sort().join(',')
    const prior = (await deps.getUnresolvedDriftState?.()) ?? { consecutive: 0, cohortKey: null, stableFor: 0 }
    // Reporting only: how long the SAME set has been stuck. It deliberately
    // does not affect the verdict — see the no-control branch below.
    const cohortUnchanged = prior.cohortKey === cohortKey
    const stableFor = cohortUnchanged ? prior.stableFor + 1 : 1

    // Two questions, and both have to be asked:
    //   1. Is most of what this pass touched unreadable?  (floor + ratio)
    //   2. Is it the SAME set of records every time?      (cohort identity)
    // A real connector fault sweeps in different orders as they change. The
    // same links, pass after pass, are broken records that merely happen to be
    // the only ones changing — and reading that as drift forever is how three
    // bad rows pin a tenant's watermark with no exception ever raised.
    const looksSystemic = isUnresolvedDriftSystemic(unresolvedLinks.length, linksDecided)
    if (!looksSystemic) {
      unresolvedSystemic = false
    } else {
      // Ask a healthy control before believing it. A cohort can look systemic
      // simply because the only orders that changed were the broken ones, and
      // repeated identity cannot settle it either — a genuine fault holds the
      // watermark, so it re-serves the SAME rows and looks frozen too.
      let control: { probed: number; resolved: number; representative: number } | null = null
      try {
        control = (await deps.probeControlLinks?.(
          unresolvedLinks.map((entry) => entry.candidate.linkId),
          DISPATCH_UNRESOLVED_CONTROL_PROBES,
        )) ?? null
      } catch (probeError) {
        // No evidence is not counter-evidence: fall through to the conservative
        // branch below rather than treating a failed probe as a healthy read.
        console.warn('[wms-dispatch-sweep] control probe failed:', probeError)
        control = null
      }
      if (control && control.representative > 0) {
        // Decisive: another order on this connector produced a COMPLETE
        // dispatched record in the same pass, so the connector can still do the
        // thing the cohort failed at. These records are the problem.
        unresolvedSystemic = false
      } else {
        // No REPRESENTATIVE control: either nothing else is active, the
        // connector cannot probe, or the controls we could read were all in a
        // lifecycle state that never exercises the failing invariant (pending
        // orders read fine while every despatch is mangled). Cohort STABILITY
        // proves nothing either — a deterministic
        // schema break produces the same cohort every pass, all the more so
        // because holding the watermark re-serves the same rows. Isolating on
        // that would quarantine the entire tenant for a fault that a single
        // connector fix would otherwise have cleared automatically, and every
        // order would then need a manual replay.
        //
        // So: stay systemic, keep every link eligible, and escalate. The cost
        // is a held watermark and a degraded (per-order) delta — recoverable
        // the moment the connector is fixed. `stableFor` is carried purely so
        // the incident can say how long this has been going on.
        unresolvedSystemic = true
      }
    }

    const committed = (await deps.saveUnresolvedDriftState?.({
      consecutive: unresolvedSystemic ? prior.consecutive + 1 : 0,
      cohortKey,
      stableFor,
      // o3d-bjc.12: the evidence an operator needs to decide. firstSeenAt
      // survives while the cohort does — "unreadable since 09:12" is the whole
      // difference between a blip and something that needs a human.
      firstSeenAt: unresolvedSystemic
        ? (cohortUnchanged ? prior.firstSeenAt ?? now.toISOString() : now.toISOString())
        : null,
      linkIds: unresolvedSystemic ? unresolvedLinks.map((entry) => entry.candidate.linkId) : [],
      lastSeenAt: unresolvedSystemic ? now.toISOString() : null,
      touched: unresolvedSystemic ? linksDecided : 0,
      reason: unresolvedSystemic ? unresolvedLinks[0]?.reason ?? null : null,
    })) ?? true
    if (!committed) {
      // An observability write failing must NEVER reclassify drift into broken
      // records — that would quarantine a whole tenant off a transient upsert
      // error. The pass still holds the watermark and still reports.
      console.error(
        '[wms-dispatch-sweep] could not persist the unresolved-drift state — the verdict stands, ' +
          'but escalation counting and cohort-stability detection are degraded until it writes',
      )
    }

    if (unresolvedSystemic) {
      // Drift holds the cursor: nothing was isolated, so the rows are still owed.
      passClean = false
      const sample = unresolvedLinks[0]?.reason ?? 'unresolved WMS record'
      try {
        await deps.reportUnresolvedDrift?.({
          linkCount: unresolvedLinks.length,
          touched: linksDecided,
          reason: sample,
          consecutivePasses: prior.consecutive + 1,
        })
      } catch (driftError) {
        console.error('[wms-dispatch-sweep] unresolved-drift report failed:', driftError)
      }
      console.warn(
        `[wms-dispatch-sweep] ${unresolvedLinks.length}/${linksDecided} links unresolved this pass — ` +
          `treating as connector drift, quarantining none (${prior.consecutive + 1} consecutive pass(es)): ${sample}`,
      )
    } else {
      for (const entry of unresolvedLinks) {
        // Committed HERE, so a systemic pass never spends a record's budget.
        let count = 0
        try {
          count = ((await deps.recordUnresolvedRead?.(entry.candidate, entry.reason)) ?? { count: 0 }).count
        } catch (streakError) {
          console.error('[wms-dispatch-sweep] unresolved-streak bookkeeping failed:', streakError)
        }
        let quarantined = false
        if (count >= DISPATCH_MAX_CONSECUTIVE_UNRESOLVED) {
          try {
            const result = await deps.quarantineUnresolved?.(entry.candidate, entry.reason, count)
            quarantined = Boolean(result?.quarantined)
          } catch (quarantineError) {
            console.error('[wms-dispatch-sweep] quarantine failed:', quarantineError)
          }
        }
        if (quarantined) {
          unresolvedQuarantined += 1
          quarantinedNumbers.add(entry.candidate.externalOrderNumber)
          // Isolated: it no longer speaks for the pass. Holding the cursor for a
          // link that has just left the candidate set would pin the watermark
          // for a record nothing will look at again until an operator acts.
        } else {
          // Still in play, so the row it could not read is still owed.
          passClean = false
        }
      }
    }
  } else if (deps.saveUnresolvedDriftState) {
    // A pass with nothing unresolved ends any drift: the next occurrence starts
    // its own count, and its own cohort.
    const prior = (await deps.getUnresolvedDriftState?.()) ?? { consecutive: 0, cohortKey: null, stableFor: 0 }
    if (prior.consecutive > 0 || prior.cohortKey !== null) {
      // Cleared, which also RETRACTS the operator-facing incident: the offer to
      // isolate must not outlive the condition it was offered for.
      await deps.saveUnresolvedDriftState({
        consecutive: 0, cohortKey: null, stableFor: 0,
        firstSeenAt: null, linkIds: [], touched: 0, reason: null, lastSeenAt: null,
      })
    }
  }

  // Coverage is the OTHER half of "stops pinning the watermark" (o3d-bjc.9). An
  // unreadable record spoils coverage as well as the clean-pass flag — an
  // incoherent split group, say — so isolating the link while the coverage gate
  // still holds would leave the watermark exactly where it was. Forgive the
  // coverage miss only when EVERY reason for it is a record we just quarantined:
  // one unattributable miss (a spent probe budget, a truncated batch) keeps the
  // hold, because that is a gap in what we LOOKED at, not a record we isolated.
  if (!deltaCoverageComplete && quarantinedNumbers.size > 0 && coverageSpoilers.size > 0) {
    const allForgiven = [...coverageSpoilers].every((number) => quarantinedNumbers.has(number))
    if (allForgiven) {
      deltaCoverageComplete = true
      console.warn(
        `[wms-dispatch-sweep] delta coverage was incomplete solely because of ${quarantinedNumbers.size} ` +
          'quarantined record(s) — releasing the watermark now they are isolated',
      )
    }
  }

  // Advance the delta cursors only after a fully clean, fully covered pass, so a
  // Mintsoft/WC blip (or a batch-truncated delta pass) can't age a changed row
  // out of the next window before it's applied.
  //  - watermark: advance iff we fetched a delta this run (store UTC ISO);
  //  - lastReconcile: stamp iff the per-order reconcile pass ran, so a skipped
  //    reconcile re-runs next tick instead of waiting a full interval.
  // NOTE the asymmetry (Codex round 9): `lastReconcile` is stamped whenever the
  // reconcile pass RAN, independent of passClean. It only tracks the reconcile
  // cadence, and gating it on a clean pass meant one permanently-unresolvable link
  // forced a full recovery reconcile — and its log rows — on every scheduler tick
  // instead of honouring the interval. The clean + fully-covered guard applies to
  // the WATERMARK, which is the thing that can lose data.
  if (deltaActive && deps.saveDeltaState) {
    const toSave: { watermark?: string; lastReconcile?: string; scope?: string | null } = {}
    // Watermark advances only when the delta pass covered EVERY changed link
    // (deltaCoverageComplete) — else a changed order beyond the batch would be
    // aged out. lastReconcile just tracks the per-order reconcile cadence.
    //
    // Truncation recovery (Codex round 7): a clamped window can't cover the gap it
    // owes, so it normally blocks the advance — but blocking forever is its own
    // wedge, because the same stale watermark is re-read every run. The escape is
    // the reconcile pass: when it drained the WHOLE eligible set this tick, every
    // active link was just authoritatively per-order verified, so the gap IS
    // covered (by a different mechanism) and the watermark can be reseeded.
    const truncationRecovered = deltaWindowTruncated && reconcileCoveredAllActive
    if (passClean && deltaFetched && deltaCoverageComplete && (!deltaWindowTruncated || truncationRecovered)) {
      toSave.watermark = now.toISOString()
    }
    if (ranReconcile) toSave.lastReconcile = now.toISOString()
    if (toSave.watermark !== undefined || toSave.lastReconcile !== undefined) {
      // The scope this run READ its cursors under. The implementation writes only if it still
      // holds — an in-flight old-scope pass must not resurrect the cursors a scope change discarded.
      // OMITTED, not nulled, when the deps expose no scope: absent is what "no check asked for"
      // means on an optional field, and it keeps the saved payload byte-identical for a connector
      // that has no scope at all.
      await deps.saveDeltaState({
        ...toSave,
        ...(deltaScopeToken !== null ? { scope: deltaScopeToken } : {}),
        // OMITTED the same way, and for the same reason: a payload that carries no generation is a
        // caller that never read one, which the repository refuses rather than guesses at.
        ...(deltaGeneration !== null ? { generation: deltaGeneration } : {}),
      })
    }
  }

  return {
    counters,
    logs,
    deltaError,
    deltaPreloadServed,
    deltaAuthoritativeRereads,
    deltaRowCount,
    unresolved: unresolvedCount,
    unresolvedQuarantined,
    unresolvedSystemic,
    // Surfaced so the wrapper can mark the job PARTIAL: a clamped window means the
    // delta is running degraded and cannot cover its own backlog.
    deltaWindowTruncated,
    // Likewise for coverage: the sweep pinned the watermark because it could not
    // prove it saw every changed order. Safe, but it must not look like success.
    deltaCoverageIncomplete: !deltaCoverageComplete,
    // o3d-rbyg round 2: how many candidate lists could not be screened for withdrawals. Their
    // orders were deferred rather than dispatched, which is safe — and, exactly like the two flags
    // above, must not read as a clean sweep. A screen that fails every tick stops fulfilment
    // silently otherwise.
    withdrawalScreenFailures: screenFailures,
  }
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

/**
 * q66in.7.2 r3 (Codex r2 finding 2) — WRITE THE INBOUND-DELTA CURSORS ONLY IF THE SCOPE IS STILL
 * THE ONE THE RUN READ THEM UNDER.
 *
 * `saveMintsoftOrderDispatchSettings` DELETES both cursors, inside its own transaction, when the
 * inbound-delta scope (ClientId / ChannelId / WarehouseId) moves — they describe orders the new
 * scope cannot see. Round 2 made that decision trustworthy by reading the before-image under a row
 * lock, so the audit can no longer claim a transition that never happened. It did not stop the
 * cursors coming BACK: a sweep that started before the scope change commits is still holding an
 * old-scope watermark, and its unconditional upsert put it straight back. The reset was undone by a
 * writer that had never heard of it, the first query under the new scope resumed from a point
 * belonging to the old one, and outstanding new-scope orders predating that point never entered the
 * delta at all. Nothing about it was visible afterwards — the key is simply present again,
 * indistinguishable from a sweep that ran normally.
 *
 * The guard is a compare-and-swap against the scope the run started under, taken under the SAME row
 * lock the save takes. Reading the scope without the lock would not close the window: Postgres runs
 * READ COMMITTED, so an unlocked SELECT inside this transaction is exactly as stale as one outside
 * it, and the delete could still commit between the read and the upserts. Locking the five dispatch
 * setting rows serialises this against the save outright — whichever transaction takes the lock
 * first runs to completion, and the other sees the result.
 *
 * LOCK ORDER is identical on both sides (the five dispatch keys, then the two cursor keys), so the
 * pair cannot cycle.
 *
 * A refused write is NOT an error. The pass did its work; its cursors are simply no longer
 * meaningful. The next run reads the cleared cursors and restarts from the lookback window, which
 * is exactly what the reset asked for. The refusal is returned (and logged) because a silently
 * dropped advance is otherwise indistinguishable from a pass that never ran.
 *
 * `scope == null` means the caller asked for no check — a connector with no scope, or a test double
 * that supplies no token — and the cursors are written unconditionally, as before.
 */
export type MintsoftDeltaCursorTx = MintsoftDispatchSettingsLockTx & {
  setting: {
    upsert(args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }): Promise<unknown>
    findMany(args: {
      where: { key: { in: string[] } }
      select: { key: true; value: true }
    }): Promise<Array<{ key: string; value: string | null }>>
  }
}

/** What the RESET needs on top of the write side: it removes the cursor rows outright. */
export type MintsoftDeltaResetTx = MintsoftDeltaCursorTx & {
  setting: { deleteMany(args: { where: { key: { in: string[] } } }): Promise<unknown> }
}

/**
 * The read side needs `findMany` and the write side needs `upsert`; kept as separate structural
 * types so neither's doubles have to grow a delegate that path never calls.
 */
export type MintsoftDeltaCursorReadTx = MintsoftDispatchSettingsLockTx & {
  setting: {
    findMany(args: {
      where: { key: { in: string[] } }
      select: { key: true; value: true }
    }): Promise<Array<{ key: string; value: string | null }>>
  }
}

/** The two Setting keys the inbound-delta cursors live in, in the order both sides touch them. */
export const MINTSOFT_DELTA_CURSOR_KEYS = ['mintsoft_order_delta_since', 'mintsoft_order_reconcile_at'] as const

/**
 * The cursor rows PLUS the generation row, read as one set.
 *
 * The generation is read in the same `findMany` as the cursors, not in a follow-up query, for the
 * same reason r4 moved the scope read inside the lock: evidence assembled across two statements can
 * describe two different moments, and a fence that judges from it is deciding about a state that
 * never existed. One statement, inside the transaction that already holds the dispatch rows
 * `FOR UPDATE`, cannot straddle a reset.
 */
export const MINTSOFT_DELTA_STATE_KEYS = [...MINTSOFT_DELTA_CURSOR_KEYS, MINTSOFT_DELTA_GENERATION_KEY] as const

/**
 * q66in.7.2 r4 (Codex r3 finding 2) — READ THE CURSORS AND THE SCOPE THEY BELONG TO ATOMICALLY.
 *
 * Round 3's compare-and-swap is only as good as the pairing it compares. The token it checks against
 * is supposed to be "the scope these cursors were read under", and the production wiring did not
 * produce that: it issued a `findMany` for the two cursor rows and THEN a separate, unlocked
 * `getMintsoftSettings()` for the scope. A scope change committing between those two reads hands the
 * run an OLD-scope watermark paired with a NEW-scope token — and the CAS at save time then compares
 * new against new, passes, and writes the old-scope watermark straight back over the reset. The
 * guard was defeated by the very interleaving it was built for, because the evidence it decides from
 * was assembled across the window rather than inside it.
 *
 * Both rows are read in ONE transaction holding the SAME five-row dispatch lock the save takes, so
 * the pair is provably consistent: whichever transaction takes the lock first runs to completion,
 * and the other sees the result. A run that reads before the change gets (old cursors, old token)
 * and is refused at save time; one that reads after gets (cleared cursors, new token) and correctly
 * restarts from the lookback window.
 *
 * LOCK ORDER is the same on every path that touches these rows — the five dispatch keys, then the
 * two cursor keys — so the read, the save and the settings write cannot cycle.
 */
export async function readMintsoftDeltaCursors(
  tx: MintsoftDeltaCursorReadTx,
  lockScope: (tx: MintsoftDeltaCursorReadTx) => Promise<MintsoftDeltaScope>,
): Promise<{ watermark: string | null; lastReconcile: string | null; scope: string; generation: number | null }> {
  const scope = mintsoftDeltaScopeToken(await lockScope(tx))
  const rows = await tx.setting.findMany({
    where: { key: { in: [...MINTSOFT_DELTA_STATE_KEYS] } },
    select: { key: true, value: true },
  })
  const map = new Map(rows.map((row) => [row.key, row.value]))
  const generation = parseMintsoftDeltaGeneration(map.get(MINTSOFT_DELTA_GENERATION_KEY) ?? null)

  // o3d-hl8l r6 (Codex r5 finding 3). THE CAS AT SAVE TIME ONLY BINDS WRITERS THAT RUN IT. A
  // mixed-version deployment — a rolling restart, or a rollback — puts an instance from before the
  // fence in front of this same row, and that instance writes a bare timestamp through code paths
  // that never look at the generation at all. So the attribution is read out of the VALUE here:
  // a cursor that cannot be placed in the current reset chain is treated as ABSENT, which restarts
  // the delta from the lookback window instead of resuming from a claim nobody can vouch for.
  const decoded = {
    watermark: decodeMintsoftDeltaCursor(map.get('mintsoft_order_delta_since') ?? null, generation),
    lastReconcile: decodeMintsoftDeltaCursor(map.get('mintsoft_order_reconcile_at') ?? null, generation),
  }
  for (const [name, result] of Object.entries(decoded)) {
    // 'absent' is the ordinary cold start and says nothing worth a line in the log.
    if (result.refusal && result.refusal !== 'absent') {
      console.warn(
        `[wms-dispatch-sweep] the inbound delta ${name} cursor cannot be attributed to reset generation `
          + `${generation === null ? 'unreadable' : generation} (${result.refusal}) — ignoring it and `
          + 'restarting from the lookback window rather than resuming from a claim this installation cannot place',
      )
    }
  }

  return {
    watermark: decoded.watermark.value,
    lastReconcile: decoded.lastReconcile.value,
    scope,
    generation,
  }
}

/**
 * o3d-hl8l r5 (Codex r4 finding 2) — THE RESET, AS ONE OPERATION BOTH SIDES SHARE.
 *
 * Clearing the cursors and minting the next generation is a single indivisible fact: cursors gone,
 * and every sweep that read the old ones now unable to write. Splitting them across the settings
 * action (which cleared) and this module (which fenced) is how the two drifted into answering
 * different questions in the first place, so the reset lives here, beside the fence it arms, and
 * `saveMintsoftOrderDispatchSettings` calls it.
 *
 * The caller MUST already hold the five dispatch setting rows `FOR UPDATE` — that lock is what makes
 * the read-then-increment below a serialized chain rather than a race between two resets. It is not
 * re-taken here, because taking it twice in one transaction would say the ordering is this
 * function's to establish when it is the caller's.
 */
export async function resetMintsoftDeltaCursors(tx: MintsoftDeltaResetTx): Promise<{ generation: number }> {
  const rows = await tx.setting.findMany({
    where: { key: { in: [MINTSOFT_DELTA_GENERATION_KEY] } },
    select: { key: true, value: true },
  })
  const current = parseMintsoftDeltaGeneration(rows[0]?.value ?? null)
  const generation = nextMintsoftDeltaGeneration(current)

  await tx.setting.deleteMany({ where: { key: { in: [...MINTSOFT_DELTA_CURSOR_KEYS] } } })
  await tx.setting.upsert({
    where: { key: MINTSOFT_DELTA_GENERATION_KEY },
    create: { key: MINTSOFT_DELTA_GENERATION_KEY, value: String(generation) },
    update: { value: String(generation) },
  })
  return { generation }
}

export type MintsoftDeltaCursorWriteResult =
  | { written: true }
  | { written: false; reason: 'cursors_reset' | 'generation_unknown' }

/**
 * o3d-hl8l r5 (Codex r4 finding 2) — REFUSE, RATHER THAN MERGE, AND DECIDE FROM THE GENERATION.
 *
 * REFUSAL RATHER THAN MERGE, deliberately. A watermark is not a set of facts that can be combined:
 * it is one claim — "every changed order up to this instant has been applied" — and a run whose
 * cursors were reset underneath it never established that claim for the new scope. There is nothing
 * to merge with the cleared state, and taking the later of the two values would pick precisely the
 * wrong one, because the RESET is the newer decision and the sweep's watermark is the older one
 * wearing a fresher timestamp. So the advance is dropped whole and the next pass starts from the
 * lookback window, which is what the reset asked for.
 *
 * WHY THE GENERATION AND NOT THE SCOPE TOKEN — see `MINTSOFT_DELTA_GENERATION_KEY`. The token is a
 * function of the current scope, so a scope changed and changed back compares equal and the stale
 * write goes through; the generation is minted once per committed reset under the dispatch row lock,
 * so it never returns to a value a running sweep can be carrying. The comparison is an equality on
 * numbers from one serialized writer chain — a lock ordering, not a clock reading, and no host
 * participates.
 *
 * AN UNATTRIBUTABLE WRITE APPLIES NO CHANGE AT ALL. A caller that supplies a scope but NO generation
 * read its cursors without ever seeing the generation row, so nothing about its write can be placed
 * in the chain. It is refused rather than waved through on the weaker token — guessing here is
 * exactly the ABA hole this replaces. A caller that supplies NEITHER asks for no check; that is an
 * absent question, not an unanswerable one, and the two are kept distinguishable in the payload
 * precisely so they can be treated differently.
 *
 * o3d-hl8l r6 (Codex r5 finding 3) — AND EVERY WRITE IS STAMPED, INCLUDING THE UNCHECKED ONE. The
 * CAS above binds writers that execute it, which a mixed-version instance does not; the durable half
 * of the fence is the generation written INTO the cursor value, which the reader checks (see
 * `decodeMintsoftDeltaCursor`). So the generation is now read under the lock on EVERY path — for the
 * comparison when one was asked for, and for the stamp always. The unchecked path therefore takes
 * the lock too: a stamp read outside it could name a generation the reset had already moved past,
 * which would write a cursor that is a lie rather than a refusal.
 */
export async function saveMintsoftDeltaCursors(
  tx: MintsoftDeltaCursorTx,
  state: { watermark?: string; lastReconcile?: string; scope?: string | null; generation?: number | null },
  lockScope: (tx: MintsoftDeltaCursorTx) => Promise<MintsoftDeltaScope>,
): Promise<MintsoftDeltaCursorWriteResult> {
  if (state.scope != null && state.generation == null) {
    console.warn(
      '[wms-dispatch-sweep] the inbound delta cursor write carries no reset generation, so it '
        + 'cannot be shown to be current — discarding the cursor advance',
    )
    return { written: false, reason: 'generation_unknown' }
  }

  // The lock is taken for its ORDERING, not for the scope it returns: holding the dispatch rows is
  // what makes the generation read below and the reset that would move it mutually exclusive.
  await lockScope(tx)
  const rows = await tx.setting.findMany({
    where: { key: { in: [MINTSOFT_DELTA_GENERATION_KEY] } },
    select: { key: true, value: true },
  })
  const current = parseMintsoftDeltaGeneration(rows[0]?.value ?? null)

  if (state.generation != null) {
    if (current === null || current !== state.generation) {
      console.warn(
        '[wms-dispatch-sweep] the inbound delta cursors were reset during this pass (generation '
          + `${state.generation} → ${current === null ? 'unreadable' : current}) — discarding the `
          + 'cursor advance rather than restoring the cursors the reset cleared',
      )
      return { written: false, reason: 'cursors_reset' }
    }
  } else if (current === null) {
    // No comparison was asked for, but a cursor still has to be STAMPED with a generation the
    // reader can order, and there is no such number here. Writing it unstamped would leave a value
    // the reader must then refuse — a cursor that never advances — so refuse at the write instead,
    // where the reason is visible.
    console.warn(
      '[wms-dispatch-sweep] the reset generation row is unreadable, so a cursor written now could '
        + 'not be attributed by any later reader — discarding the cursor advance',
    )
    return { written: false, reason: 'generation_unknown' }
  }

  const stamp = current ?? 0
  if (state.watermark !== undefined) {
    const value = encodeMintsoftDeltaCursor(stamp, state.watermark)
    await tx.setting.upsert({
      where: { key: 'mintsoft_order_delta_since' },
      create: { key: 'mintsoft_order_delta_since', value },
      update: { value },
    })
  }
  if (state.lastReconcile !== undefined) {
    const value = encodeMintsoftDeltaCursor(stamp, state.lastReconcile)
    await tx.setting.upsert({
      where: { key: 'mintsoft_order_reconcile_at' },
      create: { key: 'mintsoft_order_reconcile_at', value },
      update: { value },
    })
  }
  return { written: true }
}

/** Prisma + active-connector wiring of the deps. */
export function createPrismaDispatchDeps(connectorId: WmsConnectorId, connector: WmsConnector): WmsDispatchSweepDeps {
  // Per-connector so one WMS drifting cannot suppress (or unsuppress) another's
  // quarantine bound.
  const unresolvedStreakKey = unresolvedDriftStateKey(connectorId)
  return {
    async listCandidates(limit) {
      const rows = await db.wmsOrderPushLink.findMany({
        where: dispatchCandidateWhere(connectorId),
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
            // o3d-bjc.9: a QUARANTINED link is out of the sweep for the same reason a
            // dead-lettered one is — its record cannot be read, so re-polling it every
            // tick only pins the watermark. It comes back when an operator acts.
            dispatchUnresolvedAt: null,
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
            // o3d-bjc.9: a QUARANTINED link is out of the sweep for the same reason a
            // dead-lettered one is — its record cannot be read, so re-polling it every
            // tick only pins the watermark. It comes back when an operator acts.
            dispatchUnresolvedAt: null,
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
    // Complete claimant count for the merge ambiguity guard: EVERY link on this
    // connector that stores the number, with NO state / dead-letter / order-status
    // filter. A shipped or dead-lettered link sharing a reused number is still a
    // candidate for "which order did this survivor absorb?", so the filtered
    // candidate queries above would under-count and let an ambiguous merge through.
    async countLinksByOrderNumber(orderNumbers) {
      const counts = new Map<string, number>()
      const unique = [...new Set(orderNumbers.filter((n): n is string => Boolean(n)))]
      if (unique.length === 0) return counts
      const CHUNK = 200
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK)
        const rows = await db.wmsOrderPushLink.groupBy({
          by: ['externalOrderNumber'],
          where: { connector: connectorId, externalOrderNumber: { in: chunk } },
          _count: { _all: true },
        })
        for (const row of rows) {
          if (row.externalOrderNumber) counts.set(row.externalOrderNumber, row._count._all)
        }
        // A number with no rows at all still needs an explicit 0 rather than a
        // missing key, which the caller would otherwise read as "cannot count".
        for (const number of chunk) if (!counts.has(number)) counts.set(number, 0)
      }
      return counts
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
          // o3d-bjc.9: a QUARANTINED link is out of the sweep for the same reason a
          // dead-lettered one is — its record cannot be read, so re-polling it every
          // tick only pins the watermark. It comes back when an operator acts.
          dispatchUnresolvedAt: null,
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
            // The cursors AND the scope they belong to, read in one transaction under the same
            // five-row lock the save takes (q66in.7.2 r4). Two separate unlocked reads could pair
            // an old-scope watermark with a new-scope token, which is exactly what makes the CAS
            // at save time wave the stale advance through — see readMintsoftDeltaCursors.
            return db.$transaction((tx) => readMintsoftDeltaCursors(tx, lockMintsoftDispatchSettings))
          },
          async saveDeltaState(state: { watermark?: string; lastReconcile?: string; scope?: string | null; generation?: number | null }) {
            await db.$transaction((tx) => saveMintsoftDeltaCursors(tx, state, lockMintsoftDispatchSettings))
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
          // ...and so does the unresolved streak (o3d-bjc.9): the record that
          // could not be read was the OLD order's. The survivor gets a clean slate.
          dispatchUnresolvedCount: 0,
          dispatchUnresolvedError: null,
          dispatchUnresolvedAt: null,
          // The survivor is a DIFFERENT WMS order — reconcile recency resets too.
          reconcileCheckedAt: null,
        },
      })
    },
    /**
     * o3d-rbyg: the durable withdrawal evidence for a batch of orders, read LOCALLY — the IMS
     * markers, or a standing WooCommerce suppression tombstone.
     *
     * Delegated to the withdrawal module rather than re-queried here (round 2): the exception inbox
     * has to explain the very refusal this screen produces, and two copies of the query are how the
     * fence and its explanation drift apart. Dynamically imported so the connector-agnostic sweep
     * does not statically depend on a storefront connector.
     */
    async screenWithdrawnOrders(orderIds) {
      const { screenLocalWithdrawalEvidence } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      return screenLocalWithdrawalEvidence(orderIds)
    },
    async parkWithdrawn(candidate, reason) {
      // Compare-and-set on the stamp being absent, exactly as the dead-letter and quarantine paths
      // do: an overlapping sweep must not park the same link twice and raise two alerts.
      const updated = await db.wmsOrderPushLink.updateMany({
        where: { id: candidate.linkId, dispatchDeadLetteredAt: null },
        data: { dispatchDeadLetteredAt: new Date(), dispatchLastError: reason },
      })
      // Already parked by a concurrent run: the link IS out of the sweep, which is what the caller
      // needs to know. Reporting false would make it hold the watermark for a link it can never see
      // again — the same trap quarantineUnresolved documents.
      if (updated.count === 0) {
        const existing = await db.wmsOrderPushLink.findUnique({
          where: { id: candidate.linkId },
          select: { dispatchDeadLetteredAt: true },
        })
        return { parked: Boolean(existing?.dispatchDeadLetteredAt) }
      }

      // COMMITTED above. Everything below is audit and alerting; a failure here must not report the
      // park as having failed.
      try {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: candidate.orderId,
          tag: 'sync',
          action: 'wms_dispatch_withheld_withdrawn',
          description: `Dispatch reconciliation refused for WMS order ${candidate.externalOrderNumber}: ${reason}`,
          metadata: {
            orderId: candidate.orderId,
            externalOrderNumber: candidate.externalOrderNumber,
            connector: connectorId,
            withdrawalFence: true,
          },
          level: 'WARNING',
          resolveUser: false,
        })
        // Individually, never a broadcast: a null userId would expose order details to
        // READONLY/SUPPLIER users (same reasoning as the dead-letter and quarantine alerts).
        const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
        await Promise.all(admins.map((admin) => notify({
          userId: admin.id,
          type: 'error',
          title: 'Dispatch withheld — withdrawal standing',
          message: `Order ${candidate.externalOrderNumber} is withdrawn (or has a withdrawal standing against it) `
            + 'but the WMS reports it active. IMS did NOT mark it shipped or email the customer. '
            + 'Cancel it at the WMS — or, if the goods have already gone, record the despatch from the '
            + 'exception inbox so the stock and the sub-ledger match reality.',
          actionUrl: '/sync/exceptions',
        })))
      } catch (alertError) {
        console.error('[wms-dispatch-sweep] withdrawal park alerting failed:', alertError)
      }
      return { parked: true }
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
    // --- o3d-bjc.9: unresolved-record streak + quarantine -------------------
    async recordUnresolvedRead(candidate, reason) {
      const link = await db.wmsOrderPushLink.update({
        where: { id: candidate.linkId },
        data: { dispatchUnresolvedCount: { increment: 1 }, dispatchUnresolvedError: reason },
        select: { dispatchUnresolvedCount: true },
      })
      return { count: link.dispatchUnresolvedCount }
    },
    async clearUnresolvedReads(linkId) {
      // Only touch rows that actually carry streak state, so the happy path
      // stays write-free (same shape as clearDispatchFailures).
      await db.wmsOrderPushLink.updateMany({
        where: {
          id: linkId,
          OR: [
            { dispatchUnresolvedCount: { gt: 0 } },
            { dispatchUnresolvedError: { not: null } },
            { dispatchUnresolvedAt: { not: null } },
          ],
        },
        data: { dispatchUnresolvedCount: 0, dispatchUnresolvedError: null, dispatchUnresolvedAt: null },
      })
    },
    async quarantineUnresolved(candidate, reason, count) {
      // Compare-and-set, like the dead-letter path: an overlapping sweep whose
      // read RESOLVED clears the streak between our count and this write, and
      // that success must veto the quarantine — the count has to still be at the
      // cap when we commit.
      const updated = await db.wmsOrderPushLink.updateMany({
        where: {
          id: candidate.linkId,
          dispatchUnresolvedAt: null,
          dispatchUnresolvedCount: { gte: DISPATCH_MAX_CONSECUTIVE_UNRESOLVED },
        },
        data: { dispatchUnresolvedAt: new Date(), dispatchUnresolvedError: reason },
      })
      // COMMITTED. Everything below is audit and alerting: if it throws, the row
      // is already out of the candidate set, and reporting {quarantined:false}
      // would make the caller hold the watermark for a link it can never see
      // again — a silently parked order. Failures are logged, never propagated.
      if (updated.count === 0) return { quarantined: false }

      try {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: candidate.orderId,
        tag: 'sync',
        action: 'wms_dispatch_unresolved_quarantined',
        description: `Dispatch reconciliation quarantined after ${count} consecutive unresolved reads `
          + `(WMS order ${candidate.externalOrderNumber}): ${reason}`,
        metadata: {
          orderId: candidate.orderId,
          externalOrderNumber: candidate.externalOrderNumber,
          connector: connectorId,
          unresolvedCount: count,
          lastReason: reason,
        },
        level: 'WARNING',
        resolveUser: false,
      })

      // Individually, not a broadcast: a null userId would expose order details
      // to READONLY/SUPPLIER users (same reasoning as the dead-letter alert).
      const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
      await Promise.all(admins.map((admin) => notify({
        userId: admin.id,
        type: 'error',
        title: 'WMS record unreadable',
        message: `Order ${candidate.externalOrderNumber} cannot be read from the WMS (${count} consecutive `
          + 'unresolved reads). It has been quarantined so it stops holding the inbound sync back, and '
          + 'needs attention in the sync exception inbox.',
        actionUrl: '/sync/exceptions',
      })))
      } catch (auditError) {
        console.error(
          `[wms-dispatch-sweep] quarantined ${candidate.externalOrderNumber} but could not record/announce it:`,
          auditError,
        )
      }

      return { quarantined: true }
    },
    async probeControlLinks(excludeLinkIds, limit) {
      // Deliberately the SAME eligibility as the sweep's own candidates: a
      // control drawn from links the sweep would never touch proves nothing
      // about the reads it actually makes.
      const rows = await db.wmsOrderPushLink.findMany({
        where: {
          connector: connectorId,
          state: { in: ['SYNCED', 'MERGED'] },
          externalOrderNumber: { not: null },
          dispatchDeadLetteredAt: null,
          dispatchUnresolvedAt: null,
          id: { notIn: excludeLinkIds },
          order: { status: { notIn: [...POST_DISPATCH_STATUSES] } },
        },
        select: { externalOrderNumber: true },
        take: Math.max(0, limit),
        orderBy: [{ dispatchReconcileCheckedAt: { sort: 'desc', nulls: 'last' } }, { pushedAt: 'desc' }],
      })
      let probed = 0
      let resolved = 0
      let representative = 0
      for (const row of rows) {
        if (!row.externalOrderNumber) continue
        probed += 1
        try {
          // A READ is all we need: whether the connector can answer at all.
          // Nothing is applied from it, so a control can never write.
          const status = await (connector.fetchOrderStatus
            ? connector.fetchOrderStatus(row.externalOrderNumber)
            : Promise.resolve(null))
          if (!status) continue
          resolved += 1
          // Only a complete DISPATCHED record exercises the invariant the cohort
          // failed. A pending order resolving proves the endpoint is up, not
          // that despatch records are still readable — and a connector that
          // returns a DISPATCHED row has already passed its own completeness
          // guard (an incomplete despatch raises WmsUnresolvableRecordError
          // rather than returning).
          if (!status.dispatched) continue
          // ...and the SAME PATHS, not just the status endpoint. Unresolved
          // outcomes also come from split enumeration and part-item reads, so a
          // connector-wide fetchOrderParts degradation would leave one ordinary
          // non-split order answering perfectly while every split order breaks.
          // Treating that as healthy evidence is how the breaker would come to
          // quarantine the very cohort it exists to protect.
          if (connector.fetchOrderParts) {
            const parts = await connector.fetchOrderParts(row.externalOrderNumber)
            if (connector.fetchOrderPartItems) {
              const probePart = parts.find((entry) => entry.externalId)
              if (probePart?.externalId) await connector.fetchOrderPartItems(probePart.externalId)
            }
          }
          representative += 1
        } catch {
          // Counted as probed-but-unresolved: that is the evidence we wanted.
        }
      }
      return { probed, resolved, representative }
    },
    async getUnresolvedDriftState() {
      const row = await db.setting.findUnique({ where: { key: unresolvedStreakKey }, select: { value: true } })
      const empty = { consecutive: 0, cohortKey: null as string | null, stableFor: 0 }
      if (!row?.value) return empty
      try {
        const parsed = JSON.parse(row.value) as Partial<WmsUnresolvedDriftState>
        return {
          consecutive: Number.isFinite(parsed.consecutive) ? Math.max(0, Number(parsed.consecutive)) : 0,
          cohortKey: typeof parsed.cohortKey === 'string' ? parsed.cohortKey : null,
          stableFor: Number.isFinite(parsed.stableFor) ? Math.max(0, Number(parsed.stableFor)) : 0,
          // o3d-bjc.12: the operator-facing evidence rides in the same row.
          firstSeenAt: typeof parsed.firstSeenAt === 'string' ? parsed.firstSeenAt : null,
          linkIds: Array.isArray(parsed.linkIds)
            ? parsed.linkIds.filter((id): id is string => typeof id === 'string')
            : [],
          touched: Number.isFinite(parsed.touched) ? Math.max(0, Number(parsed.touched)) : 0,
          reason: typeof parsed.reason === 'string' ? parsed.reason : null,
          lastSeenAt: typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : null,
        }
      } catch {
        // Unreadable state is NO state: start over rather than infer a cohort
        // that was never observed.
        return empty
      }
    },
    async saveUnresolvedDriftState(state) {
      // Reports whether it REACHED DISK. The verdict never depends on this — an
      // observability write must not reclassify drift — but escalation counting
      // and cohort-stability detection do.
      try {
        const next = JSON.stringify(state)
        await db.setting.upsert({
          where: { key: unresolvedStreakKey },
          create: { key: unresolvedStreakKey, value: next },
          update: { value: next },
        })
        return true
      } catch (error) {
        console.error('[wms-dispatch-sweep] could not persist the unresolved-drift state:', error)
        return false
      }
    },
    async reportUnresolvedDrift({ linkCount, touched, reason, consecutivePasses }) {
      // ONE incident for the whole cohort, deduplicated per connector per day:
      // the point of the circuit breaker is that drift does not produce N alerts.
      const today = new Date().toISOString().slice(0, 10)
      const dedupeKey = `wms_dispatch_unresolved_drift:${connectorId}:${today}`
      const claimed = await db.setting.createMany({
        data: [{ key: dedupeKey, value: String(linkCount) }],
        skipDuplicates: true,
      })
      if (claimed.count === 0) return

      // The claim is provisional until the alert is actually OUT. Releasing it
      // on failure is what makes the next pass retry: otherwise one transient
      // error silences the primary admin alert for the rest of the UTC day,
      // while inbound sync stays held back the whole time.
      try {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: 'wms_dispatch_unresolved_drift',
        description: `${linkCount} of ${touched} WMS links were unresolvable in one dispatch pass `
          + `(${consecutivePasses} consecutive pass(es)) — treated as connector-wide drift, so none were `
          + `quarantined: ${reason}`,
        metadata: { connector: connectorId, linkCount, touched, reason, consecutivePasses },
        level: 'ERROR',
        resolveUser: false,
      })

      const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
      await Promise.all(admins.map((admin) => notify({
        userId: admin.id,
        type: 'error',
        title: 'WMS records unreadable across the board',
        message: `${linkCount} of ${touched} orders could not be read from the WMS in one pass`
          + `${consecutivePasses > 1 ? `, for ${consecutivePasses} passes running` : ''}. This looks like a `
          + 'connector-wide change rather than broken orders, so nothing has been quarantined — they will '
          + 'recover automatically once it is fixed. Inbound dispatch sync is held back until it is.',
        actionUrl: '/sync',
      })))
      } catch (publishError) {
        await db.setting.deleteMany({ where: { key: dedupeKey } }).catch(() => {})
        throw publishError
      }
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
  const clientScoped = isDispatchClientScoped(connectorId, deltaClientIdSetting)
  // Round-5 #3 regression fix: on the shared Mintsoft tenant EVERY per-order
  // lookup (Search/detail/parts) now requires a ClientId and throws without one.
  // The old "delta off, fall back to per-order reconcile" path would therefore
  // throw for every candidate, accrue consecutive-failure strikes, and
  // dead-letter every active link. So when Mintsoft is unscoped we SKIP the whole
  // sweep (no candidates touched, no strikes) rather than run a reconcile that
  // can only fail — a blank ClientId cleanly DISABLES Mintsoft dispatch sync.
  if (!clientScoped) {
    return {
      ...empty,
      status: 'SKIPPED',
      skippedReason: 'Mintsoft dispatch sync is disabled until mintsoft_client_id is configured (Sync settings) — skipped to avoid unscoped cross-client lookups',
    }
  }
  const coreOptions: WmsDispatchSweepCoreOptions = {
    batchSize: options?.batchSize,
    deltaEnabled: deltaEnabledSetting !== 'false' && clientScoped,
    deltaTimeZone: deltaTimeZoneSetting || DISPATCH_DELTA_DEFAULT_TIMEZONE,
  }

  // o3d-bjc.9: one sweep per connector at a time. Each run counts a link's
  // unresolved read once, so overlapping runs would spend the five-pass
  // quarantine budget on ONE transient incident — the cap is meant to mean
  // "five passes apart", not "five callers at once". Skip rather than queue:
  // the holder is doing this work right now.
  const locked = await withDispatchSweepLockOrSkip(connectorId, () =>
    runWmsDispatchSweepLocked(connectorId, connector, deps, coreOptions, triggeredBy))
  if ('lockSkipped' in locked) {
    return { ...empty, status: 'SKIPPED', skippedReason: 'Another dispatch sweep for this connector is already running' }
  }
  return locked
}

async function runWmsDispatchSweepLocked(
  connectorId: WmsConnectorId,
  connector: WmsConnector,
  deps: WmsDispatchSweepDeps,
  coreOptions: WmsDispatchSweepCoreOptions,
  triggeredBy: string,
): Promise<WmsDispatchSweepResult> {
  const empty = { jobId: null as string | null, totalChecked: 0, dispatched: 0, pending: 0, errors: 0 }
  void connector
  const startedAt = new Date()
  const job = await db.wmsSyncJob.create({
    data: { connector: connectorId, type: 'DISPATCH_SYNC', status: 'RUNNING', startedAt, triggeredBy },
    select: { id: true },
  })

  // Hoisted so a failure during persistence still reports the work the core did.
  let counters: WmsDispatchCounters = { totalChecked: 0, dispatched: 0, pending: 0, errors: 0, withheld: 0, deferred: 0 }

  try {
    const core = await runWmsDispatchSweepCore(deps, coreOptions)
    counters = core.counters
    const {
      logs, deltaError, unresolved, deltaWindowTruncated, deltaCoverageIncomplete,
      deltaPreloadServed, deltaAuthoritativeRereads, deltaRowCount,
      unresolvedQuarantined, unresolvedSystemic, withdrawalScreenFailures,
    } = core

    if (logs.length > 0) {
      // Map the dispatch outcomes onto the shared WmsSyncLogAction enum; the detail lives
      // in `reason`.
      const actionForLog: Record<WmsDispatchLog['action'], 'corrected' | 'noop' | 'error'> = {
        dispatched: 'corrected',
        pending: 'noop',
        error: 'error',
        // o3d-rbyg: a refused fulfilment is an EXCEPTION, not a quiet no-op. It is logged as an
        // error row so the job's own log shows it; the link's dead-letter stamp is what puts it in
        // the exception inbox, and `resolveDispatchJobOutcome` reads counters, not these rows, so
        // this does not silently fail the job.
        withheld: 'error',
        // o3d-rbyg round 2: a DEFERRED link is not an error against the order — nothing is wrong
        // with it and nothing was written. It is a noop row so the job's log still shows the pass
        // saw it and chose not to act; the screen failure itself is the error row raised below.
        deferred: 'noop',
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

    // o3d-rbyg round 2: the same treatment for a screen that could not be read. The deferral is
    // deliberate and safe, but a shop whose withdrawal screen has been failing for a day would
    // otherwise see only SUCCEEDED jobs and a warehouse that had stopped despatching.
    if (withdrawalScreenFailures > 0) {
      await db.wmsSyncLog.create({
        data: {
          jobId: job.id,
          sku: null,
          productId: null,
          action: 'error',
          reason: `The withdrawal screen failed on ${withdrawalScreenFailures} candidate list(s) — `
            + `${counters.deferred} link(s) were DEFERRED rather than dispatched, because this pass could not `
            + 'prove no withdrawal stands against them. Nothing was shipped and nothing was parked; they are '
            + 'retried next sweep.',
          payload: { withdrawalScreenFailure: true, connector: connectorId, deferred: counters.deferred } as Prisma.InputJsonValue,
        },
      })
    }

    // A clamped delta window is a degraded primary path in its own right (the
    // watermark can no longer cover its backlog); log it distinctly so an operator
    // sees WHY the job is PARTIAL, not just that it is.
    if (deltaWindowTruncated) {
      await db.wmsSyncLog.create({
        data: {
          jobId: job.id,
          sku: null,
          productId: null,
          action: 'error',
          reason:
            'Inbound Order/List delta watermark is older than the lookback window — the query window is clamped '
            + 'and cannot cover the gap; the watermark is held until a reconcile pass verifies every active link',
          payload: { deltaWindowTruncated: true, connector: connectorId } as Prisma.InputJsonValue,
        },
      })
    }

    // Say out loud when the fast path is DEAD (o3d-9vv). A fail-safe fallback made a
    // completely dead optimisation indistinguishable from a healthy run, so the
    // condition worth surfacing is "the delta returned rows yet served none of them
    // fetch-free" — that is the exact production symptom.
    //
    // Logged only when it holds, NOT once per run: an unconditional row would add
    // ~263k rows/year at a 2-minute cadence to a table with no retention sweep, and a
    // healthy signal nobody reads is not observability (Codex).
    if (deltaRowCount > 0 && deltaPreloadServed === 0) {
      await db.wmsSyncLog.create({
        data: {
          jobId: job.id,
          sku: null,
          productId: null,
          action: 'error',
          reason: `Inbound Order/List delta returned ${deltaRowCount} rows but served NONE without a `
            + `per-order fetch (${deltaAuthoritativeRereads} needed an authoritative re-read) — the delta `
            + 'optimisation is not engaging; check the page Limit, the status map, and row completeness',
          payload: {
            deltaEngaged: false,
            deltaRowCount,
            deltaPreloadServed,
            deltaAuthoritativeRereads,
            connector: connectorId,
          } as Prisma.InputJsonValue,
        },
      })
    }

    // o3d-bjc.9: both halves of the unresolved decision are recorded, because
    // "nothing was quarantined" means opposite things depending on which fired —
    // no cohort at all, or a cohort large enough to be read as drift.
    if (unresolvedQuarantined > 0 || unresolvedSystemic) {
      await db.wmsSyncLog.create({
        data: {
          jobId: job.id,
          sku: null,
          productId: null,
          action: 'error',
          reason: unresolvedSystemic
            ? `${unresolved} link(s) unresolved at once — read as connector-wide drift, so NONE were `
              + 'quarantined and every link stays eligible to recover automatically'
            : `${unresolvedQuarantined} link(s) quarantined after ${DISPATCH_MAX_CONSECUTIVE_UNRESOLVED} `
              + 'consecutive unresolved reads — they no longer hold the delta watermark and need '
              + 'attention in the sync exception inbox',
          payload: {
            unresolved,
            unresolvedQuarantined,
            unresolvedSystemic,
            connector: connectorId,
          } as Prisma.InputJsonValue,
        },
      })
    }

    const { status, effectiveErrors } = resolveDispatchJobOutcome(counters.errors, deltaError, {
      unresolved,
      deltaWindowTruncated,
      deltaCoverageIncomplete,
      withdrawalScreenFailures,
    })
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

    if (counters.dispatched > 0 || effectiveErrors > 0 || counters.withheld > 0 || counters.deferred > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'sync',
        action: deltaError ? 'wms_dispatch_sync_degraded' : 'wms_dispatch_sync',
        // o3d-rbyg round 2: a pass that deferred links is degraded in the same way a delta failure
        // is — fulfilment did not happen, and the reason was ours.
        level: deltaError || counters.deferred > 0 ? 'WARNING' : undefined,
        description: deltaError
          ? `WMS dispatch sync (${connectorId}) DEGRADED — inbound delta failed, ran per-order reconcile fallback: ${counters.totalChecked} checked, ${counters.dispatched} dispatched, ${counters.errors} order errors. Delta error: ${deltaError}`
          : `WMS dispatch sync (${connectorId}): ${counters.totalChecked} checked, ${counters.dispatched} dispatched, ${counters.errors} errors`
            + (counters.withheld > 0 ? `, ${counters.withheld} withheld (withdrawal standing)` : '')
            + (counters.deferred > 0 ? `, ${counters.deferred} deferred (withdrawal screen unreadable)` : '')
            + '.',
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
