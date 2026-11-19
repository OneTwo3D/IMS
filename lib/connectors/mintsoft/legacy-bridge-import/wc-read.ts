/**
 * THE WOOCOMMERCE ORDER PAGE WALK, with pacing and 429 back-off. PURE: the page fetch and the sleep are injected, so it runs in tests
 * without a network or a timer. The walk is sequential (one request in flight), waits `pageDelayMs` between pages, and on a 429 waits
 * (the store's Retry-After when it sent one, else doubling each time, capped) and asks for the SAME page again, up to `maxRetries` times;
 * any other error ends the walk incomplete.
 *
 * OFFSET DRIFT: an order that leaves (or enters) the status set mid-walk shifts every later page by one, so the walk could skip an order and
 * still end on an empty page. The store's X-WP-Total (the size of the whole set) is read on the first page and again on the last: if it
 * changed, or the orders collected do not add up to it, the read is INCOMPLETE and the operator reruns it.
 */
import type { WcOrderLite, WcReadResult } from './run'

export type WcPageFetch = (page: number) => Promise<{
  data: unknown
  error?: string
  /** The store's Retry-After on a failed response, in milliseconds. */
  retryAfterMs?: number
  /** X-WP-Total (the size of the whole matching set) when the store sent it. */
  totalItems?: number
}>

export type WcPageWalkOptions = {
  maxPages: number
  describeUnread: (page: number, error: string) => string
  describeUnended: (pagesRead: number) => string
  sleep?: (ms: number) => Promise<void>
  pageDelayMs?: number
  maxRetries?: number
  backoffMs?: number
  backoffCapMs?: number
  /** A Retry-After longer than this ends the walk incomplete instead of being retried early (default 120 s). */
  retryAfterCapMs?: number
}

export const WC_PAGE_DELAY_MS = 300
export const WC_RATE_LIMIT_RETRIES = 5
export const WC_RATE_LIMIT_BACKOFF_MS = 2_000
export const WC_RATE_LIMIT_BACKOFF_CAP_MS = 30_000
export const WC_RETRY_AFTER_CAP_MS = 120_000

/** True for the error text `wcFetch` returns for an HTTP 429 (`WC API error: 429 ...`). */
export const isWcRateLimited = (error: string | undefined): boolean => error !== undefined && /\bWC API error: 429\b/.test(error)

export async function walkWcOrderPages(fetchPage: WcPageFetch, options: WcPageWalkOptions): Promise<WcReadResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const pageDelayMs = options.pageDelayMs ?? WC_PAGE_DELAY_MS
  const maxRetries = options.maxRetries ?? WC_RATE_LIMIT_RETRIES
  const cap = options.backoffCapMs ?? WC_RATE_LIMIT_BACKOFF_CAP_MS
  const retryAfterCap = options.retryAfterCapMs ?? WC_RETRY_AFTER_CAP_MS
  const orders: WcOrderLite[] = []
  let pagesRead = 0
  let firstTotal: number | null = null
  for (let page = 1; page <= options.maxPages; page += 1) {
    if (page > 1 && pageDelayMs > 0) await sleep(pageDelayMs)
    let wait = options.backoffMs ?? WC_RATE_LIMIT_BACKOFF_MS
    let attempt = 0
    let result = await fetchPage(page)
    while (isWcRateLimited(result.error) && attempt < maxRetries) {
      attempt += 1
      if (result.retryAfterMs !== undefined) {
        // The store said how long to wait: honour it, and never retry EARLY (a Retry-After beyond the cap ends the read, incomplete).
        if (result.retryAfterMs > retryAfterCap) {
          return { orders, pagesRead, complete: false, error: options.describeUnread(page, `${result.error ?? 'WC API error: 429'} (Retry-After ${Math.ceil(result.retryAfterMs / 1000)} s is longer than the ${Math.ceil(retryAfterCap / 1000)} s this read will wait; rerun later)`) }
        }
        await sleep(result.retryAfterMs)
      } else {
        await sleep(Math.min(wait, cap))
        wait *= 2
      }
      result = await fetchPage(page)
    }
    if (result.error || !Array.isArray(result.data)) return { orders, pagesRead, complete: false, error: options.describeUnread(page, result.error ?? 'unreadable response') }
    pagesRead += 1
    const total = typeof result.totalItems === 'number' && result.totalItems >= 0 ? result.totalItems : null
    if (firstTotal === null) firstTotal = total
    if (result.data.length === 0) {
      if (firstTotal !== null && total !== null && total !== firstTotal) {
        return { orders, pagesRead, complete: false, error: `the store's order count changed during the read (X-WP-Total ${firstTotal} at the start, ${total} at the end): pages shifted, so an order may have been skipped; rerun the read` }
      }
      if (total !== null && orders.length !== total) {
        return { orders, pagesRead, complete: false, error: `the read collected ${orders.length} order(s) but the store reports ${total} (X-WP-Total): an order may have been skipped or repeated; rerun the read` }
      }
      return { orders, pagesRead, complete: true }
    }
    orders.push(...(result.data as WcOrderLite[]))
  }
  return { orders, pagesRead, complete: false, error: options.describeUnended(pagesRead) }
}
