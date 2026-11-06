'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { isOperationalProductStatus } from '@/lib/products/lifecycle'
import { classifyStockCountWmsPolicy, computeStockCountPostings, describeStockCountDrift, detectStockCountDrift, makeStockCountReference, type StockCountDrift, type StockCountLineForPost } from '@/lib/domain/inventory/stock-count'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { enabledWmsConnectorIds } from '@/lib/connectors/wms/enabled-connector'
import { applyStockAdjustment } from '@/lib/domain/inventory/stock-adjustment-apply'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 30000 }

export type StockCountLineRow = {
  id: string
  productId: string
  sku: string
  expectedQty: number
  countedQty: number | null
  variance: number | null
  /** On-hand this line was reconciled against; null = not reconciled (or the count changed since). */
  reconciledQty: number | null
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
  reconciledAt: string | null
  createdAt: string
  lineCount: number
  countedCount: number
  lines: StockCountLineRow[]
}

export type StockCountResult = {
  success?: boolean
  message?: string
  count?: StockCountRow
  /** 6oyu.3: the warehouse is WMS-synced (notification-only) — the client must
   * confirm and re-submit with acknowledgeWmsWarning: true. */
  requiresWmsAcknowledgement?: boolean
  /** Authorising refused because on-hand moved since the lines were reconciled (or they never were). Nothing was posted; counts are kept. */
  drift?: StockCountDrift[]
}

const COUNT_SELECT = {
  id: true,
  reference: true,
  warehouseId: true,
  status: true,
  notes: true,
  startedAt: true,
  completedAt: true,
  reconciledAt: true,
  createdAt: true,
  warehouse: { select: { code: true, name: true } },
  lines: {
    orderBy: { sku: 'asc' as const },
    select: { id: true, productId: true, sku: true, expectedQty: true, countedQty: true, variance: true, reconciledQty: true, notes: true },
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
    reconciledQty: l.reconciledQty == null ? null : Number(l.reconciledQty),
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
    reconciledAt: c.reconciledAt?.toISOString() ?? null,
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

// countedQty is stored as Decimal(12,4): bound it so an out-of-range value fails
// with a clear Zod message instead of a raw DB error (Codex).
const countedQtySchema = z.number()
  .refine(Number.isFinite, 'count must be finite')
  .min(0, 'count cannot be negative')
  .max(99_999_999.9999, 'count is too large')
const countLineInputSchema = z.object({
  lineId: z.string().min(1),
  countedQty: countedQtySchema.nullable(),
})

const saveSchema = z.object({
  countId: z.string().min(1),
  counts: z.array(countLineInputSchema),
})

type CountLineInput = z.infer<typeof countLineInputSchema>

/**
 * Persist counted quantities + reported variance for a count's lines, in-tx.
 *
 * A line whose counted quantity CHANGES loses its reconcile stamp: the variance the operator reviewed was
 * for the earlier figure, so the line has to be reconciled again before the count can be authorised. A line
 * re-submitted with the figure it already holds keeps its stamp (saving the form is not a new count).
 */
async function persistCountsTx(
  tx: Prisma.TransactionClient,
  counts: CountLineInput[],
  expectedById: Map<string, number>,
  previousCountedById: Map<string, number | null>,
): Promise<void> {
  for (const c of counts) {
    if (!expectedById.has(c.lineId)) continue
    const variance = c.countedQty == null
      ? null
      : new Prisma.Decimal(c.countedQty).sub(expectedById.get(c.lineId)!).toDecimalPlaces(4).toNumber()
    const previous = previousCountedById.get(c.lineId) ?? null
    const unchanged = previous === null
      ? c.countedQty === null
      : c.countedQty !== null && new Prisma.Decimal(previous).toDecimalPlaces(4).eq(new Prisma.Decimal(c.countedQty).toDecimalPlaces(4))
    await tx.stockCountLine.update({
      where: { id: c.lineId },
      data: { countedQty: c.countedQty, variance, ...(unchanged ? {} : { reconciledQty: null }) },
    })
  }
}

/** Enter/clear counted quantities on a count's lines (DRAFT/IN_PROGRESS only). */
export async function saveStockCountCounts(input: unknown): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Invalid counts.' }
  const { countId, counts } = parsed.data

  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${countId} FOR UPDATE`
      const count = await tx.stockCount.findUnique({ where: { id: countId }, select: { status: true, lines: { select: { id: true, expectedQty: true, countedQty: true } } } })
      if (!count) throw new Error('Stock count not found.')
      if (count.status === 'COMPLETED' || count.status === 'CANCELLED') throw new Error('This stock count can no longer be edited.')
      const expectedById = new Map(count.lines.map((l) => [l.id, Number(l.expectedQty)]))
      const previousCountedById = new Map(count.lines.map((l) => [l.id, l.countedQty == null ? null : Number(l.countedQty)]))
      await persistCountsTx(tx, counts, expectedById, previousCountedById)
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

const reconcileSchema = z.object({
  countId: z.string().min(1),
  // Optional final counts persisted within the reconcile transaction, so save+reconcile is atomic.
  counts: z.array(countLineInputSchema).optional(),
  // Refresh only these lines; absent = every counted line.
  lineIds: z.array(z.string().min(1)).optional(),
})

/**
 * Reconcile a stock count: stamp, under the stock-level lock, the on-hand each COUNTED line is being
 * reconciled against, and refresh the line's book figure and variance to it. Authorising (postStockCount)
 * compares live on-hand with this stamp and refuses when it moved. Counts and decisions are preserved;
 * re-reconciling is how an operator accepts the new figures after a refusal.
 *
 * Writes no stock movement and no ledger entry. Lock order matches postStockCount: the count row, then the
 * warehouse's stock-level rows.
 */
export async function reconcileStockCount(input: unknown): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  const parsed = reconcileSchema.safeParse(input)
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Invalid reconcile request.' }
  const { countId, counts, lineIds } = parsed.data

  try {
    let refreshed: StockCountDrift[] = []
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${countId} FOR UPDATE`
      const count = await tx.stockCount.findUnique({
        where: { id: countId },
        select: { status: true, warehouseId: true, lines: { select: { id: true, productId: true, sku: true, expectedQty: true, countedQty: true, reconciledQty: true } } },
      })
      if (!count) throw new Error('Stock count not found.')
      if (count.status === 'COMPLETED' || count.status === 'CANCELLED') throw new Error('This stock count can no longer be reconciled.')

      const expectedById = new Map(count.lines.map((l) => [l.id, Number(l.expectedQty)]))
      const previousCountedById = new Map(count.lines.map((l) => [l.id, l.countedQty == null ? null : Number(l.countedQty)]))
      if (counts && counts.length > 0) await persistCountsTx(tx, counts, expectedById, previousCountedById)
      const providedById = new Map((counts ?? []).map((c) => [c.lineId, c.countedQty]))
      const wanted = lineIds ? new Set(lineIds) : null

      const counted = count.lines
        .map((l) => ({
          lineId: l.id,
          productId: l.productId,
          sku: l.sku,
          countedQty: providedById.has(l.id) ? providedById.get(l.id)! : (l.countedQty == null ? null : Number(l.countedQty)),
          // A changed figure was un-stamped by persistCountsTx just above; the row read here predates that.
          reconciledQty: providedById.has(l.id) && providedById.get(l.id) !== previousCountedById.get(l.id)
            ? null
            : (l.reconciledQty == null ? null : Number(l.reconciledQty)),
        }))
        .filter((l): l is typeof l & { countedQty: number } => l.countedQty != null && (wanted === null || wanted.has(l.lineId)))
      if (counted.length === 0) throw new Error('Count at least one line before reconciling.')

      const productIds = counted.map((l) => l.productId)
      await tx.$queryRaw`SELECT id FROM stock_levels WHERE "warehouseId" = ${count.warehouseId} AND "productId" = ANY(${productIds}::text[]) FOR UPDATE`
      const levels = await tx.stockLevel.findMany({ where: { warehouseId: count.warehouseId, productId: { in: productIds } }, select: { productId: true, quantity: true } })
      const liveBook = new Map(levels.map((l) => [l.productId, new Prisma.Decimal(l.quantity)]))

      // What moved since the previous stamp (for the operator); a never-stamped line is not "moved".
      refreshed = detectStockCountDrift(counted, new Map([...liveBook].map(([k, v]) => [k, v.toNumber()]))).filter((d) => d.earlierOnHand != null)

      for (const l of counted) {
        const live = liveBook.get(l.productId) ?? new Prisma.Decimal(0)
        await tx.stockCountLine.update({
          where: { id: l.lineId },
          data: {
            reconciledQty: live,
            expectedQty: live.toDecimalPlaces(4),
            variance: new Prisma.Decimal(l.countedQty).sub(live).toDecimalPlaces(4),
          },
        })
      }
      await tx.stockCount.update({
        where: { id: countId },
        data: { reconciledAt: new Date(), ...(count.status === 'DRAFT' ? { status: 'IN_PROGRESS' as const, startedAt: new Date() } : {}) },
      })
    }, STOCK_TX_OPTIONS)
    revalidatePath('/stock-control/stock-counts')
    await logActivity({
      entityType: 'STOCK_COUNT', entityId: countId, action: 'reconciled', tag: 'stock',
      description: `Reconciled stock count ${countId}${refreshed.length > 0 ? `: ${refreshed.length} line(s) had moved since the earlier reconcile` : ''}`,
      metadata: { movedSinceEarlierReconcile: refreshed.length },
    })
    return { success: true, ...(refreshed.length > 0 ? { drift: refreshed } : {}) }
  } catch (e) {
    console.error(e)
    return { message: e instanceof Error ? e.message : 'Failed to reconcile the stock count.' }
  }
}

const postSchema = z.object({
  acknowledgeWmsWarning: z.boolean().optional(),
  countId: z.string().min(1),
  reasonId: z.string().min(1).optional(),
  // Optional final counts persisted within the post transaction so save+post is
  // atomic (Codex: a concurrent save can't slip between a separate save and post).
  counts: z.array(countLineInputSchema).optional(),
})

/**
 * Post a stock count: for each counted line, post an ADJUSTMENT that brings the
 * LIVE book quantity to the counted quantity (snapshot-staleness safe), creating/
 * consuming FIFO layers and the inventory journal (via applyStockAdjustment), tied
 * to the count (referenceType 'StockCount'). Atomic; double-post guarded by status.
 */
/** 6oyu.3: marker to unwind the transaction and return a confirmable result. */
class WmsAcknowledgementRequired extends Error {}

export async function postStockCount(input: unknown): Promise<StockCountResult> {
  await requirePermission('stock_control.adjust')
  const parsed = postSchema.safeParse(input)
  if (!parsed.success) return { message: parsed.error.issues[0]?.message ?? 'Invalid post request.' }
  const { countId, reasonId, counts } = parsed.data

  let affectedProductIds: string[] = []
  // A holder, not a bare `let`: the assignment happens in a callback TypeScript cannot see.
  const driftRefusal: { drift?: StockCountDrift[] } = {}
  try {
    await db.$transaction(async (tx) => {
      // Lock + double-post guard.
      await tx.$queryRaw`SELECT id FROM stock_counts WHERE id = ${countId} FOR UPDATE`
      const count = await tx.stockCount.findUnique({
        where: { id: countId },
        select: { status: true, warehouseId: true, lines: { select: { id: true, productId: true, sku: true, expectedQty: true, countedQty: true, reconciledQty: true } } },
      })
      if (!count) throw new Error('Stock count not found.')
      if (count.status === 'COMPLETED') throw new Error('This stock count has already been posted.')
      if (count.status === 'CANCELLED') throw new Error('This stock count was cancelled and cannot be posted.')

      // 6oyu.3: a WMS-mirrored warehouse's book is a reflection of WMS stock —
      // block counts under ALIGN_TO_WMS (the sync would fight them) and require
      // explicit acknowledgement under NOTIFICATION_ONLY.
      // Only ENABLED connectors' bindings apply (Codex r30): a stale binding of
      // a disabled/replaced WMS plugin must not block or warn on counts.
      const pluginState = await getIntegrationPluginState()
      // A LIST, deliberately, and the one site that keeps one (round 10, Codex HIGH 1). This does
      // not route anywhere — it screens a warehouse's bindings — so with a contradictory enabled set
      // the conservative answer is to honour EVERY enabled connector's binding rather than to pick
      // one or to ignore both. `find` would have silently dropped the second connector's block.
      const enabledWmsConnectors = enabledWmsConnectorIds(pluginState)
      const binding = enabledWmsConnectors.length === 0 ? null : await tx.externalWmsBinding.findFirst({
        where: {
          warehouseId: count.warehouseId,
          active: true,
          connection: { active: true },
          connector: { in: enabledWmsConnectors },
        },
        select: { connector: true, stockSyncMode: true },
      })
      const wmsPolicy = classifyStockCountWmsPolicy(binding)
      if (wmsPolicy.policy === 'block') throw new Error(wmsPolicy.message)
      if (wmsPolicy.policy === 'warn' && !parsed.data.acknowledgeWmsWarning) {
        throw new WmsAcknowledgementRequired(wmsPolicy.message)
      }

      const expectedById = new Map(count.lines.map((l) => [l.id, Number(l.expectedQty)]))
      // Atomic save+post: persist any final counts within this transaction.
      const previousCountedById = new Map(count.lines.map((l) => [l.id, l.countedQty == null ? null : Number(l.countedQty)]))
      if (counts && counts.length > 0) await persistCountsTx(tx, counts, expectedById, previousCountedById)
      const providedById = new Map((counts ?? []).map((c) => [c.lineId, c.countedQty]))

      const countedLines: Array<StockCountLineForPost & { countedQty: number; reconciledQty: number | null }> = count.lines
        .map((l) => {
          const countedQty = providedById.has(l.id)
            ? providedById.get(l.id)!
            : (l.countedQty == null ? null : Number(l.countedQty))
          // A figure changed by this very call was un-stamped by persistCountsTx; the row read above predates it.
          const countChangedNow = providedById.has(l.id) && providedById.get(l.id) !== previousCountedById.get(l.id)
          return {
            lineId: l.id, productId: l.productId, sku: l.sku, expectedQty: Number(l.expectedQty), countedQty,
            reconciledQty: countChangedNow || l.reconciledQty == null ? null : Number(l.reconciledQty),
          }
        })
        .filter((l): l is StockCountLineForPost & { countedQty: number; reconciledQty: number | null } => l.countedQty != null)

      // Codex: never COMPLETE an empty post (no lines counted).
      if (countedLines.length === 0) throw new Error('Count at least one line before posting.')

      // Read the LIVE book per counted product under lock.
      const productIds = countedLines.map((l) => l.productId)
      if (productIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM stock_levels WHERE "warehouseId" = ${count.warehouseId} AND "productId" = ANY(${productIds}::text[]) FOR UPDATE`
      }
      const levels = productIds.length
        ? await tx.stockLevel.findMany({ where: { warehouseId: count.warehouseId, productId: { in: productIds } }, select: { productId: true, quantity: true } })
        : []
      const liveBook = new Map(levels.map((l) => [l.productId, Number(l.quantity)]))

      // THE AUTHORISE GUARD. The live on-hand just read, under the stock-level lock, must still be the
      // figure each counted line was reconciled against. If it moved (a receipt landed, an order shipped, the
      // WMS stock sync ran) or the line was never reconciled, nothing is posted: the transaction returns
      // normally so the counts this call saved are kept, and the operator reconciles again or investigates.
      const drift = detectStockCountDrift(countedLines, liveBook)
      if (drift.length > 0) {
        driftRefusal.drift = drift
        return
      }

      const postings = computeStockCountPostings(countedLines, liveBook)
      for (const posting of postings) {
        if (posting.adjustmentQty !== 0) {
          try {
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
          } catch (e) {
            // Codex: name the offending SKU. A surplus of a product with no cost
            // basis fails here (scjz.2) — surface which line and why so the operator
            // can resolve it (e.g. add it via a costed stock adjustment first).
            throw new Error(`Line ${posting.sku}: ${e instanceof Error ? e.message : String(e)}`)
          }
          affectedProductIds.push(posting.productId)
        }
        // Persist the reported variance (count vs snapshot) on the line.
        await tx.stockCountLine.update({ where: { id: posting.lineId }, data: { variance: posting.reportedVariance } })
      }

      await tx.stockCount.update({ where: { id: countId }, data: { status: 'COMPLETED', completedAt: new Date() } })
    }, STOCK_TX_OPTIONS)

    if (driftRefusal.drift) {
      revalidatePath('/stock-control/stock-counts')
      return { message: describeStockCountDrift(driftRefusal.drift), drift: driftRefusal.drift }
    }
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
    if (e instanceof WmsAcknowledgementRequired) {
      return { requiresWmsAcknowledgement: true, message: e.message }
    }
    console.error(e)
    return { message: e instanceof Error ? e.message : 'Failed to post the stock count.' }
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
