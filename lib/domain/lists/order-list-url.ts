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
