import type {
  WmsOrderCancelResult,
  WmsOrderPushInput,
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
  | { kind: 'defaultId'; courierServiceId: number }
  | { kind: 'none' }

function buildPushPayload(input: WmsOrderPushInput, courier: CourierOption, includeItems = true): Record<string, unknown> {
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
  if (includeItems) {
    // Mintsoft's order-update endpoint (NewOrder) does not accept items, so line
    // amendments are not propagated via update — only on create.
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
  let created = await createOrder(buildPushPayload(input, { kind: 'name' }))

  // Courier name the WMS couldn't resolve → retry with the configured default
  // courier service id (Mintsoft requires one); if none is set, surface the error.
  if (!created.ok && created.message && /courierservice/i.test(created.message) && input.courierService) {
    const defaultId = Number.parseInt((await getMintsoftSettings()).mintsoft_default_courier_service_id, 10)
    if (Number.isFinite(defaultId)) {
      created = await createOrder(buildPushPayload(input, { kind: 'defaultId', courierServiceId: defaultId }))
    }
  }

  if (created.ok && created.data) {
    const externalOrderId = toStr(created.data.OrderId)
    if (externalOrderId) {
      return {
        externalOrderId,
        externalOrderNumber: toStr(created.data.OrderNumber) ?? input.orderNumber,
        status: 'NEW',
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

export async function updateMintsoftOrder(externalOrderId: string, input: WmsOrderPushInput): Promise<WmsOrderUpdateResult> {
  const { found, isNew } = await fetchMintsoftOrderStatusId(externalOrderId)
  if (!found) return { updated: false, status: 'NOT_FOUND' }
  if (!isNew) return { updated: false, status: 'NOT_NEW' }

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
