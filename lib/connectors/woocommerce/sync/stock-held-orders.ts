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
 * COMPLETED ORDERS. WooCommerce also reduces stock for `completed` orders, and the default import
 * filter is `processing` only, so an unimported completed order would be given back too. Completed
 * orders are read as well, bounded by a window: modified since the order-sweep cursor
 * (the older of last_wc_order_sync_at / last_wc_order_reconcile_at) minus WC_COMPLETED_OVERLAP_MS.
 * Older completed orders have been imported or are covered by the reconcile. The same rule applies
 * (unimported: in full; imported: unallocated remainder). If EITHER cursor is missing the window
 * cannot be bounded, so completed orders are read EXHAUSTIVELY (no modified_after) under the same
 * completeness proof. A store whose completed history exceeds the walk ceiling, or whose total cannot
 * be proven, is then reported `incomplete` and only forced-zero pushes go out, which is the safe answer.
 * This is deliberate: an install that never runs a reconcile sweep (poll mode) would otherwise either
 * be blocked from positive pushes forever or push on an unproven picture.
 *
 * THE COVERED-HISTORY BOUNDARY (poll mode). An exhaustive completed read that is PROVEN complete AND finds every completed order
 * fully accounted for (imported, nothing unallocated, no unresolved line) proves that all completed history older than the walk's
 * start is settled. That instant is returned as `completedHistoryCoveredAtMs`; the caller persists it, and later runs bound the
 * completed read by it (minus the overlap) when a sweep cursor is missing, instead of rereading the store's whole history on
 * every push. A walk that is incomplete, or that found a completed order IMS does not hold, never sets it, so a boundary exists only
 * once it is proven and positive pushes stay disabled until then.
 *
 * COMPLETENESS. A numbered-page walk over a live result can leave holes (an order changing status
 * mid-walk shifts every later page). The WooCommerce REST orders endpoint has no id cursor, so each
 * walk is ordered by id ascending and PROVEN: ids must be strictly ascending, the collected count
 * must equal the `X-WP-Total` read with page 1, and a count read AFTER the walk must still match.
 * Anything else (a missing header, a changed total, a repeated or out-of-order id, or the page
 * ceiling WC_HELD_ORDERS_MAX_PAGES = 10,000 orders) marks the picture `incomplete`: unread orders
 * could name any product, so no positive quantity can be proven safe. The caller then pushes only
 * forced-zero products (0 can never oversell) and reports it; the next run retries.
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

/** Setting key: the persisted covered-history boundary (ISO instant), see THE COVERED-HISTORY BOUNDARY. */
export const WC_COMPLETED_HISTORY_COVERED_KEY = 'wc_completed_history_covered_at'

/**
 * Setting key: when the last transaction reset began (ISO). The reset deletes the IMS orders and allocations that justified any
 * covered-history boundary, so a boundary whose walk started before it is void; the reset sets this BEFORE it deletes and never clears it.
 */
export const WC_ORDER_RESET_MARKER_KEY = 'wc_order_reset_at'

/**
 * DIRTY ORDERS (see stock-dirty-orders.ts): orders whose IMS allocation was released, reduced or deleted. Whatever the boundary says, each is
 * fetched from WooCommerce by id (`include`, WC_DIRTY_FETCH_BATCH per request) and charged like any unimported completed order. At most
 * WC_DIRTY_MAX_PER_RUN are fetched per run (the rest make the picture incomplete, so positives wait); a fetch that fails, or an order WooCommerce
 * does not return, also makes it incomplete and its entry is kept. An entry is SETTLED (the caller may clear it) only when WooCommerce no longer
 * holds the order, or IMS accounts for it again; an order still held and still uncovered stays charged on every run, because the boundary will
 * keep omitting it.
 */
export const WC_DIRTY_FETCH_BATCH = 100
export const WC_DIRTY_MAX_PER_RUN = 1000

export const WC_HELD_ORDERS_PAGE_SIZE = 100
/** Safety ceiling only; the walk normally ends on a short page. */
export const WC_HELD_ORDERS_MAX_PAGES = 100

/** A completed order modified this long before the sweep cursor is still read (the sweep overlaps its own cursor). */
export const WC_COMPLETED_OVERLAP_MS = 24 * 60 * 60 * 1000

const KIT_EXPANSION_MAX_DEPTH = 8

/**
 * The `modified_after` for the completed-order read, from the two sweep cursors, or null when it cannot be bounded.
 * The OLDER cursor is used: completed orders are only proven imported by the sweep that includes them (the reconcile).
 */
export function completedOrdersModifiedAfter(
  syncCursor: string | null | undefined,
  reconcileCursor: string | null | undefined,
  /** The persisted covered-history boundary (see THE COVERED-HISTORY BOUNDARY); used only when the sweep cursors cannot bound the read. */
  coveredHistoryAt?: string | null,
): string | null {
  const parse = (v: string | null | undefined): number | null => {
    if (!v) return null
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  const sync = parse(syncCursor)
  const reconcile = parse(reconcileCursor)
  // A MISSING reconcile cursor is NOT "no reconcile needed": completed orders are proven imported only by the reconcile sweep, so
  // without it nothing says an older completed order was ever imported. Falling back to the poll cursor alone read just the last
  // day yet reported a complete picture (o3d-hqvrp.362). It is unbounded instead; the caller reads completed orders exhaustively.
  if (sync === null || reconcile === null) {
    const covered = parse(coveredHistoryAt)
    return covered === null ? null : new Date(covered - WC_COMPLETED_OVERLAP_MS).toISOString()
  }
  const oldest = Math.min(sync, reconcile)
  return new Date(oldest - WC_COMPLETED_OVERLAP_MS).toISOString()
}

/** The stored form of the boundary: the instant, bound to the connection generation (`wc_settings_version`) it was proven under. */
export function encodeCoveredHistoryBoundary(atMs: number, settingsVersion: string): string {
  return JSON.stringify({ at: new Date(atMs).toISOString(), v: settingsVersion })
}

/**
 * The boundary to TRUST, or null: it must parse, carry the CURRENT connection generation (a rebind or cache reset bumps it), and its
 * walk must have started no earlier than the last transaction reset (which deleted the orders it relied on). Anything else is exhaustive.
 */
export function trustedCoveredHistoryBoundary(
  raw: string | null | undefined,
  currentSettingsVersion: string,
  resetMarker: string | null | undefined,
): string | null {
  if (!raw) return null
  let at: string
  try {
    const v = JSON.parse(raw) as { at?: unknown; v?: unknown }
    if (typeof v.at !== 'string' || typeof v.v !== 'string' || v.v !== currentSettingsVersion) return null
    at = v.at
  } catch {
    return null
  }
  const atMs = Date.parse(at)
  if (Number.isNaN(atMs)) return null
  if (resetMarker) {
    const resetMs = Date.parse(resetMarker)
    // An unreadable marker means a reset happened that cannot be dated: trust nothing.
    if (Number.isNaN(resetMs) || atMs < resetMs) return null
  }
  return at
}

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
      /** The picture is not proven complete (see COMPLETENESS): only forced-zero pushes are safe. */
      incomplete: boolean
      incompleteReasons: string[]
      ordersConsidered: number
      /**
       * Set only when this run read ALL completed orders, proved that read complete, and found every one fully accounted for in IMS:
       * completed history older than this instant (epoch ms, the walk's start) is settled and later runs may bound their read by it.
       */
      completedHistoryCoveredAtMs: number | null
      /** The dirty WooCommerce order ids (see DIRTY ORDERS) this run re-checked and found settled; the caller clears exactly these entries. */
      settledDirtyWcOrderIds: string[]
    }
  | { ok: false; reason: string }

export type WcHeldUnitsDeps = {
  /** One page of `/orders` with these query params; `totalItems` is the X-WP-Total header, null when absent. */
  fetchOrdersPage: (params: Record<string, string>) => Promise<{ data: unknown; error?: string; totalItems?: number | null }>
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

type WalkResult = { orders: WcFullOrder[]; fatal?: string; incompleteReasons: string[]; startedAtMs: number }

/** Clock-skew margin for the churn probe: orders modified this long before the walk began also count as changed. */
export const WC_WALK_CHURN_MARGIN_MS = 60 * 1000

/** Walk one filtered, id-ascending result to its end and PROVE it complete (see COMPLETENESS). */
async function walkOrders(deps: WcHeldUnitsDeps, label: string, filter: Record<string, string>, opts: { churnProbe?: boolean } = {}): Promise<WalkResult> {
  const startedAtMs = Date.now()
  const orders: WcFullOrder[] = []
  const reasons: string[] = []
  const base = { ...filter, orderby: 'id', order: 'asc' }
  let firstTotal: number | null | undefined
  let ended = false
  for (let page = 1; page <= WC_HELD_ORDERS_MAX_PAGES; page++) {
    let response: { data: unknown; error?: string; totalItems?: number | null }
    try {
      response = await deps.fetchOrdersPage({ ...base, per_page: String(WC_HELD_ORDERS_PAGE_SIZE), page: String(page) })
    } catch (e) {
      return { orders, incompleteReasons: reasons, startedAtMs, fatal: `reading WooCommerce ${label} orders threw: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (response.error) return { orders, incompleteReasons: reasons, startedAtMs, fatal: `reading WooCommerce ${label} orders failed: ${response.error}` }
    if (!Array.isArray(response.data)) return { orders, incompleteReasons: reasons, startedAtMs, fatal: `WooCommerce ${label} orders answer was not a list` }
    if (page === 1) firstTotal = response.totalItems
    orders.push(...(response.data as WcFullOrder[]))
    if (response.data.length < WC_HELD_ORDERS_PAGE_SIZE) {
      ended = true
      break
    }
  }
  if (!ended) reasons.push(`${label}: more than ${WC_HELD_ORDERS_MAX_PAGES * WC_HELD_ORDERS_PAGE_SIZE} orders (page ceiling)`)

  // Strictly ascending ids: a repeat or a step back means pages overlapped or shifted under the walk.
  let last = -Infinity
  for (const o of orders) {
    const id = Number(o?.id)
    if (!Number.isFinite(id) || id <= last) {
      reasons.push(`${label}: order ids were not strictly ascending (pages shifted during the walk)`)
      break
    }
    last = id
  }
  if (ended) {
    if (firstTotal == null) reasons.push(`${label}: WooCommerce sent no X-WP-Total, so completeness cannot be proven`)
    else {
      if (orders.length !== firstTotal) reasons.push(`${label}: read ${orders.length} orders but WooCommerce reported ${firstTotal}`)
      try {
        const after = await deps.fetchOrdersPage({ ...base, per_page: '1', page: '1' })
        if (after.error || after.totalItems == null) reasons.push(`${label}: the closing count read failed`)
        else if (after.totalItems !== firstTotal) reasons.push(`${label}: the total changed during the walk (${firstTotal} to ${after.totalItems})`)
      } catch {
        reasons.push(`${label}: the closing count read threw`)
      }
      if (opts.churnProbe) {
        // An unchanged total does NOT prove an unchanged set: one order leaving the status while another enters it keeps the count and
        // shifts every later order onto a page already read. Any order that ENTERED the status was modified at that moment, so a
        // modified-since count over the walk's span must be 0; anything else means the walk may have a hole.
        const since = new Date(startedAtMs - WC_WALK_CHURN_MARGIN_MS).toISOString()
        try {
          const probe = await deps.fetchOrdersPage({ ...filter, modified_after: since, orderby: 'modified', order: 'asc', per_page: '1', page: '1' })
          if (probe.error || probe.totalItems == null) reasons.push(`${label}: the changed-during-the-walk check could not be read`)
          else if (probe.totalItems > 0) reasons.push(`${label}: ${probe.totalItems} order(s) changed while the walk was running, so a shifted page cannot be ruled out`)
        } catch {
          reasons.push(`${label}: the changed-during-the-walk check threw`)
        }
      }
    }
  }
  return { orders, incompleteReasons: reasons, startedAtMs }
}

const HOLDING_OR_COMPLETED = new Set<string>([...WC_STOCK_HOLDING_ORDER_STATUSES, 'completed'])

/**
 * Fetch the dirty orders by id and add the ones WooCommerce still holds to `orders` (once each: an order the walks already read is not
 * added twice). Orders in another status are settled at once. `pendingDirty` gets the held ones, decided after they are charged.
 */
async function recheckDirtyOrders(
  deps: WcHeldUnitsDeps,
  dirtyWcOrderIds: readonly string[],
  orders: WcFullOrder[],
  settled: Set<string>,
  pending: Set<string>,
  reasons: string[],
): Promise<{ fatal?: string }> {
  let wanted = [...new Set(dirtyWcOrderIds.filter((id) => id !== ''))]
  if (wanted.length === 0) return {}
  if (wanted.length > WC_DIRTY_MAX_PER_RUN) {
    reasons.push(`dirty orders: ${wanted.length} released orders await a re-check, more than the ${WC_DIRTY_MAX_PER_RUN} one run reads`)
    wanted = wanted.slice(0, WC_DIRTY_MAX_PER_RUN)
  }
  const have = new Set(orders.map((o) => String(o?.id ?? '')))
  for (let i = 0; i < wanted.length; i += WC_DIRTY_FETCH_BATCH) {
    const batch = wanted.slice(i, i + WC_DIRTY_FETCH_BATCH)
    let response: { data: unknown; error?: string }
    try {
      response = await deps.fetchOrdersPage({ include: batch.join(','), per_page: String(WC_DIRTY_FETCH_BATCH), page: '1' })
    } catch (e) {
      reasons.push(`dirty orders: re-check read threw: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (response.error || !Array.isArray(response.data)) {
      reasons.push(`dirty orders: re-check read failed: ${response.error ?? 'the answer was not a list'}`)
      continue
    }
    const returned = new Map<string, WcFullOrder>()
    for (const o of response.data as WcFullOrder[]) returned.set(String(o?.id ?? ''), o)
    for (const id of batch) {
      const order = returned.get(id)
      if (!order) {
        reasons.push(`dirty orders: WooCommerce did not return order ${id}`)
        continue
      }
      if (!HOLDING_OR_COMPLETED.has(String(order.status))) {
        settled.add(id)
        continue
      }
      pending.add(id)
      if (!have.has(id)) {
        orders.push(order)
        have.add(id)
      }
    }
  }
  return {}
}

export async function loadWcHeldUnitsByProduct(
  deps: WcHeldUnitsDeps,
  /** `modified_after` for the completed-order read (see completedOrdersModifiedAfter); null = cannot be bounded, so read them all. */
  completedModifiedAfter: string | null,
  /** WooCommerce ids of the dirty orders to re-check by id (see DIRTY ORDERS). */
  dirtyWcOrderIds: readonly string[] = [],
): Promise<WcHeldUnitsResult> {
  const statuses = WC_STOCK_HOLDING_ORDER_STATUSES.join(',')
  const open = await walkOrders(deps, statuses, { status: statuses })
  if (open.fatal) return { ok: false, reason: open.fatal }
  const incompleteReasons = [...open.incompleteReasons]
  const orders: WcFullOrder[] = [...open.orders]
  const completed = await walkOrders(deps, 'completed', { status: 'completed', ...(completedModifiedAfter === null ? {} : { modified_after: completedModifiedAfter }) }, { churnProbe: true })
  if (completed.fatal) return { ok: false, reason: completed.fatal }
  incompleteReasons.push(...completed.incompleteReasons.map((r) => (completedModifiedAfter === null ? `${r} (a sweep cursor is missing, so ALL completed orders were read)` : r)))
  orders.push(...completed.orders)
  const settledDirty = new Set<string>()
  const pendingDirty = new Set<string>()
  const dirty = await recheckDirtyOrders(deps, dirtyWcOrderIds, orders, settledDirty, pendingDirty, incompleteReasons)
  if (dirty.fatal) return { ok: false, reason: dirty.fatal }
  const truncated = incompleteReasons.length > 0
  const completedIds = new Set(completed.orders.map((o) => String(o?.id ?? '')))
  let completedSettled = true
  const coveredAtIfSettled = completedModifiedAfter === null && !truncated ? completed.startedAtMs : null

  const ids = [...new Set(orders.map((o) => String(o?.id ?? '')))]
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
  if (allLines.length === 0) {
    for (const id of pendingDirty) settledDirty.add(id) // held but nothing on it: nothing to charge
    return { ok: true, heldByProduct, blockedProductIds, incomplete: truncated, incompleteReasons, ordersConsidered: 0, completedHistoryCoveredAtMs: coveredAtIfSettled, settledDirtyWcOrderIds: [...settledDirty] }
  }

  const externalIds = [...new Set(allLines.flatMap((l) => [l.variationId, l.productId]).filter((n) => n > 0))]
  const skus = [...new Set(allLines.map((l) => l.sku).filter((s) => s !== ''))]
  const products = await deps.findProducts(externalIds, skus)

  const unresolvedParents = new Set<number>()
  let considered = 0
  for (const { id, lines } of perOrderLines) {
    const { held, unresolvedLines } = aggregateHeldUnits(lines, products)
    for (const l of unresolvedLines) if (l.productId > 0) unresolvedParents.add(l.productId)
    const remainder = imported.has(id) ? unallocatedRemainder(held, imported.get(id)) : held
    if (completedIds.has(id) && (remainder.size > 0 || unresolvedLines.length > 0)) completedSettled = false
    if (remainder.size > 0 || unresolvedLines.length > 0) considered++
    else if (pendingDirty.has(id)) settledDirty.add(id)
    for (const [productId, qty] of remainder) heldByProduct.set(productId, (heldByProduct.get(productId) ?? 0) + qty)
  }
  if (unresolvedParents.size > 0) {
    for (const id of await deps.findVariationIdsByParentExternalId([...unresolvedParents])) blockedProductIds.add(id)
  }
  return { ok: true, heldByProduct, blockedProductIds, incomplete: truncated, incompleteReasons, ordersConsidered: considered, completedHistoryCoveredAtMs: completedSettled ? coveredAtIfSettled : null, settledDirtyWcOrderIds: [...settledDirty] }
}
