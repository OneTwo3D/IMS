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
import { getXeroSettings, queueXeroSync } from '@/app/actions/xero-sync'

export async function runDailyBatchSync(): Promise<{
  groupA1: number
  groupA2: number
  groupB: number
  errors: string[]
}> {
  const result = { groupA1: 0, groupA2: 0, groupB: 0, errors: [] as string[] }
  const settings = await getXeroSettings()
  const today = new Date().toISOString().slice(0, 10)

  // --- Group A1: Revenue Deferral ---
  try {
    const orders = await db.salesOrder.findMany({
      where: {
        paidAt: { not: null },
        xeroRevenueDeferredDate: null,
        xeroInvoiceId: { not: null },
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
        const salesValue = Math.round(Number(order.totalGbp) * 100) / 100
        totalRevenueDeferred += salesValue

        // Update order
        await db.salesOrder.update({
          where: { id: order.id },
          data: {
            xeroRevenueDeferredDate: new Date(),
            xeroUnearnedRevenueAmount: salesValue,
          },
        })
      }

      if (totalRevenueDeferred > 0) {
        journalLines.push(
          { accountCode: settings.xero_sales_account, description: `Daily revenue deferral — ${orders.length} order(s)`, debit: totalRevenueDeferred },
          { accountCode: settings.xero_unearned_revenue_account, description: `Daily revenue deferral — ${orders.length} order(s)`, credit: totalRevenueDeferred },
        )

        await queueXeroSync({
          type: 'DAILY_BATCH_REVENUE_DEFERRAL',
          referenceType: 'DailyBatch',
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

      result.groupA1 = orders.length
    }
  } catch (e) {
    result.errors.push(`Group A1 error: ${String(e)}`)
  }

  // --- Group A2: Inventory Reclassification ---
  try {
    const orders = await db.salesOrder.findMany({
      where: {
        xeroRevenueDeferredDate: { not: null },
        xeroInventoryAllocatedDate: null,
        status: { in: ['ALLOCATED', 'PICKING', 'PACKING'] },
      },
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
      let totalAllocatedValue = 0

      for (const order of orders) {
        let orderCostValue = 0

        // Calculate cost value from FIFO cost layers for each allocation
        for (const alloc of order.allocations) {
          const costLayers = await db.costLayer.findMany({
            where: {
              productId: alloc.productId,
              warehouseId: alloc.warehouseId,
              remainingQty: { gt: 0 },
            },
            orderBy: { receivedAt: 'asc' },
          })

          let remaining = Number(alloc.qty)
          for (const layer of costLayers) {
            if (remaining <= 0) break
            const take = Math.min(remaining, Number(layer.remainingQty))
            orderCostValue += take * Number(layer.unitCostGbp)
            remaining -= take
          }
        }

        orderCostValue = Math.round(orderCostValue * 100) / 100
        totalAllocatedValue += orderCostValue

        await db.salesOrder.update({
          where: { id: order.id },
          data: {
            xeroInventoryAllocatedDate: new Date(),
            xeroAllocationBatchAmount: orderCostValue,
          },
        })
      }

      if (totalAllocatedValue > 0) {
        await queueXeroSync({
          type: 'DAILY_BATCH_INVENTORY_ALLOC',
          referenceType: 'DailyBatch',
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
        xeroShipmentJournalDate: null,
        order: {
          xeroRevenueDeferredDate: { not: null },
          xeroInventoryAllocatedDate: { not: null },
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
            line: {
              select: { totalGbp: true },
            },
          },
        },
        order: {
          select: {
            orderNumber: true,
            wcOrderNumber: true,
            totalGbp: true,
            xeroUnearnedRevenueAmount: true,
            lines: { select: { totalGbp: true } },
            shipments: {
              select: {
                id: true,
                xeroRevenueRecognizedAmount: true,
                lines: { select: { line: { select: { totalGbp: true } } } },
              },
            },
          },
        },
      },
    })

    if (shipments.length > 0) {
      let totalRevenue = 0
      let totalCogs = 0

      for (const shipment of shipments) {
        // Revenue proportion: this shipment's share of order total
        const orderTotal = Number(shipment.order.totalGbp)
        const shipmentLineValue = shipment.lines.reduce((s, l) => s + Number(l.line.totalGbp), 0)
        const orderLineTotal = shipment.order.lines.reduce((s, l) => s + Number(l.totalGbp), 0)
        const revenueProportion = orderLineTotal > 0
          ? Math.round((shipmentLineValue / orderLineTotal) * Number(shipment.order.xeroUnearnedRevenueAmount ?? orderTotal) * 100) / 100
          : 0

        // COGS: consume FIFO cost layers and decrement remainingQty
        let shipmentCogs = 0
        for (const sl of shipment.lines) {
          const costLayers = await db.costLayer.findMany({
            where: {
              productId: sl.productId,
              warehouseId: shipment.warehouseId,
              remainingQty: { gt: 0 },
            },
            orderBy: { receivedAt: 'asc' },
          })

          let remaining = Number(sl.qty)
          for (const layer of costLayers) {
            if (remaining <= 0) break
            const take = Math.min(remaining, Number(layer.remainingQty))
            shipmentCogs += take * Number(layer.unitCostGbp)

            // Actually decrement remainingQty (fixes existing bug)
            await db.costLayer.update({
              where: { id: layer.id },
              data: { remainingQty: { decrement: take } },
            })

            remaining -= take
          }
        }

        shipmentCogs = Math.round(shipmentCogs * 100) / 100
        totalRevenue += revenueProportion
        totalCogs += shipmentCogs

        await db.shipment.update({
          where: { id: shipment.id },
          data: {
            xeroShipmentJournalDate: new Date(),
            xeroCogsBatchAmount: shipmentCogs,
            xeroRevenueRecognizedAmount: revenueProportion,
          },
        })
      }

      const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []

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

      if (journalLines.length > 0) {
        await queueXeroSync({
          type: 'DAILY_BATCH_GROUP_B',
          referenceType: 'DailyBatch',
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
