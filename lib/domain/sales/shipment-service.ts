import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { consumeFifoLayersStrict, refreshSalesOrderLineCogs } from '@/lib/cost-layers'
import { addMoney, multiplyMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  validateSalesOrderStatusTransition,
  validateShipmentStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import {
  lockSalesOrder,
  lockStockLevels,
  validateAllocationIntegrity,
} from '@/lib/domain/sales/allocation-service'
import {
  isStockMovementIdempotencyConflict,
  saleDispatchMovementKey,
} from '@/lib/domain/inventory/stock-movement-idempotency'
import { buildStockMovementValueFieldsFromConsumed } from '@/lib/domain/inventory/stock-movement-value'

export const SHIPMENT_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

/**
 * Deliberate call-site boundary for this number-shaped shipment service contract.
 * Do not treat this as Decimal-internal arithmetic.
 */
function shipmentBoundaryNumber(value: DecimalInput): number {
  return toDecimal(value).toNumber()
}

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
    qty: DecimalInput
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

async function loadShipmentTransitionContext(
  client: ShipmentServiceClient,
  shipmentId: string,
): Promise<ShipmentTransitionContext | null> {
  return client.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true, status: true } },
      lines: { select: { id: true, lineId: true, productId: true, qty: true, product: { select: { sku: true } } } },
      warehouse: { select: { code: true } },
    },
  }) as Promise<ShipmentTransitionContext | null>
}

function shipmentLineDispatchFingerprint(line: ShipmentTransitionContext['lines'][number]): string {
  return [
    line.id,
    line.lineId,
    line.productId,
    shipmentBoundaryNumber(line.qty),
  ].join('|')
}

function hasSameShipmentLines(
  currentLines: ShipmentTransitionContext['lines'],
  lockedLines: ShipmentTransitionContext['lines'],
): boolean {
  if (currentLines.length !== lockedLines.length) return false
  const currentFingerprints = currentLines.map(shipmentLineDispatchFingerprint).sort()
  const lockedFingerprints = lockedLines.map(shipmentLineDispatchFingerprint).sort()
  return currentFingerprints.every((fingerprint, index) => fingerprint === lockedFingerprints[index])
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
        (committedByAllocationKey.get(key) ?? 0) + shipmentBoundaryNumber(shipmentLine.qty),
      )
    }

    const effectiveAllocs = allocs.map((alloc) => {
      const key = `${alloc.lineId}|${alloc.warehouseId}|${alloc.productId}`
      const committed = committedByAllocationKey.get(key) ?? 0
      const effectiveQty = Math.max(0, shipmentBoundaryNumber(alloc.qty) - committed)
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
        totalQty: whAllocs.reduce((sum, allocation) => sum + shipmentBoundaryNumber(allocation.qty), 0),
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
  const shipment = await loadShipmentTransitionContext(client, shipmentId)
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

    const dispatchResult = await runInTransaction(client, async (tx) => {
      await lockSalesOrder(tx, shipment.orderId)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "shipments" WHERE id = ${shipmentId} FOR UPDATE`,
      )

      const lockedShipment = await loadShipmentTransitionContext(tx, shipmentId)
      if (!lockedShipment) throw new Error('Shipment not found')
      if (lockedShipment.status !== shipment.status) {
        return {
          success: false as const,
          error: `Shipment status changed from ${shipment.status} to ${lockedShipment.status}. Reload and retry.`,
        }
      }
      if (!hasSameShipmentLines(shipment.lines, lockedShipment.lines)) {
        return {
          success: false as const,
          error: 'Shipment lines changed. Reload and retry.',
        }
      }

      const lockedTransition = validateShipmentStatusTransition(lockedShipment.status, targetStatus)
      if (!lockedTransition.success) throw new Error(lockedTransition.error)

      if (lockedShipment.lines.length === 0) {
        return {
          success: false as const,
          error: 'Shipment has no lines to dispatch',
        }
      }

      const lockedProductIds = [...new Set(lockedShipment.lines.map((line) => line.productId))]

      await tx.shipment.update({ where: { id: shipmentId }, data })
      const updatedShipment = await loadShipmentTransitionContext(tx, shipmentId)
      if (!updatedShipment) throw new Error('Shipment not found')

      await lockStockLevels(tx, lockedProductIds, [lockedShipment.warehouseId])
      let totalShipmentCogs = toDecimal(0)
      for (const line of lockedShipment.lines) {
        const qty = shipmentBoundaryNumber(line.qty)
        const qtyForDb = String(line.qty ?? 0)
        const idempotencyKey = saleDispatchMovementKey(line.id)
        let movement: { id: string } | null = null
        try {
          movement = await tx.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId: line.productId,
              fromWarehouseId: lockedShipment.warehouseId,
              qty,
              note: `Dispatched for order — shipment from ${lockedShipment.warehouse.code}`,
              referenceType: 'SalesOrder',
              referenceId: lockedShipment.orderId,
              idempotencyKey,
            },
            select: { id: true },
          })
        } catch (error) {
          if (!isStockMovementIdempotencyConflict(error)) throw error
        }
        if (!movement) {
          movement = await tx.stockMovement.findUnique({
            where: { idempotencyKey },
            select: { id: true },
          })
          if (!movement) throw new Error('Dispatched stock movement was not persisted')
          continue
        }

        const updatedStock = await tx.stockLevel.updateMany({
          where: {
            productId: line.productId,
            warehouseId: lockedShipment.warehouseId,
            quantity: { gte: qtyForDb },
            reservedQty: { gte: qtyForDb },
          },
          data: {
            quantity: { decrement: qtyForDb },
            reservedQty: { decrement: qtyForDb },
          },
        })
        if (updatedStock.count !== 1) {
          throw new Error(`Insufficient physical or reserved stock to dispatch ${line.product.sku}`)
        }

        const { consumed, totalCost } = await consumeFifoLayersStrict(
          tx, line.productId, lockedShipment.warehouseId, qty,
        )
        totalShipmentCogs = addMoney(totalShipmentCogs, totalCost)
        await tx.stockMovement.update({
          where: { id: movement.id },
          data: buildStockMovementValueFieldsFromConsumed(consumed),
        })
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => ({
              costLayerId: entry.costLayerId,
              movementId: movement.id,
              qty: entry.qty.toNumber(),
              unitCostBase: entry.unitCostBase.toNumber(),
              totalCostBase: roundQuantity(multiplyMoney(entry.qty, entry.unitCostBase), 6).toNumber(),
            })),
          })
          await tx.shipmentLine.update({
            where: { id: line.id },
            data: {
              costLayerSnapshot: consumed.map((entry) => ({
                costLayerId: entry.costLayerId,
                qty: entry.qty.toNumber(),
                unitCostBase: entry.unitCostBase.toNumber(),
              })),
            },
          })
        }
      }

      if (totalShipmentCogs.gt(0)) {
        await tx.shipment.update({
          where: { id: shipmentId },
          data: { cogsBatchAmount: roundQuantity(totalShipmentCogs, 2).toNumber() },
        })
      }

      await refreshSalesOrderLineCogs(
        tx,
        lockedShipment.lines.map((line) => line.lineId),
      )

      return {
        success: true as const,
        shipment: updatedShipment,
        stockSyncProductIds: lockedProductIds,
      }
    })

    if (!dispatchResult.success) {
      return dispatchResult
    }

    return {
      success: true,
      transitioned: true,
      dispatched: true,
      shipment: dispatchResult.shipment,
      targetStatus,
      previousStatus: shipment.status,
      stockSyncProductIds: dispatchResult.stockSyncProductIds,
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
