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
 * THE RULE (cannot oversell). Before a push, read the store's `on-hold` and `processing` orders
 * (walked to the end: a short page proves it) and, per order, work out what IMS does NOT hold:
 *   - an order IMS has not imported: every line unit;
 *   - an order IMS HAS imported (a ShoppingOrderLink exists): a link does not prove stock is
 *     reserved, because the importer tolerates no or partial allocation. For each product the order
 *     needs (a KIT line is expanded into its components, recursively, because a kit's WooCommerce
 *     stock is derived from them), subtract what IMS holds against the order for that product
 *     (the larger of its OrderAllocation rows, which are kept after dispatch, and its shipped
 *     ShipmentLine quantity) and keep the unallocated remainder.
 * The remainders are treated as extra reservations against those products.
 *
 * A line IMS cannot resolve (a variation id that matches no IMS product by variation id or SKU is
 * NEVER charged to its parent: the parent is VARIABLE and not stocked) makes the variations of that
 * parent `blocked`: they are not pushed this run, everything else is.
 *
 * TRUNCATION. The walk stops at WC_HELD_ORDERS_MAX_PAGES (10,000 orders: far above any real queue
 * of open on-hold/processing orders). If that ceiling is hit the unread orders could name any
 * product, so no quantity can be proven safe: `truncated` is set and the caller pushes only
 * forced-zero products (0 can never oversell) and reports an error.
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

export const WC_HELD_ORDERS_PAGE_SIZE = 100
/** Safety ceiling only; the walk normally ends on a short page. */
export const WC_HELD_ORDERS_MAX_PAGES = 100

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
  | {
      ok: true
      heldByProduct: Map<string, number>
      /** IMS products that must not be pushed this run (an order line naming them could not be resolved). */
      blockedProductIds: Set<string>
      /** The page ceiling was hit: only forced-zero pushes are safe. */
      truncated: boolean
      ordersConsidered: number
    }
  | { ok: false; reason: string }

export type WcHeldUnitsDeps = {
  /** One page of `/orders` for the given statuses. */
  fetchOrdersPage: (statuses: string, page: number) => Promise<{ data: unknown; error?: string }>
  /**
   * For these WooCommerce order ids, the orders IMS holds: key present = imported; value = what IMS holds against
   * the order per product (max of allocated and shipped quantity; empty when nothing is allocated).
   */
  findImportedOrders: (externalOrderIds: string[]) => Promise<Map<string, Map<string, number>>>
  /** The IMS products behind these WooCommerce ids (product or variation) or SKUs, PLUS every kit component they reach, nested kits included. */
  findProducts: (externalIds: number[], skus: string[]) => Promise<HeldProductRef[]>
  /** IMS product ids of the variations (children) of these WooCommerce parent product ids. */
  findVariationIdsByParentExternalId: (parentExternalIds: number[]) => Promise<string[]>
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
 * Pure: turn order lines into per-IMS-product units. KIT lines expand into their components
 * (nested kits included); a kit itself is never charged, its stock is derived.
 *
 * Matching: a line with a variation id matches the variation id, then the SKU, and NEVER falls
 * back to its (VARIABLE) parent; no match makes the line `unresolved`. A plain line matches the
 * product id, then the SKU; a plain line matching nothing is not an IMS product and is ignored.
 */
export function aggregateHeldUnits(
  lines: HeldLine[],
  products: HeldProductRef[],
): { held: Map<string, number>; unresolvedLines: HeldLine[] } {
  const byId = new Map<string, HeldProductRef>(products.map((p) => [p.id, p]))
  const byExternal = new Map<number, HeldProductRef>()
  const bySku = new Map<string, HeldProductRef>()
  for (const p of products) {
    if (p.externalProductId != null) byExternal.set(p.externalProductId, p)
    if (p.sku) bySku.set(p.sku, p)
  }
  const held = new Map<string, number>()
  const unresolvedLines: HeldLine[] = []
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
    let product: HeldProductRef | undefined
    if (line.variationId) {
      product = byExternal.get(line.variationId) ?? (line.sku ? bySku.get(line.sku) : undefined)
      if (!product || product.type === 'VARIABLE') {
        unresolvedLines.push(line)
        continue
      }
    } else {
      product = (line.productId ? byExternal.get(line.productId) : undefined) ?? (line.sku ? bySku.get(line.sku) : undefined)
      if (!product) continue
      if (product.type === 'VARIABLE') {
        unresolvedLines.push(line)
        continue
      }
    }
    charge(product, line.quantity, 0, new Set())
  }
  return { held, unresolvedLines }
}

/** Pure: what is left of `demand` once what IMS holds against the order is taken off, per product. */
export function unallocatedRemainder(
  demand: ReadonlyMap<string, number>,
  coverage: ReadonlyMap<string, number> | undefined,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const [productId, qty] of demand) {
    const rest = qty - (coverage?.get(productId) ?? 0)
    if (rest > 1e-9) out.set(productId, rest)
  }
  return out
}

export async function loadWcHeldUnitsByProduct(deps: WcHeldUnitsDeps): Promise<WcHeldUnitsResult> {
  const statuses = WC_STOCK_HOLDING_ORDER_STATUSES.join(',')
  const orders: WcFullOrder[] = []
  let truncated = true
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
      truncated = false
      break
    }
  }

  const ids = orders.map((o) => String(o?.id ?? ''))
  if (ids.some((id) => id === '')) return { ok: false, reason: 'a WooCommerce order had no id' }
  const imported = await deps.findImportedOrders(ids)
  const perOrderLines: { id: string; lines: HeldLine[] }[] = []
  for (const order of orders) {
    const id = String(order.id)
    const lines = toLines(order)
    if (lines === null) return { ok: false, reason: `WooCommerce order ${id} had unreadable line items` }
    perOrderLines.push({ id, lines })
  }
  const allLines = perOrderLines.flatMap((o) => o.lines)
  const heldByProduct = new Map<string, number>()
  const blockedProductIds = new Set<string>()
  if (allLines.length === 0) return { ok: true, heldByProduct, blockedProductIds, truncated, ordersConsidered: 0 }

  const externalIds = [...new Set(allLines.flatMap((l) => [l.variationId, l.productId]).filter((n) => n > 0))]
  const skus = [...new Set(allLines.map((l) => l.sku).filter((s) => s !== ''))]
  const products = await deps.findProducts(externalIds, skus)

  const unresolvedParents = new Set<number>()
  let considered = 0
  for (const { id, lines } of perOrderLines) {
    const { held, unresolvedLines } = aggregateHeldUnits(lines, products)
    for (const l of unresolvedLines) if (l.productId > 0) unresolvedParents.add(l.productId)
    const remainder = imported.has(id) ? unallocatedRemainder(held, imported.get(id)) : held
    if (remainder.size > 0 || unresolvedLines.length > 0) considered++
    for (const [productId, qty] of remainder) heldByProduct.set(productId, (heldByProduct.get(productId) ?? 0) + qty)
  }
  if (unresolvedParents.size > 0) {
    for (const id of await deps.findVariationIdsByParentExternalId([...unresolvedParents])) blockedProductIds.add(id)
  }
  return { ok: true, heldByProduct, blockedProductIds, truncated, ordersConsidered: considered }
}
