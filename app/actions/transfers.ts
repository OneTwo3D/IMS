'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'

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
  if (fromWarehouseId === toWarehouseId) {
    return { message: 'Source and destination warehouses must be different.' }
  }
  const validLines = lines.filter((l) => l.qty > 0 && l.productId)
  if (validLines.length === 0) {
    return { message: 'Add at least one product with a quantity.' }
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
    return { success: true, transfer: await mapRow(transfer) }
  } catch (e) {
    console.error(e)
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
  if (fromWarehouseId === toWarehouseId) {
    return { message: 'Source and destination warehouses must be different.' }
  }
  const validLines = lines.filter((l) => l.qty > 0 && l.productId)
  if (validLines.length === 0) {
    return { message: 'Add at least one product with a quantity.' }
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
    return { success: true, transfer: await mapRow(updated) }
  } catch (e) {
    console.error(e)
    return { message: 'Failed to update transfer.' }
  }
}

// ---------------------------------------------------------------------------
// Dispatch (DRAFT → IN_TRANSIT): books stock out of source warehouse
// ---------------------------------------------------------------------------

export async function dispatchTransfer(id: string): Promise<TransferResult> {
  try {
    await db.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: { ...TRANSFER_SELECT, status: true },
      })
      if (!transfer) throw new Error('Transfer not found')
      if (transfer.status !== 'DRAFT') throw new Error('Transfer is not in DRAFT status')

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

      // Book stock out of source warehouse for each line
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
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: 'IN_TRANSIT', dispatchedAt: new Date() },
      })
    })

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')
    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to dispatch transfer.'
    return { message: msg }
  }
}

// ---------------------------------------------------------------------------
// Receive (IN_TRANSIT → RECEIVED): books stock into destination warehouse
// ---------------------------------------------------------------------------

export async function receiveTransfer(id: string): Promise<TransferResult> {
  try {
    await db.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        select: { ...TRANSFER_SELECT, status: true },
      })
      if (!transfer) throw new Error('Transfer not found')
      if (transfer.status !== 'IN_TRANSIT') throw new Error('Transfer is not IN_TRANSIT')

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
        // Mark line as fully received
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { qtyReceived: qty },
        })
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: 'RECEIVED', completedAt: new Date() },
      })
    })

    revalidatePath('/stock-control/transfers')
    revalidatePath('/inventory')
    return { success: true }
  } catch (e: unknown) {
    console.error(e)
    const msg = e instanceof Error ? e.message : 'Failed to receive transfer.'
    return { message: msg }
  }
}

// ---------------------------------------------------------------------------
// Cancel (DRAFT only)
// ---------------------------------------------------------------------------

export async function cancelTransfer(id: string): Promise<TransferResult> {
  try {
    const existing = await db.stockTransfer.findUnique({ where: { id }, select: { status: true } })
    if (!existing) return { message: 'Transfer not found.' }
    if (existing.status !== 'DRAFT') return { message: 'Only draft transfers can be cancelled.' }

    await db.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED' } })
    revalidatePath('/stock-control/transfers')
    return { success: true }
  } catch (e) {
    console.error(e)
    return { message: 'Failed to cancel transfer.' }
  }
}
