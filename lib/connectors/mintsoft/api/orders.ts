import type { WmsOrderStatus, WmsOrderTracking } from '@/lib/connectors/wms/types'
import { getMintsoftSettings, MINTSOFT_DEFAULT_ADMIN_ORDER_URL_TEMPLATE } from '../settings/schema'
import { extractMintsoftArrayPayload, extractMintsoftObjectPayload } from './normalizers'
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
  const externalOrderId = toStr(order.ID ?? order.Id ?? order.id) ?? pickedId

  const statusId = toInt(order.OrderStatusId)
  const statusMap = await fetchMintsoftOrderStatusMap()
  const status = (statusId !== null ? statusMap.get(statusId) : null) ?? ''

  const externalOrderNumber = toStr(order.OrderNumber) ?? reference
  const partCount = toInt(order.NumberOfParts)
  const merged = mergedParts(externalOrderNumber)
  const settings = await getMintsoftSettings()
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
