import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'

/**
 * Connector-agnostic WmsStockDiscrepancy upsert/resolve, mirroring the (internal)
 * Mintsoft logic so any connector can log NOTIFICATION_ONLY discrepancies. Keyed by
 * the partial-unique (connector, warehouseId, category, product/sku) on OPEN rows.
 */

export type WmsStockDiscrepancyCategory =
  | 'MISSING_IN_WMS'
  | 'MISSING_IN_IMS'
  | 'UNMAPPED_SKU'
  | 'QTY_MISMATCH'
  | 'RECEIPT_TIMING_CONFLICT'

const OPEN_CATEGORIES: WmsStockDiscrepancyCategory[] = [
  'MISSING_IN_WMS',
  'MISSING_IN_IMS',
  'UNMAPPED_SKU',
  'QTY_MISMATCH',
  'RECEIPT_TIMING_CONFLICT',
]

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function buildOpenWhere(input: {
  connector: string
  warehouseId: string
  category: WmsStockDiscrepancyCategory
  productId: string | null
  sku: string
}): Prisma.WmsStockDiscrepancyWhereInput {
  return {
    connector: input.connector,
    warehouseId: input.warehouseId,
    category: input.category,
    status: 'OPEN',
    // A mapped row is keyed by product; an unmapped row by SKU (productId null).
    ...(input.productId ? { productId: input.productId } : { productId: null, sku: input.sku }),
  }
}

export type UpsertWmsStockDiscrepancyInput = {
  connector: string
  warehouseId: string
  category: WmsStockDiscrepancyCategory
  productId: string | null
  sku: string
  imsValue: string | null
  wmsValue: string | null
  delta: number | null
  message: string | null
}

export async function upsertWmsStockDiscrepancy(input: UpsertWmsStockDiscrepancyInput, now: Date = new Date()): Promise<void> {
  const where = buildOpenWhere(input)
  const reopen = {
    imsValue: input.imsValue,
    wmsValue: input.wmsValue,
    delta: input.delta,
    message: input.message,
    lastSeenAt: now,
    detectionCount: { increment: 1 },
    resolvedAt: null,
    resolvedBy: null,
    resolvedNote: null,
  }

  const updated = await db.wmsStockDiscrepancy.updateMany({ where, data: reopen })
  if (updated.count > 0) return

  try {
    await db.wmsStockDiscrepancy.create({
      data: {
        connector: input.connector,
        warehouseId: input.warehouseId,
        productId: input.productId,
        sku: input.sku,
        category: input.category,
        status: 'OPEN',
        imsValue: input.imsValue,
        wmsValue: input.wmsValue,
        delta: input.delta,
        message: input.message,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    })
    return
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
  }

  // Lost a create race with a concurrent run: the OPEN row now exists — reopen it.
  await db.wmsStockDiscrepancy.updateMany({ where, data: reopen })
}

/** Resolve OPEN discrepancies for a product/sku no longer in conflict. */
export async function resolveOpenWmsStockDiscrepancies(input: {
  connector: string
  warehouseId: string
  productId: string | null
  sku: string
  note?: string
}, now: Date = new Date()): Promise<void> {
  await db.wmsStockDiscrepancy.updateMany({
    where: {
      connector: input.connector,
      warehouseId: input.warehouseId,
      status: 'OPEN',
      category: { in: OPEN_CATEGORIES },
      OR: [
        ...(input.productId ? [{ productId: input.productId }] : []),
        { sku: input.sku },
      ],
    },
    data: {
      status: 'RESOLVED',
      resolvedAt: now,
      resolvedNote: input.note ?? 'Auto-resolved: WMS and IMS quantities reconciled.',
    },
  })
}
