import { Prisma, type AccountingSyncType } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import type { AccountingSettings } from '@/lib/accounting'
import { copyCostLayerSourceLinesProportionally } from '@/lib/cost-layers'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  serializeCostLayerSnapshot,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { validateRefundSalesOrderStatusUpdate } from '@/lib/domain/workflows/action-guards'
import { isFullRefundAmount } from '@/lib/domain/sales/refund-thresholds'
import {
  isStockMovementIdempotencyConflict,
  refundInboundMovementKey,
  saleDispatchMovementKey,
} from '@/lib/domain/inventory/stock-movement-idempotency'
import { buildStockMovementValueFields } from '@/lib/domain/inventory/stock-movement-value'

export const REFUND_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
export const REFUND_ACCOUNTING_LOCK_KEY = 4_112_208_031

/**
 * Deliberate call-site boundary for this number-shaped refund service contract.
 * Do not treat this as Decimal-internal arithmetic.
 */
function refundBoundaryNumber(value: DecimalInput): number {
  return toDecimal(value).toNumber()
}

const REFUND_RETURN_SOURCE_ERROR_TAG = 'RefundReturnSourceError'

class RefundReturnSourceError extends Error {
  readonly _tag = REFUND_RETURN_SOURCE_ERROR_TAG

  constructor(message: string) {
    super(message)
    this.name = REFUND_RETURN_SOURCE_ERROR_TAG
  }
}

function isRefundReturnSourceError(error: unknown): error is Error {
  const seen = new WeakSet<object>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { _tag?: unknown; name?: unknown; cause?: unknown }
    if (candidate._tag === REFUND_RETURN_SOURCE_ERROR_TAG || candidate.name === REFUND_RETURN_SOURCE_ERROR_TAG) {
      return true
    }
    current = candidate.cause
  }
  return false
}

function refundReturnSourceErrorMessage(error: unknown): string {
  const seen = new WeakSet<object>()
  let current = error
  let fallbackMessage: string | null = null
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { _tag?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    const message = typeof candidate.message === 'string' && candidate.message.trim()
      ? candidate.message
      : null
    if ((candidate._tag === REFUND_RETURN_SOURCE_ERROR_TAG || candidate.name === REFUND_RETURN_SOURCE_ERROR_TAG) && message) {
      return message
    }
    fallbackMessage ??= message
    current = candidate.cause
  }
  return fallbackMessage ?? 'Refund return source validation failed'
}

export type RefundServiceClient = Prisma.TransactionClient | typeof db

type ShipmentLineCostSnapshotSource = {
  id: string
  costLayerSnapshot: Prisma.JsonValue | null
}

export type RefundReturnRow = {
  productId: string
  qty: number
  refundLineId?: string | null
  unitCostBase?: DecimalInput
  poLineId?: string | null
  sourceCostLayerId?: string | null
}

export type RefundRequestLine = {
  lineId?: string | null
  productId: string | null
  description: string
  qty: number
  totalForeign?: number | null
  totalBase: number
  lineKind?: 'sale' | 'shipping'
}

export type CreatedRefundLine = {
  id: string
  lineId: string | null
  productId: string | null
  description: string
  qty: number
  unitPriceForeign: number
  unitPriceBase: number
  totalForeign: number
  totalBase: number
  lineKind: 'sale' | 'shipping'
}

export type RefundAccountingSyncRequest = {
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  payload: Record<string, unknown>
  idempotencyKey?: string
}

export type CreateSalesOrderRefundResult =
  | { success: false; error: string }
  | {
      success: true
      orderId: string
      totalBase: number
      refundFxRate: number
      createdRefund: { id: string }
      createdRefundLines: CreatedRefundLine[]
      creditNoteNumber: string
      newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED'
      refundOrderRef: string
      so: {
        id: string
        externalOrderNumber: string | null
        orderNumber: string | null
        status: string
      }
      accountingSyncs: RefundAccountingSyncRequest[]
      accountingWarning?: string
      returnedRows: Array<{ productId: string; sku: string; qty: number }>
    }

export type RetrySalesOrderRefundAccountingResult =
  | { success: false; error: string }
  | {
      success: true
      orderId: string
      refundId: string
      refundOrderRef: string
      accountingSyncs: RefundAccountingSyncRequest[]
      returnedRows: Array<{ productId: string; sku: string; qty: number }>
    }

function canRunTransaction(
  client: RefundServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

async function runInTransaction<T>(
  client: RefundServiceClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return canRunTransaction(client)
    ? client.$transaction(callback, REFUND_TX_OPTIONS)
    : callback(client)
}

async function lockCostLayers(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "cost_layers" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`,
  )
}

function aggregateRefundReturnRows(
  rows: RefundReturnRow[],
): RefundReturnRow[] {
  const aggregated = new Map<string, RefundReturnRow>()

  for (const row of rows) {
    if (!row.productId || !Number.isFinite(row.qty) || row.qty <= 0) continue
    // Key by refundLineId when present so same-product refund lines keep
    // distinct movement keys; legacy callers without line ids retain the old
    // product-level aggregation behavior.
    const aggregateKey = refundReturnAggregateKey(row)
    const existing = aggregated.get(aggregateKey)
    if (existing) {
      if (existing.unitCostBase != null && row.unitCostBase != null) {
        const combinedQty = existing.qty + row.qty
        existing.unitCostBase = combinedQty > 0
          ? roundQuantity(
              toDecimal(existing.unitCostBase)
                .mul(existing.qty)
                .add(toDecimal(row.unitCostBase).mul(row.qty))
                .div(combinedQty),
              6,
            ).toFixed(6)
          : existing.unitCostBase
      } else if (existing.unitCostBase == null && row.unitCostBase != null) {
        existing.unitCostBase = row.unitCostBase
      }
      existing.qty += row.qty
      continue
    }
    aggregated.set(aggregateKey, { ...row })
  }

  return [...aggregated.values()]
}

// This key feeds SalesOrderRefund RETURN_INBOUND idempotency keys. Changing it
// requires considering existing stock_movements.idempotencyKey values.
function refundReturnAggregateKey(row: Pick<RefundReturnRow, 'productId' | 'refundLineId'>): string {
  return row.refundLineId ? `${row.productId}:${row.refundLineId}` : row.productId
}

async function getExistingCreditNoteNumberMax(
  tx: Prisma.TransactionClient,
  prefix: string,
): Promise<number> {
  const parseSuffix = (value: string | null): number => {
    if (!value?.startsWith(prefix)) return 0
    const suffix = value.slice(prefix.length)
    return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : 0
  }
  const rows = await tx.salesOrderRefund.findMany({
    where: { creditNoteNumber: { startsWith: prefix } },
    select: { creditNoteNumber: true },
  })
  return rows.reduce((max, row) => Math.max(max, parseSuffix(row.creditNoteNumber)), 0)
}

async function nextCreditNoteNumber(
  tx: Prisma.TransactionClient,
  params: { prefix: string; date?: Date },
): Promise<string> {
  const date = params.date ?? new Date()
  const year = date.getFullYear()
  const counterKey = `document_counter:credit_note:${year}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${counterKey}))`
  const row = await tx.setting.findUnique({
    where: { key: counterKey },
    select: { value: true },
  })
  const prefix = `${params.prefix}${year}-`
  const current = row?.value
    ? Number.parseInt(row.value, 10)
    : await getExistingCreditNoteNumberMax(tx, prefix)
  const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1
  await tx.setting.upsert({
    where: { key: counterKey },
    create: { key: counterKey, value: String(next) },
    update: { value: String(next) },
  })
  return `${params.prefix}${year}-${String(next).padStart(5, '0')}`
}

async function getShipmentLineCostSnapshot(
  tx: Prisma.TransactionClient,
  shipmentLine: ShipmentLineCostSnapshotSource,
): Promise<CostLayerSnapshotEntry[]> {
  const explicitSnapshot = parseCostLayerSnapshot(shipmentLine.costLayerSnapshot)
  if (explicitSnapshot.length > 0) return explicitSnapshot

  const movement = await tx.stockMovement.findUnique({
    where: { idempotencyKey: saleDispatchMovementKey(shipmentLine.id) },
    select: {
      cogsEntries: {
        orderBy: { createdAt: 'asc' },
        select: {
          costLayerId: true,
          qty: true,
          unitCostBase: true,
        },
      },
    },
  })
  return serializeCostLayerSnapshot(
    (movement?.cogsEntries ?? []).map((entry) => ({
      costLayerId: entry.costLayerId,
      qty: entry.qty,
      unitCostBase: entry.unitCostBase,
    })),
  )
}

async function buildRefundFallbackReturnRows(
  client: RefundServiceClient,
  orderId: string,
  lines: Array<RefundRequestLine | CreatedRefundLine>,
  excludeRefundId?: string,
): Promise<RefundReturnRow[]> {
  const order = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      lines: {
        select: {
          id: true,
          productId: true,
          description: true,
          qty: true,
        },
      },
      allocations: {
        select: {
          lineId: true,
          productId: true,
          qty: true,
        },
      },
      shipments: {
        where: { status: 'SHIPPED' },
        select: {
          lines: {
            select: {
              lineId: true,
              productId: true,
              qty: true,
            },
          },
        },
      },
      refunds: {
        where: { returnWarehouseId: { not: null } },
        select: {
          id: true,
          lines: {
            select: { productId: true, qty: true },
          },
        },
      },
    },
  })
  if (!order) return []

  const lineById = new Map(order.lines.map((line) => [line.id, line]))
  const lineCandidatesByProduct = new Map<string, typeof order.lines>()
  for (const line of order.lines) {
    if (!line.productId) continue
    const existing = lineCandidatesByProduct.get(line.productId) ?? []
    existing.push(line)
    lineCandidatesByProduct.set(line.productId, existing)
  }

  const sourceRowsByLine = new Map<string, Map<string, number>>()
  const addSourceQty = (lineId: string, productId: string, qty: number) => {
    if (!Number.isFinite(qty) || qty <= 0) return
    const byProduct = sourceRowsByLine.get(lineId) ?? new Map<string, number>()
    byProduct.set(productId, (byProduct.get(productId) ?? 0) + qty)
    sourceRowsByLine.set(lineId, byProduct)
  }

  for (const shipment of order.shipments) {
    for (const line of shipment.lines) {
      addSourceQty(line.lineId, line.productId, refundBoundaryNumber(line.qty))
    }
  }

  const priorReturnedByProduct = new Map<string, number>()
  for (const refund of order.refunds) {
    if (excludeRefundId && refund.id === excludeRefundId) continue
    for (const refundLine of refund.lines) {
      if (!refundLine.productId) continue
      priorReturnedByProduct.set(
        refundLine.productId,
        (priorReturnedByProduct.get(refundLine.productId) ?? 0) + refundBoundaryNumber(refundLine.qty),
      )
    }
  }

  const totalDispatchedByProduct = new Map<string, number>()
  for (const [, sourceRows] of sourceRowsByLine) {
    for (const [productId, qty] of sourceRows) {
      totalDispatchedByProduct.set(productId, (totalDispatchedByProduct.get(productId) ?? 0) + qty)
    }
  }

  const remainingReturnable = new Map<string, number>()
  for (const [productId, dispatched] of totalDispatchedByProduct) {
    const priorReturned = priorReturnedByProduct.get(productId) ?? 0
    remainingReturnable.set(productId, Math.max(0, dispatched - priorReturned))
  }

  return lines.flatMap((line) => {
    if (!line.productId || line.qty <= 0) return []
    const refundLineId = 'id' in line ? line.id : null

    const sourceLine = line.lineId
      ? lineById.get(line.lineId) ?? null
      : (lineCandidatesByProduct.get(line.productId) ?? []).find((candidate) => candidate.description === line.description)
        ?? (lineCandidatesByProduct.get(line.productId) ?? [])[0]
        ?? null

    if (!sourceLine) {
      throw new RefundReturnSourceError(
        `Cannot restock product ${line.productId} for refund: no matching sales order line exists on the original order.`,
      )
    }

    const sourceRows = sourceRowsByLine.get(sourceLine.id)
    const sourceLineQty = refundBoundaryNumber(sourceLine.qty)
    if (!sourceRows || sourceRows.size === 0 || !Number.isFinite(sourceLineQty) || sourceLineQty <= 0) {
      throw new RefundReturnSourceError(
        `Cannot restock product ${sourceLine.productId ?? line.productId} for refund: no shipment line exists on the original order. Process as cash-only or refund a shipped line.`,
      )
    }

    return [...sourceRows.entries()].flatMap(([productId, totalQty]) => {
      const perUnitQty = totalQty / sourceLineQty
      if (!Number.isFinite(perUnitQty) || perUnitQty <= 0) return []
      const rawReturnQty = perUnitQty * line.qty
      const available = Math.max(0, remainingReturnable.get(productId) ?? 0)
      const cappedQty = Math.min(rawReturnQty, available)
      remainingReturnable.set(productId, available - cappedQty)

      if (cappedQty <= 0) return []
      return [{ productId, qty: cappedQty, refundLineId }]
    })
  })
}

/**
 * Applies inbound stock for refund/restock rows.
 *
 * The returned rows describe the requested final returned state for the
 * aggregate, not necessarily writes performed by this call. If an idempotency
 * conflict proves a concurrent/replayed call already created the stock
 * movement, the row is still returned so callers can keep their existing
 * final-state contract. Downstream accounting must keep its own idempotency
 * guard and must not infer "new work was performed" from this return value.
 */
export async function applyReturnInboundStockTx(
  tx: Prisma.TransactionClient,
  params: {
    referenceType: string
    referenceId: string
    warehouseId: string
    rows: RefundReturnRow[]
    note: string
  },
): Promise<Array<{ productId: string; sku: string; qty: number }>> {
  const aggregatedRows = aggregateRefundReturnRows(params.rows)
  if (aggregatedRows.length === 0) return []

  const existingMovements = await tx.stockMovement.findMany({
    where: {
      type: 'RETURN_INBOUND',
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      toWarehouseId: params.warehouseId,
    },
    select: { productId: true, qty: true },
  })
  if (existingMovements.length > 0) {
    const productIds = [...new Set(existingMovements.map((movement) => movement.productId))]
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true },
    })
    const skuByProductId = new Map(products.map((product) => [product.id, product.sku]))
    return existingMovements.map((movement) => ({
      productId: movement.productId,
      sku: skuByProductId.get(movement.productId) ?? movement.productId,
      qty: refundBoundaryNumber(movement.qty),
    }))
  }

  const rowsByAggregateKey = new Map<string, RefundReturnRow[]>()
  for (const row of params.rows) {
    if (!row.productId || !Number.isFinite(row.qty) || row.qty <= 0) continue
    const key = refundReturnAggregateKey(row)
    const rows = rowsByAggregateKey.get(key) ?? []
    rows.push(row)
    rowsByAggregateKey.set(key, rows)
  }

  for (const row of aggregatedRows) {
    const idempotencyKey = row.refundLineId && params.referenceType === 'SalesOrderRefund'
      ? refundInboundMovementKey({
          refundId: params.referenceId,
          refundLineId: row.refundLineId,
          warehouseId: params.warehouseId,
        })
      : undefined
    const result = await createReturnInboundMovementAndCostLayersTx(tx, {
      movementRow: row,
      costLayerRows: rowsByAggregateKey.get(refundReturnAggregateKey(row)) ?? [],
      warehouseId: params.warehouseId,
      note: params.note,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      idempotencyKey,
    })
    if (result === 'duplicate') {
      await tx.activityLog.create({
        data: {
          entityType: 'SALES_ORDER',
          entityId: params.referenceId,
          action: 'refund_return_deduped',
          tag: 'sales',
          level: 'INFO',
          description: `Skipped duplicate refund return for product ${row.productId}`,
          metadata: {
            idempotencyKey,
            productId: row.productId,
            refundLineId: row.refundLineId ?? null,
            referenceType: params.referenceType,
            referenceId: params.referenceId,
          },
        },
      })
      continue
    }
  }

  const returnedProducts = await tx.product.findMany({
    where: { id: { in: aggregatedRows.map((row) => row.productId) } },
    select: { id: true, sku: true },
  })
  const skuByProductId = new Map(returnedProducts.map((product) => [product.id, product.sku]))

  return aggregatedRows.map((row) => ({
    productId: row.productId,
    sku: skuByProductId.get(row.productId) ?? row.productId,
    qty: row.qty,
  }))
}

async function createReturnInboundMovementAndCostLayersTx(
  tx: Prisma.TransactionClient,
  params: {
    movementRow: RefundReturnRow
    costLayerRows: RefundReturnRow[]
    warehouseId: string
    note: string
    referenceType: string
    referenceId: string
    idempotencyKey?: string
  },
): Promise<'created' | 'duplicate'> {
  try {
    await tx.stockMovement.create({
      data: {
        type: 'RETURN_INBOUND',
        productId: params.movementRow.productId,
        toWarehouseId: params.warehouseId,
        qty: params.movementRow.qty,
        ...buildStockMovementValueFields({
          qty: params.movementRow.qty,
          unitCostBase: params.movementRow.unitCostBase ?? 0,
        }),
        note: params.note,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      },
    })
  } catch (error) {
    if (!isStockMovementIdempotencyConflict(error)) throw error
    return 'duplicate'
  }

  await tx.stockLevel.upsert({
    where: {
      productId_warehouseId: {
        productId: params.movementRow.productId,
        warehouseId: params.warehouseId,
      },
    },
    create: {
      productId: params.movementRow.productId,
      warehouseId: params.warehouseId,
      quantity: params.movementRow.qty,
      reservedQty: 0,
    },
    update: { quantity: { increment: params.movementRow.qty } },
  })

  for (const row of params.costLayerRows) {
    if (row.unitCostBase == null || row.qty <= 0) continue
    const unitCostBase = roundQuantity(row.unitCostBase, 6)
    if (unitCostBase.lt(0)) continue
    const newLayer = await tx.costLayer.create({
      data: {
        productId: row.productId,
        warehouseId: params.warehouseId,
        receivedQty: row.qty,
        remainingQty: row.qty,
        unitCostBase: unitCostBase.toFixed(6),
        poLineId: row.poLineId ?? null,
      },
      select: { id: true },
    })
    if (row.sourceCostLayerId) {
      await copyCostLayerSourceLinesProportionally(tx, row.sourceCostLayerId, newLayer.id, row.qty)
    }
  }
  return 'created'
}

function consumeRefundLineQuantity(
  lineStates: Array<{
    id: string
    productId: string | null
    description: string
    qty: number
    totalBase: number
  }>,
  remainingShipped: Map<string, number>,
  remainingUnshipped: Map<string, number>,
  refundLine: {
    lineId?: string | null
    productId: string | null
    description: string
    qty: number
    totalBase: number
    unitPriceBase?: number | null
  },
): {
  shippedRevenue: number
  unshippedRevenue: number
  assignedRevenue: number
  lineAllocations: Array<{ lineId: string; shippedQty: number; unshippedQty: number }>
} {
  if (!refundLine.productId || refundLine.qty <= 0) {
    return {
      shippedRevenue: 0,
      unshippedRevenue: 0,
      assignedRevenue: 0,
      lineAllocations: [],
    }
  }

  let remainingQty = refundLine.qty
  let shippedRevenue = 0
  let unshippedRevenue = 0
  let assignedRevenue = 0
  const lineAllocations: Array<{ lineId: string; shippedQty: number; unshippedQty: number }> = []
  const refundUnitPrice = refundLine.unitPriceBase != null
    ? refundBoundaryNumber(refundLine.unitPriceBase)
    : (refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : null)

  const priceMatches = (unitRevenue: number, candidateUnitPrice: number | null): boolean => {
    if (candidateUnitPrice == null) return false
    return Math.abs(unitRevenue - candidateUnitPrice) < 0.0001
  }

  const matchingLines = lineStates
    .filter((line) => line.productId === refundLine.productId)
    .sort((a, b) => {
      const aLineMatch = refundLine.lineId != null && a.id === refundLine.lineId
      const bLineMatch = refundLine.lineId != null && b.id === refundLine.lineId
      if (aLineMatch !== bLineMatch) return aLineMatch ? -1 : 1

      const aUnitRevenue = a.qty > 0 ? a.totalBase / a.qty : 0
      const bUnitRevenue = b.qty > 0 ? b.totalBase / b.qty : 0
      const aPriceMatch = priceMatches(aUnitRevenue, refundUnitPrice)
      const bPriceMatch = priceMatches(bUnitRevenue, refundUnitPrice)
      if (aPriceMatch !== bPriceMatch) return aPriceMatch ? -1 : 1

      const aDescMatch = a.description === refundLine.description
      const bDescMatch = b.description === refundLine.description
      if (aDescMatch !== bDescMatch) return aDescMatch ? -1 : 1

      return 0
    })

  for (const line of matchingLines) {
    if (remainingQty <= 0 || line.qty <= 0) break

    const unitRevenue = line.totalBase / line.qty
    const shippedQtyAvailable = remainingShipped.get(line.id) ?? 0
    const shippedTake = Math.min(remainingQty, shippedQtyAvailable)
    if (shippedTake > 0) {
      const shippedValue = unitRevenue * shippedTake
      shippedRevenue += shippedValue
      assignedRevenue += shippedValue
      remainingQty -= shippedTake
      remainingShipped.set(line.id, shippedQtyAvailable - shippedTake)
      lineAllocations.push({ lineId: line.id, shippedQty: shippedTake, unshippedQty: 0 })
    }

    const unshippedQtyAvailable = remainingUnshipped.get(line.id) ?? 0
    const unshippedTake = Math.min(remainingQty, unshippedQtyAvailable)
    if (unshippedTake > 0) {
      const unshippedValue = unitRevenue * unshippedTake
      unshippedRevenue += unshippedValue
      assignedRevenue += unshippedValue
      remainingQty -= unshippedTake
      remainingUnshipped.set(line.id, unshippedQtyAvailable - unshippedTake)
      lineAllocations.push({ lineId: line.id, shippedQty: 0, unshippedQty: unshippedTake })
    }
  }

  return { shippedRevenue, unshippedRevenue, assignedRevenue, lineAllocations }
}

async function stageRefundAccountingReversals(
  client: RefundServiceClient,
  params: {
    orderId: string
    orderRef: string
    refundId: string
    refundLines: CreatedRefundLine[]
    returnWarehouseId?: string
    accountingSettings: AccountingSettings
    so: {
      unearnedRevenueAmount: Prisma.Decimal | number | string | null
    }
    newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED'
  },
): Promise<{
  accountingSyncs: RefundAccountingSyncRequest[]
  snapshotReturnRows: RefundReturnRow[] | null
}> {
  let snapshotReturnRows: RefundReturnRow[] | null = null
  const accountingSyncs: RefundAccountingSyncRequest[] = []
  const settings = params.accountingSettings
  const toNetRevenue = (amountBase: number): number => Math.round(amountBase * 100) / 100
  const refundRevenue = Math.round(params.refundLines.reduce((sum, line) => sum + toNetRevenue(line.totalBase), 0) * 100) / 100

  const reversalAmounts = await runInTransaction(client, async (tx) => {
    const orderAccounting = await tx.salesOrder.findUnique({
      where: { id: params.orderId },
      select: {
        allocations: {
          select: {
            id: true,
            lineId: true,
            warehouseId: true,
            costLayerSnapshot: true,
          },
        },
        lines: {
          select: {
            id: true,
            productId: true,
            description: true,
            qty: true,
            totalBase: true,
          },
        },
        shipments: {
          where: { shipmentJournalDate: { not: null } },
          select: {
            revenueRecognizedAmount: true,
            cogsBatchAmount: true,
            lines: {
              select: {
                id: true,
                lineId: true,
                qty: true,
                costLayerSnapshot: true,
              },
            },
          },
        },
        refunds: {
          where: { id: { not: params.refundId } },
          select: {
            id: true,
            lines: {
              select: {
                id: true,
                salesOrderLineId: true,
                productId: true,
                description: true,
                qty: true,
                totalBase: true,
                unitPriceBase: true,
                costLayerSnapshot: true,
              },
            },
          },
        },
      },
    })

    const priorReversals = await tx.accountingSyncLog.findMany({
      where: {
        connector: 'xero',
        OR: [
          { referenceType: 'SalesOrder', referenceId: params.orderId },
          {
            referenceType: 'SalesOrderRefund',
            referenceId: { in: (orderAccounting?.refunds ?? []).map((refund) => refund.id) },
          },
        ],
        type: { in: ['COGS_REVERSAL', 'UNEARNED_REV_REVERSAL'] },
        status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
      },
      select: { type: true, payload: true },
    })

    const shipmentLineSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
    for (const shipment of orderAccounting?.shipments ?? []) {
      for (const shipmentLine of shipment.lines) {
        shipmentLineSnapshots.set(
          shipmentLine.id,
          await getShipmentLineCostSnapshot(tx, shipmentLine),
        )
      }
    }

    const referencedCostLayerIds = Array.from(new Set([
      ...(orderAccounting?.allocations ?? []).flatMap((allocation) => (
        parseCostLayerSnapshot(allocation.costLayerSnapshot).map((entry) => entry.costLayerId)
      )),
      ...(orderAccounting?.shipments ?? []).flatMap((shipment) => (
        shipment.lines.flatMap((line) => (
          (shipmentLineSnapshots.get(line.id) ?? []).map((entry) => entry.costLayerId)
        ))
      )),
      ...(orderAccounting?.refunds ?? []).flatMap((refund) => (
        refund.lines.flatMap((line) => (
          parseCostLayerSnapshot(line.costLayerSnapshot).map((entry) => entry.costLayerId)
        ))
      )),
    ]))
    await lockCostLayers(tx, referencedCostLayerIds)
    const referencedCostLayers = referencedCostLayerIds.length > 0
      ? await tx.costLayer.findMany({
          where: { id: { in: referencedCostLayerIds } },
          select: { id: true, productId: true, poLineId: true, unitCostBase: true },
        })
      : []
    const productIdByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, layer.productId]))
    const poLineIdByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, layer.poLineId]))
    const currentUnitCostByCostLayerId = new Map(referencedCostLayers.map((layer) => [layer.id, refundBoundaryNumber(layer.unitCostBase)]))
    const refreshSnapshotCosts = (entries: CostLayerSnapshotEntry[]): CostLayerSnapshotEntry[] => (
      entries.map((entry) => ({
        ...entry,
        // Shipment/allocation snapshots prove which layer and quantity were
        // consumed. Refund valuation refreshes to the current layer cost so
        // returned stock matches its carrying value. Trade-off: if landed-cost
        // revaluation ran after shipment, reversed COGS differs from the
        // originally posted COGS by the revaluation delta; revisit if finance
        // requires per-shipment posted COGS reversal instead.
        unitCostBase: currentUnitCostByCostLayerId.get(entry.costLayerId) ?? entry.unitCostBase,
      }))
    )

    const extractPayloadAmount = (
      payload: unknown,
      accountCode: string,
    ): number => {
      const linesPayload = (payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
      if (!Array.isArray(linesPayload)) return 0
      return linesPayload.reduce((sum, line) => (
        line.accountCode === accountCode ? sum + refundBoundaryNumber(line.debit ?? 0) : sum
      ), 0)
    }

    const priorUnearnedReversed = priorReversals
      .filter((row) => row.type === 'UNEARNED_REV_REVERSAL')
      .reduce((sum, row) => sum + extractPayloadAmount(row.payload, settings.unearnedRevenueAccount), 0)

    const lineContexts = (orderAccounting?.lines ?? []).map((line) => ({
      id: line.id,
      productId: line.productId,
      description: line.description,
      qty: refundBoundaryNumber(line.qty),
      totalBase: refundBoundaryNumber(line.totalBase),
    }))

    const shippedQtyByLine = new Map<string, number>()
    let totalRecognized = 0

    for (const shipment of orderAccounting?.shipments ?? []) {
      totalRecognized += refundBoundaryNumber(shipment.revenueRecognizedAmount)
      for (const line of shipment.lines) {
        shippedQtyByLine.set(
          line.lineId,
          (shippedQtyByLine.get(line.lineId) ?? 0) + refundBoundaryNumber(line.qty),
        )
      }
    }

    const remainingShippedQtyByLine = new Map<string, number>()
    const remainingUnshippedQtyByLine = new Map<string, number>()

    for (const line of lineContexts) {
      const shippedQty = Math.min(line.qty, shippedQtyByLine.get(line.id) ?? 0)
      const unshippedQty = Math.max(0, line.qty - shippedQty)
      remainingShippedQtyByLine.set(line.id, shippedQty)
      remainingUnshippedQtyByLine.set(line.id, unshippedQty)
    }

    for (const priorRefund of orderAccounting?.refunds ?? []) {
      for (const priorRefundLine of priorRefund.lines) {
        consumeRefundLineQuantity(
          lineContexts,
          remainingShippedQtyByLine,
          remainingUnshippedQtyByLine,
          {
            lineId: priorRefundLine.salesOrderLineId,
            productId: priorRefundLine.productId,
            description: priorRefundLine.description,
            qty: refundBoundaryNumber(priorRefundLine.qty),
            totalBase: refundBoundaryNumber(priorRefundLine.totalBase),
            unitPriceBase: refundBoundaryNumber(priorRefundLine.unitPriceBase),
          },
        )
      }
    }

    let shippedQtyRevenue = 0
    let unshippedQtyRevenue = 0
    let nonQtyRevenue = 0
    const refundLayerSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
    const shipmentLineAvailability = new Map<string, CostLayerSnapshotEntry[]>()
    const allocationAvailability = new Map<string, CostLayerSnapshotEntry[]>()

    for (const shipment of orderAccounting?.shipments ?? []) {
      for (const shipmentLine of shipment.lines) {
        shipmentLineAvailability.set(
          shipmentLine.id,
          shipmentLineSnapshots.get(shipmentLine.id) ?? [],
        )
      }
    }

    for (const allocation of orderAccounting?.allocations ?? []) {
      allocationAvailability.set(
        allocation.id,
        parseCostLayerSnapshot(allocation.costLayerSnapshot),
      )
    }

    for (const shipment of orderAccounting?.shipments ?? []) {
      for (const shipmentLine of shipment.lines) {
        for (const entry of shipmentLineSnapshots.get(shipmentLine.id) ?? []) {
          if (!entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
          )
        }
      }
    }

    for (const priorRefund of orderAccounting?.refunds ?? []) {
      for (const priorRefundLine of priorRefund.lines) {
        for (const entry of parseCostLayerSnapshot(priorRefundLine.costLayerSnapshot)) {
          if (entry.source === 'shipment' && entry.shipmentLineId) {
            const available = shipmentLineAvailability.get(entry.shipmentLineId) ?? []
            shipmentLineAvailability.set(
              entry.shipmentLineId,
              reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
            )
          }
          if (entry.source === 'allocation' && entry.orderAllocationId) {
            const available = allocationAvailability.get(entry.orderAllocationId) ?? []
            allocationAvailability.set(
              entry.orderAllocationId,
              reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
            )
          }
        }
      }
    }

    const consumeShipmentCostForLine = (lineId: string, qty: number): CostLayerSnapshotEntry[] => {
      const matchingShipmentLines = (orderAccounting?.shipments ?? [])
        .flatMap((shipment) => shipment.lines)
        .filter((line) => line.lineId === lineId)
      if (matchingShipmentLines.length === 0) return []
      let remainingQty = qty
      const consumed: CostLayerSnapshotEntry[] = []
      for (const shipment of orderAccounting?.shipments ?? []) {
        for (const shipmentLine of shipment.lines) {
          if (shipmentLine.lineId !== lineId || remainingQty <= 0) continue
          const available = shipmentLineAvailability.get(shipmentLine.id) ?? []
          const taken = takeFromSnapshotEntries(available, remainingQty, {
            shipmentLineId: shipmentLine.id,
            source: 'shipment',
          })
          consumed.push(...refreshSnapshotCosts(taken.taken))
          remainingQty = taken.remainingQty
          shipmentLineAvailability.set(
            shipmentLine.id,
            reduceSnapshotByCostLayer(
              available,
              taken.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
            ),
          )
        }
      }
      if (remainingQty > 0.0000001) {
        throw new Error(
          `Cannot reverse COGS for refunded line ${lineId}: requested ${qty} unit(s) of shipment cost basis ` +
          `but only ${(qty - remainingQty).toFixed(4)} available across recorded shipments. ` +
          `This usually means the cost-layer snapshot is stale or was cleared between batch runs.`,
        )
      }
      return consumed
    }

    const consumeAllocationCostForLine = (lineId: string, qty: number): CostLayerSnapshotEntry[] => {
      const matchingAllocations = (orderAccounting?.allocations ?? [])
        .filter((allocation) => allocation.lineId === lineId)
      if (matchingAllocations.length === 0) return []
      let remainingQty = qty
      const consumed: CostLayerSnapshotEntry[] = []
      for (const allocation of orderAccounting?.allocations ?? []) {
        if (allocation.lineId !== lineId || remainingQty <= 0) continue
        const available = allocationAvailability.get(allocation.id) ?? []
        const taken = takeFromSnapshotEntries(available, remainingQty, {
          orderAllocationId: allocation.id,
          source: 'allocation',
        })
        consumed.push(...refreshSnapshotCosts(taken.taken))
        remainingQty = taken.remainingQty
        allocationAvailability.set(
          allocation.id,
          reduceSnapshotByCostLayer(
            available,
            taken.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
          ),
        )
      }
      if (remainingQty > 0.0000001) {
        throw new Error(
          `Cannot reverse COGS for refunded line ${lineId}: requested ${qty} unit(s) of allocation cost basis ` +
          `but only ${(qty - remainingQty).toFixed(4)} available across recorded allocations. ` +
          `This usually means the cost-layer snapshot is stale or was cleared between batch runs.`,
        )
      }
      return consumed
    }

    for (const refundLine of params.refundLines) {
      const refundLineNet = toNetRevenue(refundLine.totalBase)
      if (!refundLine.productId || refundLine.qty <= 0) {
        nonQtyRevenue += refundLineNet
        continue
      }

      const allocation = consumeRefundLineQuantity(
        lineContexts,
        remainingShippedQtyByLine,
        remainingUnshippedQtyByLine,
        refundLine,
      )
      shippedQtyRevenue += allocation.shippedRevenue
      unshippedQtyRevenue += allocation.unshippedRevenue

      const costSnapshot: CostLayerSnapshotEntry[] = []
      for (const lineAllocation of allocation.lineAllocations) {
        if (lineAllocation.shippedQty > 0) {
          costSnapshot.push(...consumeShipmentCostForLine(lineAllocation.lineId, lineAllocation.shippedQty))
        }
        if (lineAllocation.unshippedQty > 0) {
          costSnapshot.push(...consumeAllocationCostForLine(lineAllocation.lineId, lineAllocation.unshippedQty))
        }
      }
      refundLayerSnapshots.set(refundLine.id, costSnapshot)
      nonQtyRevenue += Math.max(0, refundLineNet - allocation.assignedRevenue)
    }

    const componentTotal = shippedQtyRevenue + unshippedQtyRevenue + nonQtyRevenue
    const roundingDelta = Math.round((refundRevenue - componentTotal) * 100) / 100
    if (roundingDelta > 0) {
      nonQtyRevenue += roundingDelta
    }

    for (const refundLine of params.refundLines) {
      const costSnapshot = refundLayerSnapshots.get(refundLine.id) ?? []
      await tx.salesOrderRefundLine.update({
        where: { id: refundLine.id },
        data: {
          costLayerSnapshot: serializeCostLayerSnapshot(costSnapshot) as never,
        },
      })
    }

    if (params.returnWarehouseId) {
      snapshotReturnRows = params.refundLines.flatMap((refundLine) => (
        (refundLayerSnapshots.get(refundLine.id) ?? []).flatMap((entry) => {
          if (entry.source !== 'shipment') return []
          const productId = productIdByCostLayerId.get(entry.costLayerId)
          if (!productId) return []
          return [{
            productId,
            qty: refundBoundaryNumber(entry.qty),
            refundLineId: refundLine.id,
            unitCostBase: entry.unitCostBase,
            poLineId: poLineIdByCostLayerId.get(entry.costLayerId) ?? null,
            sourceCostLayerId: entry.costLayerId,
          }]
        })
      ))
    }

    const remainingUnearned = Math.round(Math.max(
      0,
      refundBoundaryNumber(params.so.unearnedRevenueAmount) - totalRecognized - priorUnearnedReversed,
    ) * 100) / 100
    const shipmentRefundSnapshot = params.refundLines.flatMap((line) => (
      (refundLayerSnapshots.get(line.id) ?? []).filter((entry) => entry.source === 'shipment')
    ))
    const allocationRefundSnapshot = params.refundLines.flatMap((line) => (
      (refundLayerSnapshots.get(line.id) ?? []).filter((entry) => entry.source === 'allocation')
    ))

    if (params.newStatus === 'REFUNDED') {
      await tx.salesOrder.update({
        where: { id: params.orderId },
        data: {
          revenueDeferredDate: null,
          inventoryAllocatedDate: null,
        },
      })
    }

    return {
      cogsReversal: roundQuantity(sumCostLayerSnapshot(shipmentRefundSnapshot), 2).toNumber(),
      unearnedReversal: Math.min(
        remainingUnearned,
        Math.round((unshippedQtyRevenue + nonQtyRevenue) * 100) / 100,
      ),
      allocationReversal: roundQuantity(sumCostLayerSnapshot(allocationRefundSnapshot), 2).toNumber(),
    }
  })

  if (reversalAmounts.cogsReversal > 0) {
    accountingSyncs.push({
      type: 'COGS_REVERSAL',
      referenceType: 'SalesOrderRefund',
      referenceId: params.refundId,
      idempotencyKey: `sales-order-refund:${params.refundId}:cogs-reversal`,
      payload: {
        date: new Date().toISOString().slice(0, 10),
        reference: `COGS reversal: ${params.orderRef}`,
        narration: `COGS reversal — refund on order ${params.orderRef}`,
        lines: [
          { accountCode: settings.inventoryAccount, description: `COGS reversal: ${params.orderRef}`, debit: reversalAmounts.cogsReversal },
          { accountCode: settings.cogsAccount, description: `COGS reversal: ${params.orderRef}`, credit: reversalAmounts.cogsReversal },
        ],
      },
    })
  }

  const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []
  if (reversalAmounts.unearnedReversal > 0) {
    journalLines.push(
      { accountCode: settings.unearnedRevenueAccount, description: `Unearned revenue reversal: ${params.orderRef}`, debit: reversalAmounts.unearnedReversal },
      { accountCode: settings.salesAccount, description: `Unearned revenue reversal: ${params.orderRef}`, credit: reversalAmounts.unearnedReversal },
    )
  }
  if (reversalAmounts.allocationReversal > 0) {
    journalLines.push(
      { accountCode: settings.inventoryAccount, description: `Allocation reversal: ${params.orderRef}`, debit: reversalAmounts.allocationReversal },
      { accountCode: settings.allocatedInventoryAccount, description: `Allocation reversal: ${params.orderRef}`, credit: reversalAmounts.allocationReversal },
    )
  }

  if (journalLines.length > 0) {
    const hasInventoryReversal = reversalAmounts.allocationReversal > 0
    accountingSyncs.push({
      type: 'UNEARNED_REV_REVERSAL',
      referenceType: 'SalesOrderRefund',
      referenceId: params.refundId,
      idempotencyKey: `sales-order-refund:${params.refundId}:unearned-reversal`,
      payload: {
        date: new Date().toISOString().slice(0, 10),
        reference: `Unearned reversal: ${params.orderRef}`,
        narration: hasInventoryReversal
          ? `Unearned revenue + allocation reversal — refund on order ${params.orderRef}`
          : `Unearned revenue reversal — refund on order ${params.orderRef}`,
        lines: journalLines,
      },
    })
  }

  return { accountingSyncs, snapshotReturnRows }
}

function formatRefundAccountingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function accountingWarningMessage(error: unknown): string {
  return `Refund was created, but accounting reversal staging failed: ${formatRefundAccountingError(error)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRefundAccountingRetrySyncs(
  value: Prisma.JsonValue | null | undefined,
): RefundAccountingSyncRequest[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.payload)) return []
    if (
      typeof entry.type !== 'string' ||
      typeof entry.referenceType !== 'string' ||
      typeof entry.referenceId !== 'string'
    ) {
      return []
    }
    return [{
      type: entry.type as AccountingSyncType,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      payload: entry.payload,
      idempotencyKey: typeof entry.idempotencyKey === 'string' ? entry.idempotencyKey : undefined,
    }]
  })
}

function refundAccountingSyncsJson(
  syncs: RefundAccountingSyncRequest[],
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (syncs.length === 0) return Prisma.DbNull
  return JSON.parse(JSON.stringify(syncs)) as Prisma.InputJsonValue
}

export async function createSalesOrderRefund(
  client: RefundServiceClient,
  input: {
    orderId: string
    lines: RefundRequestLine[]
    reason: string
    returnWarehouseId?: string
    externalRefundId?: number
    creditNotePrefix: string
    accountingSettings?: AccountingSettings | null
  },
): Promise<CreateSalesOrderRefundResult> {
  const refundLines = input.lines.filter((line) => line.qty > 0 || line.totalBase > 0)
  if (!refundLines.length) return { success: false, error: 'Select at least one line to refund' }

  const totalBase = refundLines.reduce((sum, line) => sum + line.totalBase, 0)
  const txResult = await runInTransaction(client, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_ACCOUNTING_LOCK_KEY})`
    await tx.$executeRaw`SELECT id FROM sales_orders WHERE id = ${input.orderId} FOR UPDATE`

    const so = await tx.salesOrder.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        externalOrderNumber: true,
        orderNumber: true,
        status: true,
        fxRateToBase: true,
        totalBase: true,
        taxRatePercent: true,
        pricesIncludeVat: true,
        revenueDeferredDate: true,
        unearnedRevenueAmount: true,
        inventoryAllocatedDate: true,
        allocationBatchAmount: true,
        lines: { select: { id: true, productId: true, qty: true } },
        shipments: {
          where: { status: 'SHIPPED' },
          select: { id: true },
        },
      },
    })
    if (!so) return { error: 'Order not found' } as const

    const fxRate = refundBoundaryNumber(so.fxRateToBase) || 1

    // External refund deliveries provide a stable replay key. Manual refunds
    // intentionally rely on the operator UI's double-submit guard instead of
    // inventing a synthetic service-level idempotency key.
    if (input.externalRefundId != null) {
      const existingExternalRefund = await tx.salesOrderRefund.findFirst({
        where: {
          orderId: input.orderId,
          externalRefundId: input.externalRefundId,
        },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          lines: {
            select: {
              id: true,
              salesOrderLineId: true,
              productId: true,
              description: true,
              qty: true,
              unitPriceForeign: true,
              unitPriceBase: true,
              totalForeign: true,
              totalBase: true,
            },
          },
        },
      })
      if (existingExternalRefund) {
        return {
          replay: true as const,
          so,
          fxRate,
          replayTotalBase: refundBoundaryNumber(existingExternalRefund.totalBase),
          createdRefund: { id: existingExternalRefund.id },
          createdRefundLines: existingExternalRefund.lines.map((line) => ({
            id: line.id,
            lineId: line.salesOrderLineId ?? null,
            productId: line.productId,
            description: line.description,
            qty: refundBoundaryNumber(line.qty),
            unitPriceForeign: refundBoundaryNumber(line.unitPriceForeign),
            unitPriceBase: refundBoundaryNumber(line.unitPriceBase),
            totalForeign: refundBoundaryNumber(line.totalForeign),
            totalBase: refundBoundaryNumber(line.totalBase),
            lineKind: line.salesOrderLineId == null ? 'shipping' as const : 'sale' as const,
          })),
          creditNoteNumber: existingExternalRefund.creditNoteNumber ?? '',
          newStatus: so.status === 'REFUNDED' ? 'REFUNDED' as const : 'PARTIALLY_REFUNDED' as const,
        }
      }
    }

    if (
      input.returnWarehouseId &&
      refundLines.some((refundLine) => refundLine.productId && refundLine.qty > 0) &&
      so.shipments.length === 0
    ) {
      return { error: 'Cannot return refunded stock before the order has shipped' } as const
    }

    const existingRefunds = await tx.salesOrderRefund.findMany({
      where: { orderId: input.orderId },
      select: { totalBase: true },
    })
    const previouslyRefunded = existingRefunds.reduce((sum, refund) => sum + refundBoundaryNumber(refund.totalBase), 0)
    if (totalBase + previouslyRefunded > refundBoundaryNumber(so.totalBase) * 1.001) {
      return { error: 'Refund total would exceed order total' } as const
    }

    const existingRefundLines = await tx.salesOrderRefundLine.findMany({
      where: { refund: { orderId: input.orderId } },
      select: { productId: true, qty: true },
    })
    const refundedQtyByProduct = new Map<string, number>()
    for (const refundLine of existingRefundLines) {
      if (!refundLine.productId) continue
      refundedQtyByProduct.set(
        refundLine.productId,
        (refundedQtyByProduct.get(refundLine.productId) ?? 0) + refundBoundaryNumber(refundLine.qty),
      )
    }
    const originalQtyByProduct = new Map<string, number>()
    for (const salesLine of so.lines) {
      if (!salesLine.productId) continue
      originalQtyByProduct.set(
        salesLine.productId,
        (originalQtyByProduct.get(salesLine.productId) ?? 0) + refundBoundaryNumber(salesLine.qty),
      )
    }
    const soLineProductIds = new Set(
      so.lines.map((salesLine) => salesLine.productId).filter((productId): productId is string => productId != null),
    )
    for (const refundLine of refundLines) {
      if (!refundLine.productId || refundLine.qty <= 0) continue
      if (!input.externalRefundId && !soLineProductIds.has(refundLine.productId)) {
        return {
          error: `Product ${refundLine.productId} is a kit component, not a sales line product. ` +
            'Refund the kit product instead — component stock will be returned proportionally.',
        } as const
      }
      const originalQty = originalQtyByProduct.get(refundLine.productId) ?? 0
      const alreadyRefunded = refundedQtyByProduct.get(refundLine.productId) ?? 0
      const remainingRefundable = originalQty - alreadyRefunded
      if (refundLine.qty > remainingRefundable + 0.001) {
        return { error: `Refund qty ${refundLine.qty} for product ${refundLine.productId} exceeds remaining refundable qty ${remainingRefundable.toFixed(2)}` } as const
      }
    }

    const totalForeign = Math.round(totalBase * fxRate * 10000) / 10000
    const creditNoteNumber = await nextCreditNoteNumber(tx, {
      prefix: input.creditNotePrefix,
    })

    const createdRefund = await tx.salesOrderRefund.create({
      data: {
        orderId: input.orderId,
        creditNoteNumber,
        externalRefundId: input.externalRefundId ?? null,
        reason: input.reason || null,
        totalForeign,
        totalBase,
        returnWarehouseId: input.returnWarehouseId || null,
      },
      select: { id: true },
    })

    const createdRefundLines: CreatedRefundLine[] = []
    for (const refundLine of refundLines) {
      const lineTotalForeign = refundLine.totalForeign != null
        ? Math.round(refundLine.totalForeign * 10000) / 10000
        : Math.round(refundLine.totalBase * fxRate * 10000) / 10000
      const createdLine = await tx.salesOrderRefundLine.create({
        data: {
          refundId: createdRefund.id,
          salesOrderLineId: refundLine.lineId ?? null,
          productId: refundLine.productId,
          description: refundLine.description,
          qty: refundLine.qty,
          unitPriceForeign: refundLine.qty > 0 ? lineTotalForeign / refundLine.qty : 0,
          unitPriceBase: refundLine.qty > 0 ? refundLine.totalBase / refundLine.qty : 0,
          totalForeign: lineTotalForeign,
          totalBase: refundLine.totalBase,
        },
        select: {
          id: true,
          salesOrderLineId: true,
          productId: true,
          description: true,
          qty: true,
          unitPriceForeign: true,
          unitPriceBase: true,
          totalForeign: true,
          totalBase: true,
        },
      })
      createdRefundLines.push({
        id: createdLine.id,
        lineId: createdLine.salesOrderLineId ?? null,
        productId: createdLine.productId,
        description: createdLine.description,
        qty: refundBoundaryNumber(createdLine.qty),
        unitPriceForeign: refundBoundaryNumber(createdLine.unitPriceForeign),
        unitPriceBase: refundBoundaryNumber(createdLine.unitPriceBase),
        totalForeign: refundBoundaryNumber(createdLine.totalForeign),
        totalBase: refundBoundaryNumber(createdLine.totalBase),
        lineKind: refundLine.lineKind === 'shipping' ? 'shipping' : 'sale',
      })
    }

    const totalRefundedNow = previouslyRefunded + totalBase
    const orderTotal = refundBoundaryNumber(so.totalBase)
    const newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED' = isFullRefundAmount(totalRefundedNow, orderTotal)
      ? 'REFUNDED'
      : 'PARTIALLY_REFUNDED'
    const refundTransition = validateRefundSalesOrderStatusUpdate(so.status, newStatus)
    if (!refundTransition.success) throw new Error(refundTransition.error)
    await tx.salesOrder.update({ where: { id: input.orderId }, data: { status: newStatus } })

    // Build fallback rows inside the refund transaction so source-stock errors
    // roll back the refund and its lines. Stock application remains in the
    // later return-stock transaction because accounting staging may provide a
    // fresher cost-layer snapshot; if that later step fails, the persisted
    // refund is retained and marked for accounting retry like other post-refund
    // side-effect failures.
    const fallbackReturnRows = input.returnWarehouseId
      ? await buildRefundFallbackReturnRows(tx, input.orderId, createdRefundLines, createdRefund.id)
      : []

    return {
      so,
      fxRate,
      createdRefund,
      createdRefundLines,
      creditNoteNumber,
      newStatus,
      fallbackReturnRows,
    }
  }).catch((error) => {
    if (isRefundReturnSourceError(error)) {
      return { error: refundReturnSourceErrorMessage(error) } as const
    }
    throw error
  })

  if ('error' in txResult) return { success: false, error: txResult.error ?? 'Refund failed' }

  const refundOrderRef = getSalesOrderReference(txResult.so)
  if ('replay' in txResult) {
    if (txResult.replayTotalBase == null) throw new Error('Refund replay result missing persisted total')
    return {
      success: true,
      orderId: input.orderId,
      totalBase: txResult.replayTotalBase,
      refundFxRate: txResult.fxRate,
      createdRefund: txResult.createdRefund,
      createdRefundLines: txResult.createdRefundLines,
      creditNoteNumber: txResult.creditNoteNumber,
      newStatus: txResult.newStatus,
      refundOrderRef,
      so: txResult.so,
      accountingSyncs: [],
      returnedRows: [],
    }
  }

  let accountingSyncs: RefundAccountingSyncRequest[] = []
  let accountingWarning: string | undefined
  let snapshotReturnRows: RefundReturnRow[] | null = null
  if (txResult.so.revenueDeferredDate && input.accountingSettings) {
    try {
      const staged = await stageRefundAccountingReversals(client, {
        orderId: input.orderId,
        orderRef: refundOrderRef,
        refundId: txResult.createdRefund.id,
        refundLines: txResult.createdRefundLines,
        returnWarehouseId: input.returnWarehouseId,
        accountingSettings: input.accountingSettings,
        so: txResult.so,
        newStatus: txResult.newStatus,
      })
      accountingSyncs = staged.accountingSyncs
      snapshotReturnRows = staged.snapshotReturnRows
      await client.salesOrderRefund.update({
        where: { id: txResult.createdRefund.id },
        data: {
          accountingRetrySyncs: refundAccountingSyncsJson(accountingSyncs),
        },
      })
    } catch (error) {
      accountingWarning = accountingWarningMessage(error)
      await client.salesOrderRefund.update({
        where: { id: txResult.createdRefund.id },
        data: {
          accountingRetryRequired: true,
          accountingWarning,
        },
      })
    }
  }

  let returnedRows: Array<{ productId: string; sku: string; qty: number }> = []
  if (input.returnWarehouseId && !accountingWarning) {
    const snapshotRows = snapshotReturnRows ?? []
    const returnRows = snapshotRows.length > 0
      ? snapshotRows
      : txResult.fallbackReturnRows

    returnedRows = await runInTransaction(client, (tx) => (
      applyReturnInboundStockTx(tx, {
        referenceType: 'SalesOrderRefund',
        referenceId: txResult.createdRefund.id,
        warehouseId: input.returnWarehouseId!,
        rows: returnRows,
        note: 'Refund return',
      })
    ))
  }

  return {
    success: true,
    orderId: input.orderId,
    totalBase,
    refundFxRate: txResult.fxRate,
    createdRefund: txResult.createdRefund,
    createdRefundLines: txResult.createdRefundLines,
    creditNoteNumber: txResult.creditNoteNumber,
    newStatus: txResult.newStatus,
    refundOrderRef,
    so: txResult.so,
    accountingSyncs,
    accountingWarning,
    returnedRows,
  }
}

export async function retrySalesOrderRefundAccounting(
  client: RefundServiceClient,
  input: {
    refundId: string
    accountingSettings: AccountingSettings
  },
): Promise<RetrySalesOrderRefundAccountingResult> {
  try {
    return await runInTransaction(client, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFUND_ACCOUNTING_LOCK_KEY})`

      const refund = await tx.salesOrderRefund.findUnique({
        where: { id: input.refundId },
        select: {
          id: true,
          orderId: true,
          returnWarehouseId: true,
          accountingRetryRequired: true,
          accountingRetrySyncs: true,
          order: {
            select: {
              id: true,
              externalOrderNumber: true,
              orderNumber: true,
              status: true,
              revenueDeferredDate: true,
              unearnedRevenueAmount: true,
            },
          },
          lines: {
            select: {
              id: true,
              salesOrderLineId: true,
              productId: true,
              description: true,
              qty: true,
              unitPriceForeign: true,
              unitPriceBase: true,
              totalForeign: true,
              totalBase: true,
            },
          },
        },
      })
      if (!refund) return { success: false, error: 'Refund not found' }
      if (!refund.accountingRetryRequired) {
        return { success: false, error: 'No failed refund accounting action is pending for this refund' }
      }
      const persistedSyncs = parseRefundAccountingRetrySyncs(refund.accountingRetrySyncs)
      if (persistedSyncs.length > 0) {
        return {
          success: true,
          orderId: refund.orderId,
          refundId: refund.id,
          refundOrderRef: getSalesOrderReference(refund.order),
          accountingSyncs: persistedSyncs,
          returnedRows: [],
        }
      }
      if (!refund.order.revenueDeferredDate) {
        return {
          success: true,
          orderId: refund.orderId,
          refundId: refund.id,
          refundOrderRef: getSalesOrderReference(refund.order),
          accountingSyncs: [],
          returnedRows: [],
        }
      }

      const refundOrderRef = getSalesOrderReference(refund.order)
      const refundLines: CreatedRefundLine[] = refund.lines.map((line) => ({
        id: line.id,
        lineId: line.salesOrderLineId,
        productId: line.productId,
        description: line.description,
        qty: refundBoundaryNumber(line.qty),
        unitPriceForeign: refundBoundaryNumber(line.unitPriceForeign),
        unitPriceBase: refundBoundaryNumber(line.unitPriceBase),
        totalForeign: refundBoundaryNumber(line.totalForeign),
        totalBase: refundBoundaryNumber(line.totalBase),
        lineKind: line.productId ? 'sale' : 'shipping',
      }))
      const newStatus = refund.order.status === 'REFUNDED' ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      const staged = await stageRefundAccountingReversals(tx, {
        orderId: refund.orderId,
        orderRef: refundOrderRef,
        refundId: refund.id,
        refundLines,
        returnWarehouseId: refund.returnWarehouseId ?? undefined,
        accountingSettings: input.accountingSettings,
        so: refund.order,
        newStatus,
      })

      let returnedRows: Array<{ productId: string; sku: string; qty: number }> = []
      if (refund.returnWarehouseId) {
        const snapshotRows = staged.snapshotReturnRows ?? []
        const returnRows = snapshotRows.length > 0
          ? snapshotRows
          : await buildRefundFallbackReturnRows(tx, refund.orderId, refundLines, refund.id)
        returnedRows = await applyReturnInboundStockTx(tx, {
          referenceType: 'SalesOrderRefund',
          referenceId: refund.id,
          warehouseId: refund.returnWarehouseId!,
          rows: returnRows,
          note: 'Refund return',
        })
      }
      await tx.salesOrderRefund.update({
        where: { id: refund.id },
        data: {
          accountingRetrySyncs: refundAccountingSyncsJson(staged.accountingSyncs),
        },
      })

      return {
        success: true,
        orderId: refund.orderId,
        refundId: refund.id,
        refundOrderRef,
        accountingSyncs: staged.accountingSyncs,
        returnedRows,
      }
    })
  } catch (error) {
    const warning = accountingWarningMessage(error)
    await client.salesOrderRefund.update({
      where: { id: input.refundId },
      data: {
        accountingRetryRequired: true,
        accountingWarning: warning,
      },
    })
    return { success: false, error: warning }
  }
}
