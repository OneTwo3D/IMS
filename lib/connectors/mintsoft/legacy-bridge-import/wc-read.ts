/**
 * THE WOOCOMMERCE ORDER PAGE WALK, with pacing and 429 back-off. PURE: the page fetch and the sleep are injected, so it runs in tests
 * without a network or a timer. The walk is sequential (one request in flight), waits `pageDelayMs` between pages, and on a 429 waits
 * (the store's Retry-After when it sent one, else doubling each time, capped) and asks for the SAME page again, up to `maxRetries` times;
 * any other error ends the walk incomplete.
 *
 * OFFSET DRIFT: an order that leaves (or enters) the status set mid-walk shifts every later page by one, so the walk could skip an order and
 * still end on an empty page. With `verifyPass` the walk is done a SECOND time (ids only, `pass` 'verify') and the two ID SETS are compared:
 * an id the second walk saw that the first did not is a skipped order (INCOMPLETE) unless it is above the set's HIGH-WATER id, which is taken (one
 * `orderby=id&order=desc&per_page=1` request) BEFORE the first walk (the walk is by id ascending, so a NEW order lands at the tail and shifts nothing:
 * tolerated; an order skipped at the very end of the walk is at or below the high-water id and is caught); an id only the first walk saw (it left the set) is fine.
 * A new order arriving mid-walk therefore does not fail the read, and a leave plus a join that keeps the totals equal is still caught.
 * Without `verifyPass` the store's X-WP-Total is compared at the start and end instead (the totals-only check).
 */
import type { WcOrderLite, WcReadResult } from './run'

/** 'read': the full walk; 'verify': the ids-only drift walk; 'high': ONE request for the highest order id in the set (`orderby=id&order=desc&per_page=1`), taken BEFORE the first walk. */
export type WcPageFetch = (page: number, pass?: 'read' | 'verify' | 'high') => Promise<{
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
  /** Walk the set a second time (ids only) and compare id sets instead of X-WP-Total. */
  verifyPass?: boolean
}

export const WC_PAGE_DELAY_MS = 300
export const WC_RATE_LIMIT_RETRIES = 5
export const WC_RATE_LIMIT_BACKOFF_MS = 2_000
export const WC_RATE_LIMIT_BACKOFF_CAP_MS = 30_000
export const WC_RETRY_AFTER_CAP_MS = 120_000

/** True for the error text `wcFetch` returns for an HTTP 429 (`WC API error: 429 ...`). */
export const isWcRateLimited = (error: string | undefined): boolean => error !== undefined && /\bWC API error: 429\b/.test(error)

type Pass = 'read' | 'verify' | 'high'
type PassResult = { items: unknown[]; pagesRead: number; firstTotal: number | null; lastTotal: number | null; error?: string; ended: boolean }

export async function walkWcOrderPages(fetchPage: WcPageFetch, options: WcPageWalkOptions): Promise<WcReadResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const pageDelayMs = options.pageDelayMs ?? WC_PAGE_DELAY_MS
  const maxRetries = options.maxRetries ?? WC_RATE_LIMIT_RETRIES
  const cap = options.backoffCapMs ?? WC_RATE_LIMIT_BACKOFF_CAP_MS
  const retryAfterCap = options.retryAfterCapMs ?? WC_RETRY_AFTER_CAP_MS

  /** One page, honouring 429 back-off. `stop` carries the incomplete-read message when the store's Retry-After is beyond the cap. */
  const fetchWithRetry = async (page: number, pass: Pass): Promise<{ result: Awaited<ReturnType<WcPageFetch>> } | { stop: string }> => {
    let wait = options.backoffMs ?? WC_RATE_LIMIT_BACKOFF_MS
    let attempt = 0
    let result = await fetchPage(page, pass)
    while (isWcRateLimited(result.error) && attempt < maxRetries) {
      attempt += 1
      if (result.retryAfterMs !== undefined) {
        // The store said how long to wait: honour it, and never retry EARLY (a Retry-After beyond the cap ends the read, incomplete).
        if (result.retryAfterMs > retryAfterCap) {
          return { stop: options.describeUnread(page, `${result.error ?? 'WC API error: 429'} (Retry-After ${Math.ceil(result.retryAfterMs / 1000)} s is longer than the ${Math.ceil(retryAfterCap / 1000)} s this read will wait; rerun later)`) }
        }
        await sleep(result.retryAfterMs)
      } else {
        await sleep(Math.min(wait, cap))
        wait *= 2
      }
      result = await fetchPage(page, pass)
    }
    return { result }
  }

  const walk = async (pass: Pass): Promise<PassResult> => {
    const items: unknown[] = []
    let pagesRead = 0
    let firstTotal: number | null = null
    for (let page = 1; page <= options.maxPages; page += 1) {
      if (page > 1 && pageDelayMs > 0) await sleep(pageDelayMs)
      const fetched = await fetchWithRetry(page, pass)
      if ('stop' in fetched) return { items, pagesRead, firstTotal, lastTotal: null, ended: false, error: fetched.stop }
      const result = fetched.result
      if (result.error || !Array.isArray(result.data)) return { items, pagesRead, firstTotal, lastTotal: null, ended: false, error: options.describeUnread(page, result.error ?? 'unreadable response') }
      pagesRead += 1
      const total = typeof result.totalItems === 'number' && result.totalItems >= 0 ? result.totalItems : null
      if (firstTotal === null) firstTotal = total
      if (result.data.length === 0) return { items, pagesRead, firstTotal, lastTotal: total, ended: true }
      items.push(...result.data)
    }
    return { items, pagesRead, firstTotal, lastTotal: null, ended: false }
  }

  // THE SET'S HIGH-WATER ID, recorded BEFORE the first walk: the drift check excuses only ids above it (a genuinely new order). An id at or below it that
  // the first walk missed was skipped (an earlier order left the set and shifted the pages), even when it is the very last id of the set.
  let highWater = 0
  if (options.verifyPass) {
    const fetched = await fetchWithRetry(1, 'high')
    if ('stop' in fetched) return { orders: [], pagesRead: 0, complete: false, error: fetched.stop }
    const high = fetched.result
    if (high.error || !Array.isArray(high.data)) return { orders: [], pagesRead: 0, complete: false, error: options.describeUnread(1, high.error ?? 'unreadable response') }
    const top = high.data.length > 0 ? String((high.data[0] as { id?: unknown } | null)?.id ?? '') : '0'
    if (!/^[0-9]+$/.test(top)) return { orders: [], pagesRead: 0, complete: false, error: 'the highest-id probe returned an order with no numeric id: the drift check cannot be anchored; rerun the read' }
    highWater = Number(top)
    if (pageDelayMs > 0) await sleep(pageDelayMs)
  }

  const first = await walk('read')
  const orders = first.items as WcOrderLite[]
  if (first.error) return { orders, pagesRead: first.pagesRead, complete: false, error: first.error }
  if (!first.ended) return { orders, pagesRead: first.pagesRead, complete: false, error: options.describeUnended(first.pagesRead) }

  if (!options.verifyPass) {
    if (first.firstTotal !== null && first.lastTotal !== null && first.lastTotal !== first.firstTotal) {
      return { orders, pagesRead: first.pagesRead, complete: false, error: `the store's order count changed during the read (X-WP-Total ${first.firstTotal} at the start, ${first.lastTotal} at the end): pages shifted, so an order may have been skipped; rerun the read` }
    }
    if (first.lastTotal !== null && orders.length !== first.lastTotal) {
      return { orders, pagesRead: first.pagesRead, complete: false, error: `the read collected ${orders.length} order(s) but the store reports ${first.lastTotal} (X-WP-Total): an order may have been skipped or repeated; rerun the read` }
    }
    return { orders, pagesRead: first.pagesRead, complete: true }
  }

  // ID-SET CHECK: a second walk, ids only, compared with the first.
  const second = await walk('verify')
  const pagesRead = first.pagesRead + second.pagesRead
  if (second.error) return { orders, pagesRead, complete: false, error: `the drift-check walk failed: ${second.error}` }
  if (!second.ended) return { orders, pagesRead, complete: false, error: options.describeUnended(second.pagesRead) }
  const idOf = (item: unknown): string => String((item as { id?: unknown } | null)?.id ?? '')
  const firstIds = orders.map(idOf)
  if (new Set(firstIds).size !== firstIds.length) return { orders, pagesRead, complete: false, error: 'the read returned the same order id twice (a page shifted): an order may have been skipped; rerun the read' }
  const firstSet = new Set(firstIds)
  const skipped: string[] = []
  let tailJoins = 0
  for (const id of new Set(second.items.map(idOf))) {
    if (firstSet.has(id)) continue
    if (/^[0-9]+$/.test(id) && Number(id) > highWater) { tailJoins += 1; continue }
    skipped.push(id)
  }
  if (skipped.length > 0) return { orders, pagesRead, complete: false, error: `the drift-check walk found ${skipped.length} order(s) the read skipped (ids ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', ...' : ''}): pages shifted mid-read; rerun the read` }
  return { orders, pagesRead, complete: true, ...(tailJoins > 0 ? { note: `${tailJoins} order(s) joined the set after the read passed them (new orders, higher ids); they carry no bridge state and are not part of this report` } : {}) }
}
