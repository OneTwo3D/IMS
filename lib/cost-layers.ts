/**
 * Shared FIFO cost layer helpers.
 *
 * These are used by stock adjustments, transfers, manufacturing, and any
 * other path that needs to consume or create cost layers atomically.
 * All functions accept a Prisma TransactionClient so they can participate
 * in the caller's transaction.
 */

import type { Prisma } from '@/app/generated/prisma/client'

type TxClient = Prisma.TransactionClient

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/** Lock cost layer rows FOR UPDATE to prevent concurrent consumption. */
export async function lockCostLayers(tx: TxClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await tx.$executeRaw`SELECT id FROM cost_layers WHERE id = ANY(${ids}::text[]) FOR UPDATE`
}

// ---------------------------------------------------------------------------
// Consumption (negative adjustments, dispatches, transfers out)
// ---------------------------------------------------------------------------

export type ConsumedLayer = {
  costLayerId: string
  qty: number
  unitCostBase: number
}

/**
 * Consume FIFO layers oldest-first for the given product + warehouse.
 * Decrements `remainingQty` on each layer consumed.
 *
 * Returns the consumed entries (for snapshot/provenance) and total cost.
 * If layers are exhausted before `qty` is fully consumed, the shortfall
 * is returned in `remainingQty` — the caller decides whether to throw
 * or tolerate (e.g. adjustments tolerate, dispatches throw).
 */
export async function consumeFifoLayers(
  tx: TxClient,
  productId: string,
  warehouseId: string,
  qty: number,
): Promise<{ consumed: ConsumedLayer[]; totalCost: number; remainingQty: number }> {
  let remaining = qty
  let totalCost = 0
  const consumed: ConsumedLayer[] = []

  const layers = await tx.costLayer.findMany({
    where: { productId, warehouseId, remainingQty: { gt: 0 } },
    select: { id: true, remainingQty: true, unitCostBase: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  })
  await lockCostLayers(tx, layers.map((l) => l.id))

  for (const layer of layers) {
    if (remaining <= 0) break
    const layerRemaining = Number(layer.remainingQty)
    const take = Math.min(remaining, layerRemaining)
    if (take <= 0) continue
    await tx.costLayer.update({
      where: { id: layer.id },
      data: { remainingQty: { decrement: take } },
    })
    const unitCost = Number(layer.unitCostBase)
    totalCost += take * unitCost
    consumed.push({ costLayerId: layer.id, qty: take, unitCostBase: unitCost })
    remaining -= take
  }

  return { consumed, totalCost, remainingQty: remaining }
}

/**
 * Consume FIFO layers and throw if layers are exhausted before qty is met.
 * Use this for dispatches and manufacturing where a shortfall is a hard error.
 */
export async function consumeFifoLayersStrict(
  tx: TxClient,
  productId: string,
  warehouseId: string,
  qty: number,
): Promise<{ consumed: ConsumedLayer[]; totalCost: number }> {
  const result = await consumeFifoLayers(tx, productId, warehouseId, qty)
  if (result.remainingQty > 0.0001) {
    throw new Error(
      `Insufficient FIFO layers for product ${productId} in warehouse ${warehouseId}: ` +
      `needed ${qty}, only ${qty - result.remainingQty} available in cost layers`,
    )
  }
  return { consumed: result.consumed, totalCost: result.totalCost }
}

// ---------------------------------------------------------------------------
// Creation (positive adjustments, receipts, transfers in)
// ---------------------------------------------------------------------------

/**
 * Compute weighted average unit cost from existing FIFO layers.
 * Returns 0 if no layers exist (new product / empty warehouse).
 */
export async function getAverageUnitCost(
  tx: TxClient,
  productId: string,
  warehouseId: string,
): Promise<number> {
  const layers = await tx.costLayer.findMany({
    where: { productId, warehouseId, remainingQty: { gt: 0 } },
    select: { remainingQty: true, unitCostBase: true },
  })
  let totalQty = 0
  let totalValue = 0
  for (const l of layers) {
    const qty = Number(l.remainingQty)
    totalQty += qty
    totalValue += qty * Number(l.unitCostBase)
  }
  return totalQty > 0 ? totalValue / totalQty : 0
}

/**
 * Create a new cost layer. Used for positive adjustments (at average cost),
 * transfer receipts (at source layer cost), and production output.
 */
export async function createCostLayer(
  tx: TxClient,
  data: {
    productId: string
    warehouseId: string
    qty: number
    unitCostBase: number
    poLineId?: string
    isOpeningStock?: boolean
    receivedAt?: Date
  },
): Promise<string> {
  const layer = await tx.costLayer.create({
    data: {
      productId: data.productId,
      warehouseId: data.warehouseId,
      receivedQty: data.qty,
      remainingQty: data.qty,
      unitCostBase: Math.round(data.unitCostBase * 1000000) / 1000000,
      poLineId: data.poLineId ?? null,
      isOpeningStock: data.isOpeningStock ?? false,
      ...(data.receivedAt ? { receivedAt: data.receivedAt } : {}),
    },
    select: { id: true },
  })
  return layer.id
}
