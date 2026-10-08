/**
 * WHEN A XERO POSTING IS HANDED BACK WITHOUT SPENDING A RETRY.
 *
 * Two failures are not failures of the posting and must not count toward MAX_RETRIES:
 *
 *  - a RATE LIMIT: Xero asked us to wait; the work is fine.
 *  - a WRITE THE OUTBOUND-WRITE HOLD REFUSED: this installation has not been granted the destination, so
 *    the posting never ran. Spending retries on it would turn every queued posting into a FAILED row (and
 *    an UNKNOWN standing) after five ticks of a hold, for a request that never left.
 *
 * The name of `isRateLimitError` is historical; both are "defer, do not spend".
 */

import { OUTBOUND_HELD_RETRY_DELAY_MS, isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'

export const RATE_LIMIT_BACKOFF_BASE_MS = 60_000
export const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60_000

export function getRateLimitBackoffMs(retryCount: number, message: string): number {
  // A held write waits the hold's own delay, not an exponential one that nothing is escalating.
  if (isOutboundWriteHeldText(message)) return OUTBOUND_HELD_RETRY_DELAY_MS
  const hinted = message.match(/retry after (\d+)ms/i)
  const hintedMs = hinted ? Number.parseInt(hinted[1] ?? '0', 10) : 0
  const exponential = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** retryCount, RATE_LIMIT_BACKOFF_MAX_MS)
  return Math.max(hintedMs, exponential)
}

export function isRateLimitError(message: string): boolean {
  return /rate limit|rate limited|http 429|status 429/i.test(message) || isOutboundWriteHeldText(message)
}
