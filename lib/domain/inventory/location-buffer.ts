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
 * A buffer lives in its own table (location_stock_buffers), never on StockLevel: setting one must not create a stock row, which would make
 * the product a stock-push candidate and look like opening-stock history. A buffer at a location with no stock row has no effect.
 *
 * Every APPLIED change writes an activity-log row in the SAME transaction (who, when, old value, new value, REQUIRED reason), so a
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

/** One edited cell: the value the editor loaded for that warehouse and the value the operator typed. Untouched warehouses are never sent. */
export type BufferEditInput = { warehouseId: string; expectedOld: string | null; bufferQty: string | null }

export type BufferChange = {
  warehouseId: string
  warehouseCode: string
  oldValue: string
  newValue: string
}

export type StaleBufferCell = { warehouseId: string; warehouseCode: string }

export type ApplyBufferResult =
  | { ok: true; changes: BufferChange[]; stale: StaleBufferCell[] }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

type TxClient = Pick<Prisma.TransactionClient, 'product' | 'warehouse' | 'locationStockBuffer' | 'activityLog' | '$queryRaw'>

/**
 * Compare-and-set per edited warehouse. Each row is locked (insert-if-absent, then SELECT ... FOR UPDATE), the current value is
 * compared with the one the editor loaded, and a cell that moved is refused as stale while the other cells still save. Only
 * applied changes are audited, with the true old value. A buffer that ends at 0 is removed (no row means no buffer).
 */
export async function applyLocationBuffers(
  tx: TxClient,
  input: { productId: string; userId: string | null; reason: string | null | undefined; edits: BufferEditInput[] },
): Promise<ApplyBufferResult> {
  const product = await tx.product.findUnique({ where: { id: input.productId }, select: { id: true, sku: true, type: true } })
  if (!product) return { ok: false, error: 'Product not found.' }
  if (!BUFFERABLE_TYPES.has(product.type)) {
    return { ok: false, error: 'This product type does not hold its own stock, so it has no per-location buffer.' }
  }

  const seen = new Set<string>()
  for (const edit of input.edits) {
    if (seen.has(edit.warehouseId)) return { ok: false, error: 'A warehouse appears twice in the request.' }
    seen.add(edit.warehouseId)
  }

  const fieldErrors: Record<string, string> = {}
  const parsed: Array<{ warehouseId: string; expected: Prisma.Decimal; value: Prisma.Decimal }> = []
  for (const edit of input.edits) {
    const next = parseBufferInput(edit.bufferQty)
    const expected = parseBufferInput(edit.expectedOld)
    if (!next.ok) fieldErrors[edit.warehouseId] = next.error
    else if (!expected.ok) return { ok: false, error: 'The page is out of date. Reload and try again.' }
    else parsed.push({ warehouseId: edit.warehouseId, expected: expected.value, value: next.value })
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: 'Fix the highlighted values.', fieldErrors }

  const warehouses = await tx.warehouse.findMany({ where: { id: { in: [...seen] } }, select: { id: true, code: true } })
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]))
  for (const edit of input.edits) if (!warehouseById.has(edit.warehouseId)) return { ok: false, error: 'Unknown warehouse.' }

  const wanted = parsed.filter(({ expected, value }) => !expected.equals(value))
  if (wanted.length === 0) return { ok: true, changes: [], stale: [] }

  // The reason is the "why" of the audit trail, so an intended change without one is refused. Nothing is written yet.
  const reason = (input.reason ?? '').trim()
  if (reason === '') return { ok: false, error: 'Give a reason for the change.', fieldErrors: { reason: 'A reason is required.' } }
  if (reason.length > BUFFER_REASON_MAX_LENGTH) {
    return { ok: false, error: `Keep the reason under ${BUFFER_REASON_MAX_LENGTH} characters.`, fieldErrors: { reason: 'Too long.' } }
  }

  const changes: BufferChange[] = []
  const stale: StaleBufferCell[] = []
  for (const { warehouseId, expected, value } of wanted) {
    const warehouse = warehouseById.get(warehouseId)!
    // Lock the row: insert it at 0 if absent (ON CONFLICT DO NOTHING), then read it FOR UPDATE.
    await tx.locationStockBuffer.createMany({ data: [{ productId: product.id, warehouseId, bufferQty: 0 }], skipDuplicates: true })
    const locked = await tx.$queryRaw<Array<{ bufferQty: Prisma.Decimal }>>`
      SELECT "bufferQty" FROM location_stock_buffers WHERE "productId" = ${product.id} AND "warehouseId" = ${warehouseId} FOR UPDATE`
    const current = toDecimal(locked[0]?.bufferQty ?? 0)
    if (!current.equals(expected)) {
      stale.push({ warehouseId, warehouseCode: warehouse.code })
      if (current.isZero()) await tx.locationStockBuffer.deleteMany({ where: { productId: product.id, warehouseId, bufferQty: 0 } })
      continue
    }
    if (value.isZero()) {
      await tx.locationStockBuffer.deleteMany({ where: { productId: product.id, warehouseId } })
    } else {
      await tx.locationStockBuffer.update({ where: { productId_warehouseId: { productId: product.id, warehouseId } }, data: { bufferQty: value } })
    }
    changes.push({ warehouseId, warehouseCode: warehouse.code, oldValue: current.toString(), newValue: value.toString() })
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

  return { ok: true, changes, stale }
}
