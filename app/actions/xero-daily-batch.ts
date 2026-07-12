'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { parseCostLayerSnapshot, sumCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { calculateCoverageByLine, requirementsMapToRows } from '@/lib/products/fulfillment-coverage'
import { expandFulfillmentRequirementsDecimal, loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { isFullyShippedTerminalStatus, recognizeShipmentRevenue } from '@/lib/domain/accounting/revenue-recognition'
import {
  sumPostedUnearnedReversal,
  isFullyShippedNetOfRefunds,
  batchContainsFinalUnjournaledShipment,
} from '@/lib/domain/accounting/deferred-trueup'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { takeDailyBatchWindow, resolveXeroDailyBatchLimit } from '@/lib/connectors/xero/daily-sync'
import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type Decimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

/**
 * Preview & history for the Xero daily batch sub-ledger.
 *
 * The daily batch (lib/connectors/xero/daily-sync.ts) runs once per day and
 * posts three aggregated Manual Journals to Xero (A1 revenue deferral, A2
 * inventory reclassification, B shipment revenue + COGS). This module lets
 * operators see what is currently queued to post at the *next* batch run
 * without waiting for it — and review what every prior run contained.
 *
 * Preview is expensive (FIFO cost-layer scan for A2 + B), so results are
 * memoised in-process for 60 seconds. The cache lives on the Node process;
 * in this single-instance deployment that's sufficient.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DailyBatchPreviewOrder = {
  id: string
  displayOrderNumber: string
  amount: number
}

export type DailyBatchPreviewShipment = {
  id: string
  orderId: string
  displayOrderNumber: string
  revenue: number
  cogs: number
}

export type DailyBatchPreview = {
  generatedAt: string
  cachedFor: number // seconds remaining in cache, 0 if fresh
  groupA1: {
    orderCount: number
    totalRevenue: number
    orders: DailyBatchPreviewOrder[]
  }
  groupA2: {
    orderCount: number
    totalCost: number
    orders: DailyBatchPreviewOrder[]
  }
  groupB: {
    shipmentCount: number
    totalRevenue: number
    totalCogs: number
    shipments: DailyBatchPreviewShipment[]
  }
}

export type DailyBatchHistoryDay = {
  date: string
  a1: DailyBatchHistoryEntry | null
  a2: DailyBatchHistoryEntry | null
  b: DailyBatchHistoryEntry | null
}

export type DailyBatchHistoryEntry = {
  id: string
  status: string
  narration: string
  lineCount: number
  totalDebit: number
  createdAt: string
  syncedAt: string | null
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  lines: Array<{ accountCode: string; description: string; debit: number; credit: number }>
}

// ---------------------------------------------------------------------------
// In-process 60s cache
// ---------------------------------------------------------------------------

const PREVIEW_TTL_MS = 60_000

type CachedPreview = { builtAt: number; value: DailyBatchPreview }
let previewCache: CachedPreview | null = null

function invalidatePreviewCache() {
  previewCache = null
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function getXeroDailyBatchPreview(
  opts?: { force?: boolean },
): Promise<DailyBatchPreview> {
  await requirePermission('sync')

  const now = Date.now()
  if (!opts?.force && previewCache && now - previewCache.builtAt < PREVIEW_TTL_MS) {
    return {
      ...previewCache.value,
      cachedFor: Math.max(
        0,
        Math.round((PREVIEW_TTL_MS - (now - previewCache.builtAt)) / 1000),
      ),
    }
  }

  const value = await computePreview()
  previewCache = { builtAt: Date.now(), value }
  return { ...value, cachedFor: Math.round(PREVIEW_TTL_MS / 1000) }
}

async function computePreview(): Promise<DailyBatchPreview> {
  // --- A1: paid orders awaiting revenue deferral ---
  const a1Orders = await db.salesOrder.findMany({
    where: {
      paidAt: { not: null },
      revenueDeferredDate: null,
      accountingInvoiceId: { not: null },
      status: { notIn: ['CANCELLED', 'DRAFT'] },
      refundStatus: { not: 'FULL' },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      totalBase: true,
      taxBase: true,
    },
    orderBy: { paidAt: 'asc' },
  })

  const a1 = {
    orderCount: a1Orders.length,
    totalRevenue: round2(a1Orders.reduce((s, o) => s + (Number(o.totalBase) - Number(o.taxBase)), 0)),
    orders: a1Orders.slice(0, 200).map((o) => ({
      id: o.id,
      displayOrderNumber: getSalesOrderReference(o),
      amount: round2(Number(o.totalBase)),
    })),
  }

  // --- A2: orders with deferred revenue, now allocated, awaiting
  //     inventory reclassification ---
  const a2OrdersRaw = await db.salesOrder.findMany({
    where: {
      revenueDeferredDate: { not: null },
      inventoryAllocatedDate: null,
      status: { in: ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED'] },
      refundStatus: { not: 'FULL' },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      allocations: {
        select: { productId: true, warehouseId: true, qty: true },
      },
      shipments: {
        where: { status: 'SHIPPED' },
        select: {
          lines: {
            select: {
              qty: true,
              costLayerSnapshot: true,
            },
          },
        },
      },
    },
  })

  const a2OrdersComputed: DailyBatchPreviewOrder[] = []
  let a2Total = toDecimal(0)
  const a2Snapshot = await buildPreviewLayerSnapshot(
    a2OrdersRaw.flatMap((order) =>
      order.shipments.length > 0
        ? []
        : order.allocations.map((alloc) => ({
            productId: alloc.productId,
            warehouseId: alloc.warehouseId,
          })),
    ),
  )
  for (const order of a2OrdersRaw) {
    const cost = order.shipments.length > 0
      ? order.shipments.reduce((sum, shipment) => (
          addMoney(sum, shipment.lines.reduce((lineSum, line) => {
            if (Number(line.qty) <= 0) return lineSum
            return addMoney(lineSum, sumCostLayerSnapshot(parseCostLayerSnapshot(line.costLayerSnapshot)))
          }, toDecimal(0)))
        ), toDecimal(0))
      : computeFifoCostFromSnapshot(a2Snapshot, order.allocations)
    a2Total = addMoney(a2Total, cost)
    a2OrdersComputed.push({
      id: order.id,
      displayOrderNumber: getSalesOrderReference(order),
      amount: roundQuantity(cost, 2).toNumber(),
    })
  }

  const a2 = {
    orderCount: a2OrdersRaw.length,
    totalCost: roundQuantity(a2Total, 2).toNumber(),
    orders: a2OrdersComputed.slice(0, 200),
  }

  // --- B: shipped shipments whose order has completed A1+A2 but that
  //     haven't had revenue recognised yet ---
  // Apply the SAME batch window the live cron uses (take: batchLimit + 1 →
  // takeDailyBatchWindow). Otherwise the preview, seeing every unjournaled
  // shipment, would mark an order's true-up as final while live Xero splits its
  // shipments across XERO_DAILY_BATCH_LIMIT runs and defers it — overstating the
  // next batch's revenue (scjz.68/.69 parity).
  const bBatchLimit = resolveXeroDailyBatchLimit()
  const bShipments = takeDailyBatchWindow(await db.shipment.findMany({
    where: {
      status: 'SHIPPED',
      shipmentJournalDate: null,
      order: {
        refundStatus: { not: 'FULL' },
        revenueDeferredDate: { not: null },
        inventoryAllocatedDate: { not: null },
      },
    },
    select: {
      id: true,
      orderId: true,
      warehouseId: true,
      cogsBatchAmount: true,
      lines: {
        select: {
          lineId: true,
          productId: true,
          qty: true,
          costLayerSnapshot: true,
          line: { select: { id: true, qty: true, totalBase: true } },
        },
      },
      order: {
        select: {
          orderNumber: true,
          externalOrderNumber: true,
          status: true,
          refundStatus: true,
          totalBase: true,
          unearnedRevenueAmount: true,
          lines: { select: { id: true, productId: true, qty: true, totalBase: true } },
          shipments: {
            select: {
              id: true,
              status: true,
              shipmentJournalDate: true,
              revenueRecognizedAmount: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: bBatchLimit + 1,
  }), bBatchLimit).rows

  // Mirror the cron daily-sync's grouped revenue recognition so the preview
  // matches what actually posts (cogs-audit scjz.69). The naive per-shipment
  // proportional formula never trued up, so the preview under-reported B
  // revenue: the cron groups a batch's shipments by order and, on the final
  // shipment of a fully-shipped terminal order, recognizes the *remaining*
  // deferred revenue (remainingDeferred - runningRevenue) instead of the
  // rounded proportional slice, and otherwise caps the slice at the remaining
  // deferred. Use the same BOM-aware coverage-by-line so KIT/BOM shipment
  // values match too.
  const bGraph = await loadFulfillmentProductGraph(
    db,
    Array.from(new Set(
      bShipments.flatMap((shipment) => (
        shipment.order.lines.map((line) => line.productId).filter((value): value is string => !!value)
      )),
    )),
  )

  const bShipmentsByOrder = new Map<string, typeof bShipments>()
  for (const shipment of bShipments) {
    const existing = bShipmentsByOrder.get(shipment.orderId) ?? []
    existing.push(shipment)
    bShipmentsByOrder.set(shipment.orderId, existing)
  }

  // scjz.68 (mirror of the cron's reversal-aware true-up so the preview matches
  // what posts — scjz.69): subtract deferred revenue a refund credit note already
  // reversed out of the unearned account, and only true up a PARTIALLY_REFUNDED
  // order once it is fully shipped net of refunds.
  const bOrderIds = Array.from(new Set(bShipments.map((shipment) => shipment.orderId)))
  const bSettings = await getXeroSettings()
  const bPartialOrderIds = new Set(
    bShipments.filter((shipment) => shipment.order.refundStatus === 'PARTIAL').map((shipment) => shipment.orderId),
  )
  const bReversalSyncsByOrder = new Map<string, Array<{ payload: unknown }>>()
  const bShippedRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
  const bRefundedUnshippedRowsByOrder = new Map<string, Array<{ lineId: string; productId: string; qty: number }>>()
  if (bOrderIds.length > 0) {
    const bRefunds = await db.salesOrderRefund.findMany({
      where: { orderId: { in: bOrderIds } },
      select: { id: true, orderId: true },
    })
    const bRefundIdToOrderId = new Map(bRefunds.map((refund) => [refund.id, refund.orderId]))
    const bReversalSyncs = await db.accountingSyncLog.findMany({
      where: {
        connector: 'xero',
        type: 'UNEARNED_REV_REVERSAL',
        status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
        OR: [
          { referenceType: 'SalesOrder', referenceId: { in: bOrderIds } },
          { referenceType: 'SalesOrderRefund', referenceId: { in: bRefunds.map((refund) => refund.id) } },
        ],
      },
      select: { referenceType: true, referenceId: true, payload: true },
    })
    for (const sync of bReversalSyncs) {
      const targetOrderId = sync.referenceType === 'SalesOrder' ? sync.referenceId : bRefundIdToOrderId.get(sync.referenceId)
      if (!targetOrderId) continue
      const list = bReversalSyncsByOrder.get(targetOrderId) ?? []
      list.push({ payload: sync.payload })
      bReversalSyncsByOrder.set(targetOrderId, list)
    }
    if (bPartialOrderIds.size > 0) {
      const [bAllocations, bDispatchedLines, bRefundLines] = await Promise.all([
        db.orderAllocation.findMany({
          where: { orderId: { in: [...bPartialOrderIds] } },
          select: { id: true, orderId: true, lineId: true, productId: true },
        }),
        db.shipmentLine.findMany({
          where: { shipment: { orderId: { in: [...bPartialOrderIds] }, status: 'SHIPPED' } },
          select: { lineId: true, productId: true, qty: true, shipment: { select: { orderId: true } } },
        }),
        db.salesOrderRefundLine.findMany({
          where: { refund: { orderId: { in: [...bPartialOrderIds] } } },
          select: { costLayerSnapshot: true },
        }),
      ])
      const bAllocationById = new Map(bAllocations.map((allocation) => [allocation.id, allocation]))
      for (const line of bDispatchedLines) {
        if (!line.productId) continue
        const rows = bShippedRowsByOrder.get(line.shipment.orderId) ?? []
        rows.push({ lineId: line.lineId, productId: line.productId, qty: Number(line.qty) })
        bShippedRowsByOrder.set(line.shipment.orderId, rows)
      }
      for (const refundLine of bRefundLines) {
        for (const entry of parseCostLayerSnapshot(refundLine.costLayerSnapshot)) {
          if (entry.source !== 'allocation' || !entry.orderAllocationId) continue
          const allocation = bAllocationById.get(entry.orderAllocationId)
          if (!allocation?.productId || !bPartialOrderIds.has(allocation.orderId)) continue
          const rows = bRefundedUnshippedRowsByOrder.get(allocation.orderId) ?? []
          rows.push({ lineId: allocation.lineId, productId: allocation.productId, qty: toDecimal(entry.qty).toNumber() })
          bRefundedUnshippedRowsByOrder.set(allocation.orderId, rows)
        }
      }
    }
  }

  // Compute per-shipment results grouped by order, then emit in the original
  // (createdAt asc) order so the displayed list and the 200-cap are stable.
  const bShipmentResults = new Map<string, { revenue: number; cogs: Decimal }>()
  for (const [orderId, orderShipments] of bShipmentsByOrder) {
    const firstShipment = orderShipments[0]
    const order = firstShipment.order
    const deferredBase = Number(order.unearnedRevenueAmount ?? order.totalBase)
    const orderLineTotal = order.lines.reduce((sum, line) => sum + Number(line.totalBase), 0)
    const requirementsByLine = new Map(
      order.lines
        .filter((line) => !!line.productId)
        .map((line) => [
          line.id,
          requirementsMapToRows(expandFulfillmentRequirementsDecimal(line.productId!, 1, bGraph)),
        ]),
    )
    const orderLineById = new Map(order.lines.map((line) => [line.id, line]))
    const recognizedPreviously = order.shipments.reduce((sum, shipment) => (
      shipment.shipmentJournalDate ? sum + Number(shipment.revenueRecognizedAmount ?? 0) : sum
    ), 0)
    const postedUnearnedReversal = sumPostedUnearnedReversal(
      bReversalSyncsByOrder.get(orderId) ?? [],
      bSettings.xero_unearned_revenue_account,
    )
    const remainingDeferred = round2(Math.max(0, deferredBase - recognizedPreviously - postedUnearnedReversal))
    let runningRevenue = 0

    let isTrueUpEligible = isFullyShippedTerminalStatus(order.status) && order.refundStatus !== 'PARTIAL'
    if (!isTrueUpEligible && order.refundStatus === 'PARTIAL') {
      const combinedCoverageByLine = calculateCoverageByLine(requirementsByLine, [
        ...(bShippedRowsByOrder.get(orderId) ?? []),
        ...(bRefundedUnshippedRowsByOrder.get(orderId) ?? []),
      ])
      isTrueUpEligible = isFullyShippedNetOfRefunds(
        order.lines
          .filter((line) => !!line.productId)
          .map((line) => ({
            orderedQty: Number(line.qty),
            coveredQty: combinedCoverageByLine.get(line.id) ?? 0,
          })),
      )
    }
    if (isTrueUpEligible) {
      isTrueUpEligible = batchContainsFinalUnjournaledShipment(
        order.shipments.filter((shipment) => shipment.status === 'SHIPPED'),
        new Set(orderShipments.map((shipment) => shipment.id)),
      )
    }

    for (let index = 0; index < orderShipments.length; index++) {
      const shipment = orderShipments[index]
      const shippedCoverageByLine = calculateCoverageByLine(
        requirementsByLine,
        shipment.lines.map((line) => ({
          lineId: line.lineId,
          productId: line.productId,
          qty: Number(line.qty),
        })),
      )
      const shipmentLineValue = [...shippedCoverageByLine.entries()].reduce((sum, [lineId, coveredQty]) => {
        const line = orderLineById.get(lineId)
        const lineQty = Number(line?.qty ?? 0)
        if (!line || lineQty <= 0 || coveredQty <= 0) return sum
        return sum + (Number(line.totalBase) * Math.min(coveredQty, lineQty)) / lineQty
      }, 0)

      const proportionalRevenue = orderLineTotal > 0
        ? round2((shipmentLineValue / orderLineTotal) * deferredBase)
        : 0
      const revenueProportion = recognizeShipmentRevenue({
        proportionalRevenue,
        remainingDeferred,
        runningRevenue,
        isFinalShipmentOfFullyShippedTerminalOrder:
          isTrueUpEligible && index === orderShipments.length - 1,
      })
      runningRevenue += revenueProportion

      const snapshotCogs = shipment.lines.reduce((sum, line) => (
        addMoney(sum, sumCostLayerSnapshot(parseCostLayerSnapshot(line.costLayerSnapshot)))
      ), toDecimal(0))
      const cogs = snapshotCogs.gt(0) ? snapshotCogs : toDecimal(shipment.cogsBatchAmount ?? 0)

      bShipmentResults.set(shipment.id, { revenue: revenueProportion, cogs })
    }
  }

  const bShipmentsComputed: DailyBatchPreviewShipment[] = []
  let bRevenue = 0
  let bCogs = toDecimal(0)
  for (const shipment of bShipments) {
    const result = bShipmentResults.get(shipment.id) ?? { revenue: 0, cogs: toDecimal(0) }
    bRevenue += result.revenue
    bCogs = addMoney(bCogs, result.cogs)
    bShipmentsComputed.push({
      id: shipment.id,
      orderId: shipment.orderId,
      displayOrderNumber: getSalesOrderReference({ id: shipment.orderId, ...shipment.order }),
      revenue: result.revenue,
      cogs: roundQuantity(result.cogs, 2).toNumber(),
    })
  }

  const b = {
    shipmentCount: bShipments.length,
    totalRevenue: round2(bRevenue),
    totalCogs: roundQuantity(bCogs, 2).toNumber(),
    shipments: bShipmentsComputed.slice(0, 200),
  }

  return {
    generatedAt: new Date().toISOString(),
    cachedFor: 0,
    groupA1: a1,
    groupA2: a2,
    groupB: b,
  }
}

/**
 * Sum FIFO cost for a set of allocation-like rows. Reads cost layers but
 * never mutates them — this is a preview helper only.
 */
type PreviewLayerSnapshot = Map<string, Array<{ remainingQty: Decimal; unitCostBase: Decimal }>>

async function buildPreviewLayerSnapshot(
  rows: Array<{ productId: string; warehouseId: string }>,
): Promise<PreviewLayerSnapshot> {
  const snapshot: PreviewLayerSnapshot = new Map()
  const keys = new Set(rows.map((row) => `${row.productId}|${row.warehouseId}`))

  for (const key of keys) {
    const [productId, warehouseId] = key.split('|')
    const layers = await db.costLayer.findMany({
      where: {
        productId,
        warehouseId,
        remainingQty: { gt: 0 },
      },
      orderBy: { receivedAt: 'asc' },
      select: { remainingQty: true, unitCostBase: true },
    })
    snapshot.set(
      key,
      layers.map((layer) => ({
        remainingQty: toDecimal(layer.remainingQty),
        unitCostBase: toDecimal(layer.unitCostBase),
      })),
    )
  }

  return snapshot
}

function computeFifoCostFromSnapshot(
  snapshot: PreviewLayerSnapshot,
  rows: Array<{ productId: string; warehouseId: string; qty: number | { toString(): string } }>,
): Decimal {
  let total = toDecimal(0)

  for (const row of rows) {
    const layers = snapshot.get(`${row.productId}|${row.warehouseId}`) ?? []
    const rowQty: DecimalInput = typeof row.qty === 'number' ? row.qty : row.qty.toString()
    let remaining = toDecimal(rowQty)
    for (const layer of layers) {
      if (remaining.lte(0)) break
      const take = remaining.lte(layer.remainingQty) ? remaining : layer.remainingQty
      total = addMoney(total, multiplyMoney(take, layer.unitCostBase))
      layer.remainingQty = subtractMoney(layer.remainingQty, take)
      remaining = subtractMoney(remaining, take)
    }
  }

  return total
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getXeroDailyBatchHistory(
  days = 30,
): Promise<DailyBatchHistoryDay[]> {
  await requirePermission('sync')

  const since = new Date()
  since.setDate(since.getDate() - days)

  const rows = await db.accountingSyncLog.findMany({
    where: {
      connector: 'xero',
      type: {
        in: [
          'DAILY_BATCH_REVENUE_DEFERRAL',
          'DAILY_BATCH_INVENTORY_ALLOC',
          'DAILY_BATCH_GROUP_B',
        ],
      },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })

  const byDate = new Map<string, DailyBatchHistoryDay>()

  for (const row of rows) {
    const payload = (row.payload ?? {}) as {
      date?: string
      narration?: string
      lines?: Array<{
        accountCode?: string
        description?: string
        debit?: number
        credit?: number
      }>
    }
    const date = typeof payload.date === 'string' && payload.date
      ? payload.date.slice(0, 10)
      : row.createdAt.toISOString().slice(0, 10)
    let day = byDate.get(date)
    if (!day) {
      day = { date, a1: null, a2: null, b: null }
      byDate.set(date, day)
    }

    const lines = Array.isArray(payload.lines)
      ? payload.lines.map((l) => ({
          accountCode: l.accountCode ?? '',
          description: l.description ?? '',
          debit: Number(l.debit ?? 0),
          credit: Number(l.credit ?? 0),
        }))
      : []
    const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0))

    const entry: DailyBatchHistoryEntry = {
      id: row.id,
      status: row.status,
      narration: payload.narration ?? '',
      lineCount: lines.length,
      totalDebit,
      createdAt: row.createdAt.toISOString(),
      syncedAt: row.syncedAt?.toISOString() ?? null,
      externalTransactionId: row.externalTransactionId,
      errorMessage: row.errorMessage,
      retryCount: row.retryCount,
      lines,
    }

    if (row.type === 'DAILY_BATCH_REVENUE_DEFERRAL') day.a1 = entry
    else if (row.type === 'DAILY_BATCH_INVENTORY_ALLOC') day.a2 = entry
    else if (row.type === 'DAILY_BATCH_GROUP_B') day.b = entry
  }

  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
}

// ---------------------------------------------------------------------------
// Manual refresh (UI button)
// ---------------------------------------------------------------------------

export async function refreshXeroDailyBatchPreview(): Promise<DailyBatchPreview> {
  await requirePermission('sync')
  invalidatePreviewCache()
  return getXeroDailyBatchPreview({ force: true })
}
