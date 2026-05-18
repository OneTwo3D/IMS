import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
// decimal-boundary-ok: report-only (inventory invariant finding details)
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

export type InventoryInvariantSqlCollectorOptions = {
  limit?: number
  cursor?: string | null
  page?: number
  productId?: string
  warehouseId?: string
  severity?: InventoryInvariantSeverity
  quantityTolerance?: number
}

export type InventoryInvariantFindingPage = {
  findings: InventoryInvariantFinding[]
  nextCursor: string | null
  hasMore: boolean
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

export type InventoryInvariantStockMovementRow = {
  id: string
  type: string
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: DecimalLike
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
  stockMovements: InventoryInvariantStockMovementRow[]
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
  stockMovement: {
    findMany(args: unknown): Promise<InventoryInvariantStockMovementRow[]>
  }
  shipmentLine: {
    findMany(args: unknown): Promise<InventoryInvariantShipmentLineRow[]>
  }
}

export type InventoryInvariantSqlClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

type InventoryInvariantSqlFindingRow = {
  sortKey: string
  severity: InventoryInvariantSeverity
  code: string
  productId: string | null
  warehouseId: string | null
  message: string
  details: unknown
}

const DEFAULT_QUANTITY_TOLERANCE = 0.0001
const DEFAULT_SQL_COLLECTOR_PAGE_SIZE = 500
const MAX_SQL_COLLECTOR_PAGE_SIZE = 1000
const DEFAULT_SQL_REPORT_MAX_FINDINGS = 5000
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

function isStrictlyNegative(value: number): boolean {
  return value < 0
}

function greaterThanWithTolerance(left: number, right: number, tolerance: number): boolean {
  return left - right > tolerance
}

function quantityKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

function isSqlInventoryInvariantClient(client: unknown): client is InventoryInvariantSqlClient {
  return typeof (client as { $queryRaw?: unknown }).$queryRaw === 'function'
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

function normalizeSqlCollectorLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SQL_COLLECTOR_PAGE_SIZE
  if (!Number.isFinite(limit)) return DEFAULT_SQL_COLLECTOR_PAGE_SIZE
  return Math.min(Math.max(Math.floor(limit), 1), MAX_SQL_COLLECTOR_PAGE_SIZE)
}

function normalizeSqlCollectorOffset(page: number | undefined, limit: number): number {
  if (page === undefined || !Number.isFinite(page)) return 0
  return Math.max(Math.floor(page) - 1, 0) * limit
}

function mapSqlFindingRows(rows: InventoryInvariantSqlFindingRow[]): InventoryInvariantFinding[] {
  return rows.map((row) => ({
    severity: row.severity,
    code: row.code,
    productId: row.productId ?? undefined,
    warehouseId: row.warehouseId ?? undefined,
    message: row.message,
    details: row.details,
  }))
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

    if (isStrictlyNegative(receivedQty)) {
      findings.push({
        severity: 'critical',
        code: 'cost_layer_negative_received_quantity',
        productId: costLayer.productId,
        warehouseId: costLayer.warehouseId,
        message: `Cost layer received quantity is negative for ${costLayer.product.sku}`,
        details: {
          costLayerId: costLayer.id,
          sku: costLayer.product.sku,
          receivedQty,
        },
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

  for (const stockMovement of rows.stockMovements) {
    const qty = decimalToNumber(stockMovement.qty)
    if (!isStrictlyNegative(qty)) continue

    findings.push({
      severity: 'critical',
      code: 'stock_movement_negative_quantity',
      productId: stockMovement.productId,
      // Transfer movements involve two warehouses; use the origin side first
      // as the primary grouping key and keep both sides in details.
      warehouseId: stockMovement.fromWarehouseId ?? stockMovement.toWarehouseId ?? undefined,
      message: `Stock movement quantity is negative for ${stockMovement.product.sku}`,
      details: {
        movementId: stockMovement.id,
        movementType: stockMovement.type,
        sku: stockMovement.product.sku,
        qty,
        fromWarehouseId: stockMovement.fromWarehouseId,
        toWarehouseId: stockMovement.toWarehouseId,
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
  const [stockLevels, costLayers, stockMovements, shippedShipmentLines] = await Promise.all([
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
    client.stockMovement.findMany({
      where: {
        qty: { lt: 0 },
      },
      select: {
        id: true,
        type: true,
        productId: true,
        fromWarehouseId: true,
        toWarehouseId: true,
        qty: true,
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

  return { stockLevels, costLayers, stockMovements, shippedShipmentLines }
}

function sqlFifoProductTypes(): Prisma.Sql {
  return Prisma.join([...FIFO_COST_LAYER_PRODUCT_TYPES])
}

function sqlOptionalProductFilter(alias: 'sl' | 'cl' | 'sm' | 'p', productId: string | undefined): Prisma.Sql {
  if (!productId) return Prisma.empty
  if (alias === 'p') return Prisma.sql`AND p.id = ${productId}`
  return Prisma.sql`AND ${Prisma.raw(alias)}."productId" = ${productId}`
}

function sqlOptionalWarehouseFilter(
  alias: 'sl' | 'cl' | 'sm' | 's',
  warehouseId: string | undefined,
): Prisma.Sql {
  if (!warehouseId) return Prisma.empty
  if (alias === 'sm') {
    return Prisma.sql`AND (sm."fromWarehouseId" = ${warehouseId} OR sm."toWarehouseId" = ${warehouseId})`
  }
  return Prisma.sql`AND ${Prisma.raw(alias)}."warehouseId" = ${warehouseId}`
}

function sqlSeverityFilter(severity: InventoryInvariantSeverity | undefined): Prisma.Sql {
  return severity ? Prisma.sql`AND severity = ${severity}` : Prisma.empty
}

function sqlCursorFilter(cursor: string | null | undefined): Prisma.Sql {
  return cursor ? Prisma.sql`AND "sortKey" > ${cursor}` : Prisma.empty
}

function sqlPageOffset(page: number | undefined, cursor: string | null | undefined, limit: number): Prisma.Sql {
  if (cursor) return Prisma.empty
  const offset = normalizeSqlCollectorOffset(page, limit)
  return offset > 0 ? Prisma.sql`OFFSET ${offset}` : Prisma.empty
}

function buildSqlInventoryInvariantQuery(options: Required<Pick<InventoryInvariantSqlCollectorOptions, 'quantityTolerance'>> & InventoryInvariantSqlCollectorOptions): Prisma.Sql {
  const limit = normalizeSqlCollectorLimit(options.limit)
  const tolerance = options.quantityTolerance
  const negativeTolerance = -tolerance
  const offset = sqlPageOffset(options.page, options.cursor, limit)
  const stockProductFilter = sqlOptionalProductFilter('sl', options.productId)
  const stockWarehouseFilter = sqlOptionalWarehouseFilter('sl', options.warehouseId)
  const costLayerProductFilter = sqlOptionalProductFilter('cl', options.productId)
  const costLayerWarehouseFilter = sqlOptionalWarehouseFilter('cl', options.warehouseId)
  const movementProductFilter = sqlOptionalProductFilter('sm', options.productId)
  const movementWarehouseFilter = sqlOptionalWarehouseFilter('sm', options.warehouseId)
  const shipmentProductFilter = sqlOptionalProductFilter('sl', options.productId)
  const shipmentWarehouseFilter = sqlOptionalWarehouseFilter('s', options.warehouseId)
  const severityFilter = sqlSeverityFilter(options.severity)
  const cursorFilter = sqlCursorFilter(options.cursor)

  return Prisma.sql`
    WITH cost_layer_totals AS (
      SELECT
        cl."productId",
        cl."warehouseId",
        SUM(cl."remainingQty") AS "remainingCostLayerQty",
        MIN(p.sku) AS sku,
        MIN(p.type::text) AS "productType"
      FROM "cost_layers" cl
      INNER JOIN "products" p ON p.id = cl."productId"
      WHERE p.type::text IN (${sqlFifoProductTypes()})
        ${costLayerProductFilter}
        ${costLayerWarehouseFilter}
      GROUP BY cl."productId", cl."warehouseId"
    ),
    fifo_stock_levels AS (
      SELECT
        sl.id,
        sl."productId",
        sl."warehouseId",
        sl.quantity,
        p.sku,
        p.type::text AS "productType"
      FROM "stock_levels" sl
      INNER JOIN "products" p ON p.id = sl."productId"
      WHERE p.type::text IN (${sqlFifoProductTypes()})
        ${stockProductFilter}
        ${stockWarehouseFilter}
    ),
    findings AS (
      SELECT
        'stock_negative_quantity:' || sl.id AS "sortKey",
        'critical'::text AS severity,
        'stock_negative_quantity'::text AS code,
        sl."productId",
        sl."warehouseId",
        'Stock quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'stockLevelId', sl.id,
          'sku', p.sku,
          'quantity', sl.quantity
        ) AS details
      FROM "stock_levels" sl
      INNER JOIN "products" p ON p.id = sl."productId"
      WHERE sl.quantity < ${negativeTolerance}
        ${stockProductFilter}
        ${stockWarehouseFilter}

      UNION ALL

      SELECT
        'stock_negative_reserved_quantity:' || sl.id AS "sortKey",
        'critical'::text AS severity,
        'stock_negative_reserved_quantity'::text AS code,
        sl."productId",
        sl."warehouseId",
        'Reserved quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'stockLevelId', sl.id,
          'sku', p.sku,
          'reservedQty', sl."reservedQty"
        ) AS details
      FROM "stock_levels" sl
      INNER JOIN "products" p ON p.id = sl."productId"
      WHERE sl."reservedQty" < ${negativeTolerance}
        ${stockProductFilter}
        ${stockWarehouseFilter}

      UNION ALL

      SELECT
        'stock_reserved_exceeds_quantity:' || sl.id AS "sortKey",
        'critical'::text AS severity,
        'stock_reserved_exceeds_quantity'::text AS code,
        sl."productId",
        sl."warehouseId",
        'Reserved quantity exceeds stock quantity for ' || p.sku AS message,
        jsonb_build_object(
          'stockLevelId', sl.id,
          'sku', p.sku,
          'quantity', sl.quantity,
          'reservedQty', sl."reservedQty",
          'oversellAllowed', p."oversellAllowed"
        ) AS details
      FROM "stock_levels" sl
      INNER JOIN "products" p ON p.id = sl."productId"
      WHERE p.type::text IN (${sqlFifoProductTypes()})
        AND p."oversellAllowed" = false
        AND sl."reservedQty" - sl.quantity > ${tolerance}
        ${stockProductFilter}
        ${stockWarehouseFilter}

      UNION ALL

      SELECT
        'cost_layer_negative_received_quantity:' || cl.id AS "sortKey",
        'critical'::text AS severity,
        'cost_layer_negative_received_quantity'::text AS code,
        cl."productId",
        cl."warehouseId",
        'Cost layer received quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'costLayerId', cl.id,
          'sku', p.sku,
          'receivedQty', cl."receivedQty"
        ) AS details
      FROM "cost_layers" cl
      INNER JOIN "products" p ON p.id = cl."productId"
      WHERE cl."receivedQty" < 0
        ${costLayerProductFilter}
        ${costLayerWarehouseFilter}

      UNION ALL

      SELECT
        'cost_layer_negative_remaining_quantity:' || cl.id AS "sortKey",
        'critical'::text AS severity,
        'cost_layer_negative_remaining_quantity'::text AS code,
        cl."productId",
        cl."warehouseId",
        'Cost layer remaining quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'costLayerId', cl.id,
          'sku', p.sku,
          'remainingQty', cl."remainingQty"
        ) AS details
      FROM "cost_layers" cl
      INNER JOIN "products" p ON p.id = cl."productId"
      WHERE cl."remainingQty" < ${negativeTolerance}
        ${costLayerProductFilter}
        ${costLayerWarehouseFilter}

      UNION ALL

      SELECT
        'cost_layer_remaining_exceeds_received:' || cl.id AS "sortKey",
        'critical'::text AS severity,
        'cost_layer_remaining_exceeds_received'::text AS code,
        cl."productId",
        cl."warehouseId",
        'Cost layer remaining quantity exceeds received quantity for ' || p.sku AS message,
        jsonb_build_object(
          'costLayerId', cl.id,
          'sku', p.sku,
          'receivedQty', cl."receivedQty",
          'remainingQty', cl."remainingQty"
        ) AS details
      FROM "cost_layers" cl
      INNER JOIN "products" p ON p.id = cl."productId"
      WHERE cl."remainingQty" - cl."receivedQty" > ${tolerance}
        ${costLayerProductFilter}
        ${costLayerWarehouseFilter}

      UNION ALL

      SELECT
        'stock_cost_layer_quantity_mismatch:' || fsl."productId" || ':' || fsl."warehouseId" AS "sortKey",
        'warning'::text AS severity,
        'stock_cost_layer_quantity_mismatch'::text AS code,
        fsl."productId",
        fsl."warehouseId",
        'Stock quantity does not match remaining cost-layer quantity for ' || fsl.sku AS message,
        jsonb_build_object(
          'stockLevelId', fsl.id,
          'sku', fsl.sku,
          'productType', fsl."productType",
          'quantity', fsl.quantity,
          'remainingCostLayerQty', COALESCE(clt."remainingCostLayerQty", 0),
          'delta', ROUND(fsl.quantity - COALESCE(clt."remainingCostLayerQty", 0), 4),
          'exception', CAST(${FIFO_RECONCILIATION_EXCEPTION} AS text)
        ) AS details
      FROM fifo_stock_levels fsl
      LEFT JOIN cost_layer_totals clt
        ON clt."productId" = fsl."productId"
       AND clt."warehouseId" = fsl."warehouseId"
      WHERE ABS(fsl.quantity - COALESCE(clt."remainingCostLayerQty", 0)) > ${tolerance}

      UNION ALL

      SELECT
        'stock_cost_layer_quantity_mismatch:' || clt."productId" || ':' || clt."warehouseId" AS "sortKey",
        'warning'::text AS severity,
        'stock_cost_layer_quantity_mismatch'::text AS code,
        clt."productId",
        clt."warehouseId",
        'Remaining cost-layer quantity has no matching stock level for ' || clt.sku AS message,
        jsonb_build_object(
          'sku', clt.sku,
          'productType', clt."productType",
          'quantity', 0,
          'remainingCostLayerQty', clt."remainingCostLayerQty",
          'delta', ROUND(0 - clt."remainingCostLayerQty", 4),
          'exception', CAST(${FIFO_RECONCILIATION_EXCEPTION} AS text)
        ) AS details
      FROM cost_layer_totals clt
      LEFT JOIN "stock_levels" sl
        ON sl."productId" = clt."productId"
       AND sl."warehouseId" = clt."warehouseId"
      WHERE sl.id IS NULL
        AND ABS(clt."remainingCostLayerQty") > ${tolerance}

      UNION ALL

      SELECT
        'stock_movement_negative_quantity:' || sm.id AS "sortKey",
        'critical'::text AS severity,
        'stock_movement_negative_quantity'::text AS code,
        sm."productId",
        COALESCE(sm."fromWarehouseId", sm."toWarehouseId") AS "warehouseId",
        'Stock movement quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'sku', p.sku,
          'qty', sm.qty,
          'fromWarehouseId', sm."fromWarehouseId",
          'toWarehouseId', sm."toWarehouseId"
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE sm.qty < 0
        ${movementProductFilter}
        ${movementWarehouseFilter}

      UNION ALL

      SELECT
        'shipped_line_missing_cogs_snapshot:' || sl.id AS "sortKey",
        'critical'::text AS severity,
        'shipped_line_missing_cogs_snapshot'::text AS code,
        sl."productId",
        s."warehouseId",
        'Shipped stockable line is missing a COGS snapshot for ' || p.sku AS message,
        jsonb_build_object(
          'shipmentLineId', sl.id,
          'shipmentId', sl."shipmentId",
          'orderId', s."orderId",
          'lineId', sl."lineId",
          'sku', p.sku,
          'qty', sl.qty
        ) AS details
      FROM "shipment_lines" sl
      INNER JOIN "shipments" s ON s.id = sl."shipmentId"
      INNER JOIN "sales_orders" so ON so.id = s."orderId"
      INNER JOIN "products" p ON p.id = sl."productId"
      WHERE s.status = 'SHIPPED'
        AND so.status <> 'REFUNDED'
        AND p.type::text IN (${sqlFifoProductTypes()})
        AND sl.qty > ${tolerance}
        AND CASE
          WHEN sl."costLayerSnapshot" IS NULL THEN true
          WHEN jsonb_typeof(sl."costLayerSnapshot") <> 'array' THEN true
          ELSE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(sl."costLayerSnapshot") entry(value)
            WHERE jsonb_typeof(entry.value) = 'object'
              AND jsonb_typeof(entry.value->'costLayerId') = 'string'
              AND entry.value->>'costLayerId' <> ''
              AND COALESCE(entry.value->>'qty', '') ~ '^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$'
              AND (entry.value->>'qty')::numeric > 0
              AND COALESCE(entry.value->>'unitCostBase', '') ~ '^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$'
          )
        END
        ${shipmentProductFilter}
        ${shipmentWarehouseFilter}
    )
    SELECT
      "sortKey",
      severity,
      code,
      "productId",
      "warehouseId",
      message,
      details
    FROM findings
    WHERE TRUE
      ${severityFilter}
      ${cursorFilter}
    ORDER BY "sortKey"
    LIMIT ${limit}
    ${offset}
  `
}

export async function collectSqlInventoryInvariantFindingsPage(
  client: InventoryInvariantSqlClient = db as unknown as InventoryInvariantSqlClient,
  options: InventoryInvariantSqlCollectorOptions = {},
): Promise<InventoryInvariantFindingPage> {
  const limit = normalizeSqlCollectorLimit(options.limit)
  const rows = await client.$queryRaw<InventoryInvariantSqlFindingRow[]>(
    buildSqlInventoryInvariantQuery({
      ...options,
      limit,
      quantityTolerance: options.quantityTolerance ?? DEFAULT_QUANTITY_TOLERANCE,
    }),
  )

  return {
    findings: mapSqlFindingRows(rows),
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.sortKey ?? null : null,
    hasMore: rows.length === limit,
  }
}

export async function collectSqlInventoryInvariantFindings(
  client: InventoryInvariantSqlClient = db as unknown as InventoryInvariantSqlClient,
  options: Omit<InventoryInvariantSqlCollectorOptions, 'cursor' | 'page'> & {
    pageSize?: number
    maxFindings?: number
  } = {},
): Promise<InventoryInvariantFinding[]> {
  const maxFindings = Math.max(1, Math.floor(options.maxFindings ?? DEFAULT_SQL_REPORT_MAX_FINDINGS))
  const pageSize = normalizeSqlCollectorLimit(options.pageSize ?? options.limit)
  const findings: InventoryInvariantFinding[] = []
  let cursor: string | null = null

  while (findings.length < maxFindings) {
    const page = await collectSqlInventoryInvariantFindingsPage(client, {
      ...options,
      limit: Math.min(pageSize, maxFindings - findings.length),
      cursor,
    })
    findings.push(...page.findings)
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }

  return findings
}

export async function runInventoryInvariantReport(options: {
  client?: InventoryInvariantClient
  sqlClient?: InventoryInvariantSqlClient
  quantityTolerance?: number
  collectionMode?: 'rows' | 'sql'
  limit?: number
  pageSize?: number
  maxFindings?: number
  productId?: string
  warehouseId?: string
  severity?: InventoryInvariantSeverity
} = {}): Promise<InventoryInvariantReport> {
  const client = options.client ?? (db as unknown as InventoryInvariantClient)
  const sqlClient = options.sqlClient ?? (
    isSqlInventoryInvariantClient(client)
      ? client
      : db as unknown as InventoryInvariantSqlClient
  )
  const collectionMode = options.collectionMode ?? (isSqlInventoryInvariantClient(client) ? 'sql' : 'rows')
  const findings = collectionMode === 'sql'
    ? await collectSqlInventoryInvariantFindings(sqlClient, {
        quantityTolerance: options.quantityTolerance,
        limit: options.limit,
        pageSize: options.pageSize,
        maxFindings: options.maxFindings,
        productId: options.productId,
        warehouseId: options.warehouseId,
        severity: options.severity,
      })
    : evaluateInventoryInvariantRows(
        await collectInventoryInvariantRows(client),
        { quantityTolerance: options.quantityTolerance },
      )

  return {
    checkedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
  }
}
