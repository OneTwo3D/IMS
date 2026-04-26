import { db } from '@/lib/db'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

export type InventoryInvariantSeverity = 'info' | 'warning' | 'critical'

export type InventoryInvariantFinding = {
  severity: InventoryInvariantSeverity
  code: string
  productId?: string
  warehouseId?: string
  message: string
  details: unknown
}

export type InventoryInvariantReport = {
  checkedAt: string
  findings: InventoryInvariantFinding[]
  summary: {
    total: number
    info: number
    warning: number
    critical: number
  }
}

type ProductType = 'SIMPLE' | 'VARIABLE' | 'VARIANT' | 'KIT' | 'BOM' | 'NON_INVENTORY'

type ProductSnapshot = {
  id: string
  sku: string
  name?: string | null
  type: ProductType
  oversellAllowed?: boolean
}

export type InventoryInvariantStockLevelRow = {
  id: string
  productId: string
  warehouseId: string
  quantity: DecimalLike
  reservedQty: DecimalLike
  product: ProductSnapshot
}

export type InventoryInvariantCostLayerRow = {
  id: string
  productId: string
  warehouseId: string
  receivedQty: DecimalLike
  remainingQty: DecimalLike
  product: Pick<ProductSnapshot, 'id' | 'sku' | 'type'>
}

export type InventoryInvariantShipmentLineRow = {
  id: string
  shipmentId: string
  lineId: string
  productId: string
  qty: DecimalLike
  costLayerSnapshot: unknown
  product: Pick<ProductSnapshot, 'id' | 'sku' | 'type'>
  shipment: {
    orderId: string
    warehouseId: string
  }
}

export type InventoryInvariantRows = {
  stockLevels: InventoryInvariantStockLevelRow[]
  costLayers: InventoryInvariantCostLayerRow[]
  shippedShipmentLines: InventoryInvariantShipmentLineRow[]
}

export type InventoryInvariantOptions = {
  quantityTolerance?: number
}

type InventoryInvariantClient = {
  stockLevel: {
    findMany(args: unknown): Promise<InventoryInvariantStockLevelRow[]>
  }
  costLayer: {
    findMany(args: unknown): Promise<InventoryInvariantCostLayerRow[]>
  }
  shipmentLine: {
    findMany(args: unknown): Promise<InventoryInvariantShipmentLineRow[]>
  }
}

const DEFAULT_QUANTITY_TOLERANCE = 0.0001
const FIFO_RECONCILIATION_EXCEPTION = 'Products without FIFO cost layers are excluded; FIFO cost-layer products are expected to reconcile within tolerance.'

// KIT availability is derived from components, so KIT parents do not carry
// their own FIFO cost layers or shipment COGS snapshots.
const FIFO_COST_LAYER_PRODUCT_TYPES = new Set<ProductType>(['SIMPLE', 'VARIANT', 'BOM'])

export function isFifoCostLayerProductType(type: ProductType): boolean {
  return FIFO_COST_LAYER_PRODUCT_TYPES.has(type)
}

function isEffectivelyNegative(value: number, tolerance: number): boolean {
  return value < -tolerance
}

function greaterThanWithTolerance(left: number, right: number, tolerance: number): boolean {
  return left - right > tolerance
}

function quantityKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

function hasCostLayerSnapshot(value: unknown): boolean {
  return parseCostLayerSnapshot(value).some((entry) => Number.isFinite(entry.qty) && entry.qty > 0)
}

function buildSummary(findings: InventoryInvariantFinding[]): InventoryInvariantReport['summary'] {
  return findings.reduce<InventoryInvariantReport['summary']>(
    (summary, finding) => {
      summary.total += 1
      summary[finding.severity] += 1
      return summary
    },
    { total: 0, info: 0, warning: 0, critical: 0 },
  )
}

export function evaluateInventoryInvariantRows(
  rows: InventoryInvariantRows,
  options: InventoryInvariantOptions = {},
): InventoryInvariantFinding[] {
  const tolerance = options.quantityTolerance ?? DEFAULT_QUANTITY_TOLERANCE
  const findings: InventoryInvariantFinding[] = []
  const costLayerRemainingByStockKey = new Map<string, number>()
  const costLayerStockKeyMetadata = new Map<string, {
    productId: string
    warehouseId: string
    product: InventoryInvariantCostLayerRow['product']
  }>()
  const stockLevelByStockKey = new Map<string, InventoryInvariantStockLevelRow>()

  for (const stockLevel of rows.stockLevels) {
    const quantity = decimalToNumber(stockLevel.quantity)
    const reservedQty = decimalToNumber(stockLevel.reservedQty)
    stockLevelByStockKey.set(quantityKey(stockLevel.productId, stockLevel.warehouseId), stockLevel)

    if (isEffectivelyNegative(quantity, tolerance)) {
      findings.push({
        severity: 'critical',
        code: 'stock_negative_quantity',
        productId: stockLevel.productId,
        warehouseId: stockLevel.warehouseId,
        message: `Stock quantity is negative for ${stockLevel.product.sku}`,
        details: {
          stockLevelId: stockLevel.id,
          sku: stockLevel.product.sku,
          quantity,
        },
      })
    }

    if (isEffectivelyNegative(reservedQty, tolerance)) {
      findings.push({
        severity: 'critical',
        code: 'stock_negative_reserved_quantity',
        productId: stockLevel.productId,
        warehouseId: stockLevel.warehouseId,
        message: `Reserved quantity is negative for ${stockLevel.product.sku}`,
        details: {
          stockLevelId: stockLevel.id,
          sku: stockLevel.product.sku,
          reservedQty,
        },
      })
    }

    if (
      isFifoCostLayerProductType(stockLevel.product.type) &&
      !stockLevel.product.oversellAllowed &&
      greaterThanWithTolerance(reservedQty, quantity, tolerance)
    ) {
      findings.push({
        severity: 'critical',
        code: 'stock_reserved_exceeds_quantity',
        productId: stockLevel.productId,
        warehouseId: stockLevel.warehouseId,
        message: `Reserved quantity exceeds stock quantity for ${stockLevel.product.sku}`,
        details: {
          stockLevelId: stockLevel.id,
          sku: stockLevel.product.sku,
          quantity,
          reservedQty,
          oversellAllowed: stockLevel.product.oversellAllowed,
        },
      })
    }
  }

  for (const costLayer of rows.costLayers) {
    const remainingQty = decimalToNumber(costLayer.remainingQty)
    const receivedQty = decimalToNumber(costLayer.receivedQty)
    const key = quantityKey(costLayer.productId, costLayer.warehouseId)
    costLayerRemainingByStockKey.set(
      key,
      (costLayerRemainingByStockKey.get(key) ?? 0) + remainingQty,
    )
    if (!costLayerStockKeyMetadata.has(key)) {
      costLayerStockKeyMetadata.set(key, {
        productId: costLayer.productId,
        warehouseId: costLayer.warehouseId,
        product: costLayer.product,
      })
    }

    if (isEffectivelyNegative(remainingQty, tolerance)) {
      findings.push({
        severity: 'critical',
        code: 'cost_layer_negative_remaining_quantity',
        productId: costLayer.productId,
        warehouseId: costLayer.warehouseId,
        message: `Cost layer remaining quantity is negative for ${costLayer.product.sku}`,
        details: {
          costLayerId: costLayer.id,
          sku: costLayer.product.sku,
          remainingQty,
        },
      })
    }

    if (greaterThanWithTolerance(remainingQty, receivedQty, tolerance)) {
      findings.push({
        severity: 'critical',
        code: 'cost_layer_remaining_exceeds_received',
        productId: costLayer.productId,
        warehouseId: costLayer.warehouseId,
        message: `Cost layer remaining quantity exceeds received quantity for ${costLayer.product.sku}`,
        details: {
          costLayerId: costLayer.id,
          sku: costLayer.product.sku,
          receivedQty,
          remainingQty,
        },
      })
    }
  }

  for (const stockLevel of rows.stockLevels) {
    if (!isFifoCostLayerProductType(stockLevel.product.type)) continue

    const quantity = decimalToNumber(stockLevel.quantity)
    const remainingCostLayerQty = costLayerRemainingByStockKey.get(
      quantityKey(stockLevel.productId, stockLevel.warehouseId),
    ) ?? 0

    if (Math.abs(quantity - remainingCostLayerQty) > tolerance) {
      findings.push({
        severity: 'warning',
        code: 'stock_cost_layer_quantity_mismatch',
        productId: stockLevel.productId,
        warehouseId: stockLevel.warehouseId,
        message: `Stock quantity does not match remaining cost-layer quantity for ${stockLevel.product.sku}`,
        details: {
          stockLevelId: stockLevel.id,
          sku: stockLevel.product.sku,
          productType: stockLevel.product.type,
          quantity,
          remainingCostLayerQty,
          delta: Math.round((quantity - remainingCostLayerQty) * 10000) / 10000,
          exception: FIFO_RECONCILIATION_EXCEPTION,
        },
      })
    }
  }

  for (const [key, remainingCostLayerQty] of costLayerRemainingByStockKey) {
    const metadata = costLayerStockKeyMetadata.get(key)
    if (!metadata || !isFifoCostLayerProductType(metadata.product.type)) continue
    if (stockLevelByStockKey.has(key)) continue
    if (Math.abs(remainingCostLayerQty) <= tolerance) continue

    findings.push({
      severity: 'warning',
      code: 'stock_cost_layer_quantity_mismatch',
      productId: metadata.productId,
      warehouseId: metadata.warehouseId,
      message: `Remaining cost-layer quantity has no matching stock level for ${metadata.product.sku}`,
      details: {
        sku: metadata.product.sku,
        productType: metadata.product.type,
        quantity: 0,
        remainingCostLayerQty,
        delta: Math.round((0 - remainingCostLayerQty) * 10000) / 10000,
        exception: FIFO_RECONCILIATION_EXCEPTION,
      },
    })
  }

  for (const shipmentLine of rows.shippedShipmentLines) {
    if (!isFifoCostLayerProductType(shipmentLine.product.type)) continue
    if (decimalToNumber(shipmentLine.qty) <= tolerance) continue
    if (hasCostLayerSnapshot(shipmentLine.costLayerSnapshot)) continue

    findings.push({
      severity: 'critical',
      code: 'shipped_line_missing_cogs_snapshot',
      productId: shipmentLine.productId,
      warehouseId: shipmentLine.shipment.warehouseId,
      message: `Shipped stockable line is missing a COGS snapshot for ${shipmentLine.product.sku}`,
      details: {
        shipmentLineId: shipmentLine.id,
        shipmentId: shipmentLine.shipmentId,
        orderId: shipmentLine.shipment.orderId,
        lineId: shipmentLine.lineId,
        sku: shipmentLine.product.sku,
        qty: decimalToNumber(shipmentLine.qty),
      },
    })
  }

  return findings
}

export async function collectInventoryInvariantRows(
  client: InventoryInvariantClient = db as unknown as InventoryInvariantClient,
): Promise<InventoryInvariantRows> {
  const [stockLevels, costLayers, shippedShipmentLines] = await Promise.all([
    client.stockLevel.findMany({
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        quantity: true,
        reservedQty: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            oversellAllowed: true,
          },
        },
      },
    }),
    client.costLayer.findMany({
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        receivedQty: true,
        remainingQty: true,
        product: {
          select: {
            id: true,
            sku: true,
            type: true,
          },
        },
      },
    }),
    client.shipmentLine.findMany({
      where: {
        shipment: {
          status: 'SHIPPED',
          order: {
            status: { not: 'REFUNDED' },
          },
        },
      },
      select: {
        id: true,
        shipmentId: true,
        lineId: true,
        productId: true,
        qty: true,
        costLayerSnapshot: true,
        product: {
          select: {
            id: true,
            sku: true,
            type: true,
          },
        },
        shipment: {
          select: {
            orderId: true,
            warehouseId: true,
          },
        },
      },
    }),
  ])

  return { stockLevels, costLayers, shippedShipmentLines }
}

export async function runInventoryInvariantReport(options: {
  client?: InventoryInvariantClient
  quantityTolerance?: number
} = {}): Promise<InventoryInvariantReport> {
  const rows = await collectInventoryInvariantRows(
    options.client ?? (db as unknown as InventoryInvariantClient),
  )
  const findings = evaluateInventoryInvariantRows(rows, {
    quantityTolerance: options.quantityTolerance,
  })

  return {
    checkedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
  }
}
