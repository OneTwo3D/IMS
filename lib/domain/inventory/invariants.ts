import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
// decimal-boundary-ok: report-only (inventory invariant finding details)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import {
  loadReservationSourceRows,
  type ReservationBreakdownRow,
} from '@/lib/domain/inventory/reservation-breakdown'

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
  truncated?: boolean
  nextCursor?: string | null
  summary: {
    total: number
    info: number
    warning: number
    critical: number
  }
}

export type InventoryInvariantSqlCollectorOptions = {
  limit?: number
  /**
   * Cursor pagination wins over page/offset pagination. An empty string is
   * treated as no cursor and reads from the first page.
   */
  cursor?: string | null
  page?: number
  productId?: string
  warehouseId?: string
  severity?: InventoryInvariantSeverity
  quantityTolerance?: number
  /**
   * Optional stock-movement branch window for scheduled checks. Admin/on-demand
   * reports leave this unset to inspect all historical movement rows.
   */
  stockMovementLookbackDays?: number | null
}

export type InventoryInvariantFindingPage = {
  findings: InventoryInvariantFinding[]
  nextCursor: string | null
  hasMore: boolean
}

export type InventoryInvariantFindingCollection = {
  findings: InventoryInvariantFinding[]
  truncated: boolean
  nextCursor: string | null
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
  poLineId?: string | null
  poLine?: { poId: string } | null
  productionOrderId?: string | null
  adjustmentMovementId?: string | null
  product: Pick<ProductSnapshot, 'id' | 'sku' | 'type'>
}

export type InventoryInvariantStockMovementRow = {
  id: string
  type: string
  productId: string
  fromWarehouseId: string | null
  toWarehouseId: string | null
  qty: DecimalLike
  referenceType?: string | null
  referenceId?: string | null
  unitCostBase?: DecimalLike | null
  totalValueBase?: DecimalLike | null
  _count?: { cogsEntries?: number }
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
  reservationSources?: ReservationBreakdownRow[]
}

export type InventoryInvariantOptions = {
  quantityTolerance?: number
}

type InventoryInvariantClient = {
  stockLevel: {
    findMany(args: unknown): Promise<InventoryInvariantStockLevelRow[]>
    findUnique?: (args: unknown) => Promise<unknown>
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
  orderAllocation?: {
    findMany(args: unknown): Promise<unknown[]>
  }
  productionOrder?: {
    findMany(args: unknown): Promise<unknown[]>
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
const STOCK_MOVEMENT_VALUE_TOLERANCE = 0.01
const STOCK_MOVEMENT_VALUE_SMALL_TOLERANCE = 0.000001
const STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE = 0.0001
const DEFAULT_SQL_COLLECTOR_PAGE_SIZE = 500
const MAX_SQL_COLLECTOR_PAGE_SIZE = 1000
const DEFAULT_SQL_REPORT_MAX_FINDINGS = 5000
const FIFO_RECONCILIATION_EXCEPTION = 'Products without FIFO cost layers are excluded; FIFO cost-layer products are expected to reconcile within tolerance.'
const INVENTORY_INVARIANT_TRUNCATED_CODE = 'invariant_report_truncated'
const INBOUND_COST_LAYER_MOVEMENT_TYPES = new Set(['PURCHASE_RECEIPT', 'PRODUCTION_IN'])
const OUTBOUND_COGS_MOVEMENT_TYPES = new Set(['SALE_DISPATCH', 'PRODUCTION_OUT'])
const ADJUSTMENT_MOVEMENT_TYPE = 'ADJUSTMENT'

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

function stockMovementValueDelta(params: {
  qty: number
  unitCostBase: number
  totalValueBase: number
}): {
  expectedTotalValueBase: number
  delta: number
  absoluteTolerance: number
  relativeDelta: number | null
  isMismatch: boolean
} {
  const expectedTotalValueBase = Math.abs(params.qty) * params.unitCostBase
  const delta = params.totalValueBase - expectedTotalValueBase
  const absoluteDelta = Math.abs(delta)
  const expectedMagnitude = Math.abs(expectedTotalValueBase)
  const absoluteTolerance = expectedMagnitude < 1
    ? STOCK_MOVEMENT_VALUE_SMALL_TOLERANCE
    : STOCK_MOVEMENT_VALUE_TOLERANCE
  const relativeDelta = expectedMagnitude > 0
    ? absoluteDelta / expectedMagnitude
    : absoluteDelta === 0
      ? 0
      : null

  return {
    expectedTotalValueBase,
    delta,
    absoluteTolerance,
    relativeDelta,
    isMismatch: absoluteDelta > absoluteTolerance && (relativeDelta == null || relativeDelta > STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE),
  }
}

function quantityKey(productId: string, warehouseId: string): string {
  return `${productId}:${warehouseId}`
}

function movementWarehouseId(movement: InventoryInvariantStockMovementRow): string | null {
  return movement.fromWarehouseId ?? movement.toWarehouseId
}

function requiresInboundCostLayerEvidence(
  movement: InventoryInvariantStockMovementRow,
  qty: number,
  tolerance: number,
): boolean {
  if (qty <= tolerance) return false
  if (INBOUND_COST_LAYER_MOVEMENT_TYPES.has(movement.type)) return true
  return movement.type === ADJUSTMENT_MOVEMENT_TYPE && Boolean(movement.toWarehouseId)
}

function requiresCogsEntryEvidence(
  movement: InventoryInvariantStockMovementRow,
  qty: number,
  tolerance: number,
): boolean {
  if (qty <= tolerance) return false
  if (OUTBOUND_COGS_MOVEMENT_TYPES.has(movement.type)) return true
  return movement.type === ADJUSTMENT_MOVEMENT_TYPE && Boolean(movement.fromWarehouseId)
}

function hasMatchingInboundCostLayer(
  movement: InventoryInvariantStockMovementRow,
  costLayers: InventoryInvariantCostLayerRow[],
  tolerance: number,
): boolean {
  const movementQty = decimalToNumber(movement.qty)
  const warehouseId = movement.toWarehouseId
  if (!warehouseId) return false

  return costLayers.some((costLayer) => {
    if (costLayer.productId !== movement.productId) return false
    if (costLayer.warehouseId !== warehouseId) return false
    if (Math.abs(decimalToNumber(costLayer.receivedQty) - movementQty) > tolerance) return false

    if (movement.type === 'PRODUCTION_IN') {
      return Boolean(movement.referenceId) &&
        costLayer.productionOrderId === movement.referenceId
    }

    if (movement.type === 'PURCHASE_RECEIPT') {
      // Purchase receipt movements do not persist the cost-layer id. The
      // durable writer contract is product + destination warehouse + received
      // quantity plus a PO line belonging to the referenced purchase order.
      return movement.referenceType === 'PurchaseOrder' &&
        Boolean(movement.referenceId) &&
        costLayer.poLine?.poId === movement.referenceId
    }

    if (movement.type === ADJUSTMENT_MOVEMENT_TYPE) {
      return costLayer.adjustmentMovementId === movement.id
    }

    return false
  })
}

function sumReservationSources(
  sources: ReservationBreakdownRow[],
): Map<string, { qty: number; sourceCount: number; sampleReferences: string[] }> {
  const totals = new Map<string, { qty: number; sourceCount: number; sampleReferences: string[] }>()
  for (const source of sources) {
    const key = quantityKey(source.productId, source.warehouseId)
    const current = totals.get(key) ?? { qty: 0, sourceCount: 0, sampleReferences: [] }
    current.qty += decimalToNumber(source.qty)
    current.sourceCount += 1
    if (current.sampleReferences.length < 5) {
      current.sampleReferences.push(source.referenceLabel)
    }
    totals.set(key, current)
  }
  return totals
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

function normalizeSqlQueryLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SQL_COLLECTOR_PAGE_SIZE
  if (!Number.isFinite(limit)) return DEFAULT_SQL_COLLECTOR_PAGE_SIZE
  return Math.max(Math.floor(limit), 1)
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

function buildTruncatedFinding(maxFindings: number, nextCursor: string | null): InventoryInvariantFinding {
  return {
    severity: 'critical',
    code: INVENTORY_INVARIANT_TRUNCATED_CODE,
    message: `Inventory invariant report capped at ${maxFindings} findings; more findings exist`,
    details: {
      maxFindings,
      nextCursor,
    },
  }
}

function hasRowModeFilters(options: {
  productId?: string
  warehouseId?: string
  severity?: InventoryInvariantSeverity
}): boolean {
  return Boolean(options.productId || options.warehouseId || options.severity)
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

  if (rows.reservationSources) {
    const reservationTotals = sumReservationSources(rows.reservationSources)
    for (const stockLevel of rows.stockLevels) {
      const key = quantityKey(stockLevel.productId, stockLevel.warehouseId)
      const reservedQty = decimalToNumber(stockLevel.reservedQty)
      const sourceTotal = reservationTotals.get(key)
      const knownReservedQty = sourceTotal?.qty ?? 0
      if (greaterThanWithTolerance(Math.abs(reservedQty - knownReservedQty), 0, tolerance)) {
        findings.push({
          severity: 'critical',
          code: 'stock_reserved_source_mismatch',
          productId: stockLevel.productId,
          warehouseId: stockLevel.warehouseId,
          message: `Reserved quantity does not match known reservation sources for ${stockLevel.product.sku}`,
          details: {
            stockLevelId: stockLevel.id,
            sku: stockLevel.product.sku,
            reservedQty,
            knownReservedQty,
            delta: reservedQty - knownReservedQty,
            sourceCount: sourceTotal?.sourceCount ?? 0,
            sampleReferences: sourceTotal?.sampleReferences ?? [],
          },
        })
      }
      reservationTotals.delete(key)
    }

    for (const [key, sourceTotal] of reservationTotals) {
      const [productId, warehouseId] = key.split(':')
      if (!greaterThanWithTolerance(Math.abs(sourceTotal.qty), 0, tolerance)) continue
      findings.push({
        severity: 'critical',
        code: 'stock_reserved_source_mismatch',
        productId,
        warehouseId,
        message: 'Known reservation sources exist without a matching stock level',
        details: {
          reservedQty: 0,
          knownReservedQty: sourceTotal.qty,
          delta: -sourceTotal.qty,
          sourceCount: sourceTotal.sourceCount,
          sampleReferences: sourceTotal.sampleReferences,
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
    const unitCostBase = stockMovement.unitCostBase == null ? null : decimalToNumber(stockMovement.unitCostBase)
    const totalValueBase = stockMovement.totalValueBase == null ? null : decimalToNumber(stockMovement.totalValueBase)

    if (isStrictlyNegative(qty)) {
      const warehouseFindings = [
        stockMovement.fromWarehouseId
          ? { warehouseId: stockMovement.fromWarehouseId, warehouseRole: 'from' }
          : stockMovement.toWarehouseId
            ? { warehouseId: stockMovement.toWarehouseId, warehouseRole: 'to' }
            : { warehouseId: undefined, warehouseRole: 'unknown' },
        ...(stockMovement.fromWarehouseId && stockMovement.toWarehouseId && stockMovement.toWarehouseId !== stockMovement.fromWarehouseId
          ? [{ warehouseId: stockMovement.toWarehouseId, warehouseRole: 'to' }]
          : []),
      ]

      for (const warehouseFinding of warehouseFindings) findings.push({
        severity: 'critical',
        code: 'stock_movement_negative_quantity',
        productId: stockMovement.productId,
        warehouseId: warehouseFinding.warehouseId,
        message: `Stock movement quantity is negative for ${stockMovement.product.sku}`,
        details: {
          movementId: stockMovement.id,
          movementType: stockMovement.type,
          warehouseRole: warehouseFinding.warehouseRole,
          sku: stockMovement.product.sku,
          qty,
          fromWarehouseId: stockMovement.fromWarehouseId,
          toWarehouseId: stockMovement.toWarehouseId,
        },
      })
    }

    if (unitCostBase != null && totalValueBase != null) {
      const valueDelta = stockMovementValueDelta({ qty, unitCostBase, totalValueBase })
      if (valueDelta.isMismatch) {
        findings.push({
          severity: 'warning',
          code: 'stock_movement_value_mismatch',
          productId: stockMovement.productId,
          warehouseId: stockMovement.fromWarehouseId ?? stockMovement.toWarehouseId ?? undefined,
          message: `Stock movement value does not match quantity times unit cost for ${stockMovement.product.sku}`,
          details: {
            movementId: stockMovement.id,
            movementType: stockMovement.type,
            sku: stockMovement.product.sku,
            qty,
            unitCostBase,
            totalValueBase,
            expectedTotalValueBase: valueDelta.expectedTotalValueBase,
            delta: Math.round(valueDelta.delta * 1000000) / 1000000,
            absoluteTolerance: valueDelta.absoluteTolerance,
            relativeDelta: valueDelta.relativeDelta == null
              ? null
              : Math.round(valueDelta.relativeDelta * 1000000) / 1000000,
            relativeTolerance: STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE,
          },
        })
      }
    } else if (unitCostBase != null || totalValueBase != null) {
      findings.push({
        severity: 'warning',
        code: 'stock_movement_value_partial',
        productId: stockMovement.productId,
        warehouseId: stockMovement.fromWarehouseId ?? stockMovement.toWarehouseId ?? undefined,
        message: `Stock movement has only one reporting value field populated for ${stockMovement.product.sku}`,
        details: {
          movementId: stockMovement.id,
          movementType: stockMovement.type,
          sku: stockMovement.product.sku,
          qty,
          unitCostBase,
          totalValueBase,
        },
      })
    }

    if (
      requiresInboundCostLayerEvidence(stockMovement, qty, tolerance) &&
      !hasMatchingInboundCostLayer(stockMovement, rows.costLayers, tolerance)
    ) {
      findings.push({
        severity: 'critical',
        code: 'stock_movement_missing_cost_layer',
        productId: stockMovement.productId,
        warehouseId: stockMovement.toWarehouseId ?? undefined,
        message: `Inbound stock movement is missing matching cost-layer evidence for ${stockMovement.product.sku}`,
        details: {
          movementId: stockMovement.id,
          movementType: stockMovement.type,
          sku: stockMovement.product.sku,
          qty,
          toWarehouseId: stockMovement.toWarehouseId,
          referenceType: stockMovement.referenceType ?? null,
          referenceId: stockMovement.referenceId ?? null,
        },
      })
    }

    if (
      requiresCogsEntryEvidence(stockMovement, qty, tolerance) &&
      (stockMovement._count?.cogsEntries ?? 0) < 1
    ) {
      findings.push({
        severity: 'critical',
        code: 'stock_movement_missing_cogs_entry',
        productId: stockMovement.productId,
        warehouseId: movementWarehouseId(stockMovement) ?? undefined,
        message: `Outbound stock movement is missing COGS evidence for ${stockMovement.product.sku}`,
        details: {
          movementId: stockMovement.id,
          movementType: stockMovement.type,
          sku: stockMovement.product.sku,
          qty,
          fromWarehouseId: stockMovement.fromWarehouseId,
          toWarehouseId: stockMovement.toWarehouseId,
          referenceType: stockMovement.referenceType ?? null,
          referenceId: stockMovement.referenceId ?? null,
          cogsEntryCount: stockMovement._count?.cogsEntries ?? 0,
        },
      })
    }
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
  options: Pick<InventoryInvariantSqlCollectorOptions, 'stockMovementLookbackDays'> = {},
): Promise<InventoryInvariantRows> {
  const stockMovementLookbackDays = options.stockMovementLookbackDays === undefined
    ? 90
    : options.stockMovementLookbackDays
  const stockMovementLookbackDate = stockMovementLookbackDays == null
    ? null
    : new Date(Date.now() - Math.max(1, Math.floor(stockMovementLookbackDays)) * 24 * 60 * 60 * 1000)
  const [stockLevels, costLayers, stockMovements, shippedShipmentLines, reservationSources] = await Promise.all([
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
        poLineId: true,
        poLine: {
          select: {
            poId: true,
          },
        },
        productionOrderId: true,
        adjustmentMovementId: true,
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
        AND: [
          stockMovementLookbackDate ? { createdAt: { gte: stockMovementLookbackDate } } : {},
          {
            OR: [
              { qty: { lt: 0 } },
              { unitCostBase: { not: null } },
              { totalValueBase: { not: null } },
              { type: { in: [...INBOUND_COST_LAYER_MOVEMENT_TYPES, ...OUTBOUND_COGS_MOVEMENT_TYPES, ADJUSTMENT_MOVEMENT_TYPE] } },
            ],
          },
        ],
      },
      select: {
        id: true,
        type: true,
        productId: true,
        fromWarehouseId: true,
        toWarehouseId: true,
        qty: true,
        referenceType: true,
        referenceId: true,
        unitCostBase: true,
        totalValueBase: true,
        _count: {
          select: {
            cogsEntries: true,
          },
        },
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
    client.orderAllocation && client.productionOrder && client.stockLevel.findUnique
      ? loadReservationSourceRows(client as unknown as Parameters<typeof loadReservationSourceRows>[0])
      : Promise.resolve(undefined),
  ])

  return { stockLevels, costLayers, stockMovements, shippedShipmentLines, reservationSources }
}

function sqlFifoProductTypes(): Prisma.Sql {
  return Prisma.join([...FIFO_COST_LAYER_PRODUCT_TYPES])
}

function sqlOptionalProductFilter(alias: 'sl' | 'cl' | 'sm' | 'p', productId: string | undefined): Prisma.Sql {
  if (!productId) return Prisma.empty
  if (alias === 'p') return Prisma.sql`AND p.id = ${productId}`
  // safe: alias is statically constrained by the function signature; do NOT widen.
  return Prisma.sql`AND ${Prisma.raw(alias)}."productId" = ${productId}`
}

function sqlOptionalWarehouseFilter(
  alias: 'sl' | 'cl' | 's',
  warehouseId: string | undefined,
): Prisma.Sql {
  if (!warehouseId) return Prisma.empty
  // safe: alias is statically constrained by the function signature; do NOT widen.
  return Prisma.sql`AND ${Prisma.raw(alias)}."warehouseId" = ${warehouseId}`
}

// Stock movements have two UNION arms that emit different warehouse columns
// (the 'primary' arm emits COALESCE(from, to); the 'to' arm emits toWarehouseId).
// A naive OR predicate that lets either side match leaks findings outside the
// requested warehouse — when filtering for W1 on a W1→W2 movement, the 'to' arm
// would still emit W2 as the warehouseId. Each arm therefore needs its own
// filter that matches the column it actually emits.
function sqlOptionalMovementWarehouseFilter(
  arm: 'primary' | 'to',
  warehouseId: string | undefined,
): Prisma.Sql {
  if (!warehouseId) return Prisma.empty
  if (arm === 'primary') {
    return Prisma.sql`AND COALESCE(sm."fromWarehouseId", sm."toWarehouseId") = ${warehouseId}`
  }
  return Prisma.sql`AND sm."toWarehouseId" = ${warehouseId}`
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

function sqlOptionalStockMovementLookbackFilter(days: number | null | undefined): Prisma.Sql {
  if (days == null) return Prisma.empty
  if (!Number.isFinite(days)) return Prisma.empty
  const normalizedDays = Math.max(1, Math.floor(days))
  return Prisma.sql`AND sm."createdAt" >= NOW() - (${normalizedDays}::int * INTERVAL '1 day')`
}

function sqlOptionalAllocationProductFilter(productId: string | undefined): Prisma.Sql {
  return productId ? Prisma.sql`AND oa."productId" = ${productId}` : Prisma.empty
}

function sqlOptionalAllocationWarehouseFilter(warehouseId: string | undefined): Prisma.Sql {
  return warehouseId ? Prisma.sql`AND oa."warehouseId" = ${warehouseId}` : Prisma.empty
}

function sqlOptionalShipmentLineProductFilter(productId: string | undefined): Prisma.Sql {
  return productId ? Prisma.sql`AND sl."productId" = ${productId}` : Prisma.empty
}

function sqlOptionalShipmentWarehouseFilter(warehouseId: string | undefined): Prisma.Sql {
  return warehouseId ? Prisma.sql`AND s."warehouseId" = ${warehouseId}` : Prisma.empty
}

function sqlOptionalProductionWarehouseFilter(warehouseId: string | undefined): Prisma.Sql {
  return warehouseId ? Prisma.sql`AND po."warehouseId" = ${warehouseId}` : Prisma.empty
}

function sqlOptionalProductionAssemblyProductFilter(productId: string | undefined): Prisma.Sql {
  return productId ? Prisma.sql`AND pc."componentId" = ${productId}` : Prisma.empty
}

function sqlOptionalProductionDisassemblyProductFilter(productId: string | undefined): Prisma.Sql {
  return productId ? Prisma.sql`AND po."outputProductId" = ${productId}` : Prisma.empty
}

function sqlOptionalReservationProductFilter(productId: string | undefined): Prisma.Sql {
  return productId ? Prisma.sql`AND COALESCE(sl."productId", rt."productId") = ${productId}` : Prisma.empty
}

function sqlOptionalReservationWarehouseFilter(warehouseId: string | undefined): Prisma.Sql {
  return warehouseId ? Prisma.sql`AND COALESCE(sl."warehouseId", rt."warehouseId") = ${warehouseId}` : Prisma.empty
}

function buildSqlInventoryInvariantQuery(options: Required<Pick<InventoryInvariantSqlCollectorOptions, 'quantityTolerance'>> & InventoryInvariantSqlCollectorOptions): Prisma.Sql {
  const limit = normalizeSqlQueryLimit(options.limit)
  const tolerance = options.quantityTolerance
  const negativeTolerance = -tolerance
  const offset = sqlPageOffset(options.page, options.cursor, limit)
  const stockProductFilter = sqlOptionalProductFilter('sl', options.productId)
  const stockWarehouseFilter = sqlOptionalWarehouseFilter('sl', options.warehouseId)
  const costLayerProductFilter = sqlOptionalProductFilter('cl', options.productId)
  const costLayerWarehouseFilter = sqlOptionalWarehouseFilter('cl', options.warehouseId)
  const movementProductFilter = sqlOptionalProductFilter('sm', options.productId)
  const movementPrimaryWarehouseFilter = sqlOptionalMovementWarehouseFilter('primary', options.warehouseId)
  const movementToWarehouseFilter = sqlOptionalMovementWarehouseFilter('to', options.warehouseId)
  const stockMovementLookbackFilter = sqlOptionalStockMovementLookbackFilter(options.stockMovementLookbackDays)
  const shipmentProductFilter = sqlOptionalProductFilter('sl', options.productId)
  const shipmentWarehouseFilter = sqlOptionalWarehouseFilter('s', options.warehouseId)
  const allocationProductFilter = sqlOptionalAllocationProductFilter(options.productId)
  const allocationWarehouseFilter = sqlOptionalAllocationWarehouseFilter(options.warehouseId)
  const activeShipmentProductFilter = sqlOptionalShipmentLineProductFilter(options.productId)
  const activeShipmentWarehouseFilter = sqlOptionalShipmentWarehouseFilter(options.warehouseId)
  const productionWarehouseFilter = sqlOptionalProductionWarehouseFilter(options.warehouseId)
  const productionAssemblyProductFilter = sqlOptionalProductionAssemblyProductFilter(options.productId)
  const productionDisassemblyProductFilter = sqlOptionalProductionDisassemblyProductFilter(options.productId)
  const reservationProductFilter = sqlOptionalReservationProductFilter(options.productId)
  const reservationWarehouseFilter = sqlOptionalReservationWarehouseFilter(options.warehouseId)
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
    active_shipment_lines AS (
      SELECT
        sl."lineId",
        sl."productId",
        s."warehouseId",
        SUM(sl.qty) AS qty
      FROM "shipment_lines" sl
      INNER JOIN "shipments" s ON s.id = sl."shipmentId"
      INNER JOIN "sales_orders" so ON so.id = s."orderId"
      WHERE s.status <> 'PENDING'
        AND so.status NOT IN ('CANCELLED', 'REFUNDED')
        ${activeShipmentProductFilter}
        ${activeShipmentWarehouseFilter}
      GROUP BY sl."lineId", sl."productId", s."warehouseId"
    ),
    reservation_sources AS (
      SELECT
        oa."productId",
        oa."warehouseId",
        SUM(GREATEST(oa.qty - COALESCE(asl.qty, 0), 0)) AS qty
      FROM "order_allocations" oa
      INNER JOIN "sales_orders" so ON so.id = oa."orderId"
      LEFT JOIN active_shipment_lines asl
        ON asl."lineId" = oa."lineId"
       AND asl."productId" = oa."productId"
       AND asl."warehouseId" = oa."warehouseId"
      WHERE oa.qty > 0
        AND so.status NOT IN ('CANCELLED', 'REFUNDED')
        ${allocationProductFilter}
        ${allocationWarehouseFilter}
      GROUP BY oa."productId", oa."warehouseId"
      HAVING SUM(GREATEST(oa.qty - COALESCE(asl.qty, 0), 0)) > ${tolerance}

      UNION ALL

      SELECT
        pc."componentId" AS "productId",
        po."warehouseId",
        SUM(po."qtyPlanned" * pc.qty) AS qty
      FROM "production_orders" po
      INNER JOIN "products" output_product ON output_product.id = po."outputProductId"
      INNER JOIN "product_components" pc ON pc."productId" = output_product.id
      WHERE po.status = 'IN_PROGRESS'
        AND po."orderType" = 'ASSEMBLY'
        ${productionWarehouseFilter}
        ${productionAssemblyProductFilter}
      GROUP BY pc."componentId", po."warehouseId"
      HAVING SUM(po."qtyPlanned" * pc.qty) > ${tolerance}

      UNION ALL

      SELECT
        po."outputProductId" AS "productId",
        po."warehouseId",
        SUM(po."qtyPlanned") AS qty
      FROM "production_orders" po
      WHERE po.status = 'IN_PROGRESS'
        AND po."orderType" = 'DISASSEMBLY'
        ${productionWarehouseFilter}
        ${productionDisassemblyProductFilter}
      GROUP BY po."outputProductId", po."warehouseId"
      HAVING SUM(po."qtyPlanned") > ${tolerance}
    ),
    reservation_totals AS (
      SELECT
        "productId",
        "warehouseId",
        SUM(qty) AS "knownReservedQty",
        COUNT(*) AS "sourceCount"
      FROM reservation_sources
      GROUP BY "productId", "warehouseId"
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
        'stock_reserved_source_mismatch:' || COALESCE(sl."productId", rt."productId") || ':' || COALESCE(sl."warehouseId", rt."warehouseId") AS "sortKey",
        'critical'::text AS severity,
        'stock_reserved_source_mismatch'::text AS code,
        COALESCE(sl."productId", rt."productId") AS "productId",
        COALESCE(sl."warehouseId", rt."warehouseId") AS "warehouseId",
        CASE
          WHEN sl.id IS NULL THEN 'Known reservation sources exist without a matching stock level for ' || p.sku
          ELSE 'Reserved quantity does not match known reservation sources for ' || p.sku
        END AS message,
        jsonb_build_object(
          'stockLevelId', sl.id,
          'sku', p.sku,
          'reservedQty', COALESCE(sl."reservedQty", 0),
          'knownReservedQty', COALESCE(rt."knownReservedQty", 0),
          'delta', COALESCE(sl."reservedQty", 0) - COALESCE(rt."knownReservedQty", 0),
          'sourceCount', COALESCE(rt."sourceCount", 0)
        ) AS details
      FROM "stock_levels" sl
      FULL OUTER JOIN reservation_totals rt
        ON rt."productId" = sl."productId"
       AND rt."warehouseId" = sl."warehouseId"
      INNER JOIN "products" p ON p.id = COALESCE(sl."productId", rt."productId")
      WHERE ABS(COALESCE(sl."reservedQty", 0) - COALESCE(rt."knownReservedQty", 0)) > ${tolerance}
        ${reservationProductFilter}
        ${reservationWarehouseFilter}

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
      -- receivedQty is the immutable receipt quantity, so strict zero
      -- mirrors the database CHECK constraint rather than tolerance drift.
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
        'stock_movement_negative_quantity:' || sm.id || ':primary' AS "sortKey",
        'critical'::text AS severity,
        'stock_movement_negative_quantity'::text AS code,
        sm."productId",
        COALESCE(sm."fromWarehouseId", sm."toWarehouseId") AS "warehouseId",
        'Stock movement quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'warehouseRole', CASE WHEN sm."fromWarehouseId" IS NOT NULL THEN 'from' WHEN sm."toWarehouseId" IS NOT NULL THEN 'to' ELSE 'unknown' END,
          'sku', p.sku,
          'qty', sm.qty,
          'fromWarehouseId', sm."fromWarehouseId",
          'toWarehouseId', sm."toWarehouseId"
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      -- stock movement qty is written as a signed event input, not an
      -- accumulated balance, so strict zero mirrors the database constraint.
      WHERE sm.qty < 0
        ${movementProductFilter}
        ${movementPrimaryWarehouseFilter}
        ${stockMovementLookbackFilter}

      UNION ALL

      SELECT
        'stock_movement_negative_quantity:' || sm.id || ':to' AS "sortKey",
        'critical'::text AS severity,
        'stock_movement_negative_quantity'::text AS code,
        sm."productId",
        sm."toWarehouseId" AS "warehouseId",
        'Stock movement quantity is negative for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'warehouseRole', 'to',
          'sku', p.sku,
          'qty', sm.qty,
          'fromWarehouseId', sm."fromWarehouseId",
          'toWarehouseId', sm."toWarehouseId"
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE sm.qty < 0
        AND sm."fromWarehouseId" IS NOT NULL
        AND sm."toWarehouseId" IS NOT NULL
        AND sm."toWarehouseId" <> sm."fromWarehouseId"
        ${movementProductFilter}
        ${movementToWarehouseFilter}
        ${stockMovementLookbackFilter}

      UNION ALL

      SELECT
        'stock_movement_value_mismatch:' || sm.id AS "sortKey",
        'warning'::text AS severity,
        'stock_movement_value_mismatch'::text AS code,
        sm."productId",
        COALESCE(sm."fromWarehouseId", sm."toWarehouseId") AS "warehouseId",
        'Stock movement value does not match quantity times unit cost for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'sku', p.sku,
          'qty', sm.qty,
          'unitCostBase', sm."unitCostBase",
          'totalValueBase', sm."totalValueBase",
          'expectedTotalValueBase', ABS(sm.qty) * sm."unitCostBase",
          'delta', ROUND(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase"), 6),
          'absoluteTolerance', CASE
            WHEN ABS(ABS(sm.qty) * sm."unitCostBase") < 1 THEN ${STOCK_MOVEMENT_VALUE_SMALL_TOLERANCE}
            ELSE ${STOCK_MOVEMENT_VALUE_TOLERANCE}
          END,
          'relativeDelta', CASE
            WHEN ABS(ABS(sm.qty) * sm."unitCostBase") > 0
              THEN ROUND((ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) / ABS(ABS(sm.qty) * sm."unitCostBase"))::numeric, 6)
            WHEN ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) = 0 THEN 0
            ELSE NULL
          END,
          'relativeTolerance', ${STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE}
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE sm."unitCostBase" IS NOT NULL
        AND sm."totalValueBase" IS NOT NULL
        AND ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) > CASE
          WHEN ABS(ABS(sm.qty) * sm."unitCostBase") < 1 THEN ${STOCK_MOVEMENT_VALUE_SMALL_TOLERANCE}
          ELSE ${STOCK_MOVEMENT_VALUE_TOLERANCE}
        END
        AND CASE
          WHEN ABS(ABS(sm.qty) * sm."unitCostBase") = 0 THEN TRUE
          ELSE ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) / ABS(ABS(sm.qty) * sm."unitCostBase") > ${STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE}
        END
        ${movementProductFilter}
        ${movementPrimaryWarehouseFilter}
        ${stockMovementLookbackFilter}

      UNION ALL

      SELECT
        'stock_movement_value_partial:' || sm.id AS "sortKey",
        'warning'::text AS severity,
        'stock_movement_value_partial'::text AS code,
        sm."productId",
        COALESCE(sm."fromWarehouseId", sm."toWarehouseId") AS "warehouseId",
        'Stock movement has only one reporting value field populated for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'sku', p.sku,
          'qty', sm.qty,
          'unitCostBase', sm."unitCostBase",
          'totalValueBase', sm."totalValueBase"
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE ((sm."unitCostBase" IS NULL AND sm."totalValueBase" IS NOT NULL)
        OR (sm."unitCostBase" IS NOT NULL AND sm."totalValueBase" IS NULL))
        ${movementProductFilter}
        ${movementPrimaryWarehouseFilter}
        ${stockMovementLookbackFilter}

      UNION ALL

      SELECT
        'stock_movement_missing_cost_layer:' || sm.id AS "sortKey",
        'critical'::text AS severity,
        'stock_movement_missing_cost_layer'::text AS code,
        sm."productId",
        sm."toWarehouseId" AS "warehouseId",
        'Inbound stock movement is missing matching cost-layer evidence for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'sku', p.sku,
          'qty', sm.qty,
          'toWarehouseId', sm."toWarehouseId",
          'referenceType', sm."referenceType",
          'referenceId', sm."referenceId"
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE (
          sm.type IN ('PURCHASE_RECEIPT', 'PRODUCTION_IN')
          OR (sm.type = 'ADJUSTMENT' AND sm."toWarehouseId" IS NOT NULL)
        )
        AND sm.qty > ${tolerance}
        AND sm."toWarehouseId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "cost_layers" cl
          WHERE cl."productId" = sm."productId"
            AND cl."warehouseId" = sm."toWarehouseId"
            AND ABS(cl."receivedQty" - sm.qty) <= ${tolerance}
            AND (
              (sm.type = 'PRODUCTION_IN'
                AND sm."referenceType" = 'ProductionOrder'
                AND sm."referenceId" IS NOT NULL
                AND cl."production_order_id" = sm."referenceId")
              OR
              (sm.type = 'PURCHASE_RECEIPT'
                AND sm."referenceType" = 'PurchaseOrder'
                AND sm."referenceId" IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM "purchase_order_lines" pol
                  WHERE pol.id = cl."poLineId"
                    AND pol."poId" = sm."referenceId"
                ))
              OR
              (sm.type = 'ADJUSTMENT'
                AND cl."adjustment_movement_id" = sm.id)
            )
        )
        ${movementProductFilter}
        ${movementToWarehouseFilter}
        ${stockMovementLookbackFilter}

      UNION ALL

      SELECT
        'stock_movement_missing_cogs_entry:' || sm.id AS "sortKey",
        'critical'::text AS severity,
        'stock_movement_missing_cogs_entry'::text AS code,
        sm."productId",
        COALESCE(sm."fromWarehouseId", sm."toWarehouseId") AS "warehouseId",
        'Outbound stock movement is missing COGS evidence for ' || p.sku AS message,
        jsonb_build_object(
          'movementId', sm.id,
          'movementType', sm.type,
          'sku', p.sku,
          'qty', sm.qty,
          'fromWarehouseId', sm."fromWarehouseId",
          'toWarehouseId', sm."toWarehouseId",
          'referenceType', sm."referenceType",
          'referenceId', sm."referenceId",
          'cogsEntryCount', 0
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE (
          sm.type IN ('SALE_DISPATCH', 'PRODUCTION_OUT')
          OR (sm.type = 'ADJUSTMENT' AND sm."fromWarehouseId" IS NOT NULL)
        )
        AND sm.qty > ${tolerance}
        AND NOT EXISTS (
          SELECT 1
          FROM "cogs_entries" ce
          WHERE ce."movementId" = sm.id
        )
        ${movementProductFilter}
        ${movementPrimaryWarehouseFilter}
        ${stockMovementLookbackFilter}

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
              AND length(entry.value->>'qty') <= 64
              AND COALESCE(entry.value->>'qty', '') ~ '^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$'
              AND (entry.value->>'qty')::numeric > 0
              AND length(entry.value->>'unitCostBase') <= 64
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
      -- Severity is applied after the UNION so all codes share one query
      -- shape. Production cron does not filter severity; ad-hoc filtered
      -- admin calls trade some inner work for simpler collector maintenance.
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
      limit: limit + 1,
      quantityTolerance: options.quantityTolerance ?? DEFAULT_QUANTITY_TOLERANCE,
    }),
  )
  const hasMore = rows.length > limit
  const visibleRows = hasMore ? rows.slice(0, limit) : rows

  return {
    findings: mapSqlFindingRows(visibleRows),
    nextCursor: hasMore ? visibleRows[visibleRows.length - 1]?.sortKey ?? null : null,
    hasMore,
  }
}

export async function collectSqlInventoryInvariantFindingCollection(
  client: InventoryInvariantSqlClient = db as unknown as InventoryInvariantSqlClient,
  options: Omit<InventoryInvariantSqlCollectorOptions, 'cursor' | 'page'> & {
    pageSize?: number
    maxFindings?: number
  } = {},
): Promise<InventoryInvariantFindingCollection> {
  const maxFindings = Math.max(1, Math.floor(options.maxFindings ?? DEFAULT_SQL_REPORT_MAX_FINDINGS))
  const pageSize = normalizeSqlCollectorLimit(options.pageSize ?? options.limit)
  const findings: InventoryInvariantFinding[] = []
  let cursor: string | null = null
  let truncated = false

  while (findings.length < maxFindings) {
    const page = await collectSqlInventoryInvariantFindingsPage(client, {
      ...options,
      limit: Math.min(pageSize, maxFindings - findings.length),
      cursor,
    })
    findings.push(...page.findings)
    cursor = page.nextCursor
    if (findings.length >= maxFindings && page.hasMore) {
      truncated = true
      break
    }
    if (!page.hasMore || !page.nextCursor) break
  }

  if (truncated) {
    findings.push(buildTruncatedFinding(maxFindings, cursor))
  }

  return { findings, truncated, nextCursor: truncated ? cursor : null }
}

export async function collectSqlInventoryInvariantFindings(
  client: InventoryInvariantSqlClient = db as unknown as InventoryInvariantSqlClient,
  options: Omit<InventoryInvariantSqlCollectorOptions, 'cursor' | 'page'> & {
    pageSize?: number
    maxFindings?: number
  } = {},
): Promise<InventoryInvariantFinding[]> {
  const collection = await collectSqlInventoryInvariantFindingCollection(client, options)
  return collection.findings
}

export async function runInventoryInvariantReport(options: {
  client?: InventoryInvariantClient
  sqlClient?: InventoryInvariantSqlClient
  quantityTolerance?: number
  /**
   * SQL mode supports productId/warehouseId/severity filters. Row mode exists
   * for evaluator fixtures and rejects those filters rather than ignoring them.
   */
  collectionMode?: 'rows' | 'sql'
  limit?: number
  pageSize?: number
  maxFindings?: number
  productId?: string
  warehouseId?: string
  severity?: InventoryInvariantSeverity
  stockMovementLookbackDays?: number | null
} = {}): Promise<InventoryInvariantReport> {
  const client = options.client ?? (db as unknown as InventoryInvariantClient)
  const collectionMode = options.collectionMode ?? (isSqlInventoryInvariantClient(client) ? 'sql' : 'rows')
  if (collectionMode === 'rows' && hasRowModeFilters(options)) {
    throw new Error('Inventory invariant row collection mode does not support productId, warehouseId, or severity filters')
  }
  if (collectionMode === 'sql' && !options.sqlClient && !isSqlInventoryInvariantClient(client)) {
    throw new Error('SQL collection mode requires a $queryRaw-capable client; pass options.sqlClient explicitly')
  }

  const collection = collectionMode === 'sql'
    ? await collectSqlInventoryInvariantFindingCollection(
        options.sqlClient ?? (client as unknown as InventoryInvariantSqlClient),
        {
        quantityTolerance: options.quantityTolerance,
        limit: options.limit,
        pageSize: options.pageSize,
        maxFindings: options.maxFindings,
        productId: options.productId,
        warehouseId: options.warehouseId,
        severity: options.severity,
        stockMovementLookbackDays: options.stockMovementLookbackDays,
      },
      )
      : {
          findings: evaluateInventoryInvariantRows(
            await collectInventoryInvariantRows(client, {
              stockMovementLookbackDays: options.stockMovementLookbackDays,
            }),
            { quantityTolerance: options.quantityTolerance },
          ),
          truncated: false,
          nextCursor: null,
        }

  return {
    checkedAt: new Date().toISOString(),
    findings: collection.findings,
    truncated: collection.truncated,
    nextCursor: collection.nextCursor,
    summary: buildSummary(collection.findings),
  }
}
