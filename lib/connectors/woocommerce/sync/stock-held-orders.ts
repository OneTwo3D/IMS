/**
 * WooCommerce orders that HOLD stock in the store but are not (yet) reserved in IMS.
 *
 * WHY. The stock push writes an ABSOLUTE `stock_quantity` = quantity - reservedQty. Reservations
 * exist only for orders IMS has imported and allocated. WooCommerce core, though, lowers stock
 * when an order enters `on-hold` (BACS / cheque) as well as `processing`. IMS imports only the
 * operator's selected statuses (default `processing`), and an order can also be imported late or
 * refused (tax block, FX queue, store-credit refusal, admission refusal row). For every such order
 * the store has already taken the units off, IMS has not, and an absolute push puts them back:
 * the next customer can buy stock that does not exist.
 *
 * THE RULE (cannot oversell). Before a push, read the store's `on-hold` and `processing` orders,
 * drop the ones IMS already holds (a ShoppingOrderLink exists: they are reserved, allocated or
 * shipped, so IMS's own figures already count them), and treat the remaining line quantities as
 * extra reservations against the products they name (a KIT line is expanded into its components,
 * recursively, because a kit's WooCommerce stock is derived from them).
 *
 * WHEN THE ORDER DATA CANNOT BE TRUSTED (the read fails, an unreadable page, more pages than the
 * walk allows) the loader reports `ok: false` and the caller pushes NOTHING for the run. Skipping is
 * the only choice that cannot oversell: any quantity IMS wrote could erase a decrement it cannot
 * see, while leaving WooCommerce's own figure untouched can never be stale-high because of this
 * code. The run is reported as an error, so the queue retries and the daily reconcile covers it.
 *
 * WHEN THE DATA IS STALE rather than missing (an order moved to `completed` or `cancelled` in the
 * moment between the read and the push) the error is on the safe side: a cancelled order's units
 * are held back for one cycle (under-push, corrected by the next push), never given away.
 *
 * Deliberately conservative: WooCommerce does not expose whether it actually reduced stock for an
 * order (the `_order_stock_reduced` meta is private), so every unimported on-hold/processing line
 * is assumed reduced. Over-holding self-corrects once IMS imports the order; under-holding
 * oversells.
 *
 * Pure parts are exported for tests; the loader takes its I/O as arguments so it runs offline.
 */

import type { WcFullOrder } from './types'

/** The statuses in which WooCommerce core holds stock (wc_maybe_reduce_stock_levels). */
export const WC_STOCK_HOLDING_ORDER_STATUSES = ['on-hold', 'processing'] as const

/** `per_page` x this bounds the walk; more than this and the data is declared unusable. */
export const WC_HELD_ORDERS_PAGE_SIZE = 100
export const WC_HELD_ORDERS_MAX_PAGES = 20

const KIT_EXPANSION_MAX_DEPTH = 8

export type HeldLine = { productId: number; variationId: number; sku: string; quantity: number }

export type HeldProductRef = {
  id: string
  sku: string
  type: string
  externalProductId: number | null
  components: { componentId: string; qty: number }[]
}

export type WcHeldUnitsResult =
  | { ok: true; heldByProduct: Map<string, number>; ordersConsidered: number }
  | { ok: false; reason: string }

export type WcHeldUnitsDeps = {
  /** One page of `/orders` for the given statuses. */
  fetchOrdersPage: (statuses: string, page: number) => Promise<{ data: unknown; error?: string }>
  /** Which of these WooCommerce order ids IMS already holds (a ShoppingOrderLink exists). */
  findImportedOrderIds: (externalOrderIds: string[]) => Promise<Set<string>>
  /** The IMS products behind these WooCommerce ids (product or variation) or SKUs, PLUS every kit component they reach, nested kits included. */
  findProducts: (externalIds: number[], skus: string[]) => Promise<HeldProductRef[]>
}

function toLines(order: WcFullOrder): HeldLine[] | null {
  if (!Array.isArray(order.line_items)) return null
  const lines: HeldLine[] = []
  for (const item of order.line_items) {
    const quantity = Number(item.quantity)
    if (!Number.isFinite(quantity)) return null
    if (quantity <= 0) continue
    lines.push({
      productId: Number(item.product_id) || 0,
      variationId: Number(item.variation_id) || 0,
      sku: typeof item.sku === 'string' ? item.sku.trim() : '',
      quantity,
    })
  }
  return lines
}

/**
 * Pure: turn the unimported orders' lines into per-IMS-product held units. KIT lines expand into
 * their components (nested kits included); a kit itself is never charged, its stock is derived.
 * Lines that match no IMS product are ignored (nothing of IMS's to over-push).
 */
export function aggregateHeldUnits(
  lines: HeldLine[],
  products: HeldProductRef[],
): Map<string, number> {
  const byId = new Map<string, HeldProductRef>(products.map((p) => [p.id, p]))
  const byExternal = new Map<number, HeldProductRef>()
  const bySku = new Map<string, HeldProductRef>()
  for (const p of products) {
    if (p.externalProductId != null) byExternal.set(p.externalProductId, p)
    if (p.sku) bySku.set(p.sku, p)
  }
  const held = new Map<string, number>()
  const charge = (product: HeldProductRef, qty: number, depth: number, trail: Set<string>): void => {
    if (product.type === 'KIT') {
      // A cycle or absurd nesting cannot be resolved here; availability flags it separately.
      if (depth >= KIT_EXPANSION_MAX_DEPTH || trail.has(product.id)) return
      const next = new Set(trail).add(product.id)
      for (const c of product.components) {
        const component = byId.get(c.componentId)
        if (component) charge(component, qty * Number(c.qty), depth + 1, next)
        else held.set(c.componentId, (held.get(c.componentId) ?? 0) + qty * Number(c.qty))
      }
      return
    }
    held.set(product.id, (held.get(product.id) ?? 0) + qty)
  }
  for (const line of lines) {
    const product =
      (line.variationId ? byExternal.get(line.variationId) : undefined)
      ?? (line.productId ? byExternal.get(line.productId) : undefined)
      ?? (line.sku ? bySku.get(line.sku) : undefined)
    if (product) charge(product, line.quantity, 0, new Set())
  }
  return held
}

export async function loadWcHeldUnitsByProduct(deps: WcHeldUnitsDeps): Promise<WcHeldUnitsResult> {
  const statuses = WC_STOCK_HOLDING_ORDER_STATUSES.join(',')
  const orders: WcFullOrder[] = []
  let complete = false
  for (let page = 1; page <= WC_HELD_ORDERS_MAX_PAGES; page++) {
    let response: { data: unknown; error?: string }
    try {
      response = await deps.fetchOrdersPage(statuses, page)
    } catch (e) {
      return { ok: false, reason: `reading WooCommerce ${statuses} orders threw: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (response.error) return { ok: false, reason: `reading WooCommerce ${statuses} orders failed: ${response.error}` }
    if (!Array.isArray(response.data)) return { ok: false, reason: 'WooCommerce orders answer was not a list' }
    orders.push(...(response.data as WcFullOrder[]))
    if (response.data.length < WC_HELD_ORDERS_PAGE_SIZE) {
      complete = true
      break
    }
  }
  if (!complete) {
    return { ok: false, reason: `more than ${WC_HELD_ORDERS_MAX_PAGES * WC_HELD_ORDERS_PAGE_SIZE} on-hold/processing orders in WooCommerce` }
  }

  const ids = orders.map((o) => String(o?.id ?? '')).filter((id) => id !== '')
  const imported = await deps.findImportedOrderIds(ids)
  const lines: HeldLine[] = []
  let considered = 0
  for (const order of orders) {
    const id = String(order?.id ?? '')
    if (!id) return { ok: false, reason: 'a WooCommerce order had no id' }
    if (imported.has(id)) continue
    const orderLines = toLines(order)
    if (orderLines === null) return { ok: false, reason: `WooCommerce order ${id} had unreadable line items` }
    considered++
    lines.push(...orderLines)
  }
  if (lines.length === 0) return { ok: true, heldByProduct: new Map(), ordersConsidered: considered }

  const externalIds = [...new Set(lines.flatMap((l) => [l.variationId, l.productId]).filter((n) => n > 0))]
  const skus = [...new Set(lines.map((l) => l.sku).filter((s) => s !== ''))]
  const products = await deps.findProducts(externalIds, skus)
  return { ok: true, heldByProduct: aggregateHeldUnits(lines, products), ordersConsidered: considered }
}
