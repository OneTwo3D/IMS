/**
 * THE WOOCOMMERCE ORDER PAGE WALK, with pacing and 429 back-off. PURE: the page fetch and the sleep are injected, so it runs in tests
 * without a network or a timer. The walk is sequential (one request in flight), waits `pageDelayMs` between pages, and on a 429 waits
 * (doubling each time, capped) and asks for the SAME page again, up to `maxRetries` times; any other error ends the walk incomplete.
 */
import type { WcOrderLite, WcReadResult } from './run'

export type WcPageFetch = (page: number) => Promise<{ data: unknown; error?: string }>

export type WcPageWalkOptions = {
  maxPages: number
  describeUnread: (page: number, error: string) => string
  describeUnended: (pagesRead: number) => string
  sleep?: (ms: number) => Promise<void>
  pageDelayMs?: number
  maxRetries?: number
  backoffMs?: number
  backoffCapMs?: number
}

export const WC_PAGE_DELAY_MS = 300
export const WC_RATE_LIMIT_RETRIES = 5
export const WC_RATE_LIMIT_BACKOFF_MS = 2_000
export const WC_RATE_LIMIT_BACKOFF_CAP_MS = 30_000

/** True for the error text `wcFetch` returns for an HTTP 429 (`WC API error: 429 ...`). */
export const isWcRateLimited = (error: string | undefined): boolean => error !== undefined && /\bWC API error: 429\b/.test(error)

export async function walkWcOrderPages(fetchPage: WcPageFetch, options: WcPageWalkOptions): Promise<WcReadResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const pageDelayMs = options.pageDelayMs ?? WC_PAGE_DELAY_MS
  const maxRetries = options.maxRetries ?? WC_RATE_LIMIT_RETRIES
  const cap = options.backoffCapMs ?? WC_RATE_LIMIT_BACKOFF_CAP_MS
  const orders: WcOrderLite[] = []
  let pagesRead = 0
  for (let page = 1; page <= options.maxPages; page += 1) {
    if (page > 1 && pageDelayMs > 0) await sleep(pageDelayMs)
    let wait = options.backoffMs ?? WC_RATE_LIMIT_BACKOFF_MS
    let attempt = 0
    let result = await fetchPage(page)
    while (isWcRateLimited(result.error) && attempt < maxRetries) {
      attempt += 1
      await sleep(Math.min(wait, cap))
      wait *= 2
      result = await fetchPage(page)
    }
    if (result.error || !Array.isArray(result.data)) return { orders, pagesRead, complete: false, error: options.describeUnread(page, result.error ?? 'unreadable response') }
    pagesRead += 1
    if (result.data.length === 0) return { orders, pagesRead, complete: true }
    orders.push(...(result.data as WcOrderLite[]))
  }
  return { orders, pagesRead, complete: false, error: options.describeUnended(pagesRead) }
}
