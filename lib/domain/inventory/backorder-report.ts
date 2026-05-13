import { db } from '@/lib/db'
// decimal-boundary-ok: report-only (derived backorder quantities)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import { roundQuantity } from '@/lib/domain/math/decimal'
import {
  calculateCoverageByLine,
  requirementsMapToRows,
  type FulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import {
  expandFulfillmentRequirementsDecimal,
  loadFulfillmentProductGraph,
} from '@/lib/products/kit-fulfillment'
import {
  isStockTrackedProductType,
  STOCK_TRACKED_PRODUCT_TYPES,
  type BackorderProductType,
} from '@/lib/domain/inventory/backorder-policy'

export {
  isStockTrackedProductType,
  STOCK_TRACKED_PRODUCT_TYPES,
  type BackorderProductType,
}

export type BackorderReportLineRow = {
  id: string
  orderId: string
  productId: string | null
  sku: string | null
  description: string
  qty: DecimalLike
  product: {
    id: string
    sku: string
    type: BackorderProductType
    oversellAllowed: boolean
  } | null
}

export type BackorderReportAllocationRow = {
  lineId: string
  productId: string
  qty: DecimalLike
}

export type BackorderReportShipmentLineRow = {
  lineId: string
  productId: string
  qty: DecimalLike
  shipment: {
    status: string
  }
}

export type BackorderReportRows = {
  lines: BackorderReportLineRow[]
  allocations: BackorderReportAllocationRow[]
  shipmentLines: BackorderReportShipmentLineRow[]
  requirementsByLine: Map<string, FulfillmentRequirement[]>
}

export type BackorderReportReason =
  | 'fully_covered'
  | 'stock_shortage'
  | 'not_stock_tracked'
  | 'missing_product'

export type BackorderReportLine = {
  orderId: string
  lineId: string
  productId: string | null
  sku: string | null
  description: string
  orderedQty: number
  shippedQty: number
  committedShipmentQty: number
  allocatedQty: number
  unallocatedQty: number
  requiresStock: boolean
  backorderEligible: boolean
  reason: BackorderReportReason
}

export type BackorderReport = {
  lines: BackorderReportLine[]
  summary: {
    totalLines: number
    stockTrackedLines: number
    backorderLines: number
    orderedQty: number
    shippedQty: number
    committedShipmentQty: number
    allocatedQty: number
    unallocatedQty: number
  }
}

type BackorderReportClient = {
  salesOrderLine: {
    findMany(args: unknown): Promise<BackorderReportLineRow[]>
  }
  orderAllocation: {
    findMany(args: unknown): Promise<BackorderReportAllocationRow[]>
  }
  shipmentLine: {
    findMany(args: unknown): Promise<BackorderReportShipmentLineRow[]>
  }
  product: Parameters<typeof loadFulfillmentProductGraph>[0]['product']
}

const QUANTITY_TOLERANCE = 0.0001
function toReportQuantity(value: number): number {
  if (Math.abs(value) <= QUANTITY_TOLERANCE) return 0
  return roundQuantity(value, 4).toNumber()
}

function defaultRequirements(line: BackorderReportLineRow): FulfillmentRequirement[] {
  if (!line.productId) return []
  return [{ productId: line.productId, factor: 1 }]
}

function buildSummary(lines: BackorderReportLine[]): BackorderReport['summary'] {
  return lines.reduce<BackorderReport['summary']>(
    (summary, line) => {
      summary.totalLines += 1
      if (line.requiresStock) summary.stockTrackedLines += 1
      if (line.unallocatedQty > QUANTITY_TOLERANCE) summary.backorderLines += 1
      summary.orderedQty += line.orderedQty
      summary.shippedQty += line.shippedQty
      summary.committedShipmentQty += line.committedShipmentQty
      summary.allocatedQty += line.allocatedQty
      summary.unallocatedQty += line.unallocatedQty
      return summary
    },
    {
      totalLines: 0,
      stockTrackedLines: 0,
      backorderLines: 0,
      orderedQty: 0,
      shippedQty: 0,
      committedShipmentQty: 0,
      allocatedQty: 0,
      unallocatedQty: 0,
    },
  )
}

export function buildBackorderReport(rows: BackorderReportRows): BackorderReport {
  const shippedByLine = calculateCoverageByLine(
    rows.requirementsByLine,
    rows.shipmentLines
      .filter((line) => line.shipment.status === 'SHIPPED')
      .map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: decimalToNumber(line.qty),
      })),
  )
  const committedShipmentByLine = calculateCoverageByLine(
    rows.requirementsByLine,
    rows.shipmentLines
      .filter((line) => line.shipment.status !== 'PENDING')
      .map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        qty: decimalToNumber(line.qty),
      })),
  )
  const allocatedByLine = calculateCoverageByLine(
    rows.requirementsByLine,
    rows.allocations.map((allocation) => ({
      lineId: allocation.lineId,
      productId: allocation.productId,
      qty: decimalToNumber(allocation.qty),
    })),
  )

  const lines = rows.lines.map<BackorderReportLine>((line) => {
    const orderedQty = decimalToNumber(line.qty)
    if (!line.productId || !line.product) {
      return {
        orderId: line.orderId,
        lineId: line.id,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        orderedQty: toReportQuantity(orderedQty),
        shippedQty: 0,
        committedShipmentQty: 0,
        allocatedQty: 0,
        unallocatedQty: 0,
        requiresStock: false,
        backorderEligible: false,
        reason: 'missing_product',
      }
    }

    if (!isStockTrackedProductType(line.product.type)) {
      return {
        orderId: line.orderId,
        lineId: line.id,
        productId: line.productId,
        sku: line.sku,
        description: line.description,
        orderedQty: toReportQuantity(orderedQty),
        shippedQty: 0,
        committedShipmentQty: 0,
        allocatedQty: 0,
        unallocatedQty: 0,
        requiresStock: false,
        backorderEligible: false,
        reason: 'not_stock_tracked',
      }
    }

    const shippedQty = shippedByLine.get(line.id) ?? 0
    const committedShipmentQty = committedShipmentByLine.get(line.id) ?? 0
    const remainingAfterCommitted = Math.max(0, orderedQty - committedShipmentQty)
    const rawAllocatedQty = allocatedByLine.get(line.id) ?? 0
    // This is a demand report, not an integrity report: over-allocation drift
    // is capped to the remaining demand and must be surfaced by invariants.
    const allocatedQty = Math.min(remainingAfterCommitted, rawAllocatedQty)
    const rawUnallocatedQty = Math.max(0, remainingAfterCommitted - allocatedQty)
    const hasBackorder = rawUnallocatedQty > QUANTITY_TOLERANCE
    const unallocatedQty = hasBackorder ? rawUnallocatedQty : 0

    return {
      orderId: line.orderId,
      lineId: line.id,
      productId: line.productId,
      sku: line.sku,
      description: line.description,
      orderedQty: toReportQuantity(orderedQty),
      shippedQty: toReportQuantity(Math.min(orderedQty, shippedQty)),
      committedShipmentQty: toReportQuantity(Math.min(orderedQty, committedShipmentQty)),
      allocatedQty: toReportQuantity(allocatedQty),
      unallocatedQty: toReportQuantity(unallocatedQty),
      requiresStock: true,
      // Eligibility is a sales-policy hint. Allocation can still fail if a
      // KIT's required components are not themselves allocatable.
      backorderEligible: hasBackorder && line.product.oversellAllowed,
      reason: hasBackorder ? 'stock_shortage' : 'fully_covered',
    }
  })

  return {
    lines,
    summary: buildSummary(lines),
  }
}

/**
 * Read-only collector for a single sales order. Callers must authenticate and
 * verify that the current user may view `orderId` before calling this helper.
 * The reads are intentionally eventual-consistent; callers making mutation
 * decisions from the report should run collection inside their own transaction.
 */
export async function collectBackorderReportRows(
  orderId: string,
  client: BackorderReportClient = db as unknown as BackorderReportClient,
): Promise<BackorderReportRows> {
  const [lines, allocations, shipmentLines] = await Promise.all([
    client.salesOrderLine.findMany({
      where: { orderId },
      select: {
        id: true,
        orderId: true,
        productId: true,
        sku: true,
        description: true,
        qty: true,
        product: {
          select: {
            id: true,
            sku: true,
            type: true,
            oversellAllowed: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    }),
    client.orderAllocation.findMany({
      where: { orderId },
      select: {
        lineId: true,
        productId: true,
        qty: true,
      },
    }),
    client.shipmentLine.findMany({
      where: { shipment: { orderId } },
      select: {
        lineId: true,
        productId: true,
        qty: true,
        shipment: { select: { status: true } },
      },
    }),
  ])

  const productIds = lines.map((line) => line.productId).filter((id): id is string => !!id)
  const graph = await loadFulfillmentProductGraph(
    client as unknown as Parameters<typeof loadFulfillmentProductGraph>[0],
    productIds,
  )
  const requirementsByLine = new Map<string, FulfillmentRequirement[]>()
  for (const line of lines) {
    requirementsByLine.set(
      line.id,
      line.productId
        ? requirementsMapToRows(expandFulfillmentRequirementsDecimal(line.productId, 1, graph))
        : defaultRequirements(line),
    )
  }

  return {
    lines,
    allocations,
    shipmentLines,
    requirementsByLine,
  }
}

/**
 * Builds a derived backorder report for one sales order. This domain helper
 * performs no auth or ownership checks; route handlers/server actions must
 * enforce those boundaries before exposing the returned data.
 */
export async function getSalesOrderBackorderReport(
  orderId: string,
  client?: BackorderReportClient,
): Promise<BackorderReport> {
  return buildBackorderReport(await collectBackorderReportRows(orderId, client))
}
