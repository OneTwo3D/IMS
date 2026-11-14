import { isOutboundWriteHeldError } from '@/lib/security/outbound-write-grant'
import { isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'

/**
 * The storefront stock enqueue that follows a stock change (an alignment, a reallocation, a book-in) is best-effort post-commit, but a failure leaves the store
 * advertising the old quantity (after an align-down, a higher one: an oversell window). Producers therefore COUNT it in their result, and the cron mappings read the
 * count. A failure that is the outbound-write hold's refusal (nothing sent) is counted apart as held.
 */
export type StockEnqueueOutcome = 'ok' | 'failed' | 'held'

export function classifyStockEnqueueFailure(error: unknown): Exclude<StockEnqueueOutcome, 'ok'> {
  if (isOutboundWriteHeldError(error) && error.nothingSent === true) return 'held'
  return isOutboundWriteHeldText(error instanceof Error ? error.message : String(error)) ? 'held' : 'failed'
}
