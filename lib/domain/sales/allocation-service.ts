import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import {
  calculateFulfillmentCoverage,
  calculateCoverageByLine,
  requirementsMapToRows,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirements,
  getFulfillmentAvailableQty,
  listFulfillmentLeafProductIds,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'
import { buildBackorderReport, type BackorderReportLine } from '@/lib/domain/inventory/backorder-report'
import { validateSalesOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

export const ALLOCATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const ALLOCATION_EPSILON = 0.000001

export type AllocationServiceClient = Prisma.TransactionClient | typeof db

export type AllocateSalesOrderInput = {
  orderId: string
  refuseIfShipmentsExist?: boolean
}

export type AllocateSalesOrderResult = {
  success: boolean
  error?: string
  syncProductIds: string[]
  allocationCount: number
  unallocatedLines: AllocationUnallocatedLine[]
  unallocatedQty: number
  backorderLineCount: number
  orderRef?: string
  isWcOrder?: boolean
  shipFromWarehouseId?: string | null
  logAttempt?: boolean
}

export type AllocationUnallocatedLine = Pick<
  BackorderReportLine,
  | 'lineId'
  | 'productId'
  | 'sku'
  | 'description'
  | 'orderedQty'
  | 'committedShipmentQty'
  | 'allocatedQty'
  | 'unallocatedQty'
  | 'backorderEligible'
  | 'reason'
> & { componentBlockers: string[] }

type AllocationRowInput = {
  lineId: string
  productId: string
  warehouseId: string
  qty: number
}

function canRunTransaction(
  client: AllocationServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

export function buildAvailableStockMap(
  rows: Array<{ productId: string; warehouseId: string; quantity: DecimalLike; reservedQty: DecimalLike }>,
): Map<string, Map<string, number>> {
  const stockMap = new Map<string, Map<string, number>>()
  for (const row of rows) {
    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, number>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(
      row.warehouseId,
      Math.max(0, decimalToNumber(row.quantity) - decimalToNumber(row.reservedQty)),
    )
  }
  return stockMap
}

export function buildAvailableStockMapIncludingOwnReservations(
  stockRows: Array<{ productId: string; warehouseId: string; quantity: DecimalLike; reservedQty: DecimalLike }>,
  ownRows: Array<{ productId: string; warehouseId: string; qty: DecimalLike }>,
): Map<string, Map<string, number>> {
  const ownByProductWarehouse = new Map<string, number>()
  for (const row of ownRows) {
    const key = `${row.productId}:${row.warehouseId}`
    ownByProductWarehouse.set(
      key,
      (ownByProductWarehouse.get(key) ?? 0) + decimalToNumber(row.qty),
    )
  }

  const stockMap = new Map<string, Map<string, number>>()
  for (const row of stockRows) {
    const quantity = decimalToNumber(row.quantity)
    const reservedQty = decimalToNumber(row.reservedQty)
    const ownQty = ownByProductWarehouse.get(`${row.productId}:${row.warehouseId}`) ?? 0
    if (ownQty > reservedQty + ALLOCATION_EPSILON) {
      console.warn(
        `[allocation-service] own allocations exceed reserved stock for product ${row.productId} in warehouse ${row.warehouseId}; reservedQty=${reservedQty}, ownQty=${ownQty}`,
      )
    }
    const otherReservedQty = Math.max(0, reservedQty - ownQty)
    const available = Math.max(0, quantity - otherReservedQty)

    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, number>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(row.warehouseId, available)
  }
  return stockMap
}

function cloneAvailableStockMap(
  stockMap: Map<string, Map<string, number>>,
): Map<string, Map<string, number>> {
  const copy = new Map<string, Map<string, number>>()
  for (const [productId, byWarehouse] of stockMap) {
    copy.set(productId, new Map(byWarehouse))
  }
  return copy
}

function applyRequirementDeltaToAvailableMap(
  stockMap: Map<string, Map<string, number>>,
  requirements: Map<string, number>,
  warehouseId: string,
  direction: 'reserve' | 'release',
) {
  for (const [productId, qty] of requirements) {
    const byWarehouse = stockMap.get(productId) ?? new Map<string, number>()
    const current = byWarehouse.get(warehouseId) ?? 0
    byWarehouse.set(
      warehouseId,
      direction === 'reserve' ? current - qty : current + qty,
    )
    stockMap.set(productId, byWarehouse)
  }
}

export async function lockSalesOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "sales_orders" WHERE id = ${orderId} FOR UPDATE`,
  )
}

export async function lockStockLevels(
  tx: Prisma.TransactionClient,
  productIds: string[],
  warehouseIds: string[],
): Promise<void> {
  if (productIds.length === 0 || warehouseIds.length === 0) return
  await tx.$queryRaw(
    Prisma.sql`
      SELECT id
      FROM "stock_levels"
      WHERE "productId" IN (${Prisma.join(productIds)})
        AND "warehouseId" IN (${Prisma.join(warehouseIds)})
      FOR UPDATE
    `,
  )
}

/**
 * If the daily batch A2 has already staged this order's allocations for
 * accounting (inventoryAllocatedDate is set), any subsequent allocation
 * edit would orphan the FIFO snapshots that Group B and refund reversals
 * depend on. Reset the accounting flags so A2 re-runs for this order on
 * the next daily batch, re-snapshotting the updated allocations.
 *
 * Invariant: allocation accounting is staged at the order level. A staged
 * order must treat every allocation snapshot as a single replaceable set; the
 * schema does not support mixed staged/unstaged snapshots for one order.
 *
 * Safe to call unconditionally; no-ops when inventoryAllocatedDate is null.
 * Must run inside the same transaction as the allocation mutation.
 */
export async function resetAllocationAccountingIfStaged(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const so = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: { inventoryAllocatedDate: true },
  })
  if (!so?.inventoryAllocatedDate) return

  const journaledShipment = await tx.shipment.findFirst({
    where: { orderId, shipmentJournalDate: { not: null } },
    select: { id: true },
  })
  if (journaledShipment) {
    throw new Error(
      'Cannot modify allocations after shipments have been posted to accounting. ' +
      'Process a refund instead, or contact finance to reverse the journal entries first.',
    )
  }

  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      inventoryAllocatedDate: null,
      allocationBatchAmount: null,
    },
  })
  await tx.orderAllocation.updateMany({
    where: { orderId },
    data: { costLayerSnapshot: Prisma.DbNull },
  })
}

export async function applyAllocationReservationDelta(
  tx: Prisma.TransactionClient,
  rows: Array<{ productId: string; warehouseId: string; qty: number }>,
  direction: 'reserve' | 'release',
) {
  for (const row of rows) {
    const qty = decimalToNumber(row.qty)
    if (qty <= 0) continue
    if (direction === 'reserve') {
      const updated = await tx.stockLevel.updateMany({
        where: { productId: row.productId, warehouseId: row.warehouseId },
        data: { reservedQty: { increment: qty } },
      })
      if (updated.count === 0) {
        throw new Error(`Cannot reserve stock for product ${row.productId} in warehouse ${row.warehouseId}: no stock level exists`)
      }
      continue
    }

    await tx.stockLevel.updateMany({
      where: { productId: row.productId, warehouseId: row.warehouseId },
      data: { reservedQty: { decrement: qty } },
    })
  }
}

export async function validateAllocationIntegrity(
  client: AllocationServiceClient,
  orderId: string,
  lineIds?: string[],
): Promise<string | null> {
  const lines = await client.salesOrderLine.findMany({
    where: {
      orderId,
      productId: { not: null },
      ...(lineIds?.length ? { id: { in: lineIds } } : {}),
    },
    select: {
      id: true,
      productId: true,
      qty: true,
      sku: true,
      description: true,
    },
  })
  if (lines.length === 0) return null

  const graph = await loadFulfillmentProductGraph(
    client,
    lines.map((line) => line.productId!).filter(Boolean),
  )
  const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
  for (const line of lines) {
    requirementsByLine.set(
      line.id,
      requirementsMapToRows(expandFulfillmentRequirements(line.productId!, 1, graph)),
    )
  }

  const [allocations, activeShipmentLines] = await Promise.all([
    client.orderAllocation.findMany({
      where: {
        orderId,
        ...(lineIds?.length ? { lineId: { in: lineIds } } : {}),
      },
      select: {
        lineId: true,
        productId: true,
        warehouseId: true,
        qty: true,
      },
    }),
    client.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
        ...(lineIds?.length ? { lineId: { in: lineIds } } : {}),
      },
      select: {
        lineId: true,
        productId: true,
        qty: true,
      },
    }),
  ])

  const committedByLine = calculateCoverageByLine(
    requirementsByLine,
    activeShipmentLines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      qty: decimalToNumber(line.qty),
    })),
  )

  for (const line of lines) {
    const requirements = requirementsByLine.get(line.id) ?? []
    if (requirements.length === 0) continue

    const requiredProductIds = new Set(requirements.map((requirement) => requirement.productId))
    const lineAllocations = allocations.filter((allocation) => allocation.lineId === line.id)
    const byWarehouse = new Map<string, Map<string, number>>()

    for (const allocation of lineAllocations) {
      const quantities = byWarehouse.get(allocation.warehouseId) ?? new Map<string, number>()
      quantities.set(
        allocation.productId,
        (quantities.get(allocation.productId) ?? 0) + decimalToNumber(allocation.qty),
      )
      byWarehouse.set(allocation.warehouseId, quantities)
    }

    let allocatedCoverage = 0
    for (const [warehouseId, quantities] of byWarehouse) {
      const coverage = calculateFulfillmentCoverage(requirements, quantities)
      if (coverage <= ALLOCATION_EPSILON) {
        return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} does not contain a complete component set`
      }

      for (const requirement of requirements) {
        const actualQty = quantities.get(requirement.productId) ?? 0
        const expectedQty = coverage * requirement.factor
        if (Math.abs(actualQty - expectedQty) > ALLOCATION_EPSILON) {
          return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} must keep bundle components in matching quantities`
        }
      }

      for (const productId of quantities.keys()) {
        if (!requiredProductIds.has(productId)) {
          return `Allocation for sales line ${line.sku ?? line.description} contains an unexpected component`
        }
      }

      allocatedCoverage += coverage
    }

    const committedCoverage = committedByLine.get(line.id) ?? 0
    const remainingQty = Math.max(0, decimalToNumber(line.qty) - committedCoverage)
    if (Math.abs(allocatedCoverage - remainingQty) > ALLOCATION_EPSILON && allocatedCoverage > remainingQty) {
      return `Allocation for sales line ${line.sku ?? line.description} exceeds the remaining quantity to fulfill`
    }
  }

  return null
}

function mergeAllocationRows(rows: AllocationRowInput[]): AllocationRowInput[] {
  const merged = new Map<string, AllocationRowInput>()

  for (const row of rows) {
    const key = `${row.lineId}|${row.warehouseId}|${row.productId}`
    const existing = merged.get(key)
    if (existing) {
      existing.qty += row.qty
      continue
    }
    merged.set(key, { ...row })
  }

  return [...merged.values()].filter((row) => row.qty > 0)
}

function collectNonOversellLeafComponents(
  productId: string,
  graph: Awaited<ReturnType<typeof loadFulfillmentProductGraph>>,
): string[] {
  const blockers = new Set<string>()

  function visit(currentProductId: string, stack: Set<string>) {
    if (stack.has(currentProductId)) return
    const node = graph.get(currentProductId)
    if (!node || node.type !== 'KIT') return

    stack.add(currentProductId)
    for (const component of node.productComponents) {
      if (component.componentType === 'KIT') {
        visit(component.componentId, stack)
        continue
      }
      if (!component.componentOversellAllowed) {
        blockers.add(component.componentSku || component.componentId)
      }
    }
    stack.delete(currentProductId)
  }

  visit(productId, new Set<string>())
  return [...blockers].sort()
}

function noAllocationResult(error: string): AllocateSalesOrderResult {
  return {
    success: false,
    error,
    syncProductIds: [],
    allocationCount: 0,
    unallocatedLines: [],
    unallocatedQty: 0,
    backorderLineCount: 0,
  }
}

export async function allocateSalesOrder(
  client: AllocationServiceClient,
  input: AllocateSalesOrderInput,
): Promise<AllocateSalesOrderResult> {
  const { orderId } = input
  const so = await client.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      shoppingLinks: { where: { connector: 'woocommerce' }, select: { id: true }, take: 1 },
      status: true,
      shipFromWarehouseId: true,
      lines: {
        select: {
          id: true,
          orderId: true,
          productId: true,
          qty: true,
          sku: true,
          description: true,
          product: {
            select: {
              id: true,
              sku: true,
              type: true,
              oversellAllowed: true,
            },
          },
        },
      },
    },
  })
  if (!so) return noAllocationResult('Order not found')

  const isWcOrder = so.shoppingLinks.length > 0
  const orderRef = so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8)
  const allWarehouses = await client.warehouse.findMany({
    where: {
      active: true,
      availableForSale: true,
      ...(isWcOrder ? { syncToStore: true } : {}),
    },
    select: { id: true, code: true, name: true, isDefault: true, syncToStore: true },
    orderBy: { isDefault: 'desc' },
  })
  if (!allWarehouses.length) {
    return {
      ...noAllocationResult(isWcOrder ? 'No WooCommerce-synced warehouses available for sale' : 'No warehouses available for sale'),
      orderRef,
      isWcOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
    }
  }

  const primaryId = so.shipFromWarehouseId
  const sorted = [...allWarehouses].sort((a, b) => {
    if (a.id === primaryId) return -1
    if (b.id === primaryId) return 1
    if (a.isDefault && !b.isDefault) return -1
    if (!a.isDefault && b.isDefault) return 1
    if (a.syncToStore && !b.syncToStore) return -1
    if (!a.syncToStore && b.syncToStore) return 1
    return 0
  })

  const productIds = so.lines.filter((line) => line.productId).map((line) => line.productId!)

  const runAllocation = async (tx: Prisma.TransactionClient) => {
    await lockSalesOrder(tx, orderId)

    if (input.refuseIfShipmentsExist) {
      const shipmentExists = await tx.shipment.findFirst({
        where: { orderId },
        select: { id: true },
      })
      if (shipmentExists) {
        return { nextAllocations: [], syncProductIds: [], refused: true as const }
      }
    }

    await resetAllocationAccountingIfStaged(tx, orderId)
    const graph = await loadFulfillmentProductGraph(tx, productIds)
    const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
    for (const line of so.lines) {
      if (!line.productId) continue
      requirementsByLine.set(
        line.id,
        requirementsMapToRows(expandFulfillmentRequirements(line.productId, 1, graph)),
      )
    }

    const leafProductIds = listFulfillmentLeafProductIds(productIds, graph)
    await lockStockLevels(tx, leafProductIds, sorted.map((warehouse) => warehouse.id))

    const stockLevels = await tx.stockLevel.findMany({
      where: { productId: { in: leafProductIds }, warehouseId: { in: sorted.map((warehouse) => warehouse.id) } },
      select: { productId: true, warehouseId: true, quantity: true, reservedQty: true },
    })
    const ownAllocations = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { productId: true, warehouseId: true, qty: true },
    })
    const stockMap = buildAvailableStockMapIncludingOwnReservations(stockLevels, ownAllocations)

    const activeShipmentLines = await tx.shipmentLine.findMany({
      where: {
        shipment: { orderId, status: { not: 'PENDING' } },
      },
      select: { lineId: true, productId: true, qty: true, shipment: { select: { status: true } } },
    })
    const committedByLine = calculateCoverageByLine(
      requirementsByLine,
      activeShipmentLines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: decimalToNumber(line.qty),
      })),
    )

    const lines = so.lines.filter((line) => line.productId).map((line) => {
      const committed = committedByLine.get(line.id) ?? 0
      return {
        id: line.id,
        productId: line.productId!,
        sku: line.sku ?? line.productId!,
        qty: Math.max(0, decimalToNumber(line.qty) - committed),
      }
    }).filter((line) => line.qty > 0)

    const lineOptions = new Map<string, string[]>()
    for (const line of lines) {
      const options: string[] = []
      for (const warehouse of sorted) {
        const avail = getFulfillmentAvailableQty(line.productId, warehouse.id, graph, stockMap)
        if (avail >= line.qty) options.push(warehouse.id)
      }
      lineOptions.set(line.id, options)
    }

    const forcedWarehouses = new Set<string>()
    for (const [, options] of lineOptions) {
      if (options.length === 1) forcedWarehouses.add(options[0])
    }

    const nextAllocationRows: AllocationRowInput[] = []
    const tempStock = cloneAvailableStockMap(stockMap)

    for (const line of lines) {
      const options = lineOptions.get(line.id) ?? []
      let bestWh: string | null = null
      let remaining = line.qty

      if (options.length > 0) {
        const forcedOption = options.find((warehouseId) => forcedWarehouses.has(warehouseId))
        bestWh = forcedOption ?? options[0]
      }

      if (bestWh) {
        const avail = getFulfillmentAvailableQty(line.productId, bestWh, graph, tempStock)
        const allocQty = Math.min(remaining, avail)
        if (allocQty > ALLOCATION_EPSILON) {
          const requirements = expandFulfillmentRequirements(line.productId, allocQty, graph)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: bestWh, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, bestWh, 'reserve')
          remaining -= allocQty
        }
      }

      if (remaining > ALLOCATION_EPSILON) {
        for (const warehouse of sorted) {
          if (remaining <= ALLOCATION_EPSILON) break
          if (bestWh && warehouse.id === bestWh) continue
          const avail = getFulfillmentAvailableQty(line.productId, warehouse.id, graph, tempStock)
          if (avail <= ALLOCATION_EPSILON) continue
          const allocQty = Math.min(remaining, avail)
          const requirements = expandFulfillmentRequirements(line.productId, allocQty, graph)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: warehouse.id, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, warehouse.id, 'reserve')
          remaining -= allocQty
        }
      }
    }

    const nextAllocations = mergeAllocationRows(nextAllocationRows)
    const existingAllocs = await tx.orderAllocation.findMany({
      where: { orderId },
      select: { lineId: true, productId: true, warehouseId: true, qty: true },
    })
    await applyAllocationReservationDelta(
      tx,
      existingAllocs.map((alloc) => ({
        productId: alloc.productId,
        warehouseId: alloc.warehouseId,
        qty: decimalToNumber(alloc.qty),
      })),
      'release',
    )
    await tx.orderAllocation.deleteMany({ where: { orderId } })

    for (const alloc of nextAllocations) {
      await tx.orderAllocation.create({
        data: {
          orderId,
          lineId: alloc.lineId,
          productId: alloc.productId,
          warehouseId: alloc.warehouseId,
          qty: alloc.qty,
        },
      })
    }
    await applyAllocationReservationDelta(
      tx,
      nextAllocations.map((alloc) => ({
        productId: alloc.productId,
        warehouseId: alloc.warehouseId,
        qty: alloc.qty,
      })),
      'reserve',
    )

    if (nextAllocations.length > 0 && ['DRAFT', 'PENDING_PAYMENT', 'PROCESSING'].includes(so.status)) {
      const transition = validateSalesOrderStatusTransition(so.status, 'ALLOCATED')
      if (!transition.success) throw new Error(transition.error)
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: 'ALLOCATED' } })
    }

    const report = buildBackorderReport({
      lines: so.lines.map((line) => ({
        id: line.id,
        orderId: line.orderId,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        qty: line.qty,
        product: line.product,
      })),
      allocations: nextAllocations.map((allocation) => ({
        lineId: allocation.lineId,
        productId: allocation.productId,
        qty: allocation.qty,
      })),
      shipmentLines: activeShipmentLines,
      requirementsByLine,
    })

    return {
      nextAllocations,
      syncProductIds: [...new Set([
        ...existingAllocs.map((alloc) => alloc.productId),
        ...nextAllocations.map((alloc) => alloc.productId),
      ])],
      unallocatedLines: report.lines
        .filter((line) => line.unallocatedQty > ALLOCATION_EPSILON)
        .map((line) => {
          const sourceLine = so.lines.find((candidate) => candidate.id === line.lineId)
          return {
            lineId: line.lineId,
            productId: line.productId,
            sku: line.sku,
            description: line.description,
            orderedQty: line.orderedQty,
            committedShipmentQty: line.committedShipmentQty,
            allocatedQty: line.allocatedQty,
            unallocatedQty: line.unallocatedQty,
            backorderEligible: line.backorderEligible,
            reason: line.reason,
            componentBlockers: sourceLine?.product?.type === 'KIT' && sourceLine.productId
              ? collectNonOversellLeafComponents(sourceLine.productId, graph)
              : [],
          }
        }),
      unallocatedQty: report.summary.unallocatedQty,
      backorderLineCount: report.lines.filter((line) => line.unallocatedQty > ALLOCATION_EPSILON && line.backorderEligible).length,
      refused: false as const,
    }
  }

  const allocationResult = canRunTransaction(client)
    ? await client.$transaction(runAllocation, ALLOCATION_TX_OPTIONS)
    : await runAllocation(client)

  if (allocationResult.refused) {
    return {
      success: false,
      error: 'Order has existing shipments; reallocation refused',
      syncProductIds: [],
      allocationCount: 0,
      unallocatedLines: [],
      unallocatedQty: 0,
      backorderLineCount: 0,
      orderRef,
      isWcOrder,
      shipFromWarehouseId: so.shipFromWarehouseId,
    }
  }

  const allocationCount = allocationResult.nextAllocations.length
  const canLeaveUnallocated = allocationResult.unallocatedLines.every((line) => line.backorderEligible)
  const success = canLeaveUnallocated
  return {
    success,
    error: success
      ? undefined
      : allocationCount > 0
        ? 'Some lines could not be fully allocated and are not oversell-eligible'
        : 'No stock available for allocation',
    syncProductIds: allocationResult.syncProductIds,
    allocationCount,
    unallocatedLines: allocationResult.unallocatedLines,
    unallocatedQty: allocationResult.unallocatedQty,
    backorderLineCount: allocationResult.backorderLineCount,
    orderRef,
    isWcOrder,
    shipFromWarehouseId: so.shipFromWarehouseId,
    logAttempt: true,
  }
}
