/**
 * THE STALENESS RULE, PURE.
 *
 * `evaluateReadSyncStream` turns a stream, the time of its last recorded success, the clock and the
 * stream's age limit into one of three states. It reads nothing and writes nothing; every caller (the
 * status command, the alarm job, the tests) goes through it, so the rule cannot drift between them.
 *
 *   fresh  the last recorded success is younger than the limit
 *   stale  the last recorded success is at least as old as the limit (the boundary is STALE, matching the
 *          WMS watchdog's `>=`), or it lies in the future of the clock reading it - a stamp from the
 *          future would otherwise keep a stopped feed looking fresh until the clock caught up
 *   never  no success has been recorded (or the stored value is not a time)
 */

import { type ReadSyncStreamId } from './read-sync-liveness-constants'

export type ReadSyncFreshness = 'fresh' | 'stale' | 'never'

/** How far ahead of the clock a recorded success may be before it stops being believed (clock skew between processes). */
export const READ_SYNC_FUTURE_TOLERANCE_MS = 5 * 60_000

export type ReadSyncEvaluation = {
  stream: ReadSyncStreamId
  state: ReadSyncFreshness
  lastSuccessAt: Date | null
  /** Milliseconds since the last success; null when there is none. May be negative for a future-dated stamp. */
  ageMs: number | null
  maxAgeMs: number
  /** True when the recorded success is later than the clock by more than the tolerance. */
  futureTimestamp: boolean
}

export function evaluateReadSyncStream(
  stream: ReadSyncStreamId,
  lastSuccessAt: Date | null,
  now: Date,
  maxAgeMs: number,
): ReadSyncEvaluation {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error(`read-sync stream ${stream} needs a positive age limit, got ${maxAgeMs}`)
  }
  if (lastSuccessAt === null || Number.isNaN(lastSuccessAt.getTime())) {
    return { stream, state: 'never', lastSuccessAt: null, ageMs: null, maxAgeMs, futureTimestamp: false }
  }
  const ageMs = now.getTime() - lastSuccessAt.getTime()
  const futureTimestamp = ageMs < -READ_SYNC_FUTURE_TOLERANCE_MS
  const state: ReadSyncFreshness = futureTimestamp || ageMs >= maxAgeMs ? 'stale' : 'fresh'
  return { stream, state, lastSuccessAt, ageMs, maxAgeMs, futureTimestamp }
}

/** Parse a stored stamp. Anything that is not a time is "no success recorded", never a fresh one. */
export function parseReadSyncStamp(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed) : null
}
