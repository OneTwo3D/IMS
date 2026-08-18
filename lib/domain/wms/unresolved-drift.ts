import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { dispatchCandidateWhere, type WmsUnresolvedDriftState } from '@/lib/domain/wms/dispatch-sweep'

/**
 * o3d-bjc.12: the operator's side of an indeterminate unresolved cohort.
 *
 * The dispatch sweep refuses to mass-quarantine a cohort it cannot prove is
 * record-local (o3d-bjc.9): with no healthy control to compare against, "these
 * records are broken" and "this connector is broken" look identical, and
 * isolating on a guess takes a whole tenant out of sync for a fault one fix
 * would have cleared. So it holds the watermark and alerts.
 *
 * That is the right default and an incomplete one. On a quiet tenant whose only
 * active orders ARE the unreadable ones, no control can ever exist, so the
 * sweep alerts daily and the cursor never moves. The missing piece is not a
 * cleverer heuristic — it is the ability to OFFER the decision to a human.
 *
 * This module is that offer: read the incident the sweep persisted, and act on
 * it. Isolating is deliberately the operator's call, and deliberately reuses
 * the same quarantine the sweep would have applied, so each order lands in the
 * exception inbox as an ordinary replayable row.
 */

/** Where the sweep persists its drift state, per connector. */
export function unresolvedDriftStateKey(connector: string): string {
  return `wms_dispatch_unresolved_streak:${connector}`
}

export type UnresolvedDriftIncident = {
  connector: string
  /** Links the sweep could not classify, and could not prove were record-local. */
  linkCount: number
  /** How many links that pass decided an outcome for — the ratio's denominator. */
  touched: number
  /** Consecutive passes read as drift. */
  consecutivePasses: number
  /** Passes this exact cohort has persisted for. */
  stableFor: number
  firstSeenAt: string | null
  reason: string | null
  linkIds: string[]
  /**
   * A digest of the state EXACTLY as stored when this incident was read.
   *
   * The operator decides from a rendered page, and a sweep can replace the
   * cohort between the render and the click. The advisory lock only covers the
   * action itself, so without carrying this the click would isolate whatever
   * cohort happens to be current — orders nobody reviewed. The action refuses
   * unless the stored state still hashes to what the page showed.
   */
  version: string
}

/**
 * A digest of the DECISION-RELEVANT part of an incident: which connector, and
 * which links.
 *
 * Deliberately not the whole stored row. Every drift pass rewrites the counters,
 * so hashing the raw value would invalidate an operator's open page every sweep
 * interval — they would reload, re-read the same cohort, and race the next tick.
 * What must not change under them is WHO gets isolated; that is what this
 * covers. The raw value is still compared inside the transaction, where the
 * lock makes it a genuine compare-and-set.
 */
export function driftDecisionVersion(input: {
  connector: string
  cohortKey: string | null
  linkIds: string[]
  firstSeenAt: string | null
}): string {
  const material = JSON.stringify({
    connector: input.connector,
    cohortKey: input.cohortKey ?? '',
    linkIds: [...input.linkIds].sort(),
    // ABA (o3d-0gzr). Membership alone cannot tell "the cohort never changed"
    // from "it changed away and back": A -> B -> A rehashes to A's version, so a
    // page rendered against the FIRST occurrence could isolate the second one —
    // a different incident, with its own start time and its own reason.
    //
    // firstSeenAt is the discriminator we already keep: the sweep preserves it
    // while a cohort is stable and resets it whenever membership changes, which
    // is exactly the "generation" this needs. Counter-only ticks leave it alone,
    // so an open page still survives them, which was the point of hashing
    // membership rather than the raw row.
    firstSeenAt: input.firstSeenAt ?? '',
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function parseState(raw: string | null | undefined): WmsUnresolvedDriftState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<WmsUnresolvedDriftState>
    return {
      consecutive: Number.isFinite(parsed.consecutive) ? Math.max(0, Number(parsed.consecutive)) : 0,
      cohortKey: typeof parsed.cohortKey === 'string' ? parsed.cohortKey : null,
      stableFor: Number.isFinite(parsed.stableFor) ? Math.max(0, Number(parsed.stableFor)) : 0,
      firstSeenAt: typeof parsed.firstSeenAt === 'string' ? parsed.firstSeenAt : null,
      linkIds: Array.isArray(parsed.linkIds) ? parsed.linkIds.filter((id): id is string => typeof id === 'string') : [],
      touched: Number.isFinite(parsed.touched) ? Math.max(0, Number(parsed.touched)) : 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      lastSeenAt: typeof parsed.lastSeenAt === 'string' ? parsed.lastSeenAt : null,
    }
  } catch {
    // Unreadable state is NO state — never a half-parsed incident an operator
    // might act on.
    return null
  }
}

/**
 * The incident, if one is live. Null when the sweep is not currently reading
 * this connector as drift — including when it cleared, which RETRACTS the offer.
 */
/**
 * How long an incident stays actionable without the sweep re-confirming it.
 *
 * The sweep rewrites its state every pass it still reads drift, and clears it on
 * a clean one — but that clear can FAIL (an unwritable Setting row), and a stale
 * incident that outlives the condition would offer an operator the chance to
 * quarantine orders the sweep has since found perfectly healthy. So the offer
 * expires: an incident nothing has re-confirmed within this window stops being
 * actionable on its own, whatever is stored.
 */
export const DRIFT_INCIDENT_MAX_AGE_MS = 60 * 60 * 1000

/**
 * How far ahead of us a confirmation may be stamped before we stop believing it.
 *
 * Tolerates ordinary clock jitter between the sweep host and whoever serves the
 * action; anything further ahead is treated as no evidence at all rather than as
 * the freshest possible evidence.
 */
export const DRIFT_INCIDENT_MAX_CLOCK_SKEW_MS = 60 * 1000

export function toIncident(
  connector: string,
  state: WmsUnresolvedDriftState | null,
  raw?: string | null,
  now: Date = new Date(),
): UnresolvedDriftIncident | null {
  if (!state) return null
  // Stale: the sweep has not re-confirmed this in an hour, so either it stopped
  // drifting (and the retraction did not persist) or it stopped running. Either
  // way it is not evidence any more.
  const lastSeen = state.lastSeenAt ? Date.parse(state.lastSeenAt) : NaN
  if (!Number.isFinite(lastSeen)) return null
  const age = now.getTime() - lastSeen
  // A FUTURE confirmation is not a fresh one (o3d-0gzr). The sweep and whoever
  // serves this action need not be the same host, and if the sweep's clock runs
  // ahead the age goes negative — which the "> MAX_AGE" test reads as very
  // recent, keeping a dead incident actionable for the skew PLUS the hour. An
  // unreadable timestamp already fails closed; a future one has to as well, or
  // the expiry is only enforced for clocks that happen to agree. Small
  // allowance so ordinary NTP jitter does not retract a live offer; beyond it
  // the timestamp is not evidence and the sweep's next pass will rewrite it.
  if (age < -DRIFT_INCIDENT_MAX_CLOCK_SKEW_MS || age > DRIFT_INCIDENT_MAX_AGE_MS) return null
  const linkIds = state.linkIds ?? []
  // A live incident is one with a cohort. `consecutive` alone is not enough:
  // the sweep zeroes it the moment a pass reads record-local, and an offer to
  // isolate a cohort nobody is stuck on is worse than no offer.
  if (!state.cohortKey || linkIds.length === 0) return null
  return {
    connector,
    linkCount: linkIds.length,
    touched: state.touched ?? 0,
    consecutivePasses: state.consecutive,
    stableFor: state.stableFor,
    firstSeenAt: state.firstSeenAt ?? null,
    reason: state.reason ?? null,
    linkIds,
    version: driftDecisionVersion({ connector, cohortKey: state.cohortKey, linkIds, firstSeenAt: state.firstSeenAt ?? null }),
  }
}

export async function loadUnresolvedDriftIncidents(
  connectors: readonly string[],
  now: Date = new Date(),
): Promise<UnresolvedDriftIncident[]> {
  if (connectors.length === 0) return []
  const keys = connectors.map(unresolvedDriftStateKey)
  const rows = await db.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } })
  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  return connectors
    .map((connector) => {
      const raw = byKey.get(unresolvedDriftStateKey(connector)) ?? null
      return toIncident(connector, parseState(raw), raw, now)
    })
    .filter((incident): incident is UnresolvedDriftIncident => incident !== null)
}

/**
 * The links this incident names, still eligible and still unresolved.
 *
 * Re-read rather than trusted: the state was written by an earlier pass, and a
 * link that has since recovered, shipped, been cancelled or already been
 * quarantined must not be isolated by a decision taken about a different
 * moment.
 */
export function isolatableLinkWhere(incident: UnresolvedDriftIncident) {
  // The sweep's OWN candidate predicate, not an approximation of it. An order
  // that shipped, completed or was cancelled since the incident was recorded is
  // no longer a dispatch candidate, and quarantining it would invent an
  // exception for an order nobody is waiting on.
  return {
    ...dispatchCandidateWhere(incident.connector),
    id: { in: incident.linkIds },
  }
}

export async function resolveIsolatableLinks(incident: UnresolvedDriftIncident): Promise<string[]> {
  const rows = await db.wmsOrderPushLink.findMany({
    where: isolatableLinkWhere(incident),
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

/** The incident EXACTLY as stored, so an action can compare-and-set on it. */
export async function readRawDriftState(connector: string): Promise<string | null> {
  const row = await db.setting.findUnique({
    where: { key: unresolvedDriftStateKey(connector) },
    select: { value: true },
  })
  return row?.value ?? null
}
