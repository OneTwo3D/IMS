/**
 * RECORDING A HELD WRITE: LOUD, ATTRIBUTABLE, AND RATE-LIMITED.
 *
 * A held installation refuses on every attempt, and the writers retry, so an unbounded log would turn
 * a deliberate hold into an incident. At most ONE refusal per (connector, code) is written per
 * OUTBOUND_REFUSAL_LOG_WINDOW_MS; the refusals in between are counted, and the count rides on the
 * next written entry (`suppressedSinceLast`) so the totals stay recoverable from the activity log:
 * refusals in a period = sum over its entries of (1 + suppressedSinceLast).
 *
 * Two sinks, because each fails differently. stderr needs nothing and is always there; the activity
 * log is where an operator looks and what `outbound:status` counts, but it needs a database and
 * `logActivity` swallows its own failures. The database write is bounded so a stalled database cannot
 * stall a refusal.
 */

import {
  OUTBOUND_HELD_ACTION,
  OUTBOUND_HELD_TAG,
  OUTBOUND_REFUSAL_LOG_WINDOW_MS,
} from './outbound-write-hold-constants'
import type { OutboundWriteHeldError } from './outbound-write-grant'

type Bucket = { lastLoggedAt: number; suppressed: number }

const buckets = new Map<string, Bucket>()

const ACTIVITY_WRITE_TIMEOUT_MS = 2_000

export type OutboundRefusalSink = (error: OutboundWriteHeldError, suppressedSinceLast: number) => Promise<void>

async function defaultSink(error: OutboundWriteHeldError, suppressedSinceLast: number): Promise<void> {
  console.error('[outbound-write-hold] refused', {
    connector: error.connector,
    code: error.code,
    method: error.method,
    target: error.target,
    hop: error.hop,
    suppressedSinceLast,
  })
  try {
    const { logActivity } = await import('@/lib/activity-log')
    await Promise.race([
      logActivity({
        entityType: 'SYNC',
        action: OUTBOUND_HELD_ACTION,
        tag: OUTBOUND_HELD_TAG,
        level: 'WARNING',
        description: error.message,
        resolveUser: false,
        metadata: {
          connector: error.connector,
          code: error.code,
          method: error.method,
          target: error.target,
          granted: error.granted,
          attempted: error.attempted,
          hop: error.hop,
          nothingSent: error.nothingSent,
          suppressedSinceLast,
        },
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ACTIVITY_WRITE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } catch {
    // stderr above is the record of last resort; a missing database must not turn a refusal into a crash.
  }
}

let sink: OutboundRefusalSink = defaultSink

/** Test seam: replace the sink (null restores the real one). */
export function setOutboundRefusalSink(next: OutboundRefusalSink | null): void {
  sink = next ?? defaultSink
}

/** Test seam: forget the rate-limit state. */
export function resetOutboundRefusalRateLimit(): void {
  buckets.clear()
}

/**
 * Count the refusal and, at most once per window per (connector, code), write it. Never throws.
 * Returns whether this call wrote an entry.
 */
export async function recordOutboundWriteRefusal(error: OutboundWriteHeldError, now: number = Date.now()): Promise<boolean> {
  const key = `${error.connector}:${error.code}`
  const bucket = buckets.get(key)
  if (bucket && now - bucket.lastLoggedAt < OUTBOUND_REFUSAL_LOG_WINDOW_MS) {
    bucket.suppressed += 1
    return false
  }
  const suppressedSinceLast = bucket?.suppressed ?? 0
  buckets.set(key, { lastLoggedAt: now, suppressed: 0 })
  try {
    await sink(error, suppressedSinceLast)
  } catch {
    // never throws
  }
  return true
}
