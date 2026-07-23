import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import { cogsEntryDataFromConsumed, consumeFifoLayersStrict, refreshSalesOrderLineCogs } from '@/lib/cost-layers'
import { serializeCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { addMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
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
import { expandFulfillmentRequirementsDecimal, loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { withSavepoint } from '@/lib/db/savepoint'

export const SHIPMENT_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
const SHIPMENT_QTY_EPSILON_DECIMAL = new Prisma.Decimal('0.000001')

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

async function validateActiveShipmentTotalsWithinOrder(
  client: ShipmentServiceClient,
  orderId: string,
): Promise<string | null> {
  // Non-PENDING shipment lines are already committed to the order's fulfilment
  // plan, so this check intentionally includes PICKING/PACKED rows as well as
  // SHIPPED rows. That makes concurrent dispatches race-safe for total-qty
  // validation: both transactions see the same active planned shipment set.
  const [orderLines, activeShipmentLines, refundLines] = await Promise.all([
    client.salesOrderLine.findMany({
      where: { orderId },
      select: { id: true, productId: true, qty: true, sku: true, description: true },
    }),
    client.shipmentLine.findMany({
      where: { shipment: { orderId, status: { not: 'PENDING' } } },
      select: { lineId: true, productId: true, qty: true, shipment: { select: { status: true } } },
    }),
    // o3d-339: refunded units must never be dispatched. A PENDING shipment built BEFORE a refund lands
    // is not rebuilt on refund — releaseReservationsAfterRefund refuses the reservation release while a
    // shipment exists (post-refund-release.ts) and defers — so without netting refunds here that stale,
    // now-PACKED shipment could ship goods the customer was refunded for. confirmSalesOrderShipments
    // already nets refunds at BUILD time; this is the dispatch-time backstop for a shipment that
    // predates the refund. Runs under the order lock (transitionShipmentStatus), so a concurrent refund
    // is serialized.
    client.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      select: { salesOrderLineId: true, productId: true, qty: true },
    }),
  ])

  // Shipment lines are LEAF-product rows: a kit order line expands to its component products, so a kit
  // line can have several shipment lines (one per component) under the same lineId. All quantities must
  // therefore be compared in leaf-product units keyed by (orderLineId, productId) — expand each order
  // line's ordered qty AND each refund's refunded qty through the kit/BOM graph, exactly as
  // confirmSalesOrderShipments nets refunds at build time. Comparing component shipment qty against
  // parent-kit ordered/refunded qty would let a fractional-component kit slip refunded units past the
  // cap (e.g. two kits needing 0.1 of a component ship 0.2, but a per-kit cap of 1 would pass it).
  //
  // NB: this expands ordered/refunded qty through the CURRENT kit graph, matching the existing
  // build-time refund netting (confirmSalesOrderShipments) and the allocation path — the codebase has
  // no immutable per-order BOM snapshot, so a kit re-composed BETWEEN packing and dispatch can drift
  // this cap. Fixing that uniformly (persist a per-order-line fulfillment snapshot, or lock kit edits
  // while orders are in flight) is systemic and tracked separately; this guard is a strict improvement
  // over shipping every refunded unit and shares the same live-graph assumption already in force.
  const productIds = [...new Set([
    ...orderLines.map((line) => line.productId).filter((id): id is string => !!id),
    ...refundLines.map((refundLine) => refundLine.productId).filter((id): id is string => !!id),
  ])]
  const graph = productIds.length > 0 ? await loadFulfillmentProductGraph(client, productIds) : new Map()

  const lineLabelById = new Map<string, string>()
  const orderedByLeaf = new Map<string, Prisma.Decimal>()
  for (const line of orderLines) {
    lineLabelById.set(line.id, line.sku ?? line.description ?? line.id)
    if (!line.productId) continue // a description-only line has no product to ship
    for (const [componentId, componentQty] of expandFulfillmentRequirementsDecimal(line.productId, toDecimal(line.qty), graph)) {
      const key = `${line.id}|${componentId}`
      orderedByLeaf.set(key, (orderedByLeaf.get(key) ?? new Prisma.Decimal(0)).add(componentQty))
    }
  }

  const refundedByLeaf = new Map<string, Prisma.Decimal>()
  for (const refundLine of refundLines) {
    // An unmatched external refund (no order line / no product) can't be attributed to a leaf — skip it.
    if (!refundLine.salesOrderLineId || !refundLine.productId) continue
    for (const [componentId, componentQty] of expandFulfillmentRequirementsDecimal(refundLine.productId, toDecimal(refundLine.qty), graph)) {
      const key = `${refundLine.salesOrderLineId}|${componentId}`
      refundedByLeaf.set(key, (refundedByLeaf.get(key) ?? new Prisma.Decimal(0)).add(componentQty))
    }
  }

  // Split active leaf qty into ALREADY-SHIPPED (historical, cannot be un-shipped) and STILL-PLANNED
  // (PICKING/PACKED — what a dispatch is about to send). A POST-shipment refund (a return) legitimately
  // pushes already-shipped qty above ordered-minus-refunded; counting SHIPPED rows in the dispatch cap
  // would then wedge every future dispatch on the order (line A shipped-then-refunded fails the recheck,
  // blocking an unrelated PACKED line B). So only the still-planned qty is capped, against what remains
  // to ship after refunds AND after what already shipped (o3d-339).
  const shippedByLeaf = new Map<string, Prisma.Decimal>()
  const plannedByLeaf = new Map<string, { lineId: string; plannedQty: Prisma.Decimal }>()
  for (const shipmentLine of activeShipmentLines) {
    const key = `${shipmentLine.lineId}|${shipmentLine.productId}`
    if (shipmentLine.shipment.status === 'SHIPPED') {
      shippedByLeaf.set(key, (shippedByLeaf.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(shipmentLine.qty)))
    } else {
      const entry = plannedByLeaf.get(key) ?? { lineId: shipmentLine.lineId, plannedQty: new Prisma.Decimal(0) }
      entry.plannedQty = entry.plannedQty.add(toDecimal(shipmentLine.qty))
      plannedByLeaf.set(key, entry)
    }
  }

  for (const [key, { lineId, plannedQty }] of plannedByLeaf) {
    const label = lineLabelById.get(lineId)
    if (!label) {
      return `Shipment line ${lineId} no longer belongs to this order. Reload and retry.`
    }
    const orderedQty = orderedByLeaf.get(key) ?? new Prisma.Decimal(0)
    const refundedQty = refundedByLeaf.get(key) ?? new Prisma.Decimal(0)
    const shippedQty = shippedByLeaf.get(key) ?? new Prisma.Decimal(0)
    // Still shippable = ordered − refunded − already-shipped, never below zero. Only the not-yet-shipped
    // planned quantity is checked against it, so a historical post-ship refund doesn't fail the order.
    let shippableQty = orderedQty.sub(refundedQty).sub(shippedQty)
    if (shippableQty.lt(0)) shippableQty = new Prisma.Decimal(0)
    if (plannedQty.gt(shippableQty.add(SHIPMENT_QTY_EPSILON_DECIMAL))) {
      if (refundedQty.gt(0)) {
        // A PACKED shipment can't be rebuilt via confirmSalesOrderShipments (it only replaces PENDING
        // shipments) — this was packed before the refund, so it needs an operator to unpack/cancel and
        // rebuild it to the reduced quantity (tracked as the o3d-339 recovery follow-up).
        return `Shipment for line ${label} would ship more than remains after refunds — it was packed before the refund landed. Unpack or cancel this shipment and rebuild it to exclude the refunded units.`
      }
      return `Shipment quantity for line ${label} exceeds ordered quantity. Reload and retry.`
    }
  }

  return null
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

    const allocAfterShipments = allocs.map((alloc) => {
      const key = `${alloc.lineId}|${alloc.warehouseId}|${alloc.productId}`
      const committed = committedByAllocationKey.get(key) ?? 0
      const effectiveQty = Math.max(0, shipmentBoundaryNumber(alloc.qty) - committed)
      return { ...alloc, qty: effectiveQty }
    }).filter((alloc) => alloc.qty > 0)

    // Refunded units must not ship even if stale allocation rows still reserve them
    // (refund state is orthogonal now and a refund does not delete allocations).
    // Allocations are leaf-product rows, so a refunded sales line is expanded to its
    // component requirements (kit/BOM aware) before reducing the matching allocations.
    const shipmentRefundLines = await tx.salesOrderRefundLine.findMany({
      where: { refund: { orderId } },
      select: { salesOrderLineId: true, productId: true, qty: true },
    })
    const refundProductIds = [...new Set(
      shipmentRefundLines.map((refundLine) => refundLine.productId).filter((id): id is string => !!id),
    )]
    const refundGraph = refundProductIds.length > 0
      ? await loadFulfillmentProductGraph(tx, refundProductIds)
      : new Map()
    for (const refundLine of shipmentRefundLines) {
      if (!refundLine.salesOrderLineId || !refundLine.productId || shipmentBoundaryNumber(refundLine.qty) <= 0) continue
      const requirements = expandFulfillmentRequirementsDecimal(refundLine.productId, toDecimal(refundLine.qty), refundGraph)
      for (const [componentId, componentQty] of requirements) {
        let remaining = shipmentBoundaryNumber(componentQty)
        for (const alloc of allocAfterShipments) {
          if (remaining <= 0) break
          if (alloc.lineId !== refundLine.salesOrderLineId || alloc.productId !== componentId) continue
          const take = Math.min(remaining, alloc.qty)
          alloc.qty -= take
          remaining -= take
        }
      }
    }
    const effectiveAllocs = allocAfterShipments.filter((alloc) => alloc.qty > 0)

    if (!effectiveAllocs.length) {
      throw new Error('All allocated lines are already covered by active shipments or refunds')
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
      const shipmentTotalError = await validateActiveShipmentTotalsWithinOrder(tx, lockedShipment.orderId)
      if (shipmentTotalError) {
        return {
          success: false as const,
          error: shipmentTotalError,
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
          // o3d-slrn: the catch below falls through to tx.stockMovement.findUnique on the SAME
          // client, so the failing insert must be savepointed or that recovery hits a 25P02.
          movement = await withSavepoint(tx, () => tx.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId: line.productId,
              fromWarehouseId: lockedShipment.warehouseId,
              qty,
              note: `Dispatched for order — shipment from ${lockedShipment.warehouse.code}`,
              referenceType: 'SalesOrder',
              referenceId: lockedShipment.orderId,
              shipmentLineId: line.id,
              idempotencyKey,
            },
            select: { id: true },
          }))
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
          data: buildStockMovementValueFieldsFromConsumed(consumed, qty),
        })
        if (consumed.length > 0) {
          await tx.cogsEntry.createMany({
            data: consumed.map((entry) => cogsEntryDataFromConsumed(movement.id, entry)),
          })
          // Decorate the dispatch snapshot with its order allocation (one per
          // line+warehouse+product) so the Group B daily batch can relieve the
          // Allocated-Inventory contra for the shipped units (cogs-audit scjz.18).
          // The contra is relieved by QTY against the allocation's pinned layers
          // (scjz.21), so this works even though dispatch consumed FIFO-oldest
          // layers that may differ from the allocation's pinned ones.
          const allocation = await tx.orderAllocation.findUnique({
            where: {
              lineId_warehouseId_productId: {
                lineId: line.lineId,
                warehouseId: lockedShipment.warehouseId,
                productId: line.productId,
              },
            },
            select: { id: true },
          })
          const allocationId = allocation?.id
          await tx.shipmentLine.update({
            where: { id: line.id },
            data: {
              costLayerSnapshot: serializeCostLayerSnapshot(consumed.map((entry) => ({
                costLayerId: entry.costLayerId,
                qty: entry.qty,
                unitCostBase: entry.unitCostBase,
                shipmentLineId: line.id,
                ...(allocationId ? { orderAllocationId: allocationId, source: 'shipment' as const } : {}),
              }))),
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
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`
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
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${shipment.orderId} FOR UPDATE`
    const currentOrder = await tx.salesOrder.findUnique({
      where: { id: shipment.orderId },
      select: { status: true },
    })
    if (!currentOrder) return
    if (['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'].includes(currentOrder.status)) return

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
