'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { allocateBackordersForProducts } from '@/lib/fulfillment/backorder-allocator'
import { releaseOverallocations } from '@/lib/fulfillment/overallocation-rebalancer'
import { isOperationalProductStatus } from '@/lib/products/lifecycle'
import { validateStockTransferStatusTransition } from '@/lib/domain/workflows/action-guards'
import type { Prisma } from '@/app/generated/prisma/client'
import {
  consumeFifoLayersStrict,
} from '@/lib/cost-layers'
import { recreateTransferCostLayersFromSnapshotSlice } from '@/lib/domain/inventory/transfer-cost-layer-recreation'
import { uniqueViolationTargetsField } from '@/lib/db/prisma-unique-violation'
import { sliceTransferSnapshotForReceipt } from '@/lib/domain/wms/asn-reconciliation'
import {
  absorbWmsSnapshotCreditIntoQtyReceived,
  hasAnyLandedQty,
  isTransferLineFullyLanded,
  loadTransferLineLandedQty,
  requireLandedQty,
  transferLineOutstandingQty,
  type TransferLineLandedQty,
} from '@/lib/domain/inventory/transfer-landed-quantity'
import { planTransferPartialReceipt } from '@/lib/domain/inventory/transfer-partial-receipt'
import { isStockMovementIdempotencyConflict } from '@/lib/domain/inventory/stock-movement-idempotency'
import { toInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
import { canDispatchTransferQty, isCostLayerCoverageSufficient } from '@/lib/domain/inventory/transfer-availability'
import { addMoney, floorQuantity, multiplyMoney, toDecimal } from '@/lib/domain/math/decimal'
import { serializeCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import {
  buildStockMovementValueFieldsFromConsumed,
  buildStockMovementValueFieldsFromTotal,
} from '@/lib/domain/inventory/stock-movement-value'
import { withSavepoint } from '@/lib/db/savepoint'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransferLine = {
  productId: string
  sku: string
  productName: string
  qty: number
}

// o3qo: validate transfer line input. qty must be finite (rejects NaN/Infinity);
// 0/negative lines are filtered out downstream, matching prior leniency. sku and
// productName from the client are NOT trusted for persistence — the action
// re-derives them from the product record (see createTransfer/updateTransferDraft).
const transferLineSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  sku: z.string(),
  productName: z.string(),
  qty: z.number().refine(Number.isFinite, 'qty must be a finite number'),
})

export type TransferRow = {
  id: string
  reference: string
  fromWarehouseId: string
  fromWarehouseCode: string
  fromWarehouseName: string
  toWarehouseId: string
  toWarehouseCode: string
  toWarehouseName: string
  status: 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED'
  notes: string | null
  dispatchedAt: string | null
  completedAt: string | null
  createdAt: string
  lines: {
    id: string
    productId: string
    sku: string
    productName: string
    qty: number
    qtyReceived: number
    /**
     * How much of this line has already LANDED — `qtyReceived` plus any WMS
     * stock-sync alignment credit that column does not carry. The UI's
     * cancel-dispatch affordance asks THIS, not `qtyReceived`, so it agrees with the
     * server-side precondition in `cancelDispatchedTransfer` (6oyu.19 Codex r6).
     */
    landedQty: number
  }[]
}

export type TransferResult = {
  success?: boolean
  message?: string
  transfer?: TransferRow
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReference(): string {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `TRF-${ymd}-${rand}`
}

async function validateTransferAvailability(
  tx: Prisma.TransactionClient,
  fromWarehouseId: string,
  lines: TransferLine[],
) {
  const requestedByProduct = new Map<string, { qty: number; sku: string }>()
  for (const line of lines) {
    const existing = requestedByProduct.get(line.productId)
    requestedByProduct.set(line.productId, {
      qty: (existing?.qty ?? 0) + line.qty,
      sku: existing?.sku ?? line.sku,
    })
  }

  for (const [productId, requested] of requestedByProduct) {
    await tx.$queryRaw`
      SELECT "productId", "warehouseId"
      FROM stock_levels
      WHERE "productId" = ${productId}
        AND "warehouseId" = ${fromWarehouseId}
      FOR UPDATE
    `
    const level = await tx.stockLevel.findUnique({
      where: { productId_warehouseId: { productId, warehouseId: fromWarehouseId } },
      select: { quantity: true, reservedQty: true },
    })
    const available = level ? Number(level.quantity) - Number(level.reservedQty) : 0
    if (available < requested.qty) {
      throw new Error(`Insufficient stock for ${requested.sku}: ${available} available, ${requested.qty} requested`)
    }
  }
}

/**
 * Map several transfers at once, loading the landed quantity for every line in ONE
 * query rather than one per transfer.
 */
async function mapRows(rows: Array<Parameters<typeof mapRow>[0]>): Promise<TransferRow[]> {
  const landed = await loadTransferLineLandedQty(db, rows.flatMap((row) => row.lines).map((line) => ({
    id: line.id,
    qtyReceived: line.qtyReceived as never,
  })))
  return Promise.all(rows.map((row) => mapRow(row, landed)))
}

async function mapRow(t: {
  id: string
  reference: string
  fromWarehouseId: string
  toWarehouseId: string
  status: string
  notes: string | null
  dispatchedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  fromWarehouse: { code: string; name: string }
  toWarehouse: { code: string; name: string }
  lines: { id: string; productId: string; sku: string; productName: string; qty: unknown; qtyReceived: unknown }[]
}, landedByLineId?: ReadonlyMap<string, TransferLineLandedQty>): Promise<TransferRow> {
  const landed = landedByLineId ?? await loadTransferLineLandedQty(db, t.lines.map((line) => ({
    id: line.id,
    qtyReceived: line.qtyReceived as never,
  })))
  return {
    id: t.id,
    reference: t.reference,
    fromWarehouseId: t.fromWarehouseId,
    fromWarehouseCode: t.fromWarehouse.code,
    fromWarehouseName: t.fromWarehouse.name,
    toWarehouseId: t.toWarehouseId,
    toWarehouseCode: t.toWarehouse.code,
    toWarehouseName: t.toWarehouse.name,
    status: t.status as TransferRow['status'],
    notes: t.notes,
    dispatchedAt: t.dispatchedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    lines: t.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      sku: l.sku,
      productName: l.productName,
      qty: Number(l.qty),
      qtyReceived: Number(l.qtyReceived),
      landedQty: requireLandedQty(landed, l.id).qtyNumber,
    })),
  }
}

const TRANSFER_SELECT = {
  id: true,
  reference: true,
  fromWarehouseId: true,
  toWarehouseId: true,
  status: true,
  notes: true,
  dispatchedAt: true,
  completedAt: true,
  createdAt: true,
  fromWarehouse: { select: { code: true, name: true } },
  toWarehouse: { select: { code: true, name: true } },
  lines: {
    select: {
      id: true,
      productId: true,
      sku: true,
      productName: true,
      qty: true,
      qtyReceived: true,
    },
  },
} as const

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function getTransfers(limit = 200): Promise<TransferRow[]> {
  await requireInternalUser()
  const rows = await db.stockTransfer.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: TRANSFER_SELECT,
  })
  return mapRows(rows)
}

// ---------------------------------------------------------------------------
// Create (Draft)
// ---------------------------------------------------------------------------

export async function createTransfer(
  fromWarehouseId: string,
  toWarehouseId: string,
  lines: TransferLine[],
  notes?: string,
  reference?: string,
): Promise<TransferResult> {
  await requirePermission('stock_control.transfer')
  if (fromWarehouseId === toWarehouseId) {
    return { message: 'Source and destination warehouses must be different.' }
  }
  const parsed = z.array(transferLineSchema).safeParse(lines)
  if (!parsed.success) {
    return { message: parsed.error.issues[0]?.message ?? 'Invalid transfer line.' }
  }
  const validLines = parsed.data.filter((l) => l.qty > 0 && l.productId)
  if (validLines.length === 0) {
    return { message: 'Add at least one product with a quantity.' }
  }
  if (reference?.trim()) {
    const existing = await db.stockTransfer.findUnique({
      where: { reference: reference.trim() },
      select: { id: true },
    })
    if (existing) {
      return { message: `Transfer ${reference.trim()} already exists.` }
    }
  }
  const transferProducts = await db.product.findMany({
    where: { id: { in: [...new Set(validLines.map((line) => line.productId))] } },
    select: { id: true, sku: true, name: true, lifecycleStatus: true },
  })
  if (transferProducts.some((product) => !isOperationalProductStatus(product.lifecycleStatus))) {
    return { message: 'Archived products cannot be transferred.' }
  }
  // o3qo: re-derive sku/productName from the product record (never trust the
  // client-supplied values) and reject any line whose product doesn't exist.
  const productInfoMap = new Map(transferProducts.map((p) => [p.id, p]))
  if (validLines.some((l) => !productInfoMap.has(l.productId))) {
    return { message: 'Invalid product in transfer.' }
  }

  try {
    // vp70: an auto-generated reference (TRF-YYYYMMDD-<4 base36>) can collide on a
    // busy day; retry with a fresh one on a unique-constraint (P2002) violation.
    // An explicit caller-supplied reference is not retried (its uniqueness was
    // pre-checked and a clash should surface).
    const useAutoReference = !reference?.trim()
    const maxAttempts = useAutoReference ? 5 : 1
    const createOnce = () => db.$transaction(async (tx) => {
      await validateTransferAvailability(tx, fromWarehouseId, validLines)
      return tx.stockTransfer.create({
        data: {
          reference: reference?.trim() || makeReference(),
          fromWarehouseId,
          toWarehouseId,
          notes: notes || null,
          lines: {
            create: validLines.map((l) => ({
              productId: l.productId,
              sku: productInfoMap.get(l.productId)!.sku,
              productName: productInfoMap.get(l.productId)!.name,
              qty: l.qty,
            })),
          },
        },
        select: TRANSFER_SELECT,
      })
    }, STOCK_TX_OPTIONS)

    let transfer: Awaited<ReturnType<typeof createOnce>> | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        transfer = await createOnce()
        break
      } catch (e) {
        // Only retry a unique-constraint (P2002) collision on the `reference`
        // field — don't mask any other (future/nested) unique violation.
        // o3d-5od: this used to read `meta.target`, which the pg driver adapter never
        // populates, so the auto-reference retry never actually fired and a colliding
        // generated reference failed the whole action.
        const isReferenceCollision = uniqueViolationTargetsField(e, 'reference')
        if (useAutoReference && attempt < maxAttempts && isReferenceCollision) continue
        throw e
      }
    }
    if (!transfer) throw new Error('Failed to create transfer after reference retries.')
    revalidatePath('/stock-control/transfers')

    const mapped = await mapRow(transfer)
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: transfer.id,
      action: 'created',
      tag: 'stock',
      description: `Created transfer from ${mapped.fromWarehouseName} to ${mapped.toWarehouseName}`,
    })

    return { success: true, transfer: mapped }
  } catch (e) {
    console.error(e)

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      action: 'create_failed',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to create transfer.',
    })

    return { message: e instanceof Error ? e.message : 'Failed to create transfer.' }
  }
}

// ---------------------------------------------------------------------------
// Update Draft (lines + notes)
// ---------------------------------------------------------------------------

export async function updateTransferDraft(
  id: string,
  fromWarehouseId: string,
  toWarehouseId: string,
  lines: TransferLine[],
  notes?: string
): Promise<TransferResult> {
  await requirePermission('stock_control.transfer')
  if (fromWarehouseId === toWarehouseId) {
    return { message: 'Source and destination warehouses must be different.' }
  }
  const parsed = z.array(transferLineSchema).safeParse(lines)
  if (!parsed.success) {
    return { message: parsed.error.issues[0]?.message ?? 'Invalid transfer line.' }
  }
  const validLines = parsed.data.filter((l) => l.qty > 0 && l.productId)
  if (validLines.length === 0) {
    return { message: 'Add at least one product with a quantity.' }
  }
  const transferProducts = await db.product.findMany({
    where: { id: { in: [...new Set(validLines.map((line) => line.productId))] } },
    select: { id: true, sku: true, name: true, lifecycleStatus: true },
  })
  if (transferProducts.some((product) => !isOperationalProductStatus(product.lifecycleStatus))) {
    return { message: 'Archived products cannot be transferred.' }
  }
  // o3qo: re-derive sku/productName from the product record (never trust the
  // client-supplied values) and reject any line whose product doesn't exist.
  const productInfoMap = new Map(transferProducts.map((p) => [p.id, p]))
  if (validLines.some((l) => !productInfoMap.has(l.productId))) {
    return { message: 'Invalid product in transfer.' }
  }

  try {
    const existing = await db.stockTransfer.findUnique({ where: { id }, select: { status: true } })
    if (!existing) return { message: 'Transfer not found.' }
    if (existing.status !== 'DRAFT') return { message: 'Only draft transfers can be edited.' }

    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const lockedTransfer = await tx.stockTransfer.findUnique({ where: { id }, select: { status: true } })
      if (!lockedTransfer) throw new Error('Transfer not found.')
      if (lockedTransfer.status !== 'DRAFT') throw new Error('Only draft transfers can be edited.')
      await validateTransferAvailability(tx, fromWarehouseId, validLines)
      await tx.stockTransferLine.deleteMany({ where: { transferId: id } })
      await tx.stockTransfer.update({
        where: { id },
        data: {
          fromWarehouseId,
          toWarehouseId,
          notes: notes || null,
          lines: {
            create: validLines.map((l) => ({
              productId: l.productId,
              sku: productInfoMap.get(l.productId)!.sku,
              productName: productInfoMap.get(l.productId)!.name,
              qty: l.qty,
            })),
          },
        },
      })
    })

    const updated = await db.stockTransfer.findUniqueOrThrow({ where: { id }, select: TRANSFER_SELECT })
    revalidatePath('/stock-control/transfers')

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'updated',
      tag: 'stock',
      description: 'Updated transfer draft',
    })

    return { success: true, transfer: await mapRow(updated) }
  } catch (e) {
    console.error(e)

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'update_failed',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to update transfer.',
    })

    return { message: e instanceof Error ? e.message : 'Failed to update transfer.' }
  }
}

// ---------------------------------------------------------------------------
// Dispatch (DRAFT → IN_TRANSIT): books stock out of source warehouse
// ---------------------------------------------------------------------------

export async function dispatchTransfer(id: string): Promise<TransferResult> {
  try {
    await requirePermission('stock_control.transfer')
    await db.$transaction(async (tx) => {
      // Lock the transfer row to prevent concurrent dispatch
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: { ...TRANSFER_SELECT, status: true },
      })
      if (!transfer) throw new Error('Transfer not found')
      const transition = validateStockTransferStatusTransition(transfer.status, 'IN_TRANSIT')
      if (!transition.success) throw new Error(transition.error)

      // vp70: a draft with no lines would otherwise flip to IN_TRANSIT with no
      // stock movement and could then be "received" as a no-op. Reject it.
      if (transfer.lines.length === 0) {
        throw new Error('Cannot dispatch a transfer with no lines.')
      }

      // Lock stock levels for all affected products in the source warehouse
      const productIds = transfer.lines.map((l) => l.productId)
      if (productIds.length > 0) {
        await tx.$queryRaw`SELECT "productId", "warehouseId" FROM stock_levels WHERE "productId" = ANY(${productIds}::text[]) AND "warehouseId" = ${transfer.fromWarehouseId} FOR UPDATE`
      }

      // Validate available stock for each line before making any changes
      for (const line of transfer.lines) {
        const qty = Number(line.qty)
        const level = await tx.stockLevel.findUnique({
          where: { productId_warehouseId: { productId: line.productId, warehouseId: transfer.fromWarehouseId } },
          select: { quantity: true, reservedQty: true },
        })
        // audit-M-stock #1: net the source warehouse's reserved (allocated)
        // quantity so a transfer can't drain stock an order is holding there.
        if (!canDispatchTransferQty(level?.quantity, level?.reservedQty, qty)) {
          // Report the raw (unclamped) delta so an over-reservation (negative)
          // stays a visible diagnostic, not silently shown as 0.
          const rawAvailable = Number(level?.quantity ?? 0) - Number(level?.reservedQty ?? 0)
          throw new Error(`Insufficient stock for ${line.sku}: ${rawAvailable} available, ${qty} requested`)
        }
        // TRANSFER_OUT is a costed outbound movement, so dispatch consumes FIFO
        // layers STRICTLY (consumeFifoLayersStrict below). A source with positive
        // stock_level but insufficient cost layers (stock/cost-layer desync) would
        // pass the availability check above and then hard-fail mid-dispatch. Surface
        // that here, in the same pre-flight phase, with an actionable message. This
        // is advisory; the FOR UPDATE consume remains the authoritative guard.
        const layerCoverage = await tx.costLayer.aggregate({
          where: { productId: line.productId, warehouseId: transfer.fromWarehouseId, remainingQty: { gt: 0 } },
          _sum: { remainingQty: true },
        })
        const coveredQty = layerCoverage._sum.remainingQty
        if (!isCostLayerCoverageSufficient(coveredQty, qty)) {
          throw new Error(
            `Cannot dispatch ${line.sku}: ${toDecimal(coveredQty ?? 0).toString()} unit(s) covered by cost layers, ${qty} requested ` +
            `(stock/cost-layer desync — repair the cost layers for ${transfer.fromWarehouse.code} before transferring).`,
          )
        }
      }

      // Book stock out of source warehouse for each line, consuming FIFO
      // layers and storing the snapshot so receiveTransfer can recreate
      // equivalent layers at the destination warehouse.
      for (const line of transfer.lines) {
        const qtyDecimal = toDecimal(line.qty)
        const qty = qtyDecimal.toNumber()
        // Two-phase value write: create the movement to obtain its id, consume
        // FIFO, then update reporting value fields inside the same transaction.
        // Partial NULL value state is not visible outside the transaction.
        const movement = await tx.stockMovement.create({
          data: {
            type: 'TRANSFER_OUT',
            productId: line.productId,
            fromWarehouseId: transfer.fromWarehouseId,
            toWarehouseId: null,
            qty: qty.toString(),
            note: `Transfer ${transfer.reference} dispatched`,
            referenceType: 'StockTransfer',
            referenceId: id,
          },
          select: { id: true },
        })
        const updatedStock = await tx.stockLevel.updateMany({
          where: {
            productId: line.productId,
            warehouseId: transfer.fromWarehouseId,
            quantity: { gte: qtyDecimal.toString() },
          },
          data: { quantity: { decrement: qty } },
        })
        if (updatedStock.count !== 1) {
          const currentStock = await tx.stockLevel.findUnique({
            where: {
              productId_warehouseId: {
                productId: line.productId,
                warehouseId: transfer.fromWarehouseId,
              },
            },
            select: { quantity: true },
          })
          if (!currentStock) {
            throw new Error(`No stock at ${transfer.fromWarehouse.code} for ${line.sku}`)
          }
          throw new Error(
            `Insufficient stock for ${line.sku}: ${currentStock.quantity} on hand, ${qtyDecimal.toString()} requested`,
          )
        }

        // Consume FIFO layers from source warehouse — STRICT: TRANSFER_OUT is a
        // costed outbound movement, so the dispatched qty must be fully covered by
        // cost layers (un-layered positive stock is a desync, rejected up front
        // above). Store consumed entries on the transfer line so receiveTransfer
        // can split/recreate equivalent layers at the destination.
        const { consumed } = await consumeFifoLayersStrict(tx, line.productId, transfer.fromWarehouseId, qty)
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFieldsFromConsumed(consumed, qty),
        })
        if (consumed.length > 0) {
          await tx.stockTransferLine.update({
            where: { id: line.id },
            data: {
              costLayerSnapshot: serializeCostLayerSnapshot(consumed.map((c) => ({
                costLayerId: c.costLayerId,
                qty: c.qty,
                unitCostBase: c.unitCostBase,
              }))),
            },
          })
        }
      }

      // Conditional status update — only transitions from DRAFT
      const updated = await tx.stockTransfer.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'IN_TRANSIT', dispatchedAt: new Date() },
      })
      if (updated.count === 0) throw new Error('Transfer was already dispatched')
    }, STOCK_TX_OPTIONS)

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')

    const dispatched = await db.stockTransfer.findUnique({
      where: { id },
      select: { reference: true, fromWarehouseId: true, fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } }, lines: { select: { id: true } } },
    })
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'dispatched',
      tag: 'stock',
      description: `Dispatched transfer from ${dispatched?.fromWarehouse.name ?? id} to ${dispatched?.toWarehouse.name ?? id}`,
    })
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'transfer_out',
      tag: 'stock',
      description: `Transfer ${dispatched?.reference ?? id}: dispatched ${dispatched?.lines.length ?? 0} items from ${dispatched?.fromWarehouse.name ?? id}`,
    })
    const transferProducts = await db.stockTransferLine.findMany({
      where: { transferId: id },
      select: { productId: true },
    })
    const dispatchedProductIds = [...new Set(transferProducts.map((line) => line.productId))]
    const sourceWarehouseId = dispatched?.fromWarehouseId ?? null

    if (sourceWarehouseId) {
      try {
        await releaseOverallocations(
          dispatchedProductIds.map((productId) => ({ productId, warehouseId: sourceWarehouseId })),
          { source: 'transfer_dispatch', referenceId: id, referenceLabel: `transfer dispatch ${dispatched?.reference ?? id}` },
        )
      } catch (rebalanceError) {
        console.error(rebalanceError)
      }
    }

    try {
      await enqueueStockSync(dispatchedProductIds, 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = toInventoryConstraintMessage(e, 'Failed to dispatch transfer.')

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'dispatch_failed',
      tag: 'stock',
      level: 'ERROR',
      description: msg,
    })

    return { message: msg }
  }
}

// ---------------------------------------------------------------------------
// Receive (IN_TRANSIT → RECEIVED): books stock into destination warehouse
// ---------------------------------------------------------------------------

/**
 * Books `qtyToReceive` units of one transfer line into the destination
 * warehouse: a TRANSFER_IN movement, a stock-level increment, and recreated
 * FIFO cost layers sliced from the dispatch snapshot (walking past
 * `alreadyReceivedQty` so a WMS or earlier partial receipt is not double-costed),
 * with a £0 balancing layer for any uncosted shortfall. Shared by the full
 * (receiveTransfer) and partial (receiveTransferPartial) receive paths so they
 * never drift. Caller is responsible for the line's qtyReceived update + status.
 */
async function applyTransferLineReceipt(
  tx: Prisma.TransactionClient,
  params: {
    transferId: string
    transferLineId: string
    transferReference: string
    toWarehouseId: string
    productId: string
    snapshot: Prisma.JsonValue | null | undefined
    /**
     * How much of this line had ALREADY landed before this receipt — the offset
     * into the dispatch snapshot. A `TransferLineLandedQty` rather than a number so
     * that it can only have come from lib/domain/inventory/transfer-landed-quantity
     * (6oyu.19 Codex r6): this path used to pass `qtyReceived` alone, which reads
     * zero for a line the WMS stock-sync alignment has already landed and layered,
     * and re-laid those layers.
     */
    alreadyLanded: TransferLineLandedQty
    qtyToReceive: number
    /** When set, makes the receipt movement idempotent (skips if already booked). */
    idempotencyKey?: string
  },
): Promise<{ booked: boolean }> {
  const { transferId, transferLineId, transferReference, toWarehouseId, productId, snapshot, alreadyLanded, qtyToReceive, idempotencyKey } = params
  const alreadyReceivedQty = alreadyLanded.qtyNumber

  const snapshotSlice = sliceTransferSnapshotForReceipt({
    snapshot,
    alreadyLanded,
    qtyReceived: qtyToReceive,
  })
  const totalValueBase = snapshotSlice.reduce(
    (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
    toDecimal(0),
  )
  try {
    // o3d-slrn: returning { booked: false } leaves the caller continuing on this same tx, so
    // the failing insert must be savepointed or everything after it hits a 25P02.
    await withSavepoint(tx, () => tx.stockMovement.create({
      data: {
        type: 'TRANSFER_IN',
        productId,
        fromWarehouseId: null,
        toWarehouseId,
        qty: qtyToReceive.toString(),
        note: alreadyReceivedQty > 0
          ? `Transfer ${transferReference} received (${qtyToReceive} after ${alreadyReceivedQty} already booked)`
          : `Transfer ${transferReference} received`,
        referenceType: 'StockTransfer',
        referenceId: transferId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...buildStockMovementValueFieldsFromTotal({ qty: qtyToReceive, totalValueBase }),
      },
    }))
  } catch (error) {
    // Idempotent path only: a duplicate submit/retry already booked this line, so
    // skip the rest of its booking (stock level, layers were applied the first time).
    if (idempotencyKey && isStockMovementIdempotencyConflict(error)) return { booked: false }
    throw error
  }
  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId, warehouseId: toWarehouseId } },
    create: { productId, warehouseId: toWarehouseId, quantity: qtyToReceive.toString() },
    update: { quantity: { increment: qtyToReceive } },
  })

  // Recreate FIFO layers at the destination from the unconsumed slice of the
  // dispatch snapshot (the slicer walks past alreadyReceivedQty and returns the
  // next qtyToReceive units). The shared helper GUARANTEES two things about the
  // layers it creates — each is reachable by propagateLandedCostToOutputs, and
  // together they cover the slice's whole quantity — so never open-code this.
  //
  // It REFUSES a snapshot entry whose unit cost is negative (Codex round-5 HIGH,
  // o3d-gd2f): nothing downstream can carry the sign, so it creates nothing and
  // aborts this transaction rather than let the stock increment above commit
  // alone. Do NOT wrap this call in a try or a savepoint.
  //
  // It settles NOTHING (Codex round-4 LOW). A landed-cost revaluation that landed
  // while these units were in transit had no layer to journal against and IMS
  // persisted no obligation for it; creating the layer now does not discharge it,
  // and the delta is still sitting in the transit clearing account. That gap is
  // open and tracked as o3d-nrl4 — see the contract on
  // STOCK_TRANSFER_SOURCE_LAYER_CONSUMPTION.IN_TRANSIT.
  //
  // `bookedQty` is the stock increment made immediately above, and the helper's
  // coverage postcondition is measured against IT, not against the slice (Codex
  // round-8 HIGH-1). cogs-audit scjz.5's £0 balancing layer for an under-recording
  // dispatch snapshot is now the helper's `BALANCE_AT_ZERO_COST` policy: it used to
  // be built here, and the three other call sites — which increment stock the same
  // way — did not build one at all.
  await recreateTransferCostLayersFromSnapshotSlice(
    tx,
    {
      productId,
      warehouseId: toWarehouseId,
      transferLineId,
      contextLabel: `transfer ${transferReference} receipt`,
      bookedQty: qtyToReceive,
      uncostedShortfall: 'BALANCE_AT_ZERO_COST',
    },
    snapshotSlice,
  )

  return { booked: true }
}


export async function receiveTransfer(id: string): Promise<TransferResult> {
  try {
    await requirePermission('stock_control.transfer')
    await db.$transaction(async (tx) => {
      // Lock the transfer row to prevent concurrent receive
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: { ...TRANSFER_SELECT, status: true },
      })
      if (!transfer) throw new Error('Transfer not found')
      const transition = validateStockTransferStatusTransition(transfer.status, 'RECEIVED')
      if (!transition.success) throw new Error(transition.error)

      // Load cost layer snapshots stored at dispatch time
      const linesWithSnapshots = await tx.stockTransferLine.findMany({
        where: { transferId: id },
        select: { id: true, productId: true, costLayerSnapshot: true },
      })
      const snapshotByLineId = new Map(linesWithSnapshots.map((l) => [l.id, l.costLayerSnapshot]))
      const productIds = transfer.lines.map((line) => line.productId)
      if (productIds.length > 0) {
        await tx.stockLevel.createMany({
          data: productIds.map((productId) => ({
            productId,
            warehouseId: transfer.toWarehouseId,
            quantity: 0,
          })),
          skipDuplicates: true,
        })
        await tx.$queryRaw`
          SELECT "productId", "warehouseId"
          FROM stock_levels
          WHERE "productId" = ANY(${productIds}::text[])
            AND "warehouseId" = ${transfer.toWarehouseId}
          FOR UPDATE
        `
      }

      // 6oyu.19 (Codex r6): how much of each line has ALREADY landed, from the one
      // definition. `qtyReceived` alone reads zero for a line the WMS stock-sync
      // alignment has already brought into stock and laid into cost layers, and
      // receiving from that offset re-lays every one of those layers.
      const landedByLineId = await loadTransferLineLandedQty(tx, transfer.lines)

      for (const line of transfer.lines) {
        // A WMS connector callback or a stock-sync alignment may already have
        // booked in part of this line — cost layers and a TRANSFER_IN movement for
        // that portion are already down. Receive only the outstanding quantity to
        // avoid double-counting; skip the line entirely if it is already fully
        // landed.
        // 4ve5: subtract the Decimal(12,4) quantities in the Decimal engine, not via
        // JS floats, so the remaining qty persisted to the movement, stock level and
        // value fields carries no last-place IEEE-754 drift.
        const alreadyLanded = requireLandedQty(landedByLineId, line.id)
        const remainingQty = transferLineOutstandingQty(line.qty, alreadyLanded).toNumber()

        if (remainingQty > 0) {
          await applyTransferLineReceipt(tx, {
            transferId: id,
            transferLineId: line.id,
            transferReference: transfer.reference,
            toWarehouseId: transfer.toWarehouseId,
            productId: line.productId,
            snapshot: snapshotByLineId.get(line.id),
            alreadyLanded,
            qtyToReceive: remainingQty,
          })
        }

        // Mark line as fully received regardless of which path got us here.
        // 4ve5: persist the exact Decimal line qty, not a JS-float round-trip.
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { qtyReceived: line.qty },
        })
        // Setting qtyReceived to the WHOLE line quantity swallows any alignment
        // credit into that column, so the credit must stop counting through the
        // snapshot arm or the line reads as over-landed for ever. See
        // absorbWmsSnapshotCreditIntoQtyReceived — this is the manual-path
        // equivalent of the qtyAccountedViaReceipt increment the WMS webhook has
        // always made.
        await absorbWmsSnapshotCreditIntoQtyReceived(tx, line.id, alreadyLanded.fromUnabsorbedWmsSnapshot)
      }

      // Conditional status update — only transitions from IN_TRANSIT
      const updated = await tx.stockTransfer.updateMany({
        where: { id, status: 'IN_TRANSIT' },
        data: { status: 'RECEIVED', completedAt: new Date() },
      })
      if (updated.count === 0) throw new Error('Transfer was already received')
    }, STOCK_TX_OPTIONS)

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')

    const received = await db.stockTransfer.findUnique({
      where: { id },
      select: { reference: true, toWarehouse: { select: { name: true } }, lines: { select: { id: true } } },
    })
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'received',
      tag: 'stock',
      description: `Received transfer at ${received?.toWarehouse.name ?? id}`,
    })
    await logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'transfer_in',
      tag: 'stock',
      description: `Transfer ${received?.reference ?? id}: received ${received?.lines.length ?? 0} items at ${received?.toWarehouse.name ?? id}`,
    })
    const receivedTransferProducts = await db.stockTransferLine.findMany({
      where: { transferId: id },
      select: { productId: true },
    })
    const receivedProductIds = [...new Set(receivedTransferProducts.map((line) => line.productId))]

    try {
      await allocateBackordersForProducts(receivedProductIds, {
        source: 'transfer_receive',
        referenceId: id,
        referenceLabel: `transfer receive ${received?.reference ?? id}`,
      })
    } catch (allocError) {
      console.error(allocError)
    }

    try {
      await enqueueStockSync(receivedProductIds, 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = toInventoryConstraintMessage(e, 'Failed to receive transfer.')

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'receive_failed',
      tag: 'stock',
      level: 'ERROR',
      description: msg,
    })

    return { message: msg }
  }
}

const partialReceiptInputSchema = z
  .array(
    z.object({
      lineId: z.string().min(1),
      qty: z.number().refine(Number.isFinite, 'qty must be a finite number').positive('qty must be greater than zero'),
    }),
  )
  .min(1, 'Select at least one line to receive')

/**
 * Receive PART of an in-transit transfer: book the operator-specified per-line
 * quantities (capped at each line's remaining) into the destination, leaving the
 * transfer IN_TRANSIT until every line is fully received. Shares the per-line
 * receipt + FIFO recreation with receiveTransfer (applyTransferLineReceipt).
 */
export async function receiveTransferPartial(id: string, lineDeltas: unknown, submissionToken: unknown): Promise<TransferResult> {
  try {
    await requirePermission('stock_control.transfer')

    const parsed = partialReceiptInputSchema.safeParse(lineDeltas)
    if (!parsed.success) {
      return { message: parsed.error.issues[0]?.message ?? 'Invalid receive request.' }
    }
    const requested = parsed.data
    // Client-supplied per-submit token makes each line's receipt idempotent, so a
    // retry/double-submit of the same partial cannot double-book stock.
    const token = typeof submissionToken === 'string' ? submissionToken.trim().slice(0, 100) : ''
    if (!token) return { message: 'Missing receive token — refresh and try again.' }

    let receivedProductIds: string[] = []
    let bookedCount = 0
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: {
          id: true,
          reference: true,
          status: true,
          toWarehouseId: true,
          completedAt: true,
          lines: { select: { id: true, productId: true, qty: true, qtyReceived: true, costLayerSnapshot: true } },
        },
      })
      if (!transfer) throw new Error('Transfer not found')
      if (transfer.status !== 'IN_TRANSIT') throw new Error('Only in-transit transfers can be partially received.')

      const lineById = new Map(transfer.lines.map((l) => [l.id, l]))
      // Fail loudly on lines that aren't part of this transfer (no silent skip).
      for (const item of requested) {
        if (!lineById.has(item.lineId)) throw new Error(`Transfer line ${item.lineId} is not part of this transfer.`)
      }

      // 6oyu.19 (Codex r6): cap against what has already LANDED, from the one
      // definition — `qtyReceived` alone offers up quantity a WMS alignment has
      // already booked in and layered.
      const landedByLineId = await loadTransferLineLandedQty(tx, transfer.lines)
      const { plan } = planTransferPartialReceipt(
        transfer.lines.map((l) => ({ id: l.id, qty: Number(l.qty), landed: requireLandedQty(landedByLineId, l.id) })),
        requested.map((r) => ({ lineId: r.lineId, qty: r.qty })),
      )
      // Empty plan = the selected lines are already fully received (e.g. an
      // idempotent retry whose first submit completed them) — a no-op success,
      // not an error.
      const planProductIds = [...new Set(plan.map((p) => lineById.get(p.lineId)!.productId))]
      await tx.stockLevel.createMany({
        data: planProductIds.map((productId) => ({ productId, warehouseId: transfer.toWarehouseId, quantity: 0 })),
        skipDuplicates: true,
      })
      await tx.$queryRaw`
        SELECT "productId", "warehouseId"
        FROM stock_levels
        WHERE "productId" = ANY(${planProductIds}::text[])
          AND "warehouseId" = ${transfer.toWarehouseId}
        FOR UPDATE
      `

      for (const planLine of plan) {
        const line = lineById.get(planLine.lineId)!
        // Exact-decimal cap against the locked remaining, so qtyReceived reaches
        // its line qty precisely (no JS-float drift on Decimal(12,4) quantities).
        const qtyReceivedDecimal = toDecimal(line.qtyReceived)
        const alreadyLanded = requireLandedQty(landedByLineId, line.id)
        const remainingDecimal = transferLineOutstandingQty(line.qty, alreadyLanded)
        let receiveDecimal = toDecimal(planLine.receiveQty)
        if (receiveDecimal.gt(remainingDecimal)) receiveDecimal = remainingDecimal
        // Floor to the transfer line's 4dp precision so the SAME value drives both
        // the receipt movement and the qtyReceived set (no movement-vs-qtyReceived
        // drift), and a sub-0.0001 request can never round UP and over-book — it
        // floors to 0 and is skipped below.
        receiveDecimal = floorQuantity(receiveDecimal, 4)
        if (receiveDecimal.lte(0)) continue

        const { booked } = await applyTransferLineReceipt(tx, {
          transferId: id,
          transferLineId: line.id,
          transferReference: transfer.reference,
          toWarehouseId: transfer.toWarehouseId,
          productId: line.productId,
          snapshot: line.costLayerSnapshot,
          alreadyLanded,
          qtyToReceive: receiveDecimal.toNumber(),
          idempotencyKey: `transfer-partial:${token}:${line.id}`,
        })
        if (!booked) continue // retry of an already-booked line — don't double-count

        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { qtyReceived: addMoney(qtyReceivedDecimal, receiveDecimal).toFixed(4) },
        })
        bookedCount++
      }

      receivedProductIds = planProductIds

      // Recompute completion from the locked, updated rows (Decimal-exact) rather
      // than the float plan, so the RECEIVED flip is precise.
      const updatedLines = await tx.stockTransferLine.findMany({
        where: { transferId: id },
        select: { id: true, qty: true, qtyReceived: true },
      })
      // Completion is a question about LANDED quantity, not about one column: a line
      // whose units arrived via a WMS stock-sync alignment has a qtyReceived of zero
      // and is nonetheless fully accounted for (6oyu.19 Codex r6).
      const updatedLanded = await loadTransferLineLandedQty(tx, updatedLines)
      const allReceived = updatedLines.every((l) => isTransferLineFullyLanded(l.qty, requireLandedQty(updatedLanded, l.id)))
      if (allReceived) {
        const closed = await tx.stockTransfer.updateMany({
          where: { id, status: 'IN_TRANSIT' },
          data: { status: 'RECEIVED', completedAt: transfer.completedAt ?? new Date() },
        })
        if (closed.count === 0) throw new Error('Transfer was already received')
      }
    }, STOCK_TX_OPTIONS)

    // Nothing newly booked (idempotent retry, or lines already fully received):
    // succeed quietly without a redundant receive activity or stock re-sync.
    if (bookedCount === 0) return { success: true }

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')

    const after = await db.stockTransfer.findUnique({
      where: { id },
      select: { reference: true, status: true, toWarehouse: { select: { name: true } } },
    })
    const fullyReceived = after?.status === 'RECEIVED'
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: fullyReceived ? 'received' : 'partially_received',
      tag: 'stock',
      description: `${fullyReceived ? 'Received' : 'Partially received'} transfer ${after?.reference ?? id} at ${after?.toWarehouse.name ?? id}`,
    })

    try {
      await allocateBackordersForProducts(receivedProductIds, {
        source: 'transfer_receive',
        referenceId: id,
        referenceLabel: `transfer partial receive ${after?.reference ?? id}`,
      })
    } catch (allocError) {
      console.error(allocError)
    }
    try {
      await enqueueStockSync(receivedProductIds, 'IMS_CHANGE')
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = toInventoryConstraintMessage(e, 'Failed to receive transfer.')
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'receive_failed',
      tag: 'stock',
      level: 'ERROR',
      description: msg,
    })
    return { message: msg }
  }
}

// ---------------------------------------------------------------------------
// Cancel (DRAFT only)
// ---------------------------------------------------------------------------

export async function cancelTransfer(id: string): Promise<TransferResult> {
  try {
    await requirePermission('stock_control.transfer')
    const existing = await db.stockTransfer.findUnique({ where: { id }, select: { status: true } })
    if (!existing) return { message: 'Transfer not found.' }
    const transition = validateStockTransferStatusTransition(existing.status, 'CANCELLED')
    if (!transition.success) return { message: transition.error }

    // 7ddn: close the dispatch/cancel race. Without the lock + conditional guard, a
    // concurrent dispatchTransfer (DRAFT→IN_TRANSIT, which decrements source stock)
    // could be overwritten by this unconditional update, flipping IN_TRANSIT→CANCELLED
    // and stranding the already-dispatched stock with no compensating movement. Lock
    // the transfer row and transition only if it is still DRAFT, mirroring the other
    // state mutations (dispatch/receive). The pre-checks above stay for nice messages;
    // this conditional update is the authoritative guard.
    const cancelled = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const updated = await tx.stockTransfer.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'CANCELLED' },
      })
      return updated.count === 1
    }, STOCK_TX_OPTIONS)
    if (!cancelled) return { message: 'Transfer is no longer in a cancellable state.' }
    revalidatePath('/stock-control/transfers')

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'cancelled',
      tag: 'stock',
      description: 'Cancelled transfer',
    })

    return { success: true }
  } catch (e) {
    console.error(e)

    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'cancel_failed',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to cancel transfer.',
    })

    return { message: 'Failed to cancel transfer.' }
  }
}

// ---------------------------------------------------------------------------
// Cancel dispatch (IN_TRANSIT → CANCELLED): compensating action that books the
// stranded stock back into the SOURCE warehouse when a dispatched transfer will
// never be received (audit-C5). The state machine intentionally does NOT allow
// IN_TRANSIT → CANCELLED for the plain cancel path (which performs no stock
// movement); this dedicated action restores stock + cost layers from the
// dispatch-time snapshot, so it owns its own guard and conditional update.
// ---------------------------------------------------------------------------

export async function cancelDispatchedTransfer(id: string): Promise<TransferResult> {
  try {
    await requirePermission('stock_control.transfer')
    let restoredLineCount = 0
    let linesMissingCostLayers = 0
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: { ...TRANSFER_SELECT, status: true },
      })
      if (!transfer) throw new Error('Transfer not found')
      if (transfer.status !== 'IN_TRANSIT') {
        throw new Error('Only an in-transit transfer can have its dispatch cancelled')
      }

      const lines = await tx.stockTransferLine.findMany({
        where: { transferId: id },
        select: { id: true, productId: true, qty: true, qtyReceived: true, costLayerSnapshot: true },
      })

      // A partly-landed transfer (a WMS webhook book-in, a manual partial receipt or
      // a WMS stock-sync alignment has already brought some units to rest and laid
      // their cost layers) cannot be cleanly cancel-dispatched: restoring the
      // remainder to source while leaving the landed units where they are would
      // split the transfer across both warehouses under a CANCELLED status. Close
      // such a transfer out via the receive path instead.
      //
      // 6oyu.19 (Codex round-6 HIGH-1): this asked `qtyReceived > 0` alone, which is
      // ZERO for a line the stock-sync ALIGNMENT landed — that path increments
      // `wms_asn_line_maps.qtyAccountedViaSnapshot` and never touches the transfer
      // line. The guard passed, the restore below created a SECOND replacement cost
      // layer linked to the same source layer, and a later landed-cost revaluation
      // propagated into both and posted the inventory reclassification twice. It now
      // asks the one definition of "already landed", which counts both routes.
      const landedByLineId = await loadTransferLineLandedQty(tx, lines)
      if (lines.some((line) => hasAnyLandedQty(requireLandedQty(landedByLineId, line.id)))) {
        throw new Error('This transfer has already been partly received — finish receiving it instead of cancelling the dispatch.')
      }

      const productIds = [...new Set(lines.map((line) => line.productId))]
      if (productIds.length > 0) {
        await tx.stockLevel.createMany({
          data: productIds.map((productId) => ({ productId, warehouseId: transfer.fromWarehouseId, quantity: 0 })),
          skipDuplicates: true,
        })
        await tx.$queryRaw`
          SELECT "productId", "warehouseId"
          FROM stock_levels
          WHERE "productId" = ANY(${productIds}::text[])
            AND "warehouseId" = ${transfer.fromWarehouseId}
          FOR UPDATE
        `
      }

      for (const line of lines) {
        // Anything already landed is not stranded, so restore only the portion that
        // never arrived — measured with the same landed definition the guard above
        // uses, and sliced from the same offset, so the two can never disagree about
        // which units are still in transit.
        // 4ve5: subtract the Decimal(12,4) quantities in the Decimal engine, not via
        // JS floats, so the restored qty persisted back to the source movement, stock
        // level and value fields carries no IEEE-754 drift.
        const alreadyLanded = requireLandedQty(landedByLineId, line.id)
        const restoreQty = transferLineOutstandingQty(line.qty, alreadyLanded).toNumber()
        if (restoreQty <= 0) continue

        const snapshotSlice = sliceTransferSnapshotForReceipt({
          snapshot: line.costLayerSnapshot,
          alreadyLanded,
          qtyReceived: restoreQty,
        })
        // No snapshot (dispatched before snapshot tracking, or source had no FIFO
        // layers): stock is still restored but no source layers are recreated —
        // surface it so the stock/cost-layer reconciliation can be reviewed.
        if (snapshotSlice.length === 0) linesMissingCostLayers += 1
        const totalValueBase = snapshotSlice.reduce(
          (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
          toDecimal(0),
        )

        await tx.stockMovement.create({
          data: {
            type: 'TRANSFER_IN',
            productId: line.productId,
            fromWarehouseId: null,
            toWarehouseId: transfer.fromWarehouseId,
            qty: restoreQty.toString(),
            note: `Transfer ${transfer.reference} dispatch cancelled — restored ${restoreQty} to source`,
            referenceType: 'StockTransfer',
            referenceId: id,
            ...buildStockMovementValueFieldsFromTotal({ qty: restoreQty, totalValueBase }),
          },
        })
        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId: line.productId, warehouseId: transfer.fromWarehouseId } },
          create: { productId: line.productId, warehouseId: transfer.fromWarehouseId, quantity: restoreQty.toString() },
          update: { quantity: { increment: restoreQty } },
        })

        // Recreate FIFO layers at the SOURCE from the snapshot slice (mirrors the
        // destination recreation in receiveTransfer, targeting fromWarehouseId).
        // Note: the ORIGINAL layers consumed at dispatch are NOT un-consumed; this
        // creates equivalent replacement layers (same cost basis + source-line
        // provenance), so source quantity reconciles with cost layers. Same shared
        // helper as the receipt path, for the same two guarantees: each replacement
        // layer is reachable by propagation, and the layers cover the whole restored
        // quantity (this path has no balancing step of its own, so a layer the helper
        // declined would leave the restored stock unlayered — Codex round-4 HIGH).
        //
        // It REFUSES a snapshot entry whose unit cost is negative (Codex round-5
        // HIGH, o3d-gd2f), creating nothing and aborting this transaction rather
        // than let the restore above commit alone. Do NOT wrap this call in a try
        // or a savepoint.
        //
        // A cancellation is the OTHER way in-transit units come to rest, and it
        // settles no deferred reclass either (Codex round-4 LOW): a revaluation that
        // landed mid-transit was never persisted as an obligation, so nothing here
        // discharges it and the delta stays in the transit clearing account. Open,
        // tracked as o3d-nrl4.
        //
        // `bookedQty` is the restore increment above (Codex round-8 HIGH-1). This
        // path restores the FULL outstanding line quantity, and the snapshot can
        // cover less than that — a source that dispatched legacy/uncosted stock is
        // the ordinary case, and `linesMissingCostLayers` above counts only the
        // TOTALLY uncovered one. A partial shortfall used to pass the helper's
        // slice-scoped check and leave restored stock unlayered at the source.
        await recreateTransferCostLayersFromSnapshotSlice(
          tx,
          {
            productId: line.productId,
            warehouseId: transfer.fromWarehouseId,
            transferLineId: line.id,
            contextLabel: `transfer ${transfer.reference} dispatch cancellation`,
            bookedQty: restoreQty,
            uncostedShortfall: 'BALANCE_AT_ZERO_COST',
          },
          snapshotSlice,
        )
        restoredLineCount += 1
      }

      // Conditional status update — only from IN_TRANSIT (guards a concurrent receive).
      const updated = await tx.stockTransfer.updateMany({
        where: { id, status: 'IN_TRANSIT' },
        data: { status: 'CANCELLED', completedAt: new Date() },
      })
      if (updated.count === 0) throw new Error('Transfer is no longer in transit')
    }, STOCK_TX_OPTIONS)

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')

    const cancelled = await db.stockTransfer.findUnique({
      where: { id },
      select: { reference: true, fromWarehouseId: true, fromWarehouse: { select: { name: true } }, lines: { select: { productId: true } } },
    })
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'dispatch_cancelled',
      tag: 'stock',
      level: 'WARNING',
      description: `Cancelled dispatch of transfer ${cancelled?.reference ?? id} — restored ${restoredLineCount} line(s) to ${cancelled?.fromWarehouse.name ?? 'source'}${linesMissingCostLayers > 0 ? ` (${linesMissingCostLayers} line(s) had no cost-layer snapshot — review reconciliation)` : ''}`,
      metadata: { reference: cancelled?.reference ?? id, restoredLineCount, linesMissingCostLayers, fromWarehouseId: cancelled?.fromWarehouseId ?? null },
    })

    const restoredProductIds = [...new Set((cancelled?.lines ?? []).map((line) => line.productId))]
    if (restoredProductIds.length > 0) {
      try {
        await allocateBackordersForProducts(restoredProductIds, {
          source: 'transfer_cancel',
          referenceId: id,
          referenceLabel: `transfer dispatch cancel ${cancelled?.reference ?? id}`,
        })
      } catch (allocError) {
        console.error(allocError)
      }
      try {
        await enqueueStockSync(restoredProductIds, 'IMS_CHANGE')
      } catch (syncError) {
        console.error(syncError)
      }
    }

    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = toInventoryConstraintMessage(e, 'Failed to cancel transfer dispatch.')
    await logActivity({
      entityType: 'STOCK_TRANSFER',
      entityId: id,
      action: 'dispatch_cancel_failed',
      tag: 'stock',
      level: 'ERROR',
      description: msg,
    })
    return { message: msg }
  }
}
