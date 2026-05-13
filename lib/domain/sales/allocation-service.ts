import { Prisma } from '@/app/generated/prisma/client'
import type { db } from '@/lib/db'
import {
  calculateCoverageByLine,
  requirementsMapToRows,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirements,
  listFulfillmentLeafProductIds,
  loadFulfillmentProductGraph,
  type FulfillmentGraphNode,
} from '@/lib/products/kit-fulfillment'
import { buildBackorderReport, type BackorderReportLine } from '@/lib/domain/inventory/backorder-report'
import { validateSalesOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const ALLOCATION_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

const ALLOCATION_EPSILON = 0.000001
const ALLOCATION_EPSILON_DECIMAL = new Prisma.Decimal('0.000001')

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
  qty: Prisma.Decimal
}

type DecimalStockMap = Map<string, Map<string, Prisma.Decimal>>

function canRunTransaction(
  client: AllocationServiceClient,
): client is typeof db {
  return typeof (client as typeof db).$transaction === 'function'
}

export function buildAvailableStockMap(
  rows: Array<{ productId: string; warehouseId: string; quantity: DecimalInput; reservedQty: DecimalInput }>,
): DecimalStockMap {
  const stockMap: DecimalStockMap = new Map()
  for (const row of rows) {
    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, Prisma.Decimal>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(
      row.warehouseId,
      Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(row.quantity).sub(toDecimal(row.reservedQty))),
    )
  }
  return stockMap
}

export function buildAvailableStockMapIncludingOwnReservations(
  stockRows: Array<{ productId: string; warehouseId: string; quantity: DecimalInput; reservedQty: DecimalInput }>,
  ownRows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
): DecimalStockMap {
  const ownByProductWarehouse = new Map<string, Prisma.Decimal>()
  for (const row of ownRows) {
    const key = `${row.productId}:${row.warehouseId}`
    ownByProductWarehouse.set(
      key,
      (ownByProductWarehouse.get(key) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)),
    )
  }

  const stockMap: DecimalStockMap = new Map()
  for (const row of stockRows) {
    const quantity = toDecimal(row.quantity)
    const reservedQty = toDecimal(row.reservedQty)
    const ownQty = ownByProductWarehouse.get(`${row.productId}:${row.warehouseId}`) ?? new Prisma.Decimal(0)
    if (ownQty.gt(reservedQty.add(ALLOCATION_EPSILON_DECIMAL))) {
      console.warn(
        `[allocation-service] own allocations exceed reserved stock for product ${row.productId} in warehouse ${row.warehouseId}; reservedQty=${reservedQty.toString()}, ownQty=${ownQty.toString()}`,
      )
    }
    const otherReservedQty = Prisma.Decimal.max(new Prisma.Decimal(0), reservedQty.sub(ownQty))
    const available = Prisma.Decimal.max(new Prisma.Decimal(0), quantity.sub(otherReservedQty))

    let byWarehouse = stockMap.get(row.productId)
    if (!byWarehouse) {
      byWarehouse = new Map<string, Prisma.Decimal>()
      stockMap.set(row.productId, byWarehouse)
    }
    byWarehouse.set(row.warehouseId, available)
  }
  return stockMap
}

function cloneAvailableStockMap(
  stockMap: DecimalStockMap,
): DecimalStockMap {
  const copy: DecimalStockMap = new Map()
  for (const [productId, byWarehouse] of stockMap) {
    copy.set(productId, new Map(byWarehouse))
  }
  return copy
}

function applyRequirementDeltaToAvailableMap(
  stockMap: DecimalStockMap,
  requirements: Map<string, DecimalInput>,
  warehouseId: string,
  direction: 'reserve' | 'release',
) {
  for (const [productId, qty] of requirements) {
    const byWarehouse = stockMap.get(productId) ?? new Map<string, Prisma.Decimal>()
    const current = byWarehouse.get(warehouseId) ?? new Prisma.Decimal(0)
    const delta = toDecimal(qty)
    byWarehouse.set(
      warehouseId,
      direction === 'reserve' ? current.sub(delta) : current.add(delta),
    )
    stockMap.set(productId, byWarehouse)
  }
}

export function expandFulfillmentRequirementsDecimal(
  productId: string,
  qty: DecimalInput,
  graph: Map<string, FulfillmentGraphNode>,
): Map<string, Prisma.Decimal> {
  const totals = new Map<string, Prisma.Decimal>()

  function addRequirement(componentProductId: string, requiredQty: Prisma.Decimal) {
    totals.set(
      componentProductId,
      (totals.get(componentProductId) ?? new Prisma.Decimal(0)).add(requiredQty),
    )
  }

  function visit(currentProductId: string, currentQty: Prisma.Decimal, stack: Set<string>) {
    if (currentQty.lte(0)) return
    const node = graph.get(currentProductId)
    if (!node) {
      console.warn(`[kit-fulfillment] Product ${currentProductId} referenced as component but not found in graph — treating as leaf`)
      addRequirement(currentProductId, currentQty)
      return
    }
    if (node.type !== 'KIT' || node.productComponents.length === 0) {
      addRequirement(currentProductId, currentQty)
      return
    }
    if (stack.has(currentProductId)) {
      throw new Error(`Circular kit structure detected for product ${currentProductId}`)
    }

    stack.add(currentProductId)
    for (const component of node.productComponents) {
      const requiredQty = currentQty.mul(component.qty)
      if (component.componentType === 'KIT') {
        visit(component.componentId, requiredQty, stack)
      } else {
        addRequirement(component.componentId, requiredQty)
      }
    }
    stack.delete(currentProductId)
  }

  visit(productId, toDecimal(qty), new Set<string>())
  return totals
}

export function getDecimalFulfillmentAvailableQty(
  productId: string,
  warehouseId: string,
  graph: Map<string, FulfillmentGraphNode>,
  stockByProductWarehouse: DecimalStockMap,
  memo = new Map<string, Prisma.Decimal>(),
  stack = new Set<string>(),
): Prisma.Decimal {
  const memoKey = `${productId}|${warehouseId}`
  const memoized = memo.get(memoKey)
  if (memoized) return memoized

  const node = graph.get(productId)
  if (!node || node.type !== 'KIT' || node.productComponents.length === 0) {
    const available = Prisma.Decimal.max(
      new Prisma.Decimal(0),
      stockByProductWarehouse.get(productId)?.get(warehouseId) ?? new Prisma.Decimal(0),
    )
    memo.set(memoKey, available)
    return available
  }

  if (stack.has(memoKey)) {
    const zero = new Prisma.Decimal(0)
    memo.set(memoKey, zero)
    return zero
  }

  stack.add(memoKey)

  let available: Prisma.Decimal | null = null
  for (const component of node.productComponents) {
    // TODO(stage-4): component.qty is still number-typed by the product graph loader.
    // Switch this guard to Decimal predicates when that shared contract is widened.
    if (!Number.isFinite(component.qty) || component.qty <= 0) {
      available = new Prisma.Decimal(0)
      break
    }

    const componentAvailable = component.componentType === 'KIT'
      ? getDecimalFulfillmentAvailableQty(component.componentId, warehouseId, graph, stockByProductWarehouse, memo, stack)
      : Prisma.Decimal.max(
        new Prisma.Decimal(0),
        stockByProductWarehouse.get(component.componentId)?.get(warehouseId) ?? new Prisma.Decimal(0),
      )

    const componentCoverage = componentAvailable.div(component.qty)
    available = available == null ? componentCoverage : Prisma.Decimal.min(available, componentCoverage)
  }

  stack.delete(memoKey)
  const resolved = available == null ? new Prisma.Decimal(0) : Prisma.Decimal.max(new Prisma.Decimal(0), available)
  memo.set(memoKey, resolved)
  return resolved
}

function calculateDecimalFulfillmentCoverage(
  requirements: FulfillmentRequirement[],
  quantitiesByProduct: Map<string, Prisma.Decimal>,
): Prisma.Decimal {
  if (requirements.length === 0) return new Prisma.Decimal(0)

  let coverage: Prisma.Decimal | null = null
  for (const requirement of requirements) {
    // TODO(stage-4): requirement.factor is still number-typed by the coverage helpers.
    // Switch this guard to Decimal predicates when those shared contracts are widened.
    if (!Number.isFinite(requirement.factor) || requirement.factor <= 0) {
      return new Prisma.Decimal(0)
    }
    const availableQty = quantitiesByProduct.get(requirement.productId) ?? new Prisma.Decimal(0)
    const productCoverage = availableQty.div(requirement.factor)
    coverage = coverage == null ? productCoverage : Prisma.Decimal.min(coverage, productCoverage)
  }

  return coverage == null ? new Prisma.Decimal(0) : coverage
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
  rows: Array<{ productId: string; warehouseId: string; qty: DecimalInput }>,
  direction: 'reserve' | 'release',
) {
  for (const row of rows) {
    const qty = toDecimal(row.qty)
    if (qty.lte(0)) continue
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

  // calculateCoverageByLine remains number-based until the shared fulfillment
  // coverage helpers are widened; ALLOCATION_EPSILON_DECIMAL bounds this seam.
  const committedByLine = calculateCoverageByLine(
    requirementsByLine,
    activeShipmentLines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      qty: toDecimal(line.qty).toNumber(),
    })),
  )

  for (const line of lines) {
    const requirements = requirementsByLine.get(line.id) ?? []
    if (requirements.length === 0) continue

    const requiredProductIds = new Set(requirements.map((requirement) => requirement.productId))
    const lineAllocations = allocations.filter((allocation) => allocation.lineId === line.id)
    const byWarehouse = new Map<string, Map<string, Prisma.Decimal>>()

    for (const allocation of lineAllocations) {
      const quantities = byWarehouse.get(allocation.warehouseId) ?? new Map<string, Prisma.Decimal>()
      quantities.set(
        allocation.productId,
        (quantities.get(allocation.productId) ?? new Prisma.Decimal(0)).add(toDecimal(allocation.qty)),
      )
      byWarehouse.set(allocation.warehouseId, quantities)
    }

    let allocatedCoverage = new Prisma.Decimal(0)
    for (const [warehouseId, quantities] of byWarehouse) {
      const coverage = calculateDecimalFulfillmentCoverage(requirements, quantities)
      if (coverage.lte(ALLOCATION_EPSILON_DECIMAL)) {
        return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} does not contain a complete component set`
      }

      for (const requirement of requirements) {
        const actualQty = quantities.get(requirement.productId) ?? new Prisma.Decimal(0)
        const expectedQty = coverage.mul(requirement.factor)
        if (actualQty.sub(expectedQty).abs().gt(ALLOCATION_EPSILON_DECIMAL)) {
          return `Allocation for sales line ${line.sku ?? line.description} in warehouse ${warehouseId} must keep bundle components in matching quantities`
        }
      }

      for (const productId of quantities.keys()) {
        if (!requiredProductIds.has(productId)) {
          return `Allocation for sales line ${line.sku ?? line.description} contains an unexpected component`
        }
      }

      allocatedCoverage = allocatedCoverage.add(coverage)
    }

    const committedCoverage = toDecimal(committedByLine.get(line.id) ?? 0)
    const remainingQty = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committedCoverage))
    if (allocatedCoverage.sub(remainingQty).abs().gt(ALLOCATION_EPSILON_DECIMAL) && allocatedCoverage.gt(remainingQty)) {
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
      existing.qty = existing.qty.add(row.qty)
      continue
    }
    merged.set(key, { ...row })
  }

  return [...merged.values()].filter((row) => row.qty.gt(0))
}

function collectNonOversellLeafComponents(
  productId: string,
  graph: Map<string, FulfillmentGraphNode>,
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
    // calculateCoverageByLine remains number-based until the shared fulfillment
    // coverage helpers are widened; ALLOCATION_EPSILON_DECIMAL bounds this seam.
    const committedByLine = calculateCoverageByLine(
      requirementsByLine,
      activeShipmentLines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: toDecimal(line.qty).toNumber(),
      })),
    )

    const lines = so.lines.filter((line) => line.productId).map((line) => {
      const committed = toDecimal(committedByLine.get(line.id) ?? 0)
      return {
        id: line.id,
        productId: line.productId!,
        sku: line.sku ?? line.productId!,
        qty: Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(committed)),
      }
    }).filter((line) => line.qty.gt(0))

    const lineOptions = new Map<string, string[]>()
    for (const line of lines) {
      const options: string[] = []
      for (const warehouse of sorted) {
        const avail = getDecimalFulfillmentAvailableQty(line.productId, warehouse.id, graph, stockMap)
        if (avail.gte(line.qty)) options.push(warehouse.id)
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
        const avail = getDecimalFulfillmentAvailableQty(line.productId, bestWh, graph, tempStock)
        const allocQty = Prisma.Decimal.min(remaining, avail)
        if (allocQty.gt(ALLOCATION_EPSILON_DECIMAL)) {
          const requirements = expandFulfillmentRequirementsDecimal(line.productId, allocQty, graph)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: bestWh, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, bestWh, 'reserve')
          remaining = remaining.sub(allocQty)
        }
      }

      if (remaining.gt(ALLOCATION_EPSILON_DECIMAL)) {
        for (const warehouse of sorted) {
          if (remaining.lte(ALLOCATION_EPSILON_DECIMAL)) break
          if (bestWh && warehouse.id === bestWh) continue
          const avail = getDecimalFulfillmentAvailableQty(line.productId, warehouse.id, graph, tempStock)
          if (avail.lte(ALLOCATION_EPSILON_DECIMAL)) continue
          const allocQty = Prisma.Decimal.min(remaining, avail)
          const requirements = expandFulfillmentRequirementsDecimal(line.productId, allocQty, graph)
          for (const [productId, qty] of requirements) {
            nextAllocationRows.push({ lineId: line.id, productId, warehouseId: warehouse.id, qty })
          }
          applyRequirementDeltaToAvailableMap(tempStock, requirements, warehouse.id, 'reserve')
          remaining = remaining.sub(allocQty)
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
        qty: alloc.qty,
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
        qty: allocation.qty.toNumber(),
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
