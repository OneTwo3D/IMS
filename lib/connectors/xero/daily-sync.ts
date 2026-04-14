/**
 * Daily batch sync — the core of the Xero Sub-Ledger architecture.
 *
 * Execution order: A1 → A2 → B (always in this sequence).
 *
 * Group A1 — Revenue Deferral: DR Sales / CR Unearned Revenue
 *   Any paid order, regardless of stock status (incl. backorders).
 *
 * Group A2 — Inventory Reclassification: DR Allocated / CR Available
 *   Only allocated orders (stock physically reserved).
 *
 * Group B — Shipment: DR Unearned / CR Sales + DR COGS / CR Allocated
 *   Per-shipment, with FIFO cost layer consumption.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import type { Prisma } from '@/app/generated/prisma/client'

type MutableLayer = {
  id: string
  remainingQty: number
  unitCostGbp: number
}

type LayerSnapshot = Map<string, MutableLayer[]>

type JournalLinePayload = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function makeLayerKey(productId: string, warehouseId: string): string {
  return `${productId}|${warehouseId}`
}

async function buildLayerSnapshot(
  rows: Array<{ productId: string; warehouseId: string }>,
): Promise<LayerSnapshot> {
  const snapshot: LayerSnapshot = new Map()
  const keys = new Set(rows.map((row) => makeLayerKey(row.productId, row.warehouseId)))

  for (const key of keys) {
    const [productId, warehouseId] = key.split('|')
    const layers = await db.costLayer.findMany({
      where: {
        productId,
        warehouseId,
        remainingQty: { gt: 0 },
      },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, remainingQty: true, unitCostGbp: true },
    })
    snapshot.set(
      key,
      layers.map((layer) => ({
        id: layer.id,
        remainingQty: Number(layer.remainingQty),
        unitCostGbp: Number(layer.unitCostGbp),
      })),
    )
  }

  return snapshot
}

function consumeSnapshotCost(
  snapshot: LayerSnapshot,
  productId: string,
  warehouseId: string,
  qty: number,
  trackDecrements?: Map<string, number>,
): number {
  const layers = snapshot.get(makeLayerKey(productId, warehouseId)) ?? []
  let remaining = qty
  let total = 0

  for (const layer of layers) {
    if (remaining <= 0) break
    const take = Math.min(remaining, layer.remainingQty)
    if (take <= 0) continue
    total += take * layer.unitCostGbp
    layer.remainingQty -= take
    remaining -= take
    if (trackDecrements) {
      trackDecrements.set(layer.id, (trackDecrements.get(layer.id) ?? 0) + take)
    }
  }

  return total
}

async function createPendingSyncLog(
  tx: Prisma.TransactionClient,
  params: {
    type: 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B'
    referenceId: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  await tx.accountingSyncLog.create({
    data: {
      type: params.type,
      status: 'PENDING',
      referenceType: 'DailyBatch',
      referenceId: params.referenceId,
      payload: params.payload as never,
    },
  })
}

export async function runDailyBatchSync(): Promise<{
  groupA1: number
  groupA2: number
  groupB: number
  errors: string[]
}> {
  const result = { groupA1: 0, groupA2: 0, groupB: 0, errors: [] as string[] }
  const settings = await getXeroSettings()
  const today = new Date().toISOString().slice(0, 10)

  if (settings.xero_sync_enabled !== 'true') {
    return result
  }

  // --- Group A1: Revenue Deferral ---
  try {
    const orders = await db.salesOrder.findMany({
      where: {
        paidAt: { not: null },
        revenueDeferredDate: null,
        accountingInvoiceId: { not: null },
        status: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] },
      },
      select: {
        id: true,
        orderNumber: true,
        wcOrderNumber: true,
        totalGbp: true,
        lines: {
          select: { totalGbp: true },
        },
      },
    })

    if (orders.length > 0) {
      let totalRevenueDeferred = 0
      const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []

      for (const order of orders) {
        const salesValue = round2(Number(order.totalGbp))
        totalRevenueDeferred += salesValue
      }

      if (totalRevenueDeferred > 0) {
        journalLines.push(
          { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${orders.length} order(s)`, debit: totalRevenueDeferred },
          { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${orders.length} order(s)`, credit: totalRevenueDeferred },
        )
      }

      await db.$transaction(async (tx) => {
        if (totalRevenueDeferred > 0) {
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_REVENUE_DEFERRAL',
            referenceId: `A1-${today}`,
            payload: {
              date: today,
              reference: `Revenue Deferral ${today}`,
              narration: `Daily revenue deferral: ${orders.length} order(s), £${totalRevenueDeferred.toFixed(2)}`,
              lines: journalLines,
              _postingMode: 'submitted',
            },
          })
        }

        for (const order of orders) {
          const salesValue = round2(Number(order.totalGbp))
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              revenueDeferredDate: new Date(),
              unearnedRevenueAmount: salesValue,
            },
          })
        }
      })

      result.groupA1 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A1 error: ${String(e)}`)
  }

  // --- Group A2: Inventory Reclassification ---
  try {
    const orders = await db.salesOrder.findMany({
      where: {
        revenueDeferredDate: { not: null },
        inventoryAllocatedDate: null,
        status: { in: ['ALLOCATED', 'PICKING', 'PACKING'] },
      },
      orderBy: { revenueDeferredDate: 'asc' },
      select: {
        id: true,
        orderNumber: true,
        wcOrderNumber: true,
        allocations: {
          select: {
            productId: true,
            warehouseId: true,
            qty: true,
          },
        },
      },
    })

    if (orders.length > 0) {
      await db.$transaction(async (tx) => {
        let totalAllocatedValue = 0
        const snapshot = await buildLayerSnapshot(
          orders.flatMap((order) =>
            order.allocations.map((alloc) => ({
              productId: alloc.productId,
              warehouseId: alloc.warehouseId,
            })),
          ),
        )
        const orderValues = new Map<string, number>()

        for (const order of orders) {
          let orderCostValue = 0

          for (const alloc of order.allocations) {
            orderCostValue += consumeSnapshotCost(
              snapshot,
              alloc.productId,
              alloc.warehouseId,
              Number(alloc.qty),
            )
          }

          orderCostValue = round2(orderCostValue)
          totalAllocatedValue += orderCostValue
          orderValues.set(order.id, orderCostValue)
        }

        if (totalAllocatedValue > 0) {
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_INVENTORY_ALLOC',
            referenceId: `A2-${today}`,
            payload: {
              date: today,
              reference: `Inventory Allocation ${today}`,
              narration: `Daily inventory reclassification: ${orders.length} order(s), £${totalAllocatedValue.toFixed(2)}`,
              lines: [
                { accountCode: settings.xero_allocated_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, debit: totalAllocatedValue },
                { accountCode: settings.xero_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, credit: totalAllocatedValue },
              ],
              _postingMode: 'submitted',
            },
          })
        }

        for (const order of orders) {
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              inventoryAllocatedDate: new Date(),
              allocationBatchAmount: orderValues.get(order.id) ?? 0,
            },
          })
        }
      })

      result.groupA2 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A2 error: ${String(e)}`)
  }

  // --- Group B: Shipment Revenue Recognition + COGS ---
  try {
    const shipments = await db.shipment.findMany({
      where: {
        status: 'SHIPPED',
        shipmentJournalDate: null,
        order: {
          revenueDeferredDate: { not: null },
          inventoryAllocatedDate: { not: null },
        },
      },
      select: {
        id: true,
        orderId: true,
        warehouseId: true,
        createdAt: true,
        lines: {
          select: {
            productId: true,
            qty: true,
            line: {
              select: { id: true, qty: true, totalGbp: true },
            },
          },
        },
        order: {
          select: {
            orderNumber: true,
            wcOrderNumber: true,
            status: true,
            totalGbp: true,
            unearnedRevenueAmount: true,
            lines: { select: { totalGbp: true } },
            shipments: {
              select: {
                id: true,
                shipmentJournalDate: true,
                revenueRecognizedAmount: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    if (shipments.length > 0) {
      let totalRevenue = 0
      let totalCogs = 0
      const snapshot = await buildLayerSnapshot(
        shipments.flatMap((shipment) =>
          shipment.lines.map((line) => ({
            productId: line.productId,
            warehouseId: shipment.warehouseId,
          })),
        ),
      )
      const layerDecrements = new Map<string, number>()
      const shipmentResults = new Map<string, { revenue: number; cogs: number }>()
      const shipmentsByOrder = new Map<string, typeof shipments>()

      for (const shipment of shipments) {
        const existing = shipmentsByOrder.get(shipment.orderId) ?? []
        existing.push(shipment)
        shipmentsByOrder.set(shipment.orderId, existing)
      }

      for (const [, orderShipments] of shipmentsByOrder) {
        const firstShipment = orderShipments[0]
        const orderTotal = Number(firstShipment.order.totalGbp)
        const deferredBase = Number(firstShipment.order.unearnedRevenueAmount ?? orderTotal)
        const orderLineTotal = firstShipment.order.lines.reduce((sum, line) => sum + Number(line.totalGbp), 0)
        const recognizedPreviously = firstShipment.order.shipments.reduce((sum, shipment) => (
          shipment.shipmentJournalDate ? sum + Number(shipment.revenueRecognizedAmount ?? 0) : sum
        ), 0)
        const remainingDeferred = round2(Math.max(0, deferredBase - recognizedPreviously))
        let runningRevenue = 0

        for (let index = 0; index < orderShipments.length; index++) {
          const shipment = orderShipments[index]
          const shipmentLineValue = shipment.lines.reduce((sum, line) => {
            const lineQty = Number(line.line.qty)
            const shippedQty = Number(line.qty)
            if (lineQty <= 0 || shippedQty <= 0) return sum
            return sum + (Number(line.line.totalGbp) * shippedQty) / lineQty
          }, 0)

          let revenueProportion = orderLineTotal > 0
            ? round2((shipmentLineValue / orderLineTotal) * deferredBase)
            : 0

          if (firstShipment.order.status === 'SHIPPED' && index === orderShipments.length - 1) {
            revenueProportion = round2(Math.max(0, remainingDeferred - runningRevenue))
          } else {
            revenueProportion = Math.min(
              revenueProportion,
              round2(Math.max(0, remainingDeferred - runningRevenue)),
            )
          }

          // COGS: consume FIFO cost layers and track layer decrements so the
          // inventory mutation is committed atomically with the sync log row.
          let shipmentCogs = 0
          for (const sl of shipment.lines) {
            shipmentCogs += consumeSnapshotCost(
              snapshot,
              sl.productId,
              shipment.warehouseId,
              Number(sl.qty),
              layerDecrements,
            )
          }

          shipmentCogs = round2(shipmentCogs)
          totalRevenue += revenueProportion
          totalCogs += shipmentCogs
          runningRevenue += revenueProportion
          shipmentResults.set(shipment.id, { revenue: revenueProportion, cogs: shipmentCogs })
        }
      }

      const journalLines: JournalLinePayload[] = []

      if (totalRevenue > 0) {
        journalLines.push(
          { accountCode: settings.xero_unearned_revenue_account, description: `Revenue recognition — ${shipments.length} shipment(s)`, debit: totalRevenue },
          { accountCode: settings.xero_sales_account, description: `Revenue recognition — ${shipments.length} shipment(s)`, credit: totalRevenue },
        )
      }

      if (totalCogs > 0) {
        journalLines.push(
          { accountCode: settings.xero_cogs_account, description: `COGS — ${shipments.length} shipment(s)`, debit: totalCogs },
          { accountCode: settings.xero_allocated_inventory_account, description: `COGS — ${shipments.length} shipment(s)`, credit: totalCogs },
        )
      }

      await db.$transaction(async (tx) => {
        if (journalLines.length > 0) {
          await createPendingSyncLog(tx, {
            type: 'DAILY_BATCH_GROUP_B',
            referenceId: `B-${today}`,
            payload: {
              date: today,
              reference: `Shipment COGS ${today}`,
              narration: `Daily shipment batch: ${shipments.length} shipment(s), revenue £${totalRevenue.toFixed(2)}, COGS £${totalCogs.toFixed(2)}`,
              lines: journalLines,
              _postingMode: 'submitted',
            },
          })
        }

        for (const shipment of shipments) {
          const resultForShipment = shipmentResults.get(shipment.id) ?? { revenue: 0, cogs: 0 }
          await tx.shipment.update({
            where: { id: shipment.id },
            data: {
              shipmentJournalDate: new Date(),
              cogsBatchAmount: resultForShipment.cogs,
              revenueRecognizedAmount: resultForShipment.revenue,
            },
          })
        }

        for (const [layerId, decrement] of layerDecrements) {
          await tx.costLayer.update({
            where: { id: layerId },
            data: { remainingQty: { decrement } },
          })
        }
      })

      result.groupB = shipments.length
    }
  } catch (e) {
    result.errors.push(`Group B error: ${String(e)}`)
  }

  // Log summary
  if (result.groupA1 > 0 || result.groupA2 > 0 || result.groupB > 0) {
    logActivity({
      entityType: 'SYSTEM',
      action: 'xero_daily_batch',
      tag: 'sync',
      level: 'INFO',
      description: `Daily batch: A1=${result.groupA1} deferred, A2=${result.groupA2} allocated, B=${result.groupB} shipped`,
      metadata: result,
    })
  }

  return result
}
