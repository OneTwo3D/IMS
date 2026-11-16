import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { logActivityInTransaction } from '@/lib/activity-log'
import {
  REORDER_THRESHOLD_FIELDS,
  parseOverrideInput,
  type ReorderThresholdField,
} from '@/lib/domain/inventory/reorder-thresholds'

/**
 * Save path for the per-warehouse reorder thresholds. Every changed cell writes an activity-log row in the
 * SAME transaction (who, when, old value, new value), so an edit can never commit unaudited. Unchanged cells
 * write nothing. Planning-only: nothing here queues a WMS or storefront sync.
 */

const OVERRIDE_COLUMN = {
  reorderPoint: 'reorderPointOverride',
  safetyStockQty: 'safetyStockQtyOverride',
  reorderQty: 'reorderQtyOverride',
} as const satisfies Record<ReorderThresholdField, string>

export const OVERRIDE_FIELD_LABEL: Record<ReorderThresholdField, string> = {
  reorderPoint: 'reorder point',
  safetyStockQty: 'safety stock',
  reorderQty: 'reorder quantity',
}

/** Product types that hold their own stock rows. KIT stock is computed, VARIABLE/NON_INVENTORY have none. */
const OVERRIDABLE_TYPES: ReadonlySet<ProductType> = new Set([
  ProductType.SIMPLE, ProductType.VARIANT, ProductType.BOM,
])

export type OverrideRowInput = {
  warehouseId: string
  /** Blank/null inherits the Product value. */
  reorderPoint: string | null
  safetyStockQty: string | null
  reorderQty: string | null
}

export type OverrideChange = {
  warehouseId: string
  warehouseCode: string
  field: ReorderThresholdField
  oldValue: string | null
  newValue: string | null
}

export type ApplyOverridesResult =
  | { ok: true; changes: OverrideChange[] }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

type TxClient = Pick<Prisma.TransactionClient, 'product' | 'warehouse' | 'stockLevel' | 'activityLog'>

const asText = (value: Prisma.Decimal | null): string | null => (value == null ? null : value.toString())

export async function applyWarehouseReorderOverrides(
  tx: TxClient,
  input: { productId: string; userId: string | null; rows: OverrideRowInput[] },
): Promise<ApplyOverridesResult> {
  const product = await tx.product.findUnique({ where: { id: input.productId }, select: { id: true, sku: true, type: true } })
  if (!product) return { ok: false, error: 'Product not found.' }
  if (!OVERRIDABLE_TYPES.has(product.type)) {
    return { ok: false, error: 'This product type does not hold its own stock, so it has no per-warehouse thresholds.' }
  }

  const seen = new Set<string>()
  for (const row of input.rows) {
    if (seen.has(row.warehouseId)) return { ok: false, error: 'A warehouse appears twice in the request.' }
    seen.add(row.warehouseId)
  }

  // Validate every cell before writing anything.
  const parsed: Array<{ row: OverrideRowInput; values: Record<ReorderThresholdField, Prisma.Decimal | null> }> = []
  const fieldErrors: Record<string, string> = {}
  for (const row of input.rows) {
    const values = {} as Record<ReorderThresholdField, Prisma.Decimal | null>
    for (const field of REORDER_THRESHOLD_FIELDS) {
      const result = parseOverrideInput(row[field])
      if (result.ok) values[field] = result.value
      else fieldErrors[`${row.warehouseId}.${field}`] = result.error
    }
    parsed.push({ row, values })
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: 'Fix the highlighted values.', fieldErrors }

  const warehouses = await tx.warehouse.findMany({
    where: { id: { in: [...seen] } },
    select: { id: true, code: true, active: true },
  })
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]))
  for (const row of input.rows) {
    if (!warehouseById.has(row.warehouseId)) return { ok: false, error: 'Unknown warehouse.' }
  }

  const existing = await tx.stockLevel.findMany({
    where: { productId: product.id, warehouseId: { in: [...seen] } },
    select: { warehouseId: true, reorderPointOverride: true, safetyStockQtyOverride: true, reorderQtyOverride: true },
  })
  const existingByWarehouse = new Map(existing.map((s) => [s.warehouseId, s]))

  const changes: OverrideChange[] = []
  for (const { row, values } of parsed) {
    const warehouse = warehouseById.get(row.warehouseId)!
    const current = existingByWarehouse.get(row.warehouseId)
    const rowChanges: OverrideChange[] = []
    for (const field of REORDER_THRESHOLD_FIELDS) {
      const before = current ? (current[OVERRIDE_COLUMN[field]] as Prisma.Decimal | null) : null
      const after = values[field]
      const same = before == null ? after == null : after != null && before.equals(after)
      if (!same) {
        rowChanges.push({ warehouseId: row.warehouseId, warehouseCode: warehouse.code, field, oldValue: asText(before), newValue: asText(after) })
      }
    }
    if (rowChanges.length === 0) continue

    const data = {
      reorderPointOverride: values.reorderPoint,
      safetyStockQtyOverride: values.safetyStockQty,
      reorderQtyOverride: values.reorderQty,
    }
    if (current) {
      await tx.stockLevel.update({
        where: { productId_warehouseId: { productId: product.id, warehouseId: row.warehouseId } },
        data,
      })
    } else {
      // No stock row yet (nothing ever received there): create it at zero so the override has a home.
      // skipDuplicates semantics via upsert: a concurrent receipt that created the row first is kept as is.
      await tx.stockLevel.upsert({
        where: { productId_warehouseId: { productId: product.id, warehouseId: row.warehouseId } },
        create: { productId: product.id, warehouseId: row.warehouseId, quantity: 0, ...data },
        update: data,
      })
    }
    changes.push(...rowChanges)
  }

  for (const change of changes) {
    await logActivityInTransaction(tx, {
      userId: input.userId,
      entityType: 'PRODUCT',
      entityId: product.id,
      action: 'reorder_threshold_override_changed',
      tag: 'inventory',
      level: 'INFO',
      description: `${product.sku}: ${OVERRIDE_FIELD_LABEL[change.field]} override at ${change.warehouseCode} changed from ${change.oldValue ?? 'inherit product value'} to ${change.newValue ?? 'inherit product value'}`,
      metadata: {
        sku: product.sku,
        warehouseId: change.warehouseId,
        warehouseCode: change.warehouseCode,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      },
    })
  }

  return { ok: true, changes }
}
