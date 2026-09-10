/**
 * o3d-pzu0 — IS THE PAYMENT-POLL CURSOR ACTUALLY CATCHING UP?
 *
 * The bounded drain (o3d-zdh, drainInvoicesModifiedSince) caps unique progress at
 * MAX_CHUNKS_PER_POLL * MAX_PAGES * PAGE_SIZE rows per run. That bound is deliberate — it stops one
 * backlog poll eating the tenant's whole daily Xero allowance — but it means that at sustained
 * ingress at or above that rate the cursor lag CANNOT shrink. Payment detection is then delayed
 * indefinitely rather than recovering, and nothing says so.
 *
 * NOTHING SAYS SO IS THE DEFECT. The poller already logs `xero_payment_poll_backlog_draining` at
 * WARNING when a drain does not complete in one run. A drain that is chewing through a bulk edit and
 * will be done in three polls logs that; a drain that will never finish logs exactly the same line.
 * An operator who has seen the first kind a few times has learned the line means "it is working".
 *
 * So convergence is decided here, from the lag ACROSS polls, and escalated on a different action at
 * a different level. Pure, and persisted by the caller, so the decision can be pinned without a
 * poller, a clock, or Xero.
 */

/**
 * Below this, lag is the normal steady state and never escalates.
 *
 * The poll runs every 15 minutes and reads from a floor deliberately behind the cursor
 * (CURSOR_OVERLAP_MS), so some lag is always present. An alert that fires in the healthy case is an
 * alert the operator learns to close, which is the failure mode this whole module exists to avoid.
 */
export const LAG_ALERT_FLOOR_MS = 30 * 60_000

/**
 * How much lag a poll must actually REMOVE to count as progress.
 *
 * "Any decrease counts" was rejected, and it is worth writing down why: a drain crawling forward by
 * a second per poll against an hours-long backlog would reset the counter every single time and the
 * stall would never be reported — which is precisely how it hides today. A minute per 15-minute poll
 * is still a backlog that takes days to clear, so this is a very low bar; failing it means the drain
 * is not meaningfully draining.
 */
export const MIN_LAG_PROGRESS_MS = 60_000

/** Consecutive non-progressing polls before the stall is escalated. An hour of not converging. */
export const LAG_STALL_POLLS = 4

export type CursorLagState = {
  /** The lag left behind by the poll that wrote this, in ms. */
  lagMs: number
  /** How many consecutive polls have failed to remove MIN_LAG_PROGRESS_MS of it. */
  stalledPolls: number
}

export type CursorLagAssessment = {
  /** Persist this as the new `xero_payment_poll_lag`. */
  next: CursorLagState
  /**
   * Lag removed since the previous reading. NULL — not zero — when there is no previous reading:
   * "we do not know" and "it made no progress" are different facts, and only one of them is
   * evidence of a stall.
   */
  progressMs: number | null
  /** The drain is running and not converging. Log loudly. */
  escalate: boolean
}

/**
 * Decide whether the drain is converging, given the previous reading and the lag this poll left.
 *
 * A NEGATIVE LAG IS CLAMPED, NOT TRUSTED. The cursor is written from Xero-derived timestamps and the
 * poll start is this host's clock; a cursor slightly ahead of "now" is clock skew between the two,
 * not a negative backlog, and letting it through would make `progressMs` meaningless.
 */
export function assessCursorLag(previous: CursorLagState | null, lagMs: number): CursorLagAssessment {
  const lag = Number.isFinite(lagMs) ? Math.max(0, lagMs) : 0
  const progressMs = previous ? previous.lagMs - lag : null

  // Healthy: the backlog is within a normal poll's reach. Clears the counter, so a drain that
  // recovers is not still holding four polls of history against it.
  if (lag < LAG_ALERT_FLOOR_MS) {
    return { next: { lagMs: lag, stalledPolls: 0 }, progressMs, escalate: false }
  }

  // One reading is not a trend. A first poll (or the first after the setting was cleared) records
  // the lag and claims nothing about it.
  if (previous === null) {
    return { next: { lagMs: lag, stalledPolls: 0 }, progressMs: null, escalate: false }
  }

  // `progressMs < MIN_LAG_PROGRESS_MS` covers BOTH "barely moved" and "moved backwards": lag that
  // GREW is the failure this issue is about, and it must not read as progress through a sign error.
  const stalled = (progressMs as number) < MIN_LAG_PROGRESS_MS
  const stalledPolls = stalled ? previous.stalledPolls + 1 : 0

  return {
    next: { lagMs: lag, stalledPolls },
    progressMs,
    // `>=`, not `===`: the alert must keep firing while the stall lasts. One that stops appearing
    // reads to an operator as one that was resolved.
    escalate: stalledPolls >= LAG_STALL_POLLS,
  }
}

/**
 * Read the persisted state, or NULL for anything that is not a complete, finite reading.
 *
 * Fails to null rather than to zeros: a half-parsed state would be indistinguishable from "the drain
 * has just caught up", which is the one reading that clears the stall counter.
 */
export function parseCursorLagState(raw: unknown): CursorLagState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const lagMs = value.lagMs
  const stalledPolls = value.stalledPolls
  if (typeof lagMs !== 'number' || !Number.isFinite(lagMs)) return null
  if (typeof stalledPolls !== 'number' || !Number.isFinite(stalledPolls)) return null
  return { lagMs: Math.max(0, lagMs), stalledPolls: Math.max(0, Math.trunc(stalledPolls)) }
}

/**
 * A lag figure an operator can act on. "21600000" in an alert is a number nobody converts under
 * pressure; "6h 0m" is the thing they compare against the poll interval.
 */
export function describeLagDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}

/**
 * The persisted reading, from the raw Setting value. Separate from `parseCursorLagState` because the
 * value is TEXT: a hand-edited or truncated setting must degrade to "never recorded" rather than
 * throwing SyntaxError out of a cron route that does not wrap this call.
 */
export function readCursorLagSetting(value: string | null | undefined): CursorLagState | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return parseCursorLagState(JSON.parse(value))
  } catch {
    return null
  }
}
