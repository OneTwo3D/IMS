import { db } from '@/lib/db'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { parseCostLayerSnapshot, sumCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
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
 * Connector-agnostic daily-batch preview computation for groups A1 and A2.
 *
 * A1 (revenue deferral) and A2 (inventory reclassification) are derived purely
 * from local sales/allocation/cost-layer state — they are identical regardless
 * of which accounting connector will post the batch. This module is shared so a
 * connector's daily-batch preview surface can compute A1/A2 without duplicating
 * the FIFO cost-layer scan. (Xero keeps its own historical copy in
 * app/actions/xero-daily-batch.ts; QuickBooks consumes this shared version.)
 *
 * Group B (shipment revenue recognition + COGS) is intentionally NOT computed
 * here: it mirrors each connector's per-run batch window and reversal-aware
 * true-up, which differ between connectors (e.g. Xero windows shipments via
 * XERO_DAILY_BATCH_LIMIT, QuickBooks does not). A connector-specific B preview
 * is tracked separately.
 */

export type DailyBatchPreviewOrder = {
  id: string
  displayOrderNumber: string
  amount: number
}

export type DailyBatchA1A2Preview = {
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
}

type PreviewLayerSnapshot = Map<string, Array<{ remainingQty: Decimal; unitCostBase: Decimal }>>

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

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

/**
 * Compute the A1 (revenue deferral) and A2 (inventory reclassification) preview
 * groups from current local state — what the next daily batch will post for
 * those two groups, independent of the active accounting connector.
 */
export async function computeDailyBatchA1A2Preview(): Promise<DailyBatchA1A2Preview> {
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

  const groupA1 = {
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
      status: { in: ['ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED'] },
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

  const groupA2 = {
    orderCount: a2OrdersRaw.length,
    totalCost: roundQuantity(a2Total, 2).toNumber(),
    orders: a2OrdersComputed.slice(0, 200),
  }

  return { groupA1, groupA2 }
}
