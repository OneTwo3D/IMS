'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { getSalesOrderReference } from '@/lib/sales-order-display'

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
      status: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] },
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
      status: { in: ['ALLOCATED', 'PICKING', 'PACKING'] },
    },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      allocations: {
        select: { productId: true, warehouseId: true, qty: true },
      },
    },
  })

  const a2OrdersComputed: DailyBatchPreviewOrder[] = []
  let a2Total = 0
  const a2Snapshot = await buildPreviewLayerSnapshot(
    a2OrdersRaw.flatMap((order) =>
      order.allocations.map((alloc) => ({
        productId: alloc.productId,
        warehouseId: alloc.warehouseId,
      })),
    ),
  )
  for (const order of a2OrdersRaw) {
    const cost = computeFifoCostFromSnapshot(a2Snapshot, order.allocations)
    a2Total += cost
    a2OrdersComputed.push({
      id: order.id,
      displayOrderNumber: getSalesOrderReference(order),
      amount: round2(cost),
    })
  }

  const a2 = {
    orderCount: a2OrdersRaw.length,
    totalCost: round2(a2Total),
    orders: a2OrdersComputed.slice(0, 200),
  }

  // --- B: shipped shipments whose order has completed A1+A2 but that
  //     haven't had revenue recognised yet ---
  const bShipments = await db.shipment.findMany({
    where: {
      status: 'SHIPPED',
      shipmentJournalDate: null,
      order: {
        status: { not: 'REFUNDED' },
        revenueDeferredDate: { not: null },
        inventoryAllocatedDate: { not: null },
      },
    },
    select: {
      id: true,
      orderId: true,
      warehouseId: true,
      lines: {
        select: {
          productId: true,
          qty: true,
          line: { select: { qty: true, totalBase: true } },
        },
      },
      order: {
        select: {
          orderNumber: true,
          externalOrderNumber: true,
          totalBase: true,
          unearnedRevenueAmount: true,
          lines: { select: { totalBase: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const bShipmentsComputed: DailyBatchPreviewShipment[] = []
  let bRevenue = 0
  let bCogs = 0
  const bSnapshot = await buildPreviewLayerSnapshot(
    bShipments.flatMap((shipment) =>
      shipment.lines.map((line) => ({
        productId: line.productId,
        warehouseId: shipment.warehouseId,
      })),
    ),
  )

  for (const shipment of bShipments) {
    const orderLineTotal = shipment.order.lines.reduce(
      (s, l) => s + Number(l.totalBase),
      0,
    )
    const shipmentLineValue = shipment.lines.reduce(
      (s, l) => {
        const lineQty = Number(l.line.qty)
        const shippedQty = Number(l.qty)
        if (lineQty <= 0 || shippedQty <= 0) return s
        return s + (Number(l.line.totalBase) * shippedQty) / lineQty
      },
      0,
    )
    const deferredBase = Number(
      shipment.order.unearnedRevenueAmount ?? shipment.order.totalBase,
    )
    const revenueProportion = orderLineTotal > 0
      ? round2((shipmentLineValue / orderLineTotal) * deferredBase)
      : 0

    // Preview-only: compute COGS from FIFO layers *without* decrementing
    // them. Multiple preview shipments for the same product/warehouse may
    // therefore reuse the same layer depth — which is an acceptable, and
    // documented, preview approximation. The real batch runs exclusively
    // and will consume layers atomically.
    const cogs = computeFifoCostFromSnapshot(
      bSnapshot,
      shipment.lines.map((l) => ({
        productId: l.productId,
        warehouseId: shipment.warehouseId,
        qty: l.qty,
      })),
    )

    bRevenue += revenueProportion
    bCogs += cogs
    bShipmentsComputed.push({
      id: shipment.id,
      orderId: shipment.orderId,
      displayOrderNumber: getSalesOrderReference({ id: shipment.orderId, ...shipment.order }),
      revenue: revenueProportion,
      cogs: round2(cogs),
    })
  }

  const b = {
    shipmentCount: bShipments.length,
    totalRevenue: round2(bRevenue),
    totalCogs: round2(bCogs),
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
type PreviewLayerSnapshot = Map<string, Array<{ remainingQty: number; unitCostBase: number }>>

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
        remainingQty: Number(layer.remainingQty),
        unitCostBase: Number(layer.unitCostBase),
      })),
    )
  }

  return snapshot
}

function computeFifoCostFromSnapshot(
  snapshot: PreviewLayerSnapshot,
  rows: Array<{ productId: string; warehouseId: string; qty: number | { toString(): string } }>,
): number {
  let total = 0

  for (const row of rows) {
    const layers = snapshot.get(`${row.productId}|${row.warehouseId}`) ?? []
    let remaining = Number(row.qty)
    for (const layer of layers) {
      if (remaining <= 0) break
      const take = Math.min(remaining, layer.remainingQty)
      total += take * layer.unitCostBase
      layer.remainingQty -= take
      remaining -= take
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
    const date = row.createdAt.toISOString().slice(0, 10)
    let day = byDate.get(date)
    if (!day) {
      day = { date, a1: null, a2: null, b: null }
      byDate.set(date, day)
    }

    const payload = (row.payload ?? {}) as {
      narration?: string
      lines?: Array<{
        accountCode?: string
        description?: string
        debit?: number
        credit?: number
      }>
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
