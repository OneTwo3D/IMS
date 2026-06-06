'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { allocateBackordersForProducts } from '@/lib/fulfillment/backorder-allocator'
import { releaseOverallocations } from '@/lib/fulfillment/overallocation-rebalancer'
import { isOperationalProductStatus } from '@/lib/products/lifecycle'
import { validateStockTransferStatusTransition } from '@/lib/domain/workflows/action-guards'
import type { Prisma } from '@/app/generated/prisma/client'
import {
  consumeFifoLayersStrict,
  copyCostLayerSourceLinesProportionally,
  createCostLayer,
} from '@/lib/cost-layers'
import { sliceTransferSnapshotForReceipt } from '@/lib/domain/wms/asn-reconciliation'
import { toInventoryConstraintMessage } from '@/lib/domain/inventory/prisma-errors'
import { addMoney, multiplyMoney, roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { serializeCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import {
  buildStockMovementValueFieldsFromConsumed,
  buildStockMovementValueFieldsFromTotal,
} from '@/lib/domain/inventory/stock-movement-value'

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
    await tx.$executeRaw`
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
}): Promise<TransferRow> {
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
  await requireAuth()
  const rows = await db.stockTransfer.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: TRANSFER_SELECT,
  })
  return Promise.all(rows.map(mapRow))
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
  const validLines = lines.filter((l) => l.qty > 0 && l.productId)
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
    select: { lifecycleStatus: true },
  })
  if (transferProducts.some((product) => !isOperationalProductStatus(product.lifecycleStatus))) {
    return { message: 'Archived products cannot be transferred.' }
  }

  try {
    const transfer = await db.$transaction(async (tx) => {
      await validateTransferAvailability(tx, fromWarehouseId, validLines)
      return tx.stockTransfer.create({
        data: {
          reference: reference || makeReference(),
          fromWarehouseId,
          toWarehouseId,
          notes: notes || null,
          lines: {
            create: validLines.map((l) => ({
              productId: l.productId,
              sku: l.sku,
              productName: l.productName,
              qty: l.qty,
            })),
          },
        },
        select: TRANSFER_SELECT,
      })
    }, STOCK_TX_OPTIONS)
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
      action: 'created',
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
  const validLines = lines.filter((l) => l.qty > 0 && l.productId)
  if (validLines.length === 0) {
    return { message: 'Add at least one product with a quantity.' }
  }
  const transferProducts = await db.product.findMany({
    where: { id: { in: [...new Set(validLines.map((line) => line.productId))] } },
    select: { lifecycleStatus: true },
  })
  if (transferProducts.some((product) => !isOperationalProductStatus(product.lifecycleStatus))) {
    return { message: 'Archived products cannot be transferred.' }
  }

  try {
    const existing = await db.stockTransfer.findUnique({ where: { id }, select: { status: true } })
    if (!existing) return { message: 'Transfer not found.' }
    if (existing.status !== 'DRAFT') return { message: 'Only draft transfers can be edited.' }

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
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
              sku: l.sku,
              productName: l.productName,
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
      action: 'updated',
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
      await tx.$executeRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: { ...TRANSFER_SELECT, status: true },
      })
      if (!transfer) throw new Error('Transfer not found')
      const transition = validateStockTransferStatusTransition(transfer.status, 'IN_TRANSIT')
      if (!transition.success) throw new Error(transition.error)

      // Lock stock levels for all affected products in the source warehouse
      const productIds = transfer.lines.map((l) => l.productId)
      if (productIds.length > 0) {
        await tx.$executeRaw`SELECT "productId", "warehouseId" FROM stock_levels WHERE "productId" = ANY(${productIds}::text[]) AND "warehouseId" = ${transfer.fromWarehouseId} FOR UPDATE`
      }

      // Validate available stock for each line before making any changes
      for (const line of transfer.lines) {
        const qty = Number(line.qty)
        const level = await tx.stockLevel.findUnique({
          where: { productId_warehouseId: { productId: line.productId, warehouseId: transfer.fromWarehouseId } },
          select: { quantity: true, reservedQty: true },
        })
        const available = level ? Number(level.quantity) - Number(level.reservedQty) : 0
        if (available < qty) {
          throw new Error(`Insufficient stock for ${line.sku}: ${available} available, ${qty} requested`)
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

        // Consume FIFO layers from source warehouse — tolerant mode
        // (legacy stock may not have layers). Store consumed entries on
        // the transfer line so receiveTransfer can split/recreate them.
        const { consumed } = await consumeFifoLayersStrict(tx, line.productId, transfer.fromWarehouseId, qty)
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFieldsFromConsumed(consumed),
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
      action: 'dispatched',
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

export async function receiveTransfer(id: string): Promise<TransferResult> {
  try {
    await requirePermission('stock_control.transfer')
    await db.$transaction(async (tx) => {
      // Lock the transfer row to prevent concurrent receive
      await tx.$executeRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
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
        await tx.$executeRaw`
          SELECT "productId", "warehouseId"
          FROM stock_levels
          WHERE "productId" = ANY(${productIds}::text[])
            AND "warehouseId" = ${transfer.toWarehouseId}
          FOR UPDATE
        `
      }

      for (const line of transfer.lines) {
        const qty = Number(line.qty)
        // A WMS callback (Mintsoft etc.) may already have booked in part of
        // this line and stamped qtyReceived + cost layers + a TRANSFER_IN
        // movement for that portion. Receive only the remaining quantity to
        // avoid double-counting; skip the line entirely if it is already
        // fully received via WMS.
        const alreadyReceived = Number(line.qtyReceived ?? 0)
        const remainingQty = Math.max(0, qty - alreadyReceived)

        if (remainingQty > 0) {
          // Compute the pure snapshot slice before movement creation so the
          // transfer-in value fields and recreated destination layers use the
          // same cost basis.
          const snapshotSlice = sliceTransferSnapshotForReceipt({
            snapshot: snapshotByLineId.get(line.id),
            alreadyReceivedQty: alreadyReceived,
            qtyReceived: remainingQty,
          })
          const totalValueBase = snapshotSlice.reduce(
            (sum, entry) => addMoney(sum, multiplyMoney(entry.qty, entry.unitCostBase)),
            toDecimal(0),
          )
          await tx.stockMovement.create({
            data: {
              type: 'TRANSFER_IN',
              productId: line.productId,
              fromWarehouseId: null,
              toWarehouseId: transfer.toWarehouseId,
              qty: remainingQty.toString(),
              note: alreadyReceived > 0
                ? `Transfer ${transfer.reference} received (manual close-out of ${remainingQty} after ${alreadyReceived} already booked via WMS)`
                : `Transfer ${transfer.reference} received`,
              referenceType: 'StockTransfer',
              referenceId: id,
              ...buildStockMovementValueFieldsFromTotal({ qty: remainingQty, totalValueBase }),
            },
          })
          await tx.stockLevel.upsert({
            where: { productId_warehouseId: { productId: line.productId, warehouseId: transfer.toWarehouseId } },
            create: { productId: line.productId, warehouseId: transfer.toWarehouseId, quantity: remainingQty.toString() },
            update: { quantity: { increment: remainingQty } },
          })

          // Recreate FIFO layers at the destination warehouse from the slice
          // of the snapshot that hasn't already been consumed by a WMS
          // partial-receive. The snapshot is stored at dispatch and represents
          // the full transfer's source layers; the slicer walks past
          // alreadyReceived units and returns only the next remainingQty
          // units, matching the same algorithm the WMS handler uses.
          for (const entry of snapshotSlice) {
            const entryQty = toDecimal(entry.qty)
            const unitCostBase = toDecimal(entry.unitCostBase)
            if (entryQty.gt(0) && unitCostBase.gte(0)) {
              const newLayerId = await createCostLayer(tx, {
                productId: line.productId,
                warehouseId: transfer.toWarehouseId,
                qty: entryQty,
                unitCostBase,
              })
              const copied = await copyCostLayerSourceLinesProportionally(tx, entry.costLayerId, newLayerId, entryQty)
              if (copied === 0) {
                await tx.costLayerSourceLine.create({
                  data: {
                    costLayerId: newLayerId,
                    sourceProductId: line.productId,
                    sourceCostLayerId: entry.costLayerId,
                    qty: entryQty.toFixed(6),
                    unitCostBase,
                    totalCostBase: roundQuantity(multiplyMoney(entryQty, unitCostBase), 6).toFixed(6),
                  },
                })
              }
            }
          }
        }

        // Mark line as fully received regardless of which path got us here.
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { qtyReceived: qty },
        })
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
      action: 'received',
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

    await db.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED' } })
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
      action: 'cancelled',
      tag: 'stock',
      level: 'ERROR',
      description: e instanceof Error ? e.message : 'Failed to cancel transfer.',
    })

    return { message: 'Failed to cancel transfer.' }
  }
}
