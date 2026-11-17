import { randomUUID } from 'node:crypto'
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
  /** The value the operator wants. Blank/null inherits the Product value. */
  reorderPoint: string | null
  safetyStockQty: string | null
  reorderQty: string | null
  /**
   * The value each cell held when the operator loaded the page (blank/null = inherit). A cell whose wanted value
   * equals its expected value was not edited and is never written; an edited cell is written only if the stored
   * value still equals the expected one.
   */
  expected: { reorderPoint: string | null; safetyStockQty: string | null; reorderQty: string | null }
}

export type OverrideChange = {
  warehouseId: string
  warehouseCode: string
  field: ReorderThresholdField
  oldValue: string | null
  newValue: string | null
}

export type OverrideConflict = {
  warehouseId: string
  warehouseCode: string
  field: ReorderThresholdField
}

export type ApplyOverridesResult =
  | { ok: true; changes: OverrideChange[]; conflicts: OverrideConflict[] }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

type TxClient = Pick<Prisma.TransactionClient, 'product' | 'warehouse' | 'reorderThresholdOverride' | 'activityLog' | '$executeRaw' | '$queryRaw'>

const asText = (value: Prisma.Decimal | null): string | null => (value == null ? null : value.toString())
const sameValue = (a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean =>
  a == null ? b == null : b != null && a.equals(b)

export function describeOverrideConflict(conflicts: OverrideConflict[]): string {
  const cells = conflicts.map((c) => `${c.warehouseCode} ${OVERRIDE_FIELD_LABEL[c.field]}`).join(', ')
  return `Not saved, changed by someone else since you loaded this page: ${cells}. Reload to see the current values, then re-apply your edit.`
}

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

  // Validate every cell (wanted and expected) before writing anything.
  type Parsed = { wanted: Prisma.Decimal | null; expected: Prisma.Decimal | null }
  const parsed: Array<{ row: OverrideRowInput; cells: Record<ReorderThresholdField, Parsed> }> = []
  const fieldErrors: Record<string, string> = {}
  for (const row of input.rows) {
    const cells = {} as Record<ReorderThresholdField, Parsed>
    for (const field of REORDER_THRESHOLD_FIELDS) {
      const wanted = parseOverrideInput(row[field])
      const expected = parseOverrideInput(row.expected?.[field])
      if (!wanted.ok) fieldErrors[`${row.warehouseId}.${field}`] = wanted.error
      else if (!expected.ok) return { ok: false, error: 'The page is out of date. Reload and try again.' }
      else cells[field] = { wanted: wanted.value, expected: expected.value }
    }
    parsed.push({ row, cells })
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: 'Fix the highlighted values.', fieldErrors }

  const warehouses = await tx.warehouse.findMany({ where: { id: { in: [...seen] } }, select: { id: true, code: true } })
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]))
  for (const row of input.rows) {
    if (!warehouseById.has(row.warehouseId)) return { ok: false, error: 'Unknown warehouse.' }
  }

  const changes: OverrideChange[] = []
  const conflicts: OverrideConflict[] = []
  for (const { row, cells } of parsed) {
    const warehouse = warehouseById.get(row.warehouseId)!
    const edited = REORDER_THRESHOLD_FIELDS.filter((f) => !sameValue(cells[f].wanted, cells[f].expected))
    if (edited.length === 0) continue

    // Make sure the row exists, then lock it for the compare-and-set. No stock row is ever involved.
    await tx.$executeRaw`INSERT INTO reorder_threshold_overrides (id, "productId", "warehouseId", "updatedAt")
      VALUES (${randomUUID()}, ${product.id}, ${row.warehouseId}, NOW())
      ON CONFLICT ("productId", "warehouseId") DO NOTHING`
    await tx.$queryRaw`SELECT id FROM reorder_threshold_overrides
      WHERE "productId" = ${product.id} AND "warehouseId" = ${row.warehouseId} FOR UPDATE`
    const current = await tx.reorderThresholdOverride.findUnique({
      where: { productId_warehouseId: { productId: product.id, warehouseId: row.warehouseId } },
    })
    const data: Partial<Record<ReorderThresholdField, Prisma.Decimal | null>> = {}
    const merged: Record<ReorderThresholdField, Prisma.Decimal | null> = {
      reorderPoint: current?.reorderPoint ?? null,
      safetyStockQty: current?.safetyStockQty ?? null,
      reorderQty: current?.reorderQty ?? null,
    }
    for (const field of edited) {
      const stored = current?.[field] ?? null
      if (!sameValue(stored, cells[field].expected)) {
        conflicts.push({ warehouseId: row.warehouseId, warehouseCode: warehouse.code, field })
        continue
      }
      data[field] = cells[field].wanted
      merged[field] = cells[field].wanted
      changes.push({ warehouseId: row.warehouseId, warehouseCode: warehouse.code, field, oldValue: asText(stored), newValue: asText(cells[field].wanted) })
    }
    const where = { productId_warehouseId: { productId: product.id, warehouseId: row.warehouseId } }
    if (Object.keys(data).length > 0) await tx.reorderThresholdOverride.update({ where, data })
    // A row holding no value carries no information: drop it so "a row exists only while an override is set" holds.
    if (REORDER_THRESHOLD_FIELDS.every((f) => merged[f] == null)) {
      await tx.reorderThresholdOverride.deleteMany({ where: { productId: product.id, warehouseId: row.warehouseId } })
    }
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

  return { ok: true, changes, conflicts }
}
