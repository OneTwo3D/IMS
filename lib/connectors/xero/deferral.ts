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

/**
 * IMS'S OWN CALL-BUDGET REFUSAL (the per-tenant day cap and minute cap in `api.ts`), AS A RECOGNISABLE TOKEN.
 *
 * The refusal crosses every connector boundary as an error STRING, so recognising it from its prose would break the
 * first time anyone reworded the sentence. It is therefore tagged at ONE place (`describeLocalBudgetRefusal`, called
 * where the limiter refuses) with a fixed machine-readable token that also carries the computed wait, and recognised at
 * ONE place (`parseLocalBudgetRefusal`). The refusal is additionally tagged `notSent: 'rate-budget-refused'` on the
 * transport response, which is the typed half for callers that hold the response itself.
 */
export const LOCAL_BUDGET_REFUSAL_TAG = 'ims-xero-local-budget'
export type LocalBudgetRefusalKind = 'day' | 'minute'

/** The least a refused row waits, so a refusal that names a tiny wait can never turn into a hot loop. */
export const LOCAL_BUDGET_MIN_DEFER_MS = 30_000
/** Added to the computed wait: the call that frees the slot has to be OUT of the window, not at its edge. */
export const LOCAL_BUDGET_DEFER_MARGIN_MS = 2_000

export function describeLocalBudgetRefusal(kind: LocalBudgetRefusalKind, waitMs: number): string {
  return `[${LOCAL_BUDGET_REFUSAL_TAG} kind=${kind} wait=${Math.max(0, Math.round(waitMs))}ms]`
}

export function parseLocalBudgetRefusal(message: string): { kind: LocalBudgetRefusalKind; waitMs: number } | null {
  const m = message.match(new RegExp(`\\[${LOCAL_BUDGET_REFUSAL_TAG} kind=(day|minute) wait=(\\d+)ms\\]`))
  if (!m) return null
  return { kind: m[1] as LocalBudgetRefusalKind, waitMs: Number.parseInt(m[2] ?? '0', 10) }
}

/** How long a row refused by IMS's own budget waits before it is offered again: until calls fall out of the window. */
export function localBudgetDeferMs(message: string): number | null {
  const refusal = parseLocalBudgetRefusal(message)
  if (!refusal) return null
  return Math.max(LOCAL_BUDGET_MIN_DEFER_MS, refusal.waitMs + LOCAL_BUDGET_DEFER_MARGIN_MS)
}

export function getRateLimitBackoffMs(retryCount: number, message: string): number {
  // A held write waits the hold's own delay, not an exponential one that nothing is escalating.
  if (isOutboundWriteHeldText(message)) return OUTBOUND_HELD_RETRY_DELAY_MS
  // Our own budget knows exactly when a slot frees; an exponential guess would be wrong in both directions.
  const budgetDefer = localBudgetDeferMs(message)
  if (budgetDefer != null) return budgetDefer
  const hinted = message.match(/retry after (\d+)ms/i)
  const hintedMs = hinted ? Number.parseInt(hinted[1] ?? '0', 10) : 0
  const exponential = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** retryCount, RATE_LIMIT_BACKOFF_MAX_MS)
  return Math.max(hintedMs, exponential)
}

export function isRateLimitError(message: string): boolean {
  return /rate limit|rate limited|http 429|status 429/i.test(message) || isOutboundWriteHeldText(message) || parseLocalBudgetRefusal(message) != null
}
