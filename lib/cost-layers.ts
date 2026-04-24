/**
 * Shared FIFO cost layer helpers.
 *
 * These are used by stock adjustments, transfers, manufacturing, and any
 * other path that needs to consume or create cost layers atomically.
 * All functions accept a Prisma TransactionClient so they can participate
 * in the caller's transaction.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { parseCostLayerSnapshot, sumCostLayerSnapshot } from '@/lib/cost-layer-snapshots'

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

export type CostLayerSourceLineInput = {
  sourceProductId: string
  sourceCostLayerId?: string | null
  qty: number
  unitCostBase: number
  totalCostBase?: number
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

  const candidateLayers = await tx.costLayer.findMany({
    where: { productId, warehouseId, remainingQty: { gt: 0 } },
    select: { id: true, remainingQty: true, unitCostBase: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  })
  await lockCostLayers(tx, candidateLayers.map((l) => l.id))

  // Re-read after taking row locks so concurrent consumers cannot both act on
  // the same pre-lock remainingQty snapshot and double-decrement a layer.
  const layers = candidateLayers.length === 0
    ? []
    : await tx.costLayer.findMany({
        where: { id: { in: candidateLayers.map((layer) => layer.id) } },
        select: { id: true, remainingQty: true, unitCostBase: true },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      })

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

export async function getHistoricalAverageUnitCost(
  tx: TxClient,
  productId: string,
): Promise<number> {
  const layers = await tx.costLayer.findMany({
    where: { productId },
    select: { receivedQty: true, unitCostBase: true },
  })
  let totalQty = 0
  let totalValue = 0
  for (const layer of layers) {
    const qty = Number(layer.receivedQty)
    if (!Number.isFinite(qty) || qty <= 0) continue
    totalQty += qty
    totalValue += qty * Number(layer.unitCostBase)
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
    adjustmentMovementId?: string
    productionOrderId?: string
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
      adjustmentMovementId: data.adjustmentMovementId ?? null,
      productionOrderId: data.productionOrderId ?? null,
      isOpeningStock: data.isOpeningStock ?? false,
      ...(data.receivedAt ? { receivedAt: data.receivedAt } : {}),
    },
    select: { id: true },
  })
  return layer.id
}

export async function addCostLayerSourceLines(
  tx: TxClient,
  costLayerId: string,
  lines: CostLayerSourceLineInput[],
): Promise<number> {
  const validLines = lines
    .filter((line) => (
      line.sourceProductId &&
      Number.isFinite(line.qty) &&
      line.qty > 0 &&
      Number.isFinite(line.unitCostBase)
    ))
    .map((line) => ({
      costLayerId,
      sourceProductId: line.sourceProductId,
      sourceCostLayerId: line.sourceCostLayerId ?? null,
      qty: Math.round(line.qty * 10000) / 10000,
      unitCostBase: Math.round(line.unitCostBase * 1000000) / 1000000,
      totalCostBase: Math.round(((line.totalCostBase ?? (line.qty * line.unitCostBase)) * 1000000)) / 1000000,
    }))

  if (validLines.length === 0) return 0
  const result = await tx.costLayerSourceLine.createMany({
    data: validLines,
  })
  return result.count
}

export async function copyCostLayerSourceLinesProportionally(
  tx: TxClient,
  fromCostLayerId: string,
  toCostLayerId: string,
  copiedQty: number,
): Promise<number> {
  if (!Number.isFinite(copiedQty) || copiedQty <= 0) return 0

  const sourceLayer = await tx.costLayer.findUnique({
    where: { id: fromCostLayerId },
    select: {
      receivedQty: true,
      sourceLines: {
        select: {
          sourceProductId: true,
          sourceCostLayerId: true,
          qty: true,
          unitCostBase: true,
          totalCostBase: true,
        },
      },
    },
  })
  if (!sourceLayer || sourceLayer.sourceLines.length === 0) return 0

  const sourceReceivedQty = Number(sourceLayer.receivedQty)
  if (!Number.isFinite(sourceReceivedQty) || sourceReceivedQty <= 0) return 0

  const rawRatio = copiedQty / sourceReceivedQty
  const ratio = Math.min(1, rawRatio)
  if (ratio <= 0) return 0
  if (rawRatio > 1.000001) {
    console.warn(
      `copyCostLayerSourceLinesProportionally capped ratio at 1 for ${fromCostLayerId} -> ${toCostLayerId} ` +
      `(copiedQty=${copiedQty}, sourceReceivedQty=${sourceReceivedQty})`,
    )
  }

  return addCostLayerSourceLines(
    tx,
    toCostLayerId,
    sourceLayer.sourceLines.map((line) => ({
      sourceProductId: line.sourceProductId,
      sourceCostLayerId: line.sourceCostLayerId,
      qty: Number(line.qty) * ratio,
      unitCostBase: Number(line.unitCostBase),
      totalCostBase: Number(line.totalCostBase) * ratio,
    })),
  )
}

// ---------------------------------------------------------------------------
// Snapshot correction (retrospective landed cost adjustments)
// ---------------------------------------------------------------------------

/**
 * When a cost layer's unitCostBase changes (e.g. landed cost arrives late),
 * all frozen costLayerSnapshot JSON entries referencing that layer must be
 * updated to reflect the new cost. Otherwise future refund reversals and
 * accounting reads will use the stale pre-adjustment cost.
 *
 * Updates snapshots on: ShipmentLine, OrderAllocation, SalesOrderRefundLine,
 * StockTransferLine — every model that carries a costLayerSnapshot.
 */
export async function updateSnapshotsForCostLayerChange(
  tx: TxClient,
  costLayerId: string,
  newUnitCostBase: number,
): Promise<number> {
  // PostgreSQL jsonb_set can't easily iterate arrays. Use a raw UPDATE
  // that rewrites the unitCostBase for every matching array element.
  // The query: for each row whose costLayerSnapshot contains an entry
  // with the given costLayerId, update that entry's unitCostBase.
  //
  // We use a CTE approach: load matching rows, rewrite the JSON array
  // in application code, and update back. This is simpler and safer
  // than raw jsonb manipulation for nested array-of-objects.

  let updated = 0

  const tables = [
    { model: 'shipment_lines' },
    { model: 'order_allocations' },
    { model: 'sales_order_refund_lines' },
    { model: 'stock_transfer_lines' },
  ] as const
  const containsCostLayer = JSON.stringify([{ costLayerId }])

  for (const table of tables) {
    // Find rows whose snapshot JSON mentions this cost layer id
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; costLayerSnapshot: unknown }>>(
      `SELECT id, "costLayerSnapshot" FROM "${table.model}" WHERE "costLayerSnapshot" @> $1::jsonb`,
      containsCostLayer,
    )

    for (const row of rows) {
      if (!Array.isArray(row.costLayerSnapshot)) continue
      let changed = false
      const patched = (row.costLayerSnapshot as Array<Record<string, unknown>>).map((entry) => {
        if (entry.costLayerId === costLayerId && entry.unitCostBase !== newUnitCostBase) {
          changed = true
          return { ...entry, unitCostBase: newUnitCostBase }
        }
        return entry
      })
      if (changed) {
        await tx.$executeRawUnsafe(
          `UPDATE "${table.model}" SET "costLayerSnapshot" = $1::jsonb WHERE id = $2`,
          JSON.stringify(patched),
          row.id,
        )
        updated++
      }
    }
  }

  return updated
}

/**
 * Sum physically returned quantity for a cost layer by reading refund-line
 * snapshots on refunds that actually returned stock to a warehouse.
 */
export async function getReturnedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<number> {
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const rows = await tx.$queryRawUnsafe<Array<{ costLayerSnapshot: unknown }>>(
    `SELECT srl."costLayerSnapshot"
       FROM "sales_order_refund_lines" srl
       INNER JOIN "sales_order_refunds" sr ON sr.id = srl."refundId"
      WHERE sr."returnWarehouseId" IS NOT NULL
        AND srl."costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )

  let returnedQty = 0
  for (const row of rows) {
    for (const entry of parseCostLayerSnapshot(row.costLayerSnapshot)) {
      if (entry.costLayerId === costLayerId) {
        returnedQty += entry.qty
      }
    }
  }

  return returnedQty
}

/**
 * Sum stock returned to suppliers for a cost layer. Supplier returns consume
 * FIFO layers but are not customer COGS, so landed-cost recalculation must
 * exclude them from retrospective COGS deltas.
 */
export async function getSupplierReturnedQtyForCostLayer(
  tx: TxClient,
  costLayerId: string,
): Promise<number> {
  const rows = await tx.cogsEntry.findMany({
    where: {
      costLayerId,
      movement: { referenceType: 'PurchaseReturn' },
    },
    select: { qty: true },
  })
  return rows.reduce((sum, row) => sum + Number(row.qty), 0)
}

/**
 * Recompute stored shipment-level COGS for any shipment whose line snapshots
 * reference the changed cost layer. This keeps shipment COGS aligned with
 * retrospective landed-cost changes, including shipments already journaled.
 */
export async function refreshShipmentCogsForCostLayerChange(
  tx: TxClient,
  costLayerId: string,
): Promise<number> {
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const shipments = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT "shipmentId" AS id FROM "shipment_lines" WHERE "costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )

  let updated = 0
  for (const shipment of shipments) {
    const lines = await tx.shipmentLine.findMany({
      where: { shipmentId: shipment.id },
      select: { costLayerSnapshot: true },
    })
    const cogs = Math.round(lines.reduce((sum, line) => (
      sum + sumCostLayerSnapshot(parseCostLayerSnapshot(line.costLayerSnapshot))
    ), 0) * 100) / 100
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { cogsBatchAmount: cogs },
    })
    updated++
  }

  return updated
}

export async function refreshSalesOrderLineCogs(
  tx: TxClient,
  lineIds: string[],
): Promise<number> {
  const uniqueLineIds = [...new Set(lineIds)]
  if (uniqueLineIds.length === 0) return 0

  const shipmentLines = await tx.shipmentLine.findMany({
    where: { lineId: { in: uniqueLineIds } },
    select: { lineId: true, costLayerSnapshot: true },
  })

  const cogsByLineId = new Map<string, number>()
  const hasSnapshotByLineId = new Map<string, boolean>()
  const shipmentLineCountByLineId = new Map<string, number>()
  for (const shipmentLine of shipmentLines) {
    const snapshot = parseCostLayerSnapshot(shipmentLine.costLayerSnapshot)
    shipmentLineCountByLineId.set(
      shipmentLine.lineId,
      (shipmentLineCountByLineId.get(shipmentLine.lineId) ?? 0) + 1,
    )
    cogsByLineId.set(
      shipmentLine.lineId,
      (cogsByLineId.get(shipmentLine.lineId) ?? 0)
        + sumCostLayerSnapshot(snapshot),
    )
    if (snapshot.length > 0) {
      hasSnapshotByLineId.set(shipmentLine.lineId, true)
    }
  }

  let updated = 0
  for (const lineId of uniqueLineIds) {
    const cogs = cogsByLineId.get(lineId)
    const hasShipmentLines = (shipmentLineCountByLineId.get(lineId) ?? 0) > 0
    if (hasShipmentLines && !hasSnapshotByLineId.get(lineId)) {
      // Legacy shipped lines may pre-date shipment FIFO snapshots. Preserve
      // their existing COGS instead of nulling historical margin during a
      // retrospective landed-cost refresh.
      continue
    }
    await tx.salesOrderLine.update({
      where: { id: lineId },
      data: {
        cogsBase: cogs == null || !hasSnapshotByLineId.get(lineId)
          ? null
          : Math.round(cogs * 10000) / 10000,
      },
    })
    updated++
  }

  return updated
}

export async function refreshSalesOrderLineCogsForCostLayerChange(
  tx: TxClient,
  costLayerId: string,
): Promise<number> {
  const containsCostLayer = JSON.stringify([{ costLayerId }])
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT "lineId" AS id FROM "shipment_lines" WHERE "costLayerSnapshot" @> $1::jsonb`,
    containsCostLayer,
  )
  return refreshSalesOrderLineCogs(tx, rows.map((row) => row.id))
}
