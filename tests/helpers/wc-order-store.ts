/**
 * A stand-in WooCommerce `GET /orders` for the order-sweep tests (o3d-hqvrp.87).
 *
 * The sweep pages by KEYSET on modification time, so a fixture that answers by page number alone cannot terminate it: the store has to honour
 * `modified_after` / `modified_before`, `orderby=modified` and `page` / `per_page`, which is all this does. Times are `date_modified_gmt`, read as GMT
 * (the request values carry no zone suffix, as with `dates_are_gmt=true`).
 */
export type StoreOrder = { id: number; date_modified_gmt: string } & Record<string, unknown>

function gmtMs(value: string): number {
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`)
}

export function serveWcOrders(orders: readonly StoreOrder[], params: Record<string, string>): StoreOrder[] {
  const after = params.modified_after ? gmtMs(params.modified_after) : Number.NEGATIVE_INFINITY
  const before = params.modified_before ? gmtMs(params.modified_before) : Number.POSITIVE_INFINITY
  const perPage = Number(params.per_page ?? '10')
  const page = Number(params.page ?? '1')
  const matching = orders
    .filter((order) => gmtMs(order.date_modified_gmt) > after && gmtMs(order.date_modified_gmt) < before)
    // `orderby=date` is creation order, which the fixtures model as id order (an edit never moves an order in it).
    .sort((a, b) => (params.orderby === 'modified' ? gmtMs(a.date_modified_gmt) - gmtMs(b.date_modified_gmt) : 0) || a.id - b.id)
  return matching.slice((page - 1) * perPage, page * perPage)
}
