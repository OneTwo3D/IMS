import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { consumeFifoLayersStrict, refreshSalesOrderLineCogs } from '@/lib/cost-layers'
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import {
  validateSalesOrderStatusTransition,
  validateShipmentStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import {
  lockSalesOrder,
  lockStockLevels,
  validateAllocationIntegrity,
} from '@/lib/domain/sales/allocation-service'

export const SHIPMENT_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

export type ShipmentServiceClient = Prisma.TransactionClient | typeof db

export type ConfirmShipmentsResult = {
  orderNumber: string | null
  shipmentCount: number
  deletedPendingCount: number
  createdShipments: Array<{ id: string; warehouseId: string; lineCount: number; totalQty: number }>
}

export type ShipmentTransitionContext = {
  id: string
  orderId: string
  warehouseId: string
  status: string
  warehouse: { code: string }
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null; status: string }
  lines: Array<{
    id: string
    lineId: string
    productId: string
    qty: DecimalLike
    product: { sku: string }
  }>
}

export type ShipmentTransitionResult =
  | { success: false; error: string }
  | {
      success: true
      transitioned: boolean
      dispatched: boolean
      shipment: ShipmentTransitionContext
      targetStatus: string
      previousStatus: string
      stockSyncProductIds: string[]
    }

export type ShipmentReconciliationResult = {
  shouldGenerateInvoice: boolean
  orderId: string
}

function canRunTransaction(
  client: ShipmentServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

async function runInTransaction<T>(
  client: ShipmentServiceClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return canRunTransaction(client)
    ? client.$transaction(callback, SHIPMENT_TX_OPTIONS)
    : callback(client)
}

export async function confirmSalesOrderShipments(
  client: ShipmentServiceClient,
  orderId: string,
): Promise<ConfirmShipmentsResult> {
  return runInTransaction(client, async (tx) => {
    await lockSalesOrder(tx, orderId)
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, externalOrderNumber: true, status: true },
    })
    if (!so) throw new Error('Order not found')

    const allocs = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })
    if (!allocs.length) throw new Error('No allocations to confirm')

    const activeShipmentLines = await tx.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: { lineId: true, productId: true, shipment: { select: { warehouseId: true } }, qty: true },
    })
    const committedByAllocationKey = new Map<string, number>()
    for (const shipmentLine of activeShipmentLines) {
      const key = `${shipmentLine.lineId}|${shipmentLine.shipment.warehouseId}|${shipmentLine.productId}`
      committedByAllocationKey.set(
        key,
        (committedByAllocationKey.get(key) ?? 0) + decimalToNumber(shipmentLine.qty),
      )
    }

    const effectiveAllocs = allocs.map((alloc) => {
      const key = `${alloc.lineId}|${alloc.warehouseId}|${alloc.productId}`
      const committed = committedByAllocationKey.get(key) ?? 0
      const effectiveQty = Math.max(0, decimalToNumber(alloc.qty) - committed)
      return { ...alloc, qty: effectiveQty }
    }).filter((alloc) => alloc.qty > 0)

    if (!effectiveAllocs.length) {
      throw new Error('All allocated lines are already covered by active shipments')
    }

    const integrityError = await validateAllocationIntegrity(tx, orderId)
    if (integrityError) throw new Error(integrityError)

    const pendingShipmentMetadata = await tx.shipment.findMany({
      where: { orderId, status: 'PENDING' },
      select: { warehouseId: true, trackingNumber: true, shippingService: true },
    })
    const pendingMetadataByWarehouse = new Map(
      pendingShipmentMetadata.map((shipment) => [shipment.warehouseId, shipment]),
    )

    const deletedPending = await tx.shipment.deleteMany({ where: { orderId, status: 'PENDING' } })

    const byWarehouse = new Map<string, typeof effectiveAllocs>()
    for (const allocation of effectiveAllocs) {
      const group = byWarehouse.get(allocation.warehouseId) ?? []
      group.push(allocation)
      byWarehouse.set(allocation.warehouseId, group)
    }

    const createdShipments: ConfirmShipmentsResult['createdShipments'] = []
    for (const [warehouseId, whAllocs] of byWarehouse) {
      const pendingMetadata = pendingMetadataByWarehouse.get(warehouseId)
      const created = await tx.shipment.create({
        data: {
          orderId,
          warehouseId,
          status: 'PENDING',
          trackingNumber: pendingMetadata?.trackingNumber ?? null,
          shippingService: pendingMetadata?.shippingService ?? null,
          lines: {
            create: whAllocs.map((allocation) => ({
              lineId: allocation.lineId,
              productId: allocation.productId,
              qty: allocation.qty,
            })),
          },
        },
        select: { id: true },
      })
      createdShipments.push({
        id: created.id,
        warehouseId,
        lineCount: whAllocs.length,
        totalQty: whAllocs.reduce((sum, allocation) => sum + decimalToNumber(allocation.qty), 0),
      })
    }

    if (so.status !== 'ALLOCATED') {
      const transition = validateSalesOrderStatusTransition(so.status, 'ALLOCATED')
      if (!transition.success) throw new Error(transition.error)
      await tx.salesOrder.update({
        where: { id: orderId },
        data: { status: 'ALLOCATED' },
      })
    }

    return {
      orderNumber: so.orderNumber ?? so.externalOrderNumber,
      shipmentCount: byWarehouse.size,
      deletedPendingCount: deletedPending.count,
      createdShipments,
    }
  })
}

export async function transitionShipmentStatus(
  client: ShipmentServiceClient,
  input: {
    shipmentId: string
    targetStatus: string
    extra?: { trackingNumber?: string; shippingService?: string }
  },
): Promise<ShipmentTransitionResult> {
  const { shipmentId, targetStatus, extra } = input
  const shipment = await client.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true, status: true } },
      lines: { select: { id: true, lineId: true, productId: true, qty: true, product: { select: { sku: true } } } },
      warehouse: { select: { code: true } },
    },
  }) as ShipmentTransitionContext | null
  if (!shipment) return { success: false, error: 'Shipment not found' }

  const stockSyncProductIds = [...new Set(shipment.lines.map((line) => line.productId))]
  if (shipment.status === targetStatus) {
    return {
      success: true,
      transitioned: false,
      dispatched: false,
      shipment,
      targetStatus,
      previousStatus: shipment.status,
      stockSyncProductIds,
    }
  }

  const transition = validateShipmentStatusTransition(shipment.status, targetStatus)
  if (!transition.success) {
    return { success: false, error: transition.error }
  }

  const data: Record<string, unknown> = { status: targetStatus }
  if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
  if (extra?.shippingService) data.shippingService = extra.shippingService

  if (targetStatus === 'SHIPPED') {
    data.shippedAt = new Date()

    const dispatched = await runInTransaction(client, async (tx) => {
      await lockSalesOrder(tx, shipment.orderId)
      const locked = await tx.shipment.findUnique({
        where: { id: shipmentId },
        select: { status: true },
      })
      if (locked?.status !== shipment.status) {
        return false
      }

      await tx.shipment.update({ where: { id: shipmentId }, data })

      await lockStockLevels(tx, stockSyncProductIds, [shipment.warehouseId])
      let totalShipmentCogs = 0
      for (const line of shipment.lines) {
        const qty = decimalToNumber(line.qty)
        await tx.stockLevel.updateMany({
          where: { productId: line.productId, warehouseId: shipment.warehouseId },
          data: { reservedQty: { decrement: qty } },
        })
        await tx.stockLevel.updateMany({
          where: { productId: line.productId, warehouseId: shipment.warehouseId },
          data: { quantity: { decrement: qty } },
        })
        const movement = await tx.stockMovement.create({
          data: {
            type: 'SALE_DISPATCH',
            productId: line.productId,
            fromWarehouseId: shipment.warehouseId,
            qty,
            note: `Dispatched for order — shipment from ${shipment.warehouse.code}`,
            referenceType: 'SalesOrder',
            referenceId: shipment.orderId,
          },
          select: { id: true },
        })

        const { consumed, totalCost } = await consumeFifoLayersStrict(
          tx, line.productId, shipment.warehouseId, qty,
        )
        totalShipmentCogs += totalCost
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => ({
              costLayerId: entry.costLayerId,
              movementId: movement.id,
              qty: entry.qty,
              unitCostBase: entry.unitCostBase,
              totalCostBase: Math.round(entry.qty * entry.unitCostBase * 1000000) / 1000000,
            })),
          })
          await tx.shipmentLine.update({
            where: { id: line.id },
            data: {
              costLayerSnapshot: consumed.map((entry) => ({
                costLayerId: entry.costLayerId,
                qty: entry.qty,
                unitCostBase: entry.unitCostBase,
              })),
            },
          })
        }
      }

      if (totalShipmentCogs > 0) {
        await tx.shipment.update({
          where: { id: shipmentId },
          data: { cogsBatchAmount: Math.round(totalShipmentCogs * 100) / 100 },
        })
      }

      await refreshSalesOrderLineCogs(
        tx,
        shipment.lines.map((line) => line.lineId),
      )

      return true
    })

    return {
      success: true,
      transitioned: dispatched,
      dispatched,
      shipment,
      targetStatus,
      previousStatus: shipment.status,
      stockSyncProductIds,
    }
  }

  const transitioned = await runInTransaction(client, async (tx) => {
    await tx.$executeRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`
    const locked = await tx.shipment.findUnique({
      where: { id: shipmentId },
      select: { status: true },
    })
    if (!locked) throw new Error('Shipment not found')
    if (locked.status === targetStatus) return false
    const lockedTransition = validateShipmentStatusTransition(locked.status, targetStatus)
    if (!lockedTransition.success) throw new Error(lockedTransition.error)
    await tx.shipment.update({ where: { id: shipmentId }, data })
    return true
  })

  return {
    success: true,
    transitioned,
    dispatched: false,
    shipment,
    targetStatus,
    previousStatus: shipment.status,
    stockSyncProductIds,
  }
}

export async function reconcileOrderAfterShipment(
  client: ShipmentServiceClient,
  shipment: { orderId: string },
  extra?: { trackingNumber?: string },
): Promise<ShipmentReconciliationResult> {
  const allShipments = await client.shipment.findMany({
    where: { orderId: shipment.orderId },
    select: { id: true, status: true },
  })
  const allShipped = allShipments.every((row) => row.status === 'SHIPPED')
  if (!allShipped) {
    return { shouldGenerateInvoice: false, orderId: shipment.orderId }
  }

  const shippedShipments = await client.shipment.findMany({
    where: { orderId: shipment.orderId },
    select: { trackingNumber: true },
  })
  const trackingNumbers = shippedShipments
    .map((row) => row.trackingNumber)
    .filter(Boolean)
    .join(', ')

  await runInTransaction(client, async (tx) => {
    await tx.$executeRaw`SELECT id FROM sales_orders WHERE id = ${shipment.orderId} FOR UPDATE`
    const currentOrder = await tx.salesOrder.findUnique({
      where: { id: shipment.orderId },
      select: { status: true },
    })
    if (!currentOrder) return
    if (['SHIPPED', 'COMPLETED', 'DELIVERED', 'REFUNDED', 'CANCELLED'].includes(currentOrder.status)) return

    const transition = validateSalesOrderStatusTransition(currentOrder.status, 'SHIPPED')
    if (!transition.success) throw new Error(transition.error)
    await tx.salesOrder.update({
      where: { id: shipment.orderId },
      data: {
        status: 'SHIPPED',
        shippedAt: new Date(),
        trackingNumber: trackingNumbers || (extra?.trackingNumber ?? null),
      },
    })
  })

  const trigger = await client.setting.findUnique({ where: { key: 'invoice_trigger' } })
  return {
    shouldGenerateInvoice: trigger?.value === 'on_shipped',
    orderId: shipment.orderId,
  }
}
