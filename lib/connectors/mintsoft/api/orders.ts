import type { WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { getMintsoftSettings, MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE } from '../settings/schema'
import type { MintsoftSettings } from '../settings/schema'
import { extractMintsoftArrayPayload, extractMintsoftArrayPayloadStrict, extractMintsoftObjectPayload } from './normalizers'
import { mintsoftRequest } from './client'

/**
 * Live Mintsoft order-status lookup, modelled on the proven woo-mintsoft plugin
 * (wc_mintsoft_orders.py). An order is found by `GET /api/Order/Search?OrderNumber=`;
 * its numeric `OrderStatusId` is resolved to a name via `GET /api/Order/Statuses`
 * (cached); split (`NumberOfParts`>1) and merged (`OrderNumber` carries "a+b")
 * orders are detected from the order fields. Read-only.
 */

type RawOrder = Record<string, unknown>

const STATUSES_TTL_MS = 10 * 60 * 1000
let statusCache: { at: number; map: Map<number, string> } | null = null

function toStr(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** OrderStatusId → uppercased status name. Cached for STATUSES_TTL_MS. */
async function fetchMintsoftOrderStatusMap(): Promise<Map<number, string>> {
  if (statusCache && Date.now() - statusCache.at < STATUSES_TTL_MS) {
    return statusCache.map
  }
  const result = await mintsoftRequest<unknown>('/api/Order/Statuses')
  if (result.error) throw new Error(result.error)

  const map = new Map<number, string>()
  for (const item of extractMintsoftArrayPayload(result.data)) {
    const row = item as RawOrder
    const id = toInt(row.ID ?? row.Id ?? row.id)
    const name = toStr(row.Name ?? row.name)
    if (id !== null && name) map.set(id, name.toUpperCase())
  }
  statusCache = { at: Date.now(), map }
  return map
}

async function searchMintsoftOrdersByNumber(orderNumber: string): Promise<RawOrder[]> {
  const query = new URLSearchParams({ OrderNumber: orderNumber.trim() })
  const result = await mintsoftRequest<unknown>(`/api/Order/Search?${query.toString()}`)
  if (result.error) throw new Error(result.error)
  return extractMintsoftArrayPayload(result.data) as RawOrder[]
}

/**
 * Authoritative single-order fetch. `/api/Order/Search` rows can carry null
 * status/courier fields, so we re-read the picked order by id (matching the
 * proven plugin, which follows every search hit with GET /api/Order/{id}).
 */
async function fetchMintsoftOrderById(externalOrderId: string): Promise<RawOrder | null> {
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}`)
  if (result.status === 404) return null
  if (result.error) throw new Error(result.error)
  return extractMintsoftObjectPayload(result.data) as RawOrder | null
}

export function mergedParts(orderNumber: string | null): string[] {
  if (!orderNumber || !orderNumber.includes('+')) return []
  return orderNumber.split('+').map((part) => part.trim()).filter(Boolean)
}

/**
 * Choose the order to report for `orderNumber`. Prefer an exact OrderNumber
 * match; a split order returns one row per part (sharing the number), so sort by
 * `Part` and take the primary (Part 1) deterministically. Otherwise fall back to
 * a merged survivor that folded this number in — but only when EXACTLY ONE
 * merged candidate matches (fail closed on ambiguity, like the reference plugin).
 */
export function pickOrderRow(orders: RawOrder[], orderNumber: string): RawOrder | null {
  const wanted = orderNumber.trim()
  const exact = orders
    .filter((order) => toStr(order.OrderNumber) === wanted)
    .sort((a, b) => (toInt(a.Part) ?? 1) - (toInt(b.Part) ?? 1))
  if (exact.length > 0) return exact[0]

  const merged = orders.filter((order) => mergedParts(toStr(order.OrderNumber)).includes(wanted))
  return merged.length === 1 ? merged[0] : null
}

/**
 * Tri-state presence probe (q66in.4.4): unlike fetchMintsoftOrderStatus, this
 * distinguishes a search with NO trace of the order (MISSING) from one whose
 * candidates exist but cannot be disambiguated (AMBIGUOUS — pickOrderRow fails
 * closed on multiple merged matches). Reconciliation only treats MISSING as
 * safe grounds for re-creating the order.
 */
export async function probeMintsoftOrderPresence(orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> {
  const reference = orderNumber.trim()
  if (!reference) return 'MISSING'
  const matches = await searchMintsoftOrdersByNumber(reference)
  if (matches.length === 0) return 'MISSING'
  return pickOrderRow(matches, reference) ? 'FOUND' : 'AMBIGUOUS'
}

export function readTracking(order: RawOrder): WmsOrderTracking[] {
  const trackingNumber = toStr(order.TrackingNumber)
  const carrier = toStr(order.CourierServiceName)
  const despatchedAt = toStr(order.DespatchDate)
  if (!trackingNumber && !carrier && !despatchedAt) return []
  return [{ trackingNumber, carrier, despatchedAt }]
}

export function buildDeepLink(template: string, externalOrderId: string): string | null {
  const base = (template || MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE).trim()
  if (!base.includes('{id}')) return null
  return base.replace('{id}', encodeURIComponent(externalOrderId))
}

/**
 * Build a WmsOrderStatus from a single raw Mintsoft Order row. Shared by the
 * per-order lookup (fetchMintsoftOrderStatus) and the bulk Order/List delta
 * (fetchMintsoftOrderList) so both derive status/tracking/split/merge/deep-link
 * identically. Returns null when the row has no resolvable id. The row is
 * trusted as-is (the delta path does not re-read by id) — callers that need the
 * authoritative re-read do it before calling this.
 */
export async function normalizeMintsoftOrderRow(
  order: RawOrder,
  // Bulk callers (Order/List delta) pass a pre-fetched status map + settings so a
  // multi-row page resolves them ONCE, not once per row — otherwise a cold status
  // cache with no in-flight dedup fans out one /api/Order/Statuses request and one
  // settings read per row (o3d-bjc Codex: a request storm that trips throttling).
  ctx?: { statusMap: Map<number, string>; settings: MintsoftSettings },
): Promise<WmsOrderStatus | null> {
  const externalOrderId = toStr(order.ID ?? order.Id ?? order.id)
  if (!externalOrderId) return null

  const statusId = toInt(order.OrderStatusId)
  const statusMap = ctx?.statusMap ?? (await fetchMintsoftOrderStatusMap())
  const status = (statusId !== null ? statusMap.get(statusId) : null) ?? ''

  const externalOrderNumber = toStr(order.OrderNumber) ?? ''
  const partCount = toInt(order.NumberOfParts)
  const merged = mergedParts(externalOrderNumber)
  const settings = ctx?.settings ?? (await getMintsoftSettings())
  const tracking = readTracking(order)

  return {
    externalOrderId,
    externalOrderNumber,
    status,
    statusLabel: status || 'Unknown',
    isSplit: (partCount ?? 1) > 1,
    partCount: partCount ?? null,
    isMerged: merged.length > 0,
    mergedOrderNumbers: merged,
    deepLinkUrl: buildDeepLink(settings.mintsoft_admin_order_url_template, externalOrderId),
    tracking,
    dispatched: isMintsoftDispatched({ status, tracking }),
    raw: order,
  }
}

export async function fetchMintsoftOrderStatus(orderNumber: string): Promise<WmsOrderStatus | null> {
  const reference = orderNumber.trim()
  if (!reference) return null

  const matches = await searchMintsoftOrdersByNumber(reference)
  const picked = pickOrderRow(matches, reference)
  if (!picked) return null

  const pickedId = toStr(picked.ID ?? picked.Id ?? picked.id)
  if (!pickedId) return null

  // Re-read by id for authoritative status/tracking; fall back to the search row
  // if the detail 404s (e.g. the order was merged away after the search).
  const order = (await fetchMintsoftOrderById(pickedId)) ?? picked
  const normalized = await normalizeMintsoftOrderRow(order)
  if (!normalized) return null

  // Preserve the historical fallbacks: a row with no id echoes the picked id;
  // a row with no number echoes the caller's reference.
  return {
    ...normalized,
    externalOrderId: normalized.externalOrderId || pickedId,
    externalOrderNumber: normalized.externalOrderNumber || reference,
  }
}

/**
 * Bulk Order/List delta: every order changed since `sinceLastUpdated`, in one
 * (paginated) call, normalised to WmsOrderStatus. This is the replacement for
 * the per-active-order status poll — the dispatch sweep processes the orders in
 * this delta directly and only per-order polls on a throttled reconcile.
 *
 * `sinceLastUpdated` must already be a `YYYY-MM-DDTHH:MM:SS` timestamp in the
 * Mintsoft tenant's own timezone (Mintsoft compares SinceLastUpdated against
 * LastUpdated in the database's zone, NOT UTC — the caller does the conversion).
 * `IncludeOrderItems=true` + `SortOldestFirst=true` are always sent; ClientId /
 * WarehouseId / ChannelId scope the query to our traffic on a shared tenant.
 *
 * FAILS CLOSED on `clientId`: Mintsoft is a shared 3PL tenant, so an UNSCOPED
 * Order/List returns EVERY client's orders — and matching a foreign row to a
 * local link by order number alone could mark OUR order shipped off a FOREIGN
 * despatch. A null/absent `clientId` therefore THROWS rather than running an
 * unscoped delta. As defence in depth, any returned row whose echoed ClientId
 * differs from `clientId` is DROPPED (it falls through to the per-order reconcile).
 *
 * Also THROWS (rather than returning a partial list) when the result overflows
 * `maxPages * limit` — a truncated delta must never look complete, or the sweep
 * would advance its watermark past orders it never saw. Like every other
 * client.ts fetch it also throws on any HTTP error, so the caller can tell
 * "nothing changed" (empty list) from "couldn't complete the delta" (throw) and
 * fail safe to the per-order reconcile.
 */
export async function fetchMintsoftOrderList(opts: {
  sinceLastUpdated: string
  clientId: number | null
  warehouseId?: number | null
  channelId?: number | null
  limit?: number
  maxPages?: number
}): Promise<WmsOrderStatus[]> {
  const since = opts.sinceLastUpdated.trim()
  if (!since) return []
  // Fail closed: never run an unscoped cross-client delta (see the doc-comment).
  const clientId = opts.clientId ?? null
  if (clientId == null) {
    throw new Error(
      'Mintsoft Order/List delta requires a ClientId (configure mintsoft_client_id) — ' +
        'refusing to run an unscoped cross-client delta',
    )
  }
  const limit = opts.limit && opts.limit > 0 ? Math.trunc(opts.limit) : 200
  const maxPages = opts.maxPages && opts.maxPages > 0 ? Math.trunc(opts.maxPages) : 50

  const collected: RawOrder[] = []
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const query = new URLSearchParams({
      SinceLastUpdated: since,
      Limit: String(limit),
      PageNo: String(pageNo),
      SortOldestFirst: 'true',
      IncludeOrderItems: 'true',
      ClientId: String(clientId),
    })
    if (opts.warehouseId != null) query.set('WarehouseId', String(opts.warehouseId))
    if (opts.channelId != null) query.set('ChannelId', String(opts.channelId))

    const result = await mintsoftRequest<unknown>(`/api/Order/List?${query.toString()}`)
    if (result.error) throw new Error(result.error)

    // Strict parse: a 2xx body that is neither an array nor a recognised wrapper
    // (schema drift, a proxy error object, null) THROWS rather than looking like a
    // complete empty page — else the caller would advance its watermark past rows
    // it never saw. A genuine empty/short page still ends pagination normally.
    const page = extractMintsoftArrayPayloadStrict(result.data, `Order/List page ${pageNo}`)
    // Per-row fail-closed validation (parity with the Python delta reader): every
    // row must be an object carrying a resolvable ID and a non-empty order number.
    // A malformed row is schema/API drift, not "no change" — silently dropping it
    // (normalize→null filter, or an empty delta-map key) would let the caller
    // advance its watermark past an order it never applied.
    for (const row of page) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row is not an object — refusing to treat a malformed delta as complete`)
      }
      const record = row as RawOrder
      const rowId = toStr(record.ID ?? record.Id ?? record.id)
      if (rowId === null) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row missing a valid ID — refusing to treat a malformed delta as complete`)
      }
      if (toStr(record.OrderNumber) === null) {
        throw new Error(`Mintsoft Order/List page ${pageNo}: row ${rowId} missing an order number — refusing to treat a malformed delta as complete`)
      }
      // Defence in depth: even with ClientId in the query, DROP any row whose
      // echoed ClientId isn't ours — never trust an order-number match belonging
      // to another client on the shared tenant. A row that omits ClientId is
      // trusted via the query-param scoping. A dropped row simply isn't in the
      // delta, so it falls through to the per-order reconcile. (This is a DROP,
      // not a throw: a foreign row is valid data, just not ours.)
      const rowClientId = toInt(record.ClientId ?? record.clientId)
      if (rowClientId !== null && rowClientId !== clientId) continue
      collected.push(record)
    }
    if (page.length < limit) {
      if (collected.length === 0) return []
      // Resolve the status map + settings ONCE for the whole list (they're the
      // same for every row) so normalisation makes no per-row API/DB calls.
      const statusMap = await fetchMintsoftOrderStatusMap()
      const settings = await getMintsoftSettings()
      const normalized = await Promise.all(collected.map((row) => normalizeMintsoftOrderRow(row, { statusMap, settings })))
      return normalized.filter((row): row is WmsOrderStatus => row !== null)
    }
  }

  // No short page within the budget ⇒ more changed rows than maxPages*limit.
  // Fail closed so the caller keeps its watermark and reconciles.
  throw new Error(
    `Mintsoft Order/List delta exceeded ${maxPages} pages at limit=${limit} (since=${since}); ` +
      'refusing to treat a truncated delta as complete',
  )
}

/**
 * Raw Mintsoft order statuses that mean the goods have left the warehouse. Mintsoft
 * invoices only after despatch, so INVOICED is strictly post-despatch (the SO chip
 * treats it as terminal/green); the despatchedAt fallback covers feeds where the status
 * row lags. If a proforma-style pre-despatch INVOICED ever appears, tighten to DESPATCHED.
 */
export const MINTSOFT_DISPATCHED_STATUSES = new Set(['DESPATCHED', 'INVOICED'])

/** Mintsoft's connector-specific "dispatched" decision (normalised onto WmsOrderStatus). */
export function isMintsoftDispatched(status: { status: string; tracking: WmsOrderTracking[] }): boolean {
  if (MINTSOFT_DISPATCHED_STATUSES.has(status.status.trim().toUpperCase())) return true
  return status.tracking.some((entry) => Boolean(entry.despatchedAt))
}

export type MintsoftOrderPart = {
  /** The Mintsoft order id of this part (used to fetch its line items). */
  externalId: string
  /** 1-based part number within the split. */
  partNumber: number
  /** Raw Mintsoft status name (uppercased), e.g. "DESPATCHED". */
  status: string
  /** Normalised dispatched flag for this part. */
  dispatched: boolean
  tracking: WmsOrderTracking[]
}

/**
 * Every part of a (possibly split) Mintsoft order, by order number. A split order
 * returns one row per part from `/Order/Search` sharing the OrderNumber; unlike
 * fetchMintsoftOrderStatus (which collapses to Part 1), we keep every part and
 * re-read each by id for an authoritative status + tracking (search rows can carry
 * null status/courier). Used by dispatch-sync to reconcile per-part despatch.
 */
export async function fetchMintsoftOrderParts(orderNumber: string): Promise<MintsoftOrderPart[]> {
  const reference = orderNumber.trim()
  if (!reference) return []
  const rows = await searchMintsoftOrdersByNumber(reference)
  const exact = rows.filter((row) => toStr(row.OrderNumber) === reference)
  if (exact.length === 0) return []

  const statusMap = await fetchMintsoftOrderStatusMap()
  const parts: MintsoftOrderPart[] = []
  for (const row of exact) {
    const searchId = toStr(row.ID ?? row.Id ?? row.id)
    if (!searchId) continue
    const detail = (await fetchMintsoftOrderById(searchId)) ?? row
    const externalId = toStr(detail.ID ?? detail.Id ?? detail.id) ?? searchId
    const statusId = toInt(detail.OrderStatusId)
    const partStatus = (statusId !== null ? statusMap.get(statusId) : null) ?? ''
    const partTracking = readTracking(detail)
    parts.push({
      externalId,
      // Fall back to a running index (not a constant 1) when Mintsoft omits Part, so
      // two part-less rows can't collapse to the same number and have the storefront's
      // per-part idempotency dedupe distinct despatches into one.
      partNumber: toInt(detail.Part) ?? toInt(row.Part) ?? (parts.length + 1),
      status: partStatus,
      dispatched: isMintsoftDispatched({ status: partStatus, tracking: partTracking }),
      tracking: partTracking,
    })
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

/** Line items (SKU + whole-unit qty) of a single Mintsoft order/part. */
export async function fetchMintsoftPartItems(externalOrderId: string): Promise<Array<{ sku: string; qty: number }>> {
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Items`)
  if (result.error) throw new Error(result.error)
  const out: Array<{ sku: string; qty: number }> = []
  for (const raw of extractMintsoftArrayPayload(result.data)) {
    const r = raw as RawOrder
    const sku = toStr(r.SKU)
    const qty = toInt(r.Quantity) ?? 0
    if (sku && qty > 0) out.push({ sku, qty })
  }
  return out
}
