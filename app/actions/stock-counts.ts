'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { isOperationalProductStatus } from '@/lib/products/lifecycle'
import { computeStockCountPostings, makeStockCountReference, type StockCountLineForPost } from '@/lib/domain/inventory/stock-count'
import { applyStockAdjustment } from '@/app/actions/stock'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 30000 }

export type StockCountLineRow = {
  id: string
  productId: string
  sku: string
  expectedQty: number
  countedQty: number | null
  variance: number | null
  notes: string | null
}

export type StockCountRow = {
  id: string
  reference: string
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  status: 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  notes: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  lineCount: number
  countedCount: number
  lines: StockCountLineRow[]
}

export type StockCountResult = { success?: boolean; message?: string; count?: StockCountRow }

const COUNT_SELECT = {
  id: true,
  reference: true,
  warehouseId: true,
  status: true,
  notes: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  warehouse: { select: { code: true, name: true } },
  lines: {
    orderBy: { sku: 'asc' as const },
    select: { id: true, productId: true, sku: true, expectedQty: true, countedQty: true, variance: true, notes: true },
  },
} as const

function mapCount(c: Prisma.StockCountGetPayload<{ select: typeof COUNT_SELECT }>): StockCountRow {
  const lines: StockCountLineRow[] = c.lines.map((l) => ({
    id: l.id,
    productId: l.productId,
    sku: l.sku,
    expectedQty: Number(l.expectedQty),
    countedQty: l.countedQty == null ? null : Number(l.countedQty),
    variance: l.variance == null ? null : Number(l.variance),
    notes: l.notes,
  }))
  return {
    id: c.id,
    reference: c.reference,
    warehouseId: c.warehouseId,
    warehouseCode: c.warehouse.code,
    warehouseName: c.warehouse.name,
    status: c.status,
    notes: c.notes,
    startedAt: c.startedAt?.toISOString() ?? null,
    completedAt: c.completedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    lineCount: lines.length,
    countedCount: lines.filter((l) => l.countedQty != null).length,
    lines,
  }
}

export async function getStockCounts(limit = 100): Promise<StockCountRow[]> {
  await requirePermission('stock_control.adjust')
  const rows = await db.stockCount.findMany({ orderBy: { createdAt: 'desc' }, take: limit, select: COUNT_SELECT })
  return rows.map(mapCount)
}

export async function getStockCount(id: string): Promise<StockCountRow | null> {
  await requirePermission('stock_control.adjust')
  const row = await db.stockCount.findUnique({ where: { id }, select: COUNT_SELECT })
  return row ? mapCount(row) : null
}

const createSchema = z.object({
  warehouseId: z.string().min(1, 'Warehouse is required'),
  productIds: z.array(z.string().min(1)).optional(),
  notes: z.string().optional(),
})

/**
 * Create a DRAFT stock count, snapshotting the current book quantity (expectedQty)
 * for every operational product with a stock-level row in the warehouse (or the
 * given productIds), under a FOR UPDATE lock so a concurrent movement can't make
 * the snapshot inconsistent.
 */
export async function createStockCount(input: unknown): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Invalid stock count.' }
  const { warehouseId, productIds, notes } = parsed.data

  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const created = await db.$transaction(async (tx) => {
          // Lock the warehouse's stock-level rows so the snapshot is consistent.
          if (productIds && productIds.length > 0) {
            await tx.$queryRaw`SELECT id FROM stock_levels WHERE "warehouseId" = ${warehouseId} AND "productId" = ANY(${productIds}::text[]) FOR UPDATE`
          } else {
            await tx.$queryRaw`SELECT id FROM stock_levels WHERE "warehouseId" = ${warehouseId} FOR UPDATE`
          }
          const levels = await tx.stockLevel.findMany({
            where: { warehouseId, ...(productIds && productIds.length > 0 ? { productId: { in: productIds } } : {}) },
            select: { productId: true, quantity: true, product: { select: { sku: true, lifecycleStatus: true } } },
          })
          const countable = levels.filter((l) => isOperationalProductStatus(l.product.lifecycleStatus))
          if (countable.length === 0) throw new Error('No stocked, operational products to count in this warehouse.')

          return tx.stockCount.create({
            data: {
              reference: makeStockCountReference(new Date(), Math.random().toString(36).slice(2)),
              warehouseId,
              status: 'DRAFT',
              notes: notes || null,
              lines: {
                create: countable.map((l) => ({
                  productId: l.productId,
                  sku: l.product.sku,
                  expectedQty: l.quantity,
                })),
              },
            },
            select: COUNT_SELECT,
          })
        }, STOCK_TX_OPTIONS)

        const mapped = mapCount(created)
        revalidatePath('/stock-control/stock-counts')
        await logActivity({
          entityType: 'STOCK_COUNT', entityId: created.id, action: 'created', tag: 'stock',
          description: `Created stock count ${mapped.reference} for ${mapped.warehouseName} (${mapped.lineCount} lines)`,
        })
        return { success: true, count: mapped }
      } catch (e) {
        if (attempt < 5 && (e as { code?: string } | null)?.code === 'P2002') continue
        throw e
      }
    }
    return { message: 'Failed to create stock count.' }
  } catch (e) {
    console.error(e)
    return { message: e instanceof Error ? e.message : 'Failed to create stock count.' }
  }
}

const saveSchema = z.object({
  countId: z.string().min(1),
  counts: z.array(z.object({
    lineId: z.string().min(1),
    countedQty: z.number().refine(Number.isFinite, 'count must be finite').min(0, 'count cannot be negative').nullable(),
  })),
})

/** Enter/clear counted quantities on a count's lines (DRAFT/IN_PROGRESS only). */
export async function saveStockCountCounts(input: unknown): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Invalid counts.' }
  const { countId, counts } = parsed.data

  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${countId} FOR UPDATE`
      const count = await tx.stockCount.findUnique({ where: { id: countId }, select: { status: true, lines: { select: { id: true, expectedQty: true } } } })
      if (!count) throw new Error('Stock count not found.')
      if (count.status === 'COMPLETED' || count.status === 'CANCELLED') throw new Error('This stock count can no longer be edited.')
      const expectedById = new Map(count.lines.map((l) => [l.id, Number(l.expectedQty)]))
      for (const c of counts) {
        if (!expectedById.has(c.lineId)) continue
        const variance = c.countedQty == null ? null : new Prisma.Decimal(c.countedQty).sub(expectedById.get(c.lineId)!).toDecimalPlaces(4).toNumber()
        await tx.stockCountLine.update({
          where: { id: c.lineId },
          data: { countedQty: c.countedQty, variance },
        })
      }
      if (count.status === 'DRAFT') {
        await tx.stockCount.update({ where: { id: countId }, data: { status: 'IN_PROGRESS', startedAt: new Date() } })
      }
    }, STOCK_TX_OPTIONS)
    revalidatePath('/stock-control/stock-counts')
    return { success: true }
  } catch (e) {
    console.error(e)
    return { message: e instanceof Error ? e.message : 'Failed to save counts.' }
  }
}

const postSchema = z.object({
  countId: z.string().min(1),
  reasonId: z.string().min(1).optional(),
})

/**
 * Post a stock count: for each counted line, post an ADJUSTMENT that brings the
 * LIVE book quantity to the counted quantity (snapshot-staleness safe), creating/
 * consuming FIFO layers and the inventory journal (via applyStockAdjustment), tied
 * to the count (referenceType 'StockCount'). Atomic; double-post guarded by status.
 */
export async function postStockCount(input: unknown): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  const parsed = postSchema.safeParse(input)
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Invalid post request.' }
  const { countId, reasonId } = parsed.data

  let affectedProductIds: string[] = []
  try {
    await db.$transaction(async (tx) => {
      // Lock + double-post guard.
      await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${countId} FOR UPDATE`
      const count = await tx.stockCount.findUnique({
        where: { id: countId },
        select: { status: true, warehouseId: true, lines: { select: { id: true, productId: true, sku: true, expectedQty: true, countedQty: true } } },
      })
      if (!count) throw new Error('Stock count not found.')
      if (count.status === 'COMPLETED') throw new Error('This stock count has already been posted.')
      if (count.status === 'CANCELLED') throw new Error('This stock count was cancelled and cannot be posted.')

      const countedLines: StockCountLineForPost[] = count.lines
        .filter((l) => l.countedQty != null)
        .map((l) => ({ lineId: l.id, productId: l.productId, sku: l.sku, expectedQty: Number(l.expectedQty), countedQty: Number(l.countedQty) }))

      // Read the LIVE book per counted product under lock.
      const productIds = countedLines.map((l) => l.productId)
      if (productIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM stock_levels WHERE "warehouseId" = ${count.warehouseId} AND "productId" = ANY(${productIds}::text[]) FOR UPDATE`
      }
      const levels = productIds.length
        ? await tx.stockLevel.findMany({ where: { warehouseId: count.warehouseId, productId: { in: productIds } }, select: { productId: true, quantity: true } })
        : []
      const liveBook = new Map(levels.map((l) => [l.productId, Number(l.quantity)]))

      const postings = computeStockCountPostings(countedLines, liveBook)
      for (const posting of postings) {
        if (posting.adjustmentQty !== 0) {
          await applyStockAdjustment({
            tx,
            productId: posting.productId,
            warehouseId: count.warehouseId,
            qty: posting.adjustmentQty,
            reasonId,
            note: `Stock count ${countId}`,
            referenceType: 'StockCount',
            referenceId: countId,
          })
          affectedProductIds.push(posting.productId)
        }
        // Persist the reported variance (count vs snapshot) on the line.
        await tx.stockCountLine.update({ where: { id: posting.lineId }, data: { variance: posting.reportedVariance } })
      }

      await tx.stockCount.update({ where: { id: countId }, data: { status: 'COMPLETED', completedAt: new Date() } })
    }, STOCK_TX_OPTIONS)

    revalidatePath('/stock-control/stock-counts')
    revalidatePath('/inventory')
    affectedProductIds = [...new Set(affectedProductIds)]
    if (affectedProductIds.length > 0) {
      try { await enqueueStockSync(affectedProductIds, 'IMS_CHANGE') } catch (syncError) { console.error(syncError) }
    }
    await logActivity({
      entityType: 'STOCK_COUNT', entityId: countId, action: 'posted', tag: 'stock',
      description: `Posted stock count ${countId}: ${affectedProductIds.length} variance adjustment(s)`,
      metadata: { adjustedProductCount: affectedProductIds.length },
    })
    return { success: true }
  } catch (e) {
    console.error(e)
    return { message: e instanceof Error ? e.message : 'Failed to post stock count.' }
  }
}

export async function cancelStockCount(countId: string): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${countId} FOR UPDATE`
      const count = await tx.stockCount.findUnique({ where: { id: countId }, select: { status: true } })
      if (!count) throw new Error('Stock count not found.')
      if (count.status === 'COMPLETED') throw new Error('A posted stock count cannot be cancelled.')
      await tx.stockCount.update({ where: { id: countId }, data: { status: 'CANCELLED' } })
    }, STOCK_TX_OPTIONS)
    revalidatePath('/stock-control/stock-counts')
    await logActivity({ entityType: 'STOCK_COUNT', entityId: countId, action: 'cancelled', tag: 'stock', description: `Cancelled stock count ${countId}` })
    return { success: true }
  } catch (e) {
    console.error(e)
    return { message: e instanceof Error ? e.message : 'Failed to cancel stock count.' }
  }
}
