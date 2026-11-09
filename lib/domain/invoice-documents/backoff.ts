/**
 * Retry timing for a document that is not available yet. Pure.
 *
 * A document the ledger does not hold yet is the ordinary case (the invoicing writer has not run), so it is
 * retried on a widening schedule and only escalated to a person once it has been missing for a long time.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SCHEDULE_MS = [10 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 24 * HOUR] as const

/** A document missing from the ledger this long after IMS first looked is escalated. */
export const DOCUMENT_MISSING_ESCALATION_MS = 14 * 24 * HOUR

/** Delay before attempt number `attempts + 1`, given `attempts` attempts so far (>= 1). */
export function nextAttemptDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), SCHEDULE_MS.length) - 1
  return SCHEDULE_MS[index]
}

export function shouldEscalateMissing(firstSeenAt: Date, now: Date): boolean {
  return now.getTime() - firstSeenAt.getTime() >= DOCUMENT_MISSING_ESCALATION_MS
}
