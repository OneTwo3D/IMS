/** URL <-> filter mapping for the order lists. Pure, so it is unit-tested without a browser. */
export type OrderListUrlState = {
  q: string
  statuses: string[]
  page: number
  showCompleted: boolean
  includeArchived: boolean
  invoiced: boolean
  returned: boolean
}

export const EMPTY_ORDER_LIST_URL_STATE: OrderListUrlState = {
  q: '', statuses: [], page: 1, showCompleted: false, includeArchived: false, invoiced: false, returned: false,
}

export function orderListHref(pathname: string, state: OrderListUrlState): string {
  const p = new URLSearchParams()
  if (state.q) p.set('q', state.q)
  if (state.statuses.length) p.set('status', state.statuses.join(','))
  if (state.showCompleted) p.set('completed', '1')
  if (state.includeArchived) p.set('archived', '1')
  if (state.invoiced) p.set('invoiced', '1')
  if (state.returned) p.set('returned', '1')
  if (state.page > 1) p.set('page', String(state.page))
  const qs = p.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

/** "Showing 51–100 of 1,234" — or "No results". */
export function orderListRangeLabel(page: number, pageSize: number, total: number, noun: string): string {
  if (total === 0) return `No ${noun}`
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return `Showing ${from.toLocaleString('en-GB')}–${to.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} ${noun}`
}

/**
 * The address to go to when the debounced search fires: the CURRENT address with only `q` replaced
 * and the page reset. Built from the live query string at fire time, never from a value captured when
 * the timer was started, so a status or toggle change made during the debounce is not undone.
 */
export function withSearchQuery(pathname: string, currentSearch: string, q: string): string {
  const p = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  if (q) p.set('q', q); else p.delete('q')
  p.delete('page')
  const qs = p.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

/**
 * Whether the typed text should be replaced by the address's `q`: only when the address changed
 * for a reason other than our own push (Back/Forward, a link), never while the user is mid-type.
 */
export function shouldResyncSearchInput(urlQ: string, lastPushedQ: string): boolean {
  return urlQ !== lastPushedQ
}
