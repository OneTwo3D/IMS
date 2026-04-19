'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { enqueueStockSync } from '@/lib/shopping'
import { isOperationalProductStatus } from '@/lib/products/lifecycle'
import {
  consumeFifoLayers,
  copyCostLayerSourceLinesProportionally,
  createCostLayer,
  type ConsumedLayer,
} from '@/lib/cost-layers'

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
    // Validate stock availability at source warehouse
    for (const line of validLines) {
      const level = await db.stockLevel.findUnique({
        where: { productId_warehouseId: { productId: line.productId, warehouseId: fromWarehouseId } },
        select: { quantity: true, reservedQty: true },
      })
      const available = level ? Number(level.quantity) - Number(level.reservedQty) : 0
      if (available < line.qty) {
        return { message: `Insufficient stock for ${line.sku}: ${available} available, ${line.qty} requested` }
      }
    }

    const transfer = await db.stockTransfer.create({
      data: {
        reference: makeReference(),
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

    return { message: 'Failed to create transfer.' }
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

    return { message: 'Failed to update transfer.' }
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
      if (transfer.status !== 'DRAFT') throw new Error('Transfer is not in DRAFT status')

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
        const qty = Number(line.qty)
        await tx.stockMovement.create({
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
        })
        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId: line.productId, warehouseId: transfer.fromWarehouseId } },
          create: { productId: line.productId, warehouseId: transfer.fromWarehouseId, quantity: `-${qty}` },
          update: { quantity: { decrement: qty } },
        })

        // Consume FIFO layers from source warehouse — tolerant mode
        // (legacy stock may not have layers). Store consumed entries on
        // the transfer line so receiveTransfer can split/recreate them.
        const { consumed } = await consumeFifoLayers(tx, line.productId, transfer.fromWarehouseId, qty)
        if (consumed.length > 0) {
          await tx.stockTransferLine.update({
            where: { id: line.id },
            data: {
              costLayerSnapshot: consumed.map((c) => ({
                costLayerId: c.costLayerId,
                qty: c.qty,
                unitCostBase: c.unitCostBase,
              })),
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
    })

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')

    const dispatched = await db.stockTransfer.findUnique({
      where: { id },
      select: { reference: true, fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } }, lines: { select: { id: true } } },
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
    try {
      const transferProducts = await db.stockTransferLine.findMany({
        where: { transferId: id },
        select: { productId: true },
      })
      await enqueueStockSync(
        [...new Set(transferProducts.map((line) => line.productId))],
        'IMS_CHANGE',
      )
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to dispatch transfer.'

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
      if (transfer.status !== 'IN_TRANSIT') throw new Error('Transfer is not IN_TRANSIT')

      // Load cost layer snapshots stored at dispatch time
      const linesWithSnapshots = await tx.stockTransferLine.findMany({
        where: { transferId: id },
        select: { id: true, productId: true, costLayerSnapshot: true },
      })
      const snapshotByLineId = new Map(linesWithSnapshots.map((l) => [l.id, l.costLayerSnapshot]))

      for (const line of transfer.lines) {
        const qty = Number(line.qty)
        await tx.stockMovement.create({
          data: {
            type: 'TRANSFER_IN',
            productId: line.productId,
            fromWarehouseId: null,
            toWarehouseId: transfer.toWarehouseId,
            qty: qty.toString(),
            note: `Transfer ${transfer.reference} received`,
            referenceType: 'StockTransfer',
            referenceId: id,
          },
        })
        await tx.stockLevel.upsert({
          where: { productId_warehouseId: { productId: line.productId, warehouseId: transfer.toWarehouseId } },
          create: { productId: line.productId, warehouseId: transfer.toWarehouseId, quantity: qty.toString() },
          update: { quantity: { increment: qty } },
        })

        // Recreate FIFO layers at the destination warehouse from the
        // snapshot stored at dispatch. Each consumed source layer becomes
        // a new destination layer with the same unitCostBase, preserving
        // FIFO provenance across warehouses.
        const snapshot = snapshotByLineId.get(line.id)
        if (Array.isArray(snapshot) && snapshot.length > 0) {
          for (const entry of snapshot as ConsumedLayer[]) {
            if (entry.qty > 0 && entry.unitCostBase >= 0) {
              const newLayerId = await createCostLayer(tx, {
                productId: line.productId,
                warehouseId: transfer.toWarehouseId,
                qty: entry.qty,
                unitCostBase: entry.unitCostBase,
              })
              await copyCostLayerSourceLinesProportionally(tx, entry.costLayerId, newLayerId, entry.qty)
            }
          }
        }

        // Mark line as fully received
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
    })

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
    try {
      const transferProducts = await db.stockTransferLine.findMany({
        where: { transferId: id },
        select: { productId: true },
      })
      await enqueueStockSync(
        [...new Set(transferProducts.map((line) => line.productId))],
        'IMS_CHANGE',
      )
    } catch (syncError) {
      console.error(syncError)
    }

    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to receive transfer.'

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
    if (existing.status !== 'DRAFT') return { message: 'Only draft transfers can be cancelled.' }

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
