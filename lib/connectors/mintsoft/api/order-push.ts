import type {
  WmsOrderCancelResult,
  WmsOrderPushInput,
  WmsOrderPushLine,
  WmsOrderPushResult,
  WmsOrderUpdateResult,
} from '@/lib/connectors/wms/types'
import { extractMintsoftArrayPayload, extractMintsoftObjectPayload } from './normalizers'
import { mintsoftRequest } from './client'
import { getMintsoftSettings } from '../settings/schema'

/**
 * Outbound Mintsoft order push (Phase 8), modelled on the proven woo-mintsoft
 * plugin (wc_mintsoft_orders.py): create via `PUT /api/Order` (NewOrderWithItems),
 * dedupe on "already exists" by re-finding the order via ExternalOrderReference,
 * and cancel via `GET /api/Order/{id}/Cancel` — only while the order is still NEW.
 */

type RawOrder = Record<string, unknown>

function toStr(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

type CourierOption =
  | { kind: 'name' }
  | { kind: 'mappedId'; courierServiceId: number }
  | { kind: 'defaultId'; courierServiceId: number }
  | { kind: 'none' }

/** Resolve a shipping-service name to a Mintsoft CourierServiceId via the configured map. */
export function resolveMappedCourierId(courierService: string | null, mapJson: string): number | null {
  if (!courierService || !mapJson.trim()) return null
  try {
    const map = JSON.parse(mapJson) as Record<string, unknown>
    const raw = map[courierService]
    const id = typeof raw === 'number' ? raw : Number(String(raw).trim())
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/**
 * Strict parse for the configured default CourierServiceId: a plain positive
 * integer, else null. Plain-digit only so the saved value and this consumer
 * agree (avoids `parseInt`/`Number` divergence on `"1e3"`, `"0x10"`, decimals).
 */
export function parseDefaultCourierId(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim()
  if (!/^\d+$/.test(trimmed)) return null
  const id = Number(trimmed)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function buildPushPayload(input: WmsOrderPushInput, courier: CourierOption, includeItems = true): Record<string, unknown> {
  const a = input.shippingAddress
  const payload: Record<string, unknown> = {
    OrderNumber: input.orderNumber,
    ExternalOrderReference: input.externalReference,
    FirstName: a.firstName,
    LastName: a.lastName,
    CompanyName: a.company,
    Address1: a.address1,
    Address2: a.address2,
    Town: a.town,
    County: a.county,
    PostCode: a.postCode,
    Country: a.country,
    Email: input.email ?? '',
    Phone: input.phone ?? '',
    Currency: input.currency,
    TotalVat: round2(input.totalVat),
    ShippingTotalExVat: round2(input.shippingExVat),
    ShippingTotalVat: round2(input.shippingVat),
    DiscountTotalExVat: round2(input.discountExVat),
    DiscountTotalVat: round2(input.discountVat),
    Comments: (input.comments ?? '').slice(0, 1000),
  }
  // VAT goes on the create payload only (with the items); amends reuse this builder
  // with includeItems=false, and a Mintsoft order's VAT number may be immutable once
  // created — don't risk an amend rejection by re-sending it.
  if (includeItems && input.vatNumber) payload.VATNumber = input.vatNumber
  if (includeItems) {
    // The order-update endpoint (NewOrder) ignores items, so creates send them here and
    // amendments are reconciled separately via the /Items sub-resource endpoints
    // (see reconcileMintsoftOrderItems).
    payload.OrderItems = input.lines.map((line) => ({
      SKU: line.sku,
      Quantity: line.quantity,
      UnitPrice: line.unitPriceExVat,
      UnitPriceVat: line.unitPriceVat,
      Details: (line.description ?? '').slice(0, 255),
    }))
  }
  const warehouseId = Number.parseInt(input.externalWarehouseId, 10)
  if (Number.isFinite(warehouseId)) payload.WarehouseId = warehouseId
  if (courier.kind === 'name' && input.courierService) {
    payload.CourierService = input.courierService
  } else if (courier.kind === 'mappedId') {
    // Configured mapping: send both the name and the resolved service id.
    if (input.courierService) payload.CourierService = input.courierService
    payload.CourierServiceId = courier.courierServiceId
  } else if (courier.kind === 'defaultId') {
    // Mintsoft requires a courier identifier; fall back to a configured default
    // service id so the warehouse can re-pick if the name didn't resolve.
    payload.CourierServiceId = courier.courierServiceId
  }
  return payload
}

async function findExistingByReference(input: WmsOrderPushInput): Promise<RawOrder | null> {
  // Mintsoft's search is OrderNumber-based; match field-for-field (never
  // number-vs-reference) and only resolve when exactly one order matches.
  const query = new URLSearchParams({ OrderNumber: input.orderNumber })
  const result = await mintsoftRequest<unknown>(`/api/Order/Search?${query.toString()}`)
  if (result.error) throw new Error(result.error)
  const matches = extractMintsoftArrayPayload(result.data)
    .map((row) => row as RawOrder)
    .filter((row) => {
      const number = toStr(row.OrderNumber)
      if (number && number.includes('+')) return false // skip merged survivors
      const ref = toStr(row.ExternalOrderReference)
      return number === input.orderNumber || ref === input.externalReference
    })
  return matches.length === 1 ? matches[0] : null
}

async function createOrder(payload: Record<string, unknown>): Promise<{ ok: boolean; data: RawOrder | null; message: string | null }> {
  const result = await mintsoftRequest<unknown>('/api/Order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (result.error) throw new Error(result.error)
  // PUT /api/Order returns NewOrderResult[] (older tenants: a single object).
  const raw = result.data
  const data: RawOrder | null = Array.isArray(raw)
    ? ((raw[0] as RawOrder) ?? null)
    : (extractMintsoftObjectPayload(raw) as RawOrder | null)
  const ok = data?.Success === true || data?.OrderId != null
  return { ok, data, message: toStr(data?.Message) }
}

export async function pushMintsoftOrder(input: WmsOrderPushInput): Promise<WmsOrderPushResult> {
  const settings = await getMintsoftSettings()
  // Courier selection: a configured shipping-service → CourierServiceId mapping
  // wins; else pass the name through for the WMS to resolve; else (no service on
  // the order at all) fall straight to the configured default id if one is set.
  const mappedId = resolveMappedCourierId(input.courierService, settings.mintsoft_courier_service_map)
  const defaultId = parseDefaultCourierId(settings.mintsoft_default_courier_service_id)
  const initialCourier: CourierOption =
    mappedId != null ? { kind: 'mappedId', courierServiceId: mappedId }
    : input.courierService ? { kind: 'name' }
    : defaultId != null ? { kind: 'defaultId', courierServiceId: defaultId }
    : { kind: 'name' }
  let created = await createOrder(buildPushPayload(input, initialCourier))

  // Courier the WMS couldn't resolve → retry with the configured default id
  // (unless we already used it). Mintsoft requires a resolvable courier. A default id
  // used from the outset (order had no shipping service) is equally "pending" — the
  // warehouse should still confirm the courier before despatch (G6).
  let courierFallback = initialCourier.kind === 'defaultId'
  if (
    !created.ok && created.message && /courierservice/i.test(created.message)
    && defaultId != null && initialCourier.kind !== 'defaultId'
  ) {
    courierFallback = true
    created = await createOrder(buildPushPayload(input, { kind: 'defaultId', courierServiceId: defaultId }))
  }

  if (created.ok && created.data) {
    const externalOrderId = toStr(created.data.OrderId)
    if (externalOrderId) {
      return {
        externalOrderId,
        externalOrderNumber: toStr(created.data.OrderNumber) ?? input.orderNumber,
        status: 'NEW',
        courierFallback,
      }
    }
  }

  // Duplicate → reconcile to the order that already exists (lost writeback).
  if (created.message && /already exists/i.test(created.message)) {
    const existing = await findExistingByReference(input)
    const externalOrderId = existing ? toStr(existing.ID ?? existing.Id ?? existing.id) : null
    if (existing && externalOrderId) {
      return {
        externalOrderId,
        externalOrderNumber: toStr(existing.OrderNumber) ?? input.orderNumber,
        status: 'NEW',
        courierFallback,
      }
    }
  }

  throw new Error(created.message ?? 'Mintsoft order push failed')
}

/** Mintsoft OrderStatusId 1 === NEW; only NEW orders are mutable/cancellable. */
async function fetchMintsoftOrderStatusId(externalOrderId: string): Promise<{ found: boolean; isNew: boolean }> {
  const current = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}`)
  if (current.status === 404) return { found: false, isNew: false }
  if (current.error) throw new Error(current.error)
  const order = extractMintsoftObjectPayload(current.data) as RawOrder | null
  const statusId = order?.OrderStatusId
  return { found: true, isNew: statusId === 1 || statusId === '1' }
}

type MintsoftOrderItem = { ID: number; SKU: string | null; Quantity: number }

/** One concrete amendment to bring a Mintsoft order's items in line with the desired set. */
export type MintsoftItemAmendment =
  | { kind: 'update'; itemId: number; line: WmsOrderPushLine; quantity: number }
  | { kind: 'add'; line: WmsOrderPushLine; quantity: number }
  | { kind: 'delete'; itemId: number }

/**
 * Pure planner: diff a Mintsoft order's current items against the desired (refund-netted)
 * line set and return the amendments needed. Quantities are absolute. Matched by trimmed
 * SKU; an order carrying the same SKU on more than one line is aggregated, and any duplicate
 * WMS rows for that SKU are consolidated into the first (the rest deleted). Lines that net to
 * zero (or are gone) are deleted; lines not yet on the order are added. The plan is ordered
 * deletes → updates → adds so a consolidation never transiently overstates demand for a SKU.
 */
export function planMintsoftItemAmendments(
  current: MintsoftOrderItem[],
  desiredLines: WmsOrderPushLine[],
): MintsoftItemAmendment[] {
  const desired = new Map<string, { quantity: number; line: WmsOrderPushLine }>()
  for (const line of desiredLines) {
    const sku = line.sku?.trim()
    if (!sku) continue
    const existing = desired.get(sku)
    if (existing) existing.quantity += line.quantity
    else desired.set(sku, { quantity: line.quantity, line })
  }

  const currentBySku = new Map<string, MintsoftOrderItem[]>()
  for (const item of current) {
    const sku = item.SKU?.trim()
    if (!sku) continue
    const list = currentBySku.get(sku) ?? []
    list.push(item)
    currentBySku.set(sku, list)
  }

  const deletes: MintsoftItemAmendment[] = []
  const updates: MintsoftItemAmendment[] = []
  const adds: MintsoftItemAmendment[] = []
  for (const sku of new Set<string>([...desired.keys(), ...currentBySku.keys()])) {
    const want = desired.get(sku)
    const have = currentBySku.get(sku) ?? []
    if (!want || want.quantity <= 0) {
      for (const item of have) deletes.push({ kind: 'delete', itemId: item.ID })
      continue
    }
    if (have.length === 0) {
      adds.push({ kind: 'add', line: want.line, quantity: want.quantity })
      continue
    }
    const [primary, ...duplicates] = have
    for (const dup of duplicates) deletes.push({ kind: 'delete', itemId: dup.ID })
    if (primary.Quantity !== want.quantity) {
      updates.push({ kind: 'update', itemId: primary.ID, line: want.line, quantity: want.quantity })
    }
  }
  return [...deletes, ...updates, ...adds]
}

function buildMintsoftOrderItemPayload(line: WmsOrderPushLine, quantity: number, externalWarehouseId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    SKU: line.sku,
    Quantity: quantity,
    UnitPrice: round2(line.unitPriceExVat),
    UnitPriceVat: round2(line.unitPriceVat),
    Details: (line.description ?? '').slice(0, 255),
  }
  const warehouseId = Number.parseInt(externalWarehouseId, 10)
  if (Number.isFinite(warehouseId)) payload.WarehouseId = warehouseId
  return payload
}

async function fetchMintsoftOrderItems(externalOrderId: string): Promise<MintsoftOrderItem[]> {
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Items`)
  if (result.error) throw new Error(result.error)
  return extractMintsoftArrayPayload(result.data)
    .map((raw) => {
      const r = raw as RawOrder
      const id = typeof r.ID === 'number' ? r.ID : Number.parseInt(toStr(r.ID) ?? '', 10)
      const qty = typeof r.Quantity === 'number' ? r.Quantity : Number.parseInt(toStr(r.Quantity) ?? '', 10)
      return { ID: id, SKU: toStr(r.SKU), Quantity: Number.isFinite(qty) ? qty : 0 }
    })
    .filter((item): item is MintsoftOrderItem => Number.isFinite(item.ID))
}

/** Bring a NEW Mintsoft order's line items in line with the (refund-netted) desired set. */
async function reconcileMintsoftOrderItems(externalOrderId: string, input: WmsOrderPushInput): Promise<void> {
  // Mintsoft item quantities are whole units. If any desired line is non-integer or
  // negative, skip item reconciliation rather than send rejects in a retry loop — the
  // refund still surfaces a manual line-item query. Whole-unit orders (the norm) reconcile.
  if (input.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 0)) return

  const plan = planMintsoftItemAmendments(await fetchMintsoftOrderItems(externalOrderId), input.lines)
  const base = `/api/Order/${encodeURIComponent(externalOrderId)}/Items`
  for (const amendment of plan) {
    let result
    if (amendment.kind === 'delete') {
      result = await mintsoftRequest<unknown>(`${base}/${encodeURIComponent(String(amendment.itemId))}`, { method: 'DELETE' })
    } else if (amendment.kind === 'add') {
      result = await mintsoftRequest<unknown>(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMintsoftOrderItemPayload(amendment.line, amendment.quantity, input.externalWarehouseId)),
      })
    } else {
      result = await mintsoftRequest<unknown>(`${base}/${encodeURIComponent(String(amendment.itemId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMintsoftOrderItemPayload(amendment.line, amendment.quantity, input.externalWarehouseId)),
      })
    }
    if (result.error) throw new Error(result.error)
  }
}

export async function updateMintsoftOrder(externalOrderId: string, input: WmsOrderPushInput): Promise<WmsOrderUpdateResult> {
  const { found, isNew } = await fetchMintsoftOrderStatusId(externalOrderId)
  if (!found) return { updated: false, status: 'NOT_FOUND' }
  if (!isNew) return { updated: false, status: 'NOT_NEW' }

  // Line items are amended via the /Items sub-resource (the order-update endpoint ignores
  // them); this propagates refund-netted quantities to the still-NEW WMS order.
  await reconcileMintsoftOrderItems(externalOrderId, input)

  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPushPayload(input, { kind: 'name' }, false)),
  })
  if (result.error) throw new Error(result.error)
  const raw = result.data
  const data: RawOrder | null = Array.isArray(raw) ? ((raw[0] as RawOrder) ?? null) : (extractMintsoftObjectPayload(raw) as RawOrder | null)
  if (data?.Success === true || data?.OrderId != null) return { updated: true, status: 'NEW' }
  throw new Error(toStr(data?.Message) ?? 'Mintsoft order update failed')
}

/** Post an internal (admin) note onto a Mintsoft order via POST /api/Order/{id}/Comments. */
export async function addMintsoftOrderComment(externalOrderId: string, comment: string): Promise<void> {
  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Comment: comment.slice(0, 1000), Admin: true }),
  })
  if (result.error) throw new Error(result.error)
}

export async function cancelMintsoftOrder(externalOrderId: string): Promise<WmsOrderCancelResult> {
  // Only NEW orders are cancellable; check first so a dispatched order is a no-op.
  const { found, isNew } = await fetchMintsoftOrderStatusId(externalOrderId)
  if (!found) return { cancelled: false, status: 'NOT_FOUND' }
  if (!isNew) return { cancelled: false, status: 'NOT_CANCELLABLE' }

  const result = await mintsoftRequest<unknown>(`/api/Order/${encodeURIComponent(externalOrderId)}/Cancel`)
  if (result.error) throw new Error(result.error)
  const data = extractMintsoftObjectPayload(result.data) as RawOrder | null
  if (data?.Success === true) return { cancelled: true, status: 'CANCELLED' }
  throw new Error(toStr(data?.Message) ?? 'Mintsoft order cancel failed')
}
