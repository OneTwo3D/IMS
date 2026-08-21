import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCostLayerSnapshot } from '@/lib/cost-layer-snapshots'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
// decimal-boundary-ok: report-only (inventory invariant finding details)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import {
  loadReservationSourceRows,
  type ReservationBreakdownRow,
} from '@/lib/domain/inventory/reservation-breakdown'
import { RESERVATION_RELEASING_SHIPMENT_STATUS } from '@/lib/domain/inventory/reservation-residual'
import { HISTORICAL_IMPORT_REFERENCE_TYPES } from '@/lib/domain/inventory/stock-movement-value'
import {
  findDisproportionateFulfillmentComponent,
  type DecimalFulfillmentRequirement,
} from '@/lib/products/fulfillment-coverage'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirements } from '@/lib/products/fulfillment-requirement-snapshot'

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

export type InventoryInvariantStrandedTransferRow = {
  id: string
  reference: string
  fromWarehouseId: string
  dispatchedAt: Date | string | null
  lines: Array<{ id: string; productId: string; qty: DecimalLike }>
}

/** An allocation row at the grain it and `ShipmentLine` share (o3d-4kfh). */
export type InventoryInvariantAllocationRow = {
  lineId: string
  productId: string
  warehouseId: string
  qty: DecimalLike
}

/** A COMMITTED (non-PENDING) shipment line, at that same grain. */
export type InventoryInvariantCommittedShipmentLineRow = {
  lineId: string
  productId: string
  qty: DecimalLike
  product: Pick<ProductSnapshot, 'sku'>
  shipment: { orderId: string; warehouseId: string }
}

export type InventoryInvariantRows = {
  stockLevels: InventoryInvariantStockLevelRow[]
  costLayers: InventoryInvariantCostLayerRow[]
  stockMovements: InventoryInvariantStockMovementRow[]
  shippedShipmentLines: InventoryInvariantShipmentLineRow[]
  reservationSources?: ReservationBreakdownRow[]
  /**
   * o3d-4kfh r3: the two sides of the committed-coverage census. BOTH must be present for the
   * check to run — an allocation set without its shipment lines (or the reverse) would report
   * every commitment as unbacked. Undefined means "not collected", exactly like the two above.
   */
  orderAllocations?: InventoryInvariantAllocationRow[]
  committedShipmentLines?: InventoryInvariantCommittedShipmentLineRow[]
  /**
   * Transfers stranded IN_TRANSIT (audit-C5). The caller (collector) applies the
   * status + age filter; the evaluator emits a per-line finding for each row here.
   */
  strandedTransfers?: InventoryInvariantStrandedTransferRow[]
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
  stockTransfer?: {
    findMany(args: unknown): Promise<InventoryInvariantStrandedTransferRow[]>
  }
}

export type InventoryInvariantSqlClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

/**
 * The capability {@link collectDisproportionateCommittedKitFindings} needs (o3d-aqke): committed
 * shipment lines WITH their sales line's product, and the product read the fulfilment graph walk
 * issues. Declared as its own type rather than folded into `InventoryInvariantClient` so a fixture
 * that cannot answer it is a compile error at the call site instead of a silently skipped census.
 */
export type InventoryInvariantKitGraphClient = {
  shipmentLine: {
    findMany(args: unknown): Promise<Array<{
      lineId: string
      productId: string
      qty: DecimalInput
      product: { sku: string }
      line: {
        productId: string | null
        sku: string | null
        description: string
        /**
         * o3d-kouj's per-line pin (PR #625), selected unconditionally. Optional only so a double
         * may omit it: an absent pin is the pre-snapshot state, which
         * {@link lineFulfillmentRequirements} answers from the current graph, exactly as this
         * census did before the column existed.
         */
        fulfillmentRequirements?: unknown
      } | null
      shipment: { orderId: string; warehouseId: string }
    }>>
  }
  product: {
    findMany(args: unknown): Promise<unknown[]>
  }
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
// audit-C5: a transfer IN_TRANSIT longer than this is treated as stranded — its
// stock left the source but never arrived at the destination (a receive that
// failed or was never run). Surfaced as a reconciliation exception.
const STRANDED_TRANSFER_DAYS = 7
const STOCK_MOVEMENT_VALUE_TOLERANCE = 0.01
const STOCK_MOVEMENT_VALUE_SMALL_TOLERANCE = 0.000001
const STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE = 0.0001
const DEFAULT_SQL_COLLECTOR_PAGE_SIZE = 500
const MAX_SQL_COLLECTOR_PAGE_SIZE = 1000
const DEFAULT_SQL_REPORT_MAX_FINDINGS = 5000
const FIFO_RECONCILIATION_EXCEPTION = 'Products without FIFO cost layers are excluded; FIFO cost-layer products are expected to reconcile within tolerance.'
const INVENTORY_INVARIANT_TRUNCATED_CODE = 'invariant_report_truncated'
const INBOUND_COST_LAYER_MOVEMENT_TYPES = new Set(['PURCHASE_RECEIPT', 'PRODUCTION_IN'])
const OUTBOUND_COGS_MOVEMENT_TYPES = new Set(['SALE_DISPATCH', 'PURCHASE_REVERSAL', 'PRODUCTION_OUT'])
const HISTORICAL_IMPORT_REFERENCE_TYPE_SET: ReadonlySet<string> = new Set(HISTORICAL_IMPORT_REFERENCE_TYPES)
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
  if (isHistoricalImportDemandMovement(movement)) return false
  if (OUTBOUND_COGS_MOVEMENT_TYPES.has(movement.type)) return true
  return movement.type === ADJUSTMENT_MOVEMENT_TYPE && Boolean(movement.fromWarehouseId)
}

// Forecasting-only demand history: a warehouse-less SALE_DISPATCH carrying a
// historical-import referenceType. Zero-cost demand records with no COGS entry by
// design — exempt from the COGS-evidence guard. Narrowed to this exact shape (matches
// the DB trigger in migration 20260616120000) so a real warehouse-backed dispatch,
// PRODUCTION_OUT, or outbound ADJUSTMENT cannot evade the guard via referenceType.
function isHistoricalImportDemandMovement(movement: InventoryInvariantStockMovementRow): boolean {
  return movement.type === 'SALE_DISPATCH'
    && !movement.fromWarehouseId
    && !movement.toWarehouseId
    && Boolean(movement.referenceType)
    && HISTORICAL_IMPORT_REFERENCE_TYPE_SET.has(movement.referenceType!)
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

/**
 * Can this client answer the KIT proportionality census? Production's `db` always can; a hand-rolled
 * fixture may not, and the report says so in the return value rather than quietly dropping a check.
 */
function isKitGraphInvariantClient(client: unknown): client is InventoryInvariantKitGraphClient {
  const candidate = client as Partial<InventoryInvariantKitGraphClient> | null
  return typeof candidate?.shipmentLine?.findMany === 'function'
    && typeof candidate?.product?.findMany === 'function'
}

function isSqlInventoryInvariantClient(client: unknown): client is InventoryInvariantSqlClient {
  return typeof (client as { $queryRaw?: unknown }).$queryRaw === 'function'
}

function hasCostLayerSnapshot(value: unknown): boolean {
  return parseCostLayerSnapshot(value).some((entry) => toDecimal(entry.qty).gt(0))
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

  // o3d-4kfh r3: is every committed shipment line backed by an allocation row big enough to cover
  // it? See the SQL branch of the same name for why nothing else can see this: every consumer
  // computes `qty − committed` floored at zero, so an over-commitment vanishes rather than
  // overflowing, and the reservation census credits only the residual that still exists.
  //
  // FLAT check only (per line/warehouse/product) — the KIT proportionality half needs the
  // fulfillment requirement graph and lives in `findUncoveredCommittedShipment`, which runs at
  // validateAllocationIntegrity and (o3d-4kfh r4) at EVERY shipment transition including dispatch,
  // not just PENDING -> PICKING. This sweep is still FLAT and deliberately so: expanding the graph
  // here means a recursive walk over product_components, which the paged SQL collector below cannot
  // do without a recursive CTE. So a disproportionate committed KIT set is caught at the transition
  // seams and refused at the component editor, but is NOT reported by this census.
  //
  // o3d-4kfh r6: nor is proportionality itself sufficient at those seams. A UNIFORM rescale of a kit
  // (2xA + 1xB -> 4xA + 2xB) leaves an A=2/B=1 commitment exactly proportional to the NEW recipe at
  // coverage 0.5, so every graph-aware check passes while half a kit ships. What refuses that is the
  // graph-version CAS (`findStaleFulfillmentGraphAllocation`): allocations stamp
  // `Product.fulfillmentGraphVersion` and commitment/dispatch reject a stamp that no longer matches.
  // A STALE STAMP IS ALSO NOT REPORTED BY THIS CENSUS — it surfaces only when someone tries to pick
  // or dispatch. Adding it would need the allocation rows joined to products, which this collector
  // does not load.
  if (rows.orderAllocations && rows.committedShipmentLines) {
    const allocationScopeKey = (row: { lineId: string; warehouseId: string; productId: string }) =>
      `${row.lineId}|${row.warehouseId}|${row.productId}`
    const allocatedByScope = new Map<string, number>()
    for (const allocation of rows.orderAllocations) {
      const key = allocationScopeKey(allocation)
      allocatedByScope.set(key, (allocatedByScope.get(key) ?? 0) + decimalToNumber(allocation.qty))
    }
    const committedByScope = new Map<string, {
      lineId: string
      productId: string
      warehouseId: string
      orderId: string
      sku: string
      qty: number
    }>()
    for (const shipmentLine of rows.committedShipmentLines) {
      const scope = {
        lineId: shipmentLine.lineId,
        productId: shipmentLine.productId,
        warehouseId: shipmentLine.shipment.warehouseId,
      }
      const key = allocationScopeKey(scope)
      const current = committedByScope.get(key) ?? {
        ...scope,
        orderId: shipmentLine.shipment.orderId,
        sku: shipmentLine.product.sku,
        qty: 0,
      }
      current.qty += decimalToNumber(shipmentLine.qty)
      committedByScope.set(key, current)
    }
    for (const [key, committed] of committedByScope) {
      const allocatedQty = allocatedByScope.get(key) ?? 0
      if (!greaterThanWithTolerance(committed.qty, allocatedQty, tolerance)) continue
      findings.push({
        severity: 'critical',
        code: 'allocation_committed_shipment_uncovered',
        productId: committed.productId,
        warehouseId: committed.warehouseId,
        message: `Committed shipment quantity exceeds the allocation backing it for ${committed.sku}`,
        details: {
          lineId: committed.lineId,
          sku: committed.sku,
          committedQty: committed.qty,
          allocatedQty,
          delta: committed.qty - allocatedQty,
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

  // audit-C5: transfers the caller has already filtered to "stranded IN_TRANSIT"
  // (stock left the source but was never received). One finding per line so the
  // product/warehouse drill-down matches the source warehouse.
  for (const transfer of rows.strandedTransfers ?? []) {
    const dispatchedAtIso = transfer.dispatchedAt == null
      ? null
      : (transfer.dispatchedAt instanceof Date ? transfer.dispatchedAt.toISOString() : String(transfer.dispatchedAt))
    // Match the SQL arm's date-only format so findings dedupe across both paths.
    const dispatchedAtDate = dispatchedAtIso?.slice(0, 10) ?? null
    for (const line of transfer.lines) {
      findings.push({
        severity: 'warning',
        code: 'transfer_stranded_in_transit',
        productId: line.productId,
        warehouseId: transfer.fromWarehouseId,
        message: `Transfer ${transfer.reference} has been in transit since ${dispatchedAtDate ?? 'an unknown date'} — stock left the source but was never received`,
        details: {
          transferId: transfer.id,
          transferLineId: line.id,
          reference: transfer.reference,
          productId: line.productId,
          fromWarehouseId: transfer.fromWarehouseId,
          dispatchedAt: dispatchedAtIso,
          qty: decimalToNumber(line.qty),
          thresholdDays: STRANDED_TRANSFER_DAYS,
        },
      })
    }
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
  // audit-C5: transfers stranded IN_TRANSIT past the threshold (status + age
  // filter applied here so the evaluator stays pure).
  const strandedTransferCutoff = new Date(Date.now() - STRANDED_TRANSFER_DAYS * 24 * 60 * 60 * 1000)
  const [
    stockLevels,
    costLayers,
    stockMovements,
    shippedShipmentLines,
    reservationSources,
    strandedTransfers,
    orderAllocations,
    committedShipmentLines,
  ] = await Promise.all([
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
            refundStatus: { not: 'FULL' },
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
    client.stockTransfer
      ? client.stockTransfer.findMany({
          where: { status: 'IN_TRANSIT', dispatchedAt: { lt: strandedTransferCutoff } },
          select: {
            id: true,
            reference: true,
            fromWarehouseId: true,
            dispatchedAt: true,
            lines: { select: { id: true, productId: true, qty: true } },
          },
        })
      : Promise.resolve(undefined),
    // o3d-4kfh r3: the two sides of the committed-coverage census. Collected as a PAIR — the
    // evaluator refuses to run on one without the other, because an allocation set with no shipment
    // lines (or the reverse) would read as either "everything unbacked" or "nothing committed".
    client.orderAllocation
      ? client.orderAllocation.findMany({
          select: { lineId: true, productId: true, warehouseId: true, qty: true },
        }) as Promise<InventoryInvariantAllocationRow[]>
      : Promise.resolve(undefined),
    client.orderAllocation
      ? client.shipmentLine.findMany({
          where: { shipment: { status: { not: 'PENDING' } } },
          select: {
            lineId: true,
            productId: true,
            qty: true,
            product: { select: { sku: true } },
            shipment: { select: { orderId: true, warehouseId: true } },
          },
        }) as unknown as Promise<InventoryInvariantCommittedShipmentLineRow[]>
      : Promise.resolve(undefined),
  ])

  return {
    stockLevels,
    costLayers,
    stockMovements,
    shippedShipmentLines,
    reservationSources,
    strandedTransfers,
    orderAllocations,
    committedShipmentLines,
  }
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

function sqlNumeric(value: number): Prisma.Sql {
  return Prisma.sql`${value}::numeric`
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
  const toleranceSql = sqlNumeric(tolerance)
  const negativeToleranceSql = sqlNumeric(negativeTolerance)
  const stockMovementValueSmallToleranceSql = sqlNumeric(STOCK_MOVEMENT_VALUE_SMALL_TOLERANCE)
  const stockMovementValueToleranceSql = sqlNumeric(STOCK_MOVEMENT_VALUE_TOLERANCE)
  const stockMovementValueRelativeToleranceSql = sqlNumeric(STOCK_MOVEMENT_VALUE_RELATIVE_TOLERANCE)
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
    -- Shipment quantity per allocation row, in BOTH readings the contract defines (o3d-4kfh):
    --   "dispatchedQty" — the SHARED RESERVATION_RELEASING_SHIPMENT_STATUS, i.e. what has actually
    --     given reservation back. reservedQty is decremented ONLY on the transition to SHIPPED, so
    --     netting a PICKING/PACKED shipment out of knownReservedQty invented a
    --     stock_reserved_source_mismatch for every order sitting in the pick/pack window, and — now
    --     that the release paths share this definition — would have made them under-release and
    --     strand reservation on the stock level.
    --   "committedQty" — every non-PENDING line, i.e. what the warehouse is holding against this
    --     order. Used only by the zero-demand branch below.
    -- Deliberately NOT filtered by order status: the zero-demand branch needs the committed lines
    -- of exactly the orders the active branch excludes, and (lineId, productId, warehouseId) never
    -- spans two orders, so nothing can be miscredited.
    committed_shipment_lines AS (
      SELECT
        sl."lineId",
        sl."productId",
        s."warehouseId",
        SUM(sl.qty) AS "committedQty",
        COALESCE(SUM(sl.qty) FILTER (WHERE s.status::text = ${RESERVATION_RELEASING_SHIPMENT_STATUS}), 0) AS "dispatchedQty"
      FROM "shipment_lines" sl
      INNER JOIN "shipments" s ON s.id = sl."shipmentId"
      WHERE s.status::text <> 'PENDING'
        ${activeShipmentProductFilter}
        ${activeShipmentWarehouseFilter}
      GROUP BY sl."lineId", sl."productId", s."warehouseId"
    ),
    reservation_sources AS (
      SELECT
        oa."productId",
        oa."warehouseId",
        SUM(GREATEST(oa.qty - COALESCE(csl."dispatchedQty", 0), 0)) AS qty
      FROM "order_allocations" oa
      INNER JOIN "sales_orders" so ON so.id = oa."orderId"
      LEFT JOIN committed_shipment_lines csl
        ON csl."lineId" = oa."lineId"
       AND csl."productId" = oa."productId"
       AND csl."warehouseId" = oa."warehouseId"
      WHERE oa.qty > 0
        AND so.status <> 'CANCELLED'
        AND so."refundStatus" <> 'FULL'
        ${allocationProductFilter}
        ${allocationWarehouseFilter}
      GROUP BY oa."productId", oa."warehouseId"
      HAVING SUM(GREATEST(oa.qty - COALESCE(csl."dispatchedQty", 0), 0)) > ${toleranceSql}

      UNION ALL

      -- o3d-4kfh: ZERO-DEMAND ORDERS STILL HOLD THEIR COMMITTED RESERVATION.
      --
      -- A CANCELLED or fully-refunded order has no outstanding demand, which is why the branch
      -- above excludes it. But a full refund on an order that already has a PICKING or PACKED
      -- shipment leaves the COMMITTED portion reserved on the stock level: allocation retains the
      -- committed set (see allocateSalesOrder), and only dispatch decrements reservedQty. Omitting
      -- it made knownReservedQty short by exactly that amount and reported a correctly-held
      -- reservation as a critical stock_reserved_source_mismatch.
      --
      -- Credited for the still-committed portion ONLY — LEAST(residual, committed − dispatched).
      -- Any stale outstanding quantity above that has no demand and no shipment behind it: that
      -- part IS a leak, and it must keep showing up as a mismatch.
      SELECT
        oa."productId",
        oa."warehouseId",
        SUM(LEAST(
          GREATEST(oa.qty - COALESCE(csl."dispatchedQty", 0), 0),
          GREATEST(COALESCE(csl."committedQty", 0) - COALESCE(csl."dispatchedQty", 0), 0)
        )) AS qty
      FROM "order_allocations" oa
      INNER JOIN "sales_orders" so ON so.id = oa."orderId"
      LEFT JOIN committed_shipment_lines csl
        ON csl."lineId" = oa."lineId"
       AND csl."productId" = oa."productId"
       AND csl."warehouseId" = oa."warehouseId"
      WHERE oa.qty > 0
        AND (so.status = 'CANCELLED' OR so."refundStatus" = 'FULL')
        ${allocationProductFilter}
        ${allocationWarehouseFilter}
      GROUP BY oa."productId", oa."warehouseId"
      HAVING SUM(LEAST(
        GREATEST(oa.qty - COALESCE(csl."dispatchedQty", 0), 0),
        GREATEST(COALESCE(csl."committedQty", 0) - COALESCE(csl."dispatchedQty", 0), 0)
      )) > ${toleranceSql}

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
      HAVING SUM(po."qtyPlanned" * pc.qty) > ${toleranceSql}

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
      HAVING SUM(po."qtyPlanned") > ${toleranceSql}
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
      WHERE sl.quantity < ${negativeToleranceSql}
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
      WHERE sl."reservedQty" < ${negativeToleranceSql}
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
        AND sl."reservedQty" - sl.quantity > ${toleranceSql}
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
      WHERE ABS(COALESCE(sl."reservedQty", 0) - COALESCE(rt."knownReservedQty", 0)) > ${toleranceSql}
        ${reservationProductFilter}
        ${reservationWarehouseFilter}

      UNION ALL

      -- o3d-4kfh r3: A COMMITMENT LARGER THAN THE ALLOCATION ROW BEHIND IT.
      --
      -- The contract runs one way: OrderAllocation.qty covers outstanding demand PLUS every
      -- committed (non-PENDING) shipment line at that (line, warehouse, product). Every consumer
      -- takes it on trust and computes qty - committed floored at zero, so a commitment ABOVE its
      -- row does not overflow anywhere — it silently disappears, and the units come out of whatever
      -- shared (product, warehouse) reservedQty is there at dispatch time. The reservation census
      -- above cannot see it either: it credits only the residual, which is exactly the part that
      -- still exists.
      --
      -- Reuses committed_shipment_lines, so it is scoped by the same product/warehouse filters and
      -- the same non-PENDING definition as the reservation branches.
      --
      -- LIMIT: this is the FLAT check (per (line, warehouse, product)). It does NOT verify that a
      -- KIT's committed components are a complete proportional set — that needs the fulfillment
      -- requirement graph, which is a recursive expansion this sweep does not load. The proportional
      -- half is enforced where the graph is available: validateAllocationIntegrity and (o3d-4kfh r4)
      -- EVERY shipment transition including dispatch (findUncoveredCommittedShipment), plus the
      -- component-graph edit refusal that stops the mutation creating it in the first place, plus
      -- (o3d-4kfh r6) the graph-version CAS that catches the uniform rescale proportionality cannot
      -- see. The SCHEDULED SWEEP ITSELF REMAINS FLAT and reports neither.
      SELECT
        'allocation_committed_shipment_uncovered:' || csl."lineId" || ':' || csl."warehouseId" || ':' || csl."productId" AS "sortKey",
        'critical'::text AS severity,
        'allocation_committed_shipment_uncovered'::text AS code,
        csl."productId",
        csl."warehouseId",
        'Committed shipment quantity exceeds the allocation backing it for ' || p.sku AS message,
        jsonb_build_object(
          'lineId', csl."lineId",
          'sku', p.sku,
          'committedQty', csl."committedQty",
          'allocatedQty', COALESCE(oa.qty, 0),
          'delta', csl."committedQty" - COALESCE(oa.qty, 0)
        ) AS details
      FROM committed_shipment_lines csl
      INNER JOIN "products" p ON p.id = csl."productId"
      LEFT JOIN "order_allocations" oa
        ON oa."lineId" = csl."lineId"
       AND oa."productId" = csl."productId"
       AND oa."warehouseId" = csl."warehouseId"
      WHERE csl."committedQty" - COALESCE(oa.qty, 0) > ${toleranceSql}

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
      WHERE cl."remainingQty" < ${negativeToleranceSql}
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
      WHERE cl."remainingQty" - cl."receivedQty" > ${toleranceSql}
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
      WHERE ABS(fsl.quantity - COALESCE(clt."remainingCostLayerQty", 0)) > ${toleranceSql}

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
        AND ABS(clt."remainingCostLayerQty") > ${toleranceSql}

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
            WHEN ABS(ABS(sm.qty) * sm."unitCostBase") < 1 THEN ${stockMovementValueSmallToleranceSql}
            ELSE ${stockMovementValueToleranceSql}
          END,
          'relativeDelta', CASE
            WHEN ABS(ABS(sm.qty) * sm."unitCostBase") > 0
              THEN ROUND((ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) / ABS(ABS(sm.qty) * sm."unitCostBase"))::numeric, 6)
            WHEN ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) = 0 THEN 0
            ELSE NULL
          END,
          'relativeTolerance', ${stockMovementValueRelativeToleranceSql}
        ) AS details
      FROM "stock_movements" sm
      INNER JOIN "products" p ON p.id = sm."productId"
      WHERE sm."unitCostBase" IS NOT NULL
        AND sm."totalValueBase" IS NOT NULL
        AND ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) > CASE
          WHEN ABS(ABS(sm.qty) * sm."unitCostBase") < 1 THEN ${stockMovementValueSmallToleranceSql}
          ELSE ${stockMovementValueToleranceSql}
        END
        AND CASE
          WHEN ABS(ABS(sm.qty) * sm."unitCostBase") = 0 THEN TRUE
          ELSE ABS(sm."totalValueBase" - (ABS(sm.qty) * sm."unitCostBase")) / ABS(ABS(sm.qty) * sm."unitCostBase") > ${stockMovementValueRelativeToleranceSql}
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
        AND sm.qty > ${toleranceSql}
        AND sm."toWarehouseId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "cost_layers" cl
          WHERE cl."productId" = sm."productId"
            AND cl."warehouseId" = sm."toWarehouseId"
            AND ABS(cl."receivedQty" - sm.qty) <= ${toleranceSql}
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
          sm.type IN ('SALE_DISPATCH', 'PURCHASE_REVERSAL', 'PRODUCTION_OUT')
          OR (sm.type = 'ADJUSTMENT' AND sm."fromWarehouseId" IS NOT NULL)
        )
        AND sm.qty > ${toleranceSql}
        -- Exempt forecasting demand history (warehouse-less SALE_DISPATCH with a
        -- historical-import referenceType) — matches the DB trigger 20260616120000
        -- and requiresCogsEntryEvidence, so the report doesn't flag rows the DB
        -- intentionally permits.
        AND NOT (
          sm.type = 'SALE_DISPATCH'
          AND sm."fromWarehouseId" IS NULL
          AND sm."toWarehouseId" IS NULL
          AND COALESCE(sm."referenceType", '') IN ('WcHistorical', 'WcInitialImport', 'CsvHistorical')
        )
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
        AND so."refundStatus" <> 'FULL'
        AND p.type::text IN (${sqlFifoProductTypes()})
        AND sl.qty > ${toleranceSql}
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

      UNION ALL

      -- audit-C5: transfers stranded IN_TRANSIT — stock left the source but the
      -- receive failed or was never run. One finding per line so product/warehouse
      -- filters apply (warehouse = source). The compensating action is either a
      -- retry of the receive or a cancel-dispatch that books the stock back.
      SELECT
        'transfer_stranded_in_transit:' || stl.id AS "sortKey",
        'warning'::text AS severity,
        'transfer_stranded_in_transit'::text AS code,
        stl."productId",
        st."fromWarehouseId" AS "warehouseId",
        'Transfer ' || st.reference || ' has been in transit since ' || to_char(st."dispatchedAt", 'YYYY-MM-DD') || ' — stock left the source but was never received' AS message,
        jsonb_build_object(
          'transferId', st.id,
          'transferLineId', stl.id,
          'reference', st.reference,
          'productId', stl."productId",
          'fromWarehouseId', st."fromWarehouseId",
          'dispatchedAt', st."dispatchedAt",
          'qty', stl.qty::float8,
          'thresholdDays', ${STRANDED_TRANSFER_DAYS}::int
        ) AS details
      FROM "stock_transfers" st
      INNER JOIN "stock_transfer_lines" stl ON stl."transferId" = st.id
      WHERE st.status = 'IN_TRANSIT'
        AND st."dispatchedAt" IS NOT NULL
        AND st."dispatchedAt" < NOW() - (${STRANDED_TRANSFER_DAYS}::int * INTERVAL '1 day')
        ${options.productId ? Prisma.sql`AND stl."productId" = ${options.productId}` : Prisma.empty}
        ${options.warehouseId ? Prisma.sql`AND st."fromWarehouseId" = ${options.warehouseId}` : Prisma.empty}
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

/**
 * THE KIT HALF OF THE COMMITTED-COVERAGE CENSUS (o3d-aqke).
 *
 * WHAT WAS MISSING. `allocation_committed_shipment_uncovered` — both the SQL branch and the
 * row-mode branch above — is FLAT: it compares committed quantity against the allocation row per
 * (lineId, warehouseId, productId) and never expands the fulfilment graph. A KIT committed as
 * 2xA + 1xB against a 2xA + 2xB recipe is covered product-by-product on every one of those pairs
 * while being HALF A KIT. The transition seams catch it — `findUncoveredCommittedShipment` runs at
 * every shipment status change including dispatch, and the component editor refuses the mutation
 * that creates it — but the scheduled census reported nothing, so a set that got in by any other
 * route (direct SQL, a future writer, a repaired row) stayed invisible until someone tried to ship.
 *
 * WHY NOT THE `WITH RECURSIVE` CTE THE ISSUE SKETCHED. It would put a SECOND implementation of the
 * fulfilment expansion into the codebase, in a second language, and that expansion is not a
 * one-liner: the KIT/BOM split (a BOM is a fulfilment LEAF), `sortOrder`, cycle handling, the
 * non-positive-quantity rule and the `?? 0` defaults would all have to be restated in SQL and kept
 * in step with the TypeScript by hand — the same argument `loadFulfillmentProductGraph` already
 * makes for not expressing the WALK as a CTE. It is also the version that could not be tested:
 * a recursive CTE cannot run in a mock-based unit suite, which is exactly why this issue sat
 * blocked. Reusing the ONE expander keeps the census and the enforcement seams answering the same
 * question by construction, and makes the pass testable with the same doubles everything else uses.
 *
 * SO THIS RUNS IN BOTH COLLECTION MODES, as a pass of its own rather than a branch of either
 * collector: SQL mode reaches it because it is wired in `runInventoryInvariantReport`, not because
 * the query grew.
 *
 * SCOPED TO KIT LINES AT THE DATABASE. A line whose product is SIMPLE, VARIANT or BOM expands to a
 * single requirement of factor 1 and is proportional by construction, so only sales lines on a KIT
 * product are read at all. That is what keeps an unpaged read affordable.
 *
 * JUDGED AT THE PERSISTED SCALE (o3d-i4qd). `ShipmentLine.qty` is `Decimal(12,4)` and a kit
 * requirement is a product of `Decimal(12,4)` factors, so an exact proportionality test would
 * report every fractional kit ever shipped. Same helper, same bands, as the seams.
 *
 * IT ASKS THE PIN, NOT THE CURRENT GRAPH, WHERE ONE EXISTS (o3d-aqke, Codex r1 finding 3). Every
 * row this census reads belongs to a COMMITTED shipment, and a line holding one is a line o3d-kouj
 * has pinned: its requirements were frozen at allocation and cannot move again. Expanding the
 * current graph for such a line therefore judges the shipment against a recipe it was never
 * allocated from — reporting healthy rows as broken after any component edit, and (the money
 * direction) reporting a genuinely half-shipped kit as proportional after a uniform rescale, which
 * is the precise escape o3d-kouj exists to close. The pin is read through o3d-kouj's own seam,
 * `lineFulfillmentRequirements` — imported, not re-implemented and not injected, so this census
 * cannot drift from the thirteen other readers of the same question — and NOTHING here quantises
 * it: the stored side is a set of factors, the computed side is the band, and the single rounding
 * stays where o3d-i4qd put it. A line with no pin is answered from the current graph by that same
 * function, which is exactly what this census did before the column existed.
 *
 * WHAT IT STILL DOES NOT REPORT: a STALE GRAPH STAMP. `findStaleFulfillmentGraphAllocation` catches
 * a uniform rescale, which is proportional on the numbers and therefore invisible to this pass too;
 * surfacing it here needs the allocation rows joined to their products and is not attempted.
 */
export async function collectDisproportionateCommittedKitFindings(
  client: InventoryInvariantKitGraphClient,
  options: { warehouseId?: string } = {},
): Promise<InventoryInvariantFinding[]> {
  const shipmentLines = await client.shipmentLine.findMany({
    where: {
      shipment: {
        status: { not: 'PENDING' },
        ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
      },
      // Only a KIT sales line can be disproportionate; everything else is one requirement of 1.
      line: { product: { type: 'KIT' } },
    },
    select: {
      lineId: true,
      productId: true,
      qty: true,
      product: { select: { sku: true } },
      line: {
        select: {
          productId: true,
          sku: true,
          description: true,
          // Unconditional: the column shipped with o3d-kouj (PR #625), so every client this census
          // can be handed has it. It was briefly selected only when a resolver was injected, which
          // is a conditional this branch removed along with the seam.
          fulfillmentRequirements: true,
        },
      },
      shipment: { select: { orderId: true, warehouseId: true } },
    },
  })
  if (shipmentLines.length === 0) return []

  const rootProductIds = [
    ...new Set(shipmentLines.map((row) => row.line?.productId).filter((id): id is string => !!id)),
  ]

  const unreadablePinFindings: InventoryInvariantFinding[] = []
  let requirementsByLine: Map<string, DecimalFulfillmentRequirement[]>
  try {
    const graph = await loadFulfillmentProductGraph(
      client as unknown as Parameters<typeof loadFulfillmentProductGraph>[0],
      rootProductIds,
    )
    requirementsByLine = new Map()
    // One finding per LINE, not per shipment row: a line with four committed component rows would
    // otherwise report the same unreadable pin four times, and the pin is a property of the line.
    const unreadablePinLineIds = new Set<string>()
    for (const row of shipmentLines) {
      if (!row.line?.productId) continue
      if (requirementsByLine.has(row.lineId) || unreadablePinLineIds.has(row.lineId)) continue
      try {
        requirementsByLine.set(
          row.lineId,
          lineFulfillmentRequirements(
            { id: row.lineId, productId: row.line.productId, fulfillmentRequirements: row.line.fulfillmentRequirements },
            graph,
          ),
        )
      } catch (error) {
        // A line whose pin cannot be read is NOT judged against the current graph — that is the
        // exact substitution o3d-kouj forbids, and it would be made silently, on the one line that
        // already has something wrong with it. It is reported instead, and left out of the census.
        unreadablePinLineIds.add(row.lineId)
        unreadablePinFindings.push({
          severity: 'warning',
          code: 'allocation_committed_kit_pin_unreadable',
          warehouseId: row.shipment.warehouseId,
          message: `The pinned fulfilment requirements for sales line ${row.line.sku || row.line.description || row.lineId} could not be read, so its committed components were not judged`,
          details: {
            orderId: row.shipment.orderId,
            lineId: row.lineId,
            lineSku: row.line.sku ?? null,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  } catch (error) {
    // A census must not take the whole report down because the catalogue is mid-edit or too deep
    // to walk. Report the gap instead of throwing — a silent skip is how a check stops being one.
    return [{
      severity: 'warning',
      code: 'allocation_committed_kit_census_unavailable',
      warehouseId: options.warehouseId,
      message: 'The committed-kit proportionality census could not expand the component graph',
      details: {
        reason: error instanceof Error ? error.message : String(error),
        rootProductCount: rootProductIds.length,
      },
    }]
  }

  // Per (line, warehouse) — the grain a kit is shipped at: one shipment belongs to one warehouse,
  // and its component lines are only a complete kit together.
  const groups = new Map<string, {
    lineId: string
    warehouseId: string
    orderId: string
    lineLabel: string
    quantities: Map<string, Prisma.Decimal>
    // o3d-aqke (Codex r1 finding 1): how many separately rounded `ShipmentLine.qty` rows each
    // component's total is the sum of. A component shipped across three partials is three
    // roundings, and the one-ulp band that describes a single row does not describe their sum.
    rowCounts: Map<string, number>
    skuByProductId: Map<string, string>
  }>()
  for (const row of shipmentLines) {
    if (!requirementsByLine.has(row.lineId)) continue
    const key = `${row.lineId}|${row.shipment.warehouseId}`
    const group = groups.get(key) ?? {
      lineId: row.lineId,
      warehouseId: row.shipment.warehouseId,
      orderId: row.shipment.orderId,
      lineLabel: row.line?.sku || row.line?.description || row.lineId,
      quantities: new Map<string, Prisma.Decimal>(),
      rowCounts: new Map<string, number>(),
      skuByProductId: new Map<string, string>(),
    }
    group.quantities.set(
      row.productId,
      (group.quantities.get(row.productId) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty)),
    )
    group.rowCounts.set(row.productId, (group.rowCounts.get(row.productId) ?? 0) + 1)
    group.skuByProductId.set(row.productId, row.product.sku)
    groups.set(key, group)
  }

  const findings: InventoryInvariantFinding[] = [...unreadablePinFindings]
  for (const group of groups.values()) {
    const requirements = requirementsByLine.get(group.lineId) ?? []
    if (requirements.length === 0) continue
    const breach = findDisproportionateFulfillmentComponent(
      requirements,
      group.quantities,
      group.rowCounts,
    )
    if (!breach) continue
    findings.push({
      severity: 'critical',
      code: 'allocation_committed_kit_disproportionate',
      productId: breach.productId,
      warehouseId: group.warehouseId,
      message: `Committed shipment components for ${group.lineLabel} in warehouse ${group.warehouseId} are not a complete kit`,
      details: {
        orderId: group.orderId,
        lineId: group.lineId,
        lineSku: group.lineLabel,
        shortComponentId: breach.productId,
        shortComponentSku: group.skuByProductId.get(breach.productId) ?? null,
        conflictsWithComponentId: breach.conflictsWithProductId,
        components: requirements.map((requirement) => ({
          productId: requirement.productId,
          sku: group.skuByProductId.get(requirement.productId) ?? null,
          requiredPerKit: requirement.factor.toString(),
          committedQty: decimalToNumber(group.quantities.get(requirement.productId) ?? new Prisma.Decimal(0)),
        })),
      },
    })
  }

  return findings.sort((left, right) => (
    `${left.code}:${left.details && typeof left.details === 'object' && 'lineId' in left.details ? String((left.details as { lineId: unknown }).lineId) : ''}:${left.warehouseId}`
      .localeCompare(`${right.code}:${right.details && typeof right.details === 'object' && 'lineId' in right.details ? String((right.details as { lineId: unknown }).lineId) : ''}:${right.warehouseId}`)
  ))
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

  // o3d-aqke: the KIT half of the committed-coverage census, run in BOTH modes because it is a
  // pass over the fulfilment graph rather than a branch of either collector.
  //
  // NOT run under a `productId` filter, deliberately: proportionality is a property of a COMPLETE
  // component set, so answering it from a set filtered down to one component would be answering a
  // different question — and answering it wrongly, since every other component would read as zero.
  // A warehouse filter is safe (the grain is already per (line, warehouse)) and is passed through.
  //
  // NOT subject to the paging cap either. The read is scoped to committed shipment lines on KIT
  // sales lines, which is a small fraction of the census's other inputs; capping it would mean a
  // truncated first page could hide every kit finding behind a wall of cost-layer noise.
  //
  // Run against the SAME object the collection used — `options.sqlClient` in SQL mode, the row
  // client otherwise — never against the module-level `db` behind a caller's back. A caller that
  // supplied only a `$queryRaw` double is asking for that double to answer the whole report; going
  // around it to the real database would be a surprise, and in a test it is a live connection.
  const kitGraphClient = collectionMode === 'sql' ? (options.sqlClient ?? client) : client
  const kitFindings = options.severity != null && options.severity !== 'critical'
    ? []
    : options.productId == null && isKitGraphInvariantClient(kitGraphClient)
      ? await collectDisproportionateCommittedKitFindings(kitGraphClient, {
        warehouseId: options.warehouseId,
      })
      : []
  const findings = kitFindings.length > 0
    ? [...collection.findings, ...kitFindings]
    : collection.findings

  return {
    checkedAt: new Date().toISOString(),
    findings,
    truncated: collection.truncated,
    nextCursor: collection.nextCursor,
    summary: buildSummary(findings),
  }
}
