import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { logActivityInTransaction } from '@/lib/activity-log'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * Per-location BUFFER STOCK: units an operator holds back at a warehouse so they never reach connected sales channels.
 *
 * It is an availability control over what IMS pushes to WooCommerce and nothing else. The single place it is applied is
 * buildStockMaps() in lib/connectors/woocommerce/sync/stock-sync.ts (channel quantity = max(0, available - bufferQty)).
 *   - IMS on-hand, reserved and allocatable figures are untouched, and allocation of IMS orders never reads it: buffered
 *     units CAN be allocated to an IMS order (the buffer says what the storefront may sell, not what the warehouse may ship).
 *   - The WMS stock alignment pass reconciles real on-hand and never reads it: the buffer applies only to the channel push.
 *
 * Every change writes an activity-log row in the SAME transaction (who, when, old value, new value, REQUIRED reason), so a
 * buffer can never change unaudited. The reason is operator text about stock, entity type PRODUCT: it is not customer or order
 * personal data, so it sits outside the erasure scope (no customer/order-linked table carries it).
 */

export const BUFFER_DECIMAL_PLACES = 6
const MAX_BUFFER = toDecimal('99999999')
export const BUFFER_REASON_MAX_LENGTH = 500
export const BUFFER_CHANGED_ACTION = 'location_buffer_changed'

/** Product types that hold their own stock rows. KIT stock is computed from components, VARIABLE/NON_INVENTORY have none. */
const BUFFERABLE_TYPES: ReadonlySet<ProductType> = new Set([ProductType.SIMPLE, ProductType.VARIANT, ProductType.BOM])

export type BufferInputResult = { ok: true; value: Prisma.Decimal } | { ok: false; error: string }

/** Blank means 0 (no buffer). Otherwise a plain non-negative number. */
export function parseBufferInput(raw: string | null | undefined): BufferInputResult {
  const text = (raw ?? '').trim()
  if (text === '') return { ok: true, value: toDecimal(0) }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: 'Enter a number of zero or more.' }
  const value = toDecimal(text)
  if (value.decimalPlaces() > BUFFER_DECIMAL_PLACES) return { ok: false, error: `Use at most ${BUFFER_DECIMAL_PLACES} decimal places.` }
  if (value.gt(MAX_BUFFER)) return { ok: false, error: 'That number is too large.' }
  return { ok: true, value }
}

export type BufferRowInput = { warehouseId: string; bufferQty: string | null }

export type BufferChange = {
  warehouseId: string
  warehouseCode: string
  oldValue: string
  newValue: string
}

export type ApplyBufferResult =
  | { ok: true; changes: BufferChange[] }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

type TxClient = Pick<Prisma.TransactionClient, 'product' | 'warehouse' | 'stockLevel' | 'activityLog'>

export async function applyLocationBuffers(
  tx: TxClient,
  input: { productId: string; userId: string | null; reason: string | null | undefined; rows: BufferRowInput[] },
): Promise<ApplyBufferResult> {
  const product = await tx.product.findUnique({ where: { id: input.productId }, select: { id: true, sku: true, type: true } })
  if (!product) return { ok: false, error: 'Product not found.' }
  if (!BUFFERABLE_TYPES.has(product.type)) {
    return { ok: false, error: 'This product type does not hold its own stock, so it has no per-location buffer.' }
  }

  const seen = new Set<string>()
  for (const row of input.rows) {
    if (seen.has(row.warehouseId)) return { ok: false, error: 'A warehouse appears twice in the request.' }
    seen.add(row.warehouseId)
  }

  const fieldErrors: Record<string, string> = {}
  const parsed: Array<{ warehouseId: string; value: Prisma.Decimal }> = []
  for (const row of input.rows) {
    const result = parseBufferInput(row.bufferQty)
    if (result.ok) parsed.push({ warehouseId: row.warehouseId, value: result.value })
    else fieldErrors[row.warehouseId] = result.error
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: 'Fix the highlighted values.', fieldErrors }

  const warehouses = await tx.warehouse.findMany({ where: { id: { in: [...seen] } }, select: { id: true, code: true } })
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]))
  for (const row of input.rows) if (!warehouseById.has(row.warehouseId)) return { ok: false, error: 'Unknown warehouse.' }

  const existing = await tx.stockLevel.findMany({
    where: { productId: product.id, warehouseId: { in: [...seen] } },
    select: { warehouseId: true, bufferQty: true },
  })
  const existingByWarehouse = new Map(existing.map((s) => [s.warehouseId, s]))

  const pending = parsed
    .map(({ warehouseId, value }) => ({ warehouseId, value, before: existingByWarehouse.get(warehouseId)?.bufferQty ?? toDecimal(0) }))
    .filter(({ value, before }) => !before.equals(value))
  if (pending.length === 0) return { ok: true, changes: [] }

  // The reason is the "why" of the audit trail, so a change without one is refused. Nothing is written yet.
  const reason = (input.reason ?? '').trim()
  if (reason === '') return { ok: false, error: 'Give a reason for the change.', fieldErrors: { reason: 'A reason is required.' } }
  if (reason.length > BUFFER_REASON_MAX_LENGTH) {
    return { ok: false, error: `Keep the reason under ${BUFFER_REASON_MAX_LENGTH} characters.`, fieldErrors: { reason: 'Too long.' } }
  }

  const changes: BufferChange[] = []
  for (const { warehouseId, value, before } of pending) {
    const warehouse = warehouseById.get(warehouseId)!
    if (existingByWarehouse.has(warehouseId)) {
      await tx.stockLevel.update({ where: { productId_warehouseId: { productId: product.id, warehouseId } }, data: { bufferQty: value } })
    } else {
      // No stock row yet: create it at zero so the buffer has a home (a concurrent receipt that created it first is kept).
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId: product.id, warehouseId } },
        create: { productId: product.id, warehouseId, quantity: 0, bufferQty: value },
        update: { bufferQty: value },
      })
    }
    changes.push({ warehouseId, warehouseCode: warehouse.code, oldValue: before.toString(), newValue: value.toString() })
  }

  for (const change of changes) {
    await logActivityInTransaction(tx, {
      userId: input.userId,
      entityType: 'PRODUCT',
      entityId: product.id,
      action: BUFFER_CHANGED_ACTION,
      tag: 'inventory',
      level: 'INFO',
      description: `${product.sku}: channel buffer at ${change.warehouseCode} changed from ${change.oldValue} to ${change.newValue}. Reason: ${reason}`,
      metadata: {
        sku: product.sku,
        warehouseId: change.warehouseId,
        warehouseCode: change.warehouseCode,
        oldValue: change.oldValue,
        newValue: change.newValue,
        reason,
      },
    })
  }

  return { ok: true, changes }
}
