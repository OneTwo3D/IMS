/**
 * Daily batch sync — the core of the QuickBooks Sub-Ledger architecture.
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
import { getQuickBooksSettings } from '@/lib/connectors/quickbooks/settings'
import { Prisma } from '@/app/generated/prisma/client'
import {
  parseCostLayerSnapshot,
  reduceSnapshotByCostLayer,
  sumCostLayerSnapshot,
  takeFromSnapshotEntries,
  type CostLayerSnapshotEntry,
} from '@/lib/cost-layer-snapshots'
import { calculateCoverageByLine, requirementsMapToRows } from '@/lib/products/fulfillment-coverage'
import { expandFulfillmentRequirements, loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'

type MutableLayer = {
  id: string
  remainingQty: number
  unitCostBase: number
}

type LayerSnapshot = Map<string, MutableLayer[]>

type JournalLinePayload = {
  accountCode: string
  description: string
  debit?: number
  credit?: number
}

const QBO_DAILY_BATCH_LOCK_KEY = 4_112_208_032
const QBO_CONNECTOR = 'quickbooks'

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
      select: { id: true, remainingQty: true, unitCostBase: true },
    })
    snapshot.set(
      key,
      layers.map((layer) => ({
        id: layer.id,
        remainingQty: Number(layer.remainingQty),
        unitCostBase: Number(layer.unitCostBase),
      })),
    )
  }

  return snapshot
}

function consumeSnapshotLayers(
  snapshot: LayerSnapshot,
  productId: string,
  warehouseId: string,
  qty: number,
  trackDecrements?: Map<string, number>,
): CostLayerSnapshotEntry[] {
  const layers = snapshot.get(makeLayerKey(productId, warehouseId)) ?? []
  let remaining = qty
  const consumed: CostLayerSnapshotEntry[] = []

  for (const layer of layers) {
    if (remaining <= 0) break
    const take = Math.min(remaining, layer.remainingQty)
    if (take <= 0) continue
    consumed.push({
      costLayerId: layer.id,
      qty: take,
      unitCostBase: layer.unitCostBase,
    })
    layer.remainingQty -= take
    remaining -= take
    if (trackDecrements) {
      trackDecrements.set(layer.id, (trackDecrements.get(layer.id) ?? 0) + take)
    }
  }

  return consumed
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
      connector: QBO_CONNECTOR,
      type: params.type,
      status: 'PENDING',
      referenceType: 'DailyBatch',
      referenceId: params.referenceId,
      payload: params.payload as never,
    },
  })
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

async function resetFailedDailyBatchLogs(): Promise<void> {
  await db.accountingSyncLog.updateMany({
    where: {
      connector: QBO_CONNECTOR,
      type: { in: ['DAILY_BATCH_REVENUE_DEFERRAL', 'DAILY_BATCH_INVENTORY_ALLOC', 'DAILY_BATCH_GROUP_B'] },
      status: 'FAILED',
    },
    data: {
      status: 'PENDING',
      retryCount: 0,
      errorMessage: null,
      processingStartedAt: null,
    },
  })
}

type DailyBatchLogType = 'DAILY_BATCH_REVENUE_DEFERRAL' | 'DAILY_BATCH_INVENTORY_ALLOC' | 'DAILY_BATCH_GROUP_B'

async function hasLiveDailyBatchLog(type: DailyBatchLogType, referenceId: string): Promise<boolean> {
  const count = await db.accountingSyncLog.count({
    where: {
      connector: QBO_CONNECTOR,
      type,
      referenceId,
      status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] },
    },
  })
  return count > 0
}

async function recreateMissingDailyBatchLogs(settings: Awaited<ReturnType<typeof getQuickBooksSettings>>): Promise<void> {
  const orphanA1Orders = await db.salesOrder.findMany({
    where: { revenueDeferredDate: { not: null } },
    select: { revenueDeferredDate: true, unearnedRevenueAmount: true },
  })
  const orphanA2Orders = await db.salesOrder.findMany({
    where: { inventoryAllocatedDate: { not: null } },
    select: { inventoryAllocatedDate: true, allocationBatchAmount: true },
  })
  const orphanBShipments = await db.shipment.findMany({
    where: { shipmentJournalDate: { not: null } },
    select: { shipmentJournalDate: true, revenueRecognizedAmount: true, cogsBatchAmount: true },
  })

  const a1ByDate = new Map<string, { orderCount: number; total: number }>()
  for (const order of orphanA1Orders) {
    const stagedAt = order.revenueDeferredDate
    if (!stagedAt) continue
    const key = stagedAt.toISOString().slice(0, 10)
    const existing = a1ByDate.get(key) ?? { orderCount: 0, total: 0 }
    existing.orderCount += 1
    existing.total += Number(order.unearnedRevenueAmount ?? 0)
    a1ByDate.set(key, existing)
  }

  const a2ByDate = new Map<string, { orderCount: number; total: number }>()
  for (const order of orphanA2Orders) {
    const stagedAt = order.inventoryAllocatedDate
    if (!stagedAt) continue
    const key = stagedAt.toISOString().slice(0, 10)
    const existing = a2ByDate.get(key) ?? { orderCount: 0, total: 0 }
    existing.orderCount += 1
    existing.total += Number(order.allocationBatchAmount ?? 0)
    a2ByDate.set(key, existing)
  }

  const bByDate = new Map<string, { shipmentCount: number; revenue: number; cogs: number }>()
  for (const shipment of orphanBShipments) {
    const stagedAt = shipment.shipmentJournalDate
    if (!stagedAt) continue
    const key = stagedAt.toISOString().slice(0, 10)
    const existing = bByDate.get(key) ?? { shipmentCount: 0, revenue: 0, cogs: 0 }
    existing.shipmentCount += 1
    existing.revenue += Number(shipment.revenueRecognizedAmount ?? 0)
    existing.cogs += Number(shipment.cogsBatchAmount ?? 0)
    bByDate.set(key, existing)
  }

  for (const [date, summary] of a1ByDate) {
    const referenceId = `A1-${date}`
    if (summary.total <= 0 || await hasLiveDailyBatchLog('DAILY_BATCH_REVENUE_DEFERRAL', referenceId)) continue
    await db.accountingSyncLog.create({
      data: {
        connector: QBO_CONNECTOR,
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        status: 'PENDING',
        referenceType: 'DailyBatch',
        referenceId,
        payload: {
          date,
          reference: `Revenue Deferral ${date}`,
          narration: `Recreated revenue deferral batch: ${summary.orderCount} order(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.quickbooks_sales_account, description: `Daily revenue deferral — ${summary.orderCount} order(s)`, debit: round2(summary.total) },
            { accountCode: settings.quickbooks_unearned_revenue_account, description: `Daily revenue deferral — ${summary.orderCount} order(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        } as never,
      },
    })
  }

  for (const [date, summary] of a2ByDate) {
    const referenceId = `A2-${date}`
    if (summary.total <= 0 || await hasLiveDailyBatchLog('DAILY_BATCH_INVENTORY_ALLOC', referenceId)) continue
    await db.accountingSyncLog.create({
      data: {
        connector: QBO_CONNECTOR,
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        status: 'PENDING',
        referenceType: 'DailyBatch',
        referenceId,
        payload: {
          date,
          reference: `Inventory Allocation ${date}`,
          narration: `Recreated inventory allocation batch: ${summary.orderCount} order(s), £${round2(summary.total).toFixed(2)}`,
          lines: [
            { accountCode: settings.quickbooks_allocated_inventory_account, description: `Daily inventory allocation — ${summary.orderCount} order(s)`, debit: round2(summary.total) },
            { accountCode: settings.quickbooks_inventory_account, description: `Daily inventory allocation — ${summary.orderCount} order(s)`, credit: round2(summary.total) },
          ],
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        } as never,
      },
    })
  }

  for (const [date, summary] of bByDate) {
    const referenceId = `B-${date}`
    if ((summary.revenue <= 0 && summary.cogs <= 0) || await hasLiveDailyBatchLog('DAILY_BATCH_GROUP_B', referenceId)) continue
    const lines: JournalLinePayload[] = []
    if (round2(summary.revenue) > 0) {
      lines.push(
        { accountCode: settings.quickbooks_unearned_revenue_account, description: `Revenue recognition — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.revenue) },
        { accountCode: settings.quickbooks_sales_account, description: `Revenue recognition — ${summary.shipmentCount} shipment(s)`, credit: round2(summary.revenue) },
      )
    }
    if (round2(summary.cogs) > 0) {
      lines.push(
        { accountCode: settings.quickbooks_cogs_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, debit: round2(summary.cogs) },
        { accountCode: settings.quickbooks_allocated_inventory_account, description: `COGS — ${summary.shipmentCount} shipment(s)`, credit: round2(summary.cogs) },
      )
    }
    await db.accountingSyncLog.create({
      data: {
        connector: QBO_CONNECTOR,
        type: 'DAILY_BATCH_GROUP_B',
        status: 'PENDING',
        referenceType: 'DailyBatch',
        referenceId,
        payload: {
          date,
          reference: `Shipment COGS ${date}`,
          narration: `Recreated shipment batch: ${summary.shipmentCount} shipment(s), revenue £${round2(summary.revenue).toFixed(2)}, COGS £${round2(summary.cogs).toFixed(2)}`,
          lines,
          _postingMode: 'submitted',
          _recreatedFromStage: true,
        } as never,
      },
    })
  }
}

export async function runDailyBatchSync(): Promise<{
  groupA1: number
  groupA2: number
  groupB: number
  errors: string[]
}> {
  const result = { groupA1: 0, groupA2: 0, groupB: 0, errors: [] as string[] }
  const lockRows = await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${QBO_DAILY_BATCH_LOCK_KEY}) AS locked
  `
  if (!lockRows[0]?.locked) {
    result.errors.push('Daily batch already running')
    return result
  }

  try {
    const settings = await getQuickBooksSettings()
    const today = new Date().toISOString().slice(0, 10)

    if (settings.quickbooks_sync_enabled !== 'true') {
      return result
    }

    await resetFailedDailyBatchLogs()
    await recreateMissingDailyBatchLogs(settings)

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
        externalOrderNumber: true,
        totalBase: true,
        taxBase: true,
      },
    })

    if (orders.length > 0) {
      let totalRevenueDeferred = 0
      const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []

      for (const order of orders) {
        const salesValue = round2(Number(order.totalBase) - Number(order.taxBase))
        totalRevenueDeferred += salesValue
      }

      totalRevenueDeferred = round2(totalRevenueDeferred)

      if (totalRevenueDeferred > 0) {
        journalLines.push(
          { accountCode: settings.quickbooks_sales_account, description: `Daily revenue deferral — ${orders.length} order(s)`, debit: totalRevenueDeferred },
          { accountCode: settings.quickbooks_unearned_revenue_account, description: `Daily revenue deferral — ${orders.length} order(s)`, credit: totalRevenueDeferred },
        )
      }

      await db.$transaction(async (tx) => {
        if (journalLines.length > 0) {
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
          const salesValue = round2(Number(order.totalBase) - Number(order.taxBase))
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
        externalOrderNumber: true,
        allocations: {
          select: {
            id: true,
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
        const allocationSnapshots = new Map<string, CostLayerSnapshotEntry[]>()

        for (const order of orders) {
          let orderCostValue = 0

          for (const alloc of order.allocations) {
            const allocationSnapshot = consumeSnapshotLayers(
              snapshot,
              alloc.productId,
              alloc.warehouseId,
              Number(alloc.qty),
            )
            allocationSnapshots.set(alloc.id, allocationSnapshot)
            orderCostValue += sumCostLayerSnapshot(allocationSnapshot)
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
                { accountCode: settings.quickbooks_allocated_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, debit: totalAllocatedValue },
                { accountCode: settings.quickbooks_inventory_account, description: `Daily inventory allocation — ${orders.length} order(s)`, credit: totalAllocatedValue },
              ],
              _postingMode: 'submitted',
            },
          })
        }

        for (const order of orders) {
          for (const alloc of order.allocations) {
            await tx.orderAllocation.update({
              where: { id: alloc.id },
              data: {
                costLayerSnapshot: (allocationSnapshots.get(alloc.id) ?? []) as never,
              },
            })
          }
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
    const groupBCount = await db.$transaction(async (tx) => {
      const shipments = await tx.shipment.findMany({
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
          createdAt: true,
          lines: {
            select: {
              id: true,
              lineId: true,
              productId: true,
              qty: true,
              line: {
                select: { id: true, productId: true, qty: true, totalBase: true },
              },
            },
          },
          order: {
            select: {
              orderNumber: true,
              externalOrderNumber: true,
              status: true,
              totalBase: true,
              unearnedRevenueAmount: true,
              lines: { select: { id: true, productId: true, qty: true, totalBase: true } },
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

      if (shipments.length === 0) {
        return 0
      }

      let totalRevenue = 0
      let totalCogs = 0
      const layerDecrements = new Map<string, number>()
      const shipmentResults = new Map<string, { revenue: number; cogs: number }>()
      const shipmentSnapshots = new Map<string, CostLayerSnapshotEntry[]>()
      const shipmentsByOrder = new Map<string, typeof shipments>()
      const orderIds = Array.from(new Set(shipments.map((shipment) => shipment.orderId)))

      const [orderAllocations, priorShipmentLines, priorRefundLines] = await Promise.all([
        tx.orderAllocation.findMany({
          where: { orderId: { in: orderIds } },
          select: {
            id: true,
            orderId: true,
            lineId: true,
            productId: true,
            warehouseId: true,
            costLayerSnapshot: true,
          },
        }),
        tx.shipmentLine.findMany({
          where: {
            shipment: {
              orderId: { in: orderIds },
              shipmentJournalDate: { not: null },
            },
          },
          select: {
            costLayerSnapshot: true,
          },
        }),
        tx.salesOrderRefundLine.findMany({
          where: {
            refund: {
              orderId: { in: orderIds },
            },
          },
          select: {
            costLayerSnapshot: true,
          },
        }),
      ])

      const referencedCostLayerIds = Array.from(new Set(
        orderAllocations.flatMap((allocation) => (
          parseCostLayerSnapshot(allocation.costLayerSnapshot).map((entry) => entry.costLayerId)
        )),
      ))
      await lockCostLayers(tx, referencedCostLayerIds)
      const graph = await loadFulfillmentProductGraph(
        tx,
        Array.from(new Set(
          shipments.flatMap((shipment) => (
            shipment.order.lines.map((line) => line.productId).filter((value): value is string => !!value)
          )),
        )),
      )

      const allocationAvailability = new Map<string, CostLayerSnapshotEntry[]>()
      for (const allocation of orderAllocations) {
        allocationAvailability.set(
          allocation.id,
          parseCostLayerSnapshot(allocation.costLayerSnapshot),
        )
      }

      for (const priorShipmentLine of priorShipmentLines) {
        for (const entry of parseCostLayerSnapshot(priorShipmentLine.costLayerSnapshot)) {
          if (!entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
          )
        }
      }

      for (const priorRefundLine of priorRefundLines) {
        for (const entry of parseCostLayerSnapshot(priorRefundLine.costLayerSnapshot)) {
          if (entry.source !== 'allocation' || !entry.orderAllocationId) continue
          const available = allocationAvailability.get(entry.orderAllocationId) ?? []
          allocationAvailability.set(
            entry.orderAllocationId,
            reduceSnapshotByCostLayer(available, [{ costLayerId: entry.costLayerId, qty: entry.qty }]),
          )
        }
      }

      for (const shipment of shipments) {
        const existing = shipmentsByOrder.get(shipment.orderId) ?? []
        existing.push(shipment)
        shipmentsByOrder.set(shipment.orderId, existing)
      }

      for (const [orderId, orderShipments] of shipmentsByOrder) {
        const firstShipment = orderShipments[0]
        try {
        const deferredBase = Number(firstShipment.order.unearnedRevenueAmount ?? firstShipment.order.totalBase)
        const orderLineTotal = firstShipment.order.lines.reduce((sum, line) => sum + Number(line.totalBase), 0)
        const requirementsByLine = new Map(
          firstShipment.order.lines
            .filter((line) => !!line.productId)
            .map((line) => [
              line.id,
              requirementsMapToRows(expandFulfillmentRequirements(line.productId!, 1, graph)),
            ]),
        )
        const orderLineById = new Map(firstShipment.order.lines.map((line) => [line.id, line]))
        const recognizedPreviously = firstShipment.order.shipments.reduce((sum, shipment) => (
          shipment.shipmentJournalDate ? sum + Number(shipment.revenueRecognizedAmount ?? 0) : sum
        ), 0)
        const remainingDeferred = round2(Math.max(0, deferredBase - recognizedPreviously))
        let runningRevenue = 0

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
          const shipmentCostSnapshot: CostLayerSnapshotEntry[] = []
          for (const sl of shipment.lines) {
            let remainingQty = Number(sl.qty)
            const matchingAllocations = orderAllocations.filter((allocation) => (
              allocation.orderId === shipment.orderId
              && allocation.lineId === sl.lineId
              && allocation.productId === sl.productId
              && allocation.warehouseId === shipment.warehouseId
            ))

            for (const allocation of matchingAllocations) {
              if (remainingQty <= 0) break
              const availableEntries = allocationAvailability.get(allocation.id) ?? []
              const consumed = takeFromSnapshotEntries(availableEntries, remainingQty, {
                orderAllocationId: allocation.id,
                shipmentLineId: sl.id,
                source: 'shipment',
              })
              shipmentCostSnapshot.push(...consumed.taken)
              remainingQty = consumed.remainingQty
              allocationAvailability.set(
                allocation.id,
                reduceSnapshotByCostLayer(
                  availableEntries,
                  consumed.taken.map((entry) => ({ costLayerId: entry.costLayerId, qty: entry.qty })),
                ),
              )
            }

            if (remainingQty > 0.0000001) {
              throw new Error(`Missing allocated cost layers for shipment line ${sl.id}`)
            }
          }

          for (const entry of shipmentCostSnapshot) {
            layerDecrements.set(entry.costLayerId, (layerDecrements.get(entry.costLayerId) ?? 0) + entry.qty)
          }

          const shipmentCogs = round2(sumCostLayerSnapshot(shipmentCostSnapshot))
          totalRevenue += revenueProportion
          totalCogs += shipmentCogs
          runningRevenue += revenueProportion
          shipmentResults.set(shipment.id, { revenue: revenueProportion, cogs: shipmentCogs })
          for (const sl of shipment.lines) {
            shipmentSnapshots.set(
              sl.id,
              shipmentCostSnapshot.filter((entry) => entry.shipmentLineId === sl.id),
            )
          }
        }
        } catch (orderError) {
          const orderRef = firstShipment.order.orderNumber ?? firstShipment.order.externalOrderNumber ?? orderId.slice(0, 8)
          result.errors.push(`Group B order ${orderRef}: ${String(orderError)}`)
          for (const s of orderShipments) {
            const sr = shipmentResults.get(s.id)
            if (sr) {
              totalRevenue -= sr.revenue
              totalCogs -= sr.cogs
              shipmentResults.delete(s.id)
            }
            for (const sl of s.lines) shipmentSnapshots.delete(sl.id)
          }
        }
      }

      const journalLines: JournalLinePayload[] = []

      if (totalRevenue > 0) {
        journalLines.push(
          { accountCode: settings.quickbooks_unearned_revenue_account, description: `Revenue recognition — ${shipments.length} shipment(s)`, debit: totalRevenue },
          { accountCode: settings.quickbooks_sales_account, description: `Revenue recognition — ${shipments.length} shipment(s)`, credit: totalRevenue },
        )
      }

      if (totalCogs > 0) {
        journalLines.push(
          { accountCode: settings.quickbooks_cogs_account, description: `COGS — ${shipments.length} shipment(s)`, debit: totalCogs },
          { accountCode: settings.quickbooks_allocated_inventory_account, description: `COGS — ${shipments.length} shipment(s)`, credit: totalCogs },
        )
      }

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

      // Only mark shipments that were successfully processed. Failed
      // orders had their results removed from shipmentResults by the
      // per-order catch block — those shipments must remain untouched
      // (shipmentJournalDate stays null) so the next batch run retries.
      for (const shipment of shipments) {
        const resultForShipment = shipmentResults.get(shipment.id)
        if (!resultForShipment) continue // failed order — skip, leave retryable
        for (const line of shipment.lines) {
          const lineSnapshot = shipmentSnapshots.get(line.id)
          if (lineSnapshot) {
            await tx.shipmentLine.update({
              where: { id: line.id },
              data: {
                costLayerSnapshot: lineSnapshot as never,
              },
            })
          }
        }
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

      return shipments.length
    })
    if (groupBCount > 0) {
      result.groupB = groupBCount
    }
  } catch (e) {
    result.errors.push(`Group B error: ${String(e)}`)
  }

    // Log summary
    if (result.groupA1 > 0 || result.groupA2 > 0 || result.groupB > 0) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'quickbooks_daily_batch',
        tag: 'sync',
        level: 'INFO',
        description: `Daily batch: A1=${result.groupA1} deferred, A2=${result.groupA2} allocated, B=${result.groupB} shipped`,
        metadata: result,
        resolveUser: false,
      })
    }

    return result
  } finally {
    await db.$executeRaw`SELECT pg_advisory_unlock(${QBO_DAILY_BATCH_LOCK_KEY})`
  }
}
