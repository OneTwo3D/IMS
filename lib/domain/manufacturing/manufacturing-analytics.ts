import { Prisma, ProductionOrderStatus, ProductionOrderType, StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly, elapsedDaysDecimal, exclusiveEndOfUtcDay, parseOptionalDateOnly } from '@/lib/domain/math/date-window'
import { parseProductionOrderComponentSnapshot } from '@/lib/domain/manufacturing/component-consumption'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { SourceScanTooLargeError } from '@/lib/security/source-scan-error'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const QUANTITY_TOLERANCE = new Prisma.Decimal('0.0001')

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type ManufacturingAnalyticsClient = {
  productionOrder: FindManyDelegate
  stockMovement: FindManyDelegate
  costLayer: FindManyDelegate
}

export type ManufacturingAnalyticsDeps = {
  client?: ManufacturingAnalyticsClient
  now?: () => Date
}

export type ManufacturingAnalyticsFilters = {
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

export type ManufacturingAnalyticsReport<Row> = {
  generatedAt: string
  dateFrom: string | null
  dateTo: string | null
  rows: Row[]
  pageInfo: PageInfo
  totals: Record<string, string>
  notices: string[]
}

export type ProductionVarianceReportRow = {
  productionOrderId: string
  productionOrderReference: string
  productionOrderHref: string
  status: ProductionOrderStatus
  scheduledAt: string | null
  completedAt: string | null
  warehouseCode: string
  outputSku: string
  outputProductName: string
  componentProductId: string
  componentSku: string
  componentName: string
  stockUnit: string
  plannedQty: string
  actualQty: string
  varianceQty: string
  variancePct: string | null
  overConsumedQty: string
  overConsumedValueBase: string
  orderYieldPct: string | null
  outcome: 'on_plan' | 'over_consumed' | 'under_consumed'
}

export type WipReportRow = {
  productionOrderId: string
  productionOrderReference: string
  productionOrderHref: string
  status: ProductionOrderStatus
  startedAt: string | null
  scheduledAt: string | null
  daysSinceStart: string
  warehouseCode: string
  outputSku: string
  outputProductName: string
  plannedOutputQty: string
  producedQty: string
  remainingOutputQty: string
  manufacturingCostBase: string
  consumedComponentValueBase: string
  reservedComponentValueBase: string
  expectedOutputValueBase: string
  wipValueBase: string
  costLineCount: number
}

type BomItemRow = {
  componentProductId: string
  qty: DecimalInput
  component: {
    id: string
    sku: string
    name: string
    stockUnit: string
  }
}

type ProductionOrderBaseRow = {
  id: string
  reference: string
  orderType: ProductionOrderType
  status: ProductionOrderStatus
  qtyPlanned: DecimalInput
  qtyProduced: DecimalInput
  scheduledAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  outputProduct: { sku: string; name: string }
  warehouse: { code: string; name: string }
}

type ProductionVarianceOrderRow = ProductionOrderBaseRow & {
  bom: { items: BomItemRow[] }
}

type WipProductionOrderRow = ProductionOrderBaseRow & {
  warehouseId: string
  outputProductId: string
  componentSnapshot: unknown
  // Live product components (the BOM completion actually falls back to when an
  // order has no frozen snapshot). NOT the legacy `Bom` row, which component
  // edits do not update.
  outputProduct: { sku: string; name: string; productComponents: Array<{ componentId: string; qty: DecimalInput }> }
  manufacturingCostLines: Array<{ amountBase: DecimalInput }>
}

type CostLayerRow = {
  productId: string
  warehouseId: string
  remainingQty: DecimalInput
  unitCostBase: DecimalInput
}

function costPairKey(productId: string, warehouseId: string): string {
  return `${productId}::${warehouseId}`
}

type FifoCostLayer = { remainingQty: Prisma.Decimal; unitCostBase: Prisma.Decimal }

/**
 * Open cost layers per (product, warehouse) in FIFO consumption order
 * (receivedAt ASC, id ASC) — mirrors consumeFifoLayersStrict, which is how
 * completion actually values component/output consumption. Batched into one
 * query to avoid an N+1 over the reserved products (scjz.31).
 */
async function loadFifoCostLayersByPair(
  client: ManufacturingAnalyticsClient,
  pairs: Array<{ productId: string; warehouseId: string }>,
): Promise<Map<string, FifoCostLayer[]>> {
  const byPair = new Map<string, FifoCostLayer[]>()
  if (pairs.length === 0) return byPair
  const layers = await client.costLayer.findMany({
    // Pairwise OR (not productId IN x warehouseId IN) so a multi-product,
    // multi-warehouse report doesn't scan the unrelated cross-combinations.
    where: { remainingQty: { gt: 0 }, OR: pairs.map((pair) => ({ productId: pair.productId, warehouseId: pair.warehouseId })) },
    select: { productId: true, warehouseId: true, remainingQty: true, unitCostBase: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: SOURCE_ROW_LIMIT + 1,
  }) as CostLayerRow[]
  // Bound the scan like the order/movement queries so a product with a huge
  // number of open layers can't make the WIP report load arbitrary rows.
  if (layers.length > SOURCE_ROW_LIMIT) {
    throw new ManufacturingAnalyticsSourceLimitError(`WIP cost-layer source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }
  for (const layer of layers) {
    const key = costPairKey(layer.productId, layer.warehouseId)
    const list = byPair.get(key) ?? []
    list.push({ remainingQty: toDecimal(layer.remainingQty), unitCostBase: toDecimal(layer.unitCostBase) })
    byPair.set(key, list)
  }
  return byPair
}

/**
 * Consume `qty` units from FIFO-ordered open layers, returning the cost
 * completion will capitalise. MUTATES the shared layer list (decrements
 * remainingQty) so that when several in-progress orders reserve the same
 * (product, warehouse) each draws fresh layers in turn — orders are valued in
 * the report's start-order, a reasonable proxy for completion order — rather
 * than every order re-claiming the same cheap oldest layers. A reservation
 * larger than current on-hand (completion would later block on it) values the
 * uncovered remainder at the newest layer's unit cost, or zero when no layers
 * exist.
 */
function consumeFifoReservation(layers: FifoCostLayer[] | undefined, qty: Prisma.Decimal): Prisma.Decimal {
  if (qty.lte(0)) return new Prisma.Decimal(0)
  let remaining = qty
  let value = new Prisma.Decimal(0)
  let lastUnitCost = new Prisma.Decimal(0)
  for (const layer of layers ?? []) {
    if (remaining.lte(0)) break
    lastUnitCost = layer.unitCostBase
    if (layer.remainingQty.lte(0)) continue
    const take = Prisma.Decimal.min(remaining, layer.remainingQty)
    value = value.add(take.mul(layer.unitCostBase))
    layer.remainingQty = layer.remainingQty.sub(take)
    remaining = remaining.sub(take)
  }
  if (remaining.gt(0)) value = value.add(remaining.mul(lastUnitCost))
  return value
}

/**
 * Reserved (committed-but-not-yet-consumed) quantity per product for an
 * IN_PROGRESS order. ASSEMBLY reserves its BOM components — using the frozen
 * componentSnapshot so a mid-production component edit doesn't change the
 * valuation basis (matches completion), falling back to the live BOM only for
 * orders started before snapshots existed. DISASSEMBLY instead reserves the
 * finished good being broken down; its components are recovered at completion,
 * not reserved (scjz.31).
 */
function reservationRequirementsByProduct(order: WipProductionOrderRow): Map<string, Prisma.Decimal> {
  const plannedQty = toDecimal(order.qtyPlanned)
  const reserved = new Map<string, Prisma.Decimal>()
  if (order.orderType === ProductionOrderType.DISASSEMBLY) {
    if (plannedQty.gt(0)) reserved.set(order.outputProductId, plannedQty)
    return reserved
  }
  const components: Array<{ componentId: string; qty: DecimalInput }> =
    parseProductionOrderComponentSnapshot(order.componentSnapshot)
    ?? order.outputProduct.productComponents
  for (const comp of components) {
    const requirementQty = toDecimal(comp.qty).mul(plannedQty)
    if (requirementQty.lte(0)) continue
    reserved.set(comp.componentId, (reserved.get(comp.componentId) ?? new Prisma.Decimal(0)).add(requirementQty))
  }
  return reserved
}

type ProductionOutMovementRow = {
  referenceId: string | null
  productId: string
  qty: DecimalInput
  totalValueBase: DecimalInput
}

type ReportOptions = {
  paginate?: boolean
}

export class ManufacturingAnalyticsSourceLimitError extends SourceScanTooLargeError {
  constructor(message: string) {
    super('Manufacturing analytics source rows', SOURCE_ROW_LIMIT, { message })
    this.name = 'ManufacturingAnalyticsSourceLimitError'
  }
}

function clientFromDeps(deps?: ManufacturingAnalyticsDeps): ManufacturingAnalyticsClient {
  return (deps?.client ?? db) as unknown as ManufacturingAnalyticsClient
}

function nowFromDeps(deps?: ManufacturingAnalyticsDeps): Date {
  return deps?.now?.() ?? new Date()
}

function parseDateOnly(value: string | undefined, endOfDay = false): Date | undefined {
  return parseOptionalDateOnly(value, { endOfDay })
}

function optionalDateOnly(date: Date | undefined): string | null {
  return date ? dateOnly(date) : null
}

function dateWhere(filters: ManufacturingAnalyticsFilters, field: 'createdAt' | 'completedAt'): Record<string, unknown> {
  const dateFrom = parseDateOnly(filters.dateFrom)
  const dateTo = parseDateOnly(filters.dateTo, true)
  const dateToExclusive = dateTo ? exclusiveEndOfUtcDay(dateTo) : undefined
  if (!dateFrom && !dateTo) return {}
  return {
    [field]: {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateToExclusive ? { lt: dateToExclusive } : {}),
    },
  }
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value as number)))
}

function pageInfo(totalRows: number, page: number | undefined, pageSize: number): PageInfo {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor(page ?? 1)))
  return {
    page: currentPage,
    pageSize,
    totalRows,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1,
  }
}

function paginate<T>(rows: T[], filters: ManufacturingAnalyticsFilters, enabled: boolean): { rows: T[]; pageInfo: PageInfo } {
  const pageSize = clampPageSize(filters.pageSize)
  const info = pageInfo(rows.length, filters.page, pageSize)
  if (!enabled) return { rows, pageInfo: { ...info, page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false } }
  const start = (info.page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), pageInfo: info }
}

function report<Row>(
  rows: Row[],
  filters: ManufacturingAnalyticsFilters,
  generatedAt: Date,
  totals: Record<string, string>,
  notices: string[],
  paginateRows: boolean,
): ManufacturingAnalyticsReport<Row> {
  const paged = paginate(rows, filters, paginateRows)
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: optionalDateOnly(parseDateOnly(filters.dateFrom)),
    dateTo: optionalDateOnly(parseDateOnly(filters.dateTo, true)),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals,
    notices,
  }
}

function quantity(value: DecimalInput): string {
  return roundQuantity(value, 4).toString()
}

function amount(value: DecimalInput): string {
  return roundQuantity(value, 2).toString()
}

function percent(value: DecimalInput): string {
  return roundQuantity(value, 2).toString()
}

function orderHref(id: string): string {
  return `/manufacturing/${id}`
}

function movementKey(referenceId: string, productId: string): string {
  return `${referenceId}:${productId}`
}

async function loadProductionOutMovements(client: ManufacturingAnalyticsClient, productionOrderIds: string[]): Promise<ProductionOutMovementRow[]> {
  if (productionOrderIds.length === 0) return []
  const movements = await client.stockMovement.findMany({
    where: {
      type: StockMovementType.PRODUCTION_OUT,
      referenceType: 'ProductionOrder',
      referenceId: { in: productionOrderIds },
    },
    take: SOURCE_ROW_LIMIT + 1,
    select: {
      referenceId: true,
      productId: true,
      qty: true,
      totalValueBase: true,
    },
  }) as ProductionOutMovementRow[]
  if (movements.length > SOURCE_ROW_LIMIT) {
    throw new ManufacturingAnalyticsSourceLimitError(`Manufacturing movement source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }
  return movements
}

function movementTotalsByOrderAndProduct(movements: ProductionOutMovementRow[]): Map<string, { qty: Prisma.Decimal; valueBase: Prisma.Decimal }> {
  const totals = new Map<string, { qty: Prisma.Decimal; valueBase: Prisma.Decimal }>()
  for (const movement of movements) {
    if (!movement.referenceId) continue
    const key = movementKey(movement.referenceId, movement.productId)
    const current = totals.get(key) ?? { qty: new Prisma.Decimal(0), valueBase: new Prisma.Decimal(0) }
    current.qty = current.qty.add(toDecimal(movement.qty))
    current.valueBase = current.valueBase.add(toDecimal(movement.totalValueBase))
    totals.set(key, current)
  }
  return totals
}

function movementTotalsByOrder(movements: ProductionOutMovementRow[]): Map<string, { qty: Prisma.Decimal; valueBase: Prisma.Decimal }> {
  const totals = new Map<string, { qty: Prisma.Decimal; valueBase: Prisma.Decimal }>()
  for (const movement of movements) {
    if (!movement.referenceId) continue
    const current = totals.get(movement.referenceId) ?? { qty: new Prisma.Decimal(0), valueBase: new Prisma.Decimal(0) }
    current.qty = current.qty.add(toDecimal(movement.qty))
    current.valueBase = current.valueBase.add(toDecimal(movement.totalValueBase))
    totals.set(movement.referenceId, current)
  }
  return totals
}

function varianceOutcome(varianceQty: Prisma.Decimal): ProductionVarianceReportRow['outcome'] {
  if (varianceQty.gt(QUANTITY_TOLERANCE)) return 'over_consumed'
  if (varianceQty.lt(QUANTITY_TOLERANCE.neg())) return 'under_consumed'
  return 'on_plan'
}

export async function getProductionVarianceReport(
  filters: ManufacturingAnalyticsFilters = {},
  options: ReportOptions = {},
  deps?: ManufacturingAnalyticsDeps,
): Promise<ManufacturingAnalyticsReport<ProductionVarianceReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const orders = await client.productionOrder.findMany({
    where: {
      orderType: ProductionOrderType.ASSEMBLY,
      status: { in: [ProductionOrderStatus.IN_PROGRESS, ProductionOrderStatus.COMPLETED] },
      ...dateWhere(filters, 'completedAt'),
    },
    orderBy: [{ completedAt: 'desc' }, { reference: 'asc' }],
    take: SOURCE_ROW_LIMIT + 1,
    select: {
      id: true,
      reference: true,
      orderType: true,
      status: true,
      qtyPlanned: true,
      qtyProduced: true,
      scheduledAt: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      outputProduct: { select: { sku: true, name: true } },
      warehouse: { select: { code: true, name: true } },
      bom: {
        select: {
          items: {
            orderBy: { sortOrder: 'asc' },
            select: {
              componentProductId: true,
              qty: true,
              component: { select: { id: true, sku: true, name: true, stockUnit: true } },
            },
          },
        },
      },
    },
  }) as ProductionVarianceOrderRow[]
  if (orders.length > SOURCE_ROW_LIMIT) {
    throw new ManufacturingAnalyticsSourceLimitError(`Production variance source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }

  const varianceOrders = orders.filter((order) => (
    order.status === ProductionOrderStatus.IN_PROGRESS ||
    order.status === ProductionOrderStatus.COMPLETED
  ))
  const movements = await loadProductionOutMovements(client, varianceOrders.map((order) => order.id))
  const actualByOrderAndProduct = movementTotalsByOrderAndProduct(movements)
  const rows: ProductionVarianceReportRow[] = []
  let plannedTotal = new Prisma.Decimal(0)
  let actualTotal = new Prisma.Decimal(0)
  let overConsumedTotal = new Prisma.Decimal(0)
  let overConsumedValueTotal = new Prisma.Decimal(0)

  for (const order of varianceOrders) {
    const plannedOutputQty = toDecimal(order.qtyPlanned)
    const producedQty = toDecimal(order.qtyProduced)
    const orderYieldPct = plannedOutputQty.gt(0) ? producedQty.div(plannedOutputQty).mul(100) : null
    for (const item of order.bom.items) {
      const plannedQty = toDecimal(item.qty).mul(plannedOutputQty)
      const actual = actualByOrderAndProduct.get(movementKey(order.id, item.componentProductId)) ?? {
        qty: new Prisma.Decimal(0),
        valueBase: new Prisma.Decimal(0),
      }
      const varianceQty = actual.qty.sub(plannedQty)
      const overConsumedQty = Prisma.Decimal.max(varianceQty, new Prisma.Decimal(0))
      const overConsumedValueBase = overConsumedQty.gt(0) && actual.qty.gt(0)
        ? actual.valueBase.mul(overConsumedQty).div(actual.qty)
        : new Prisma.Decimal(0)
      const variancePct = plannedQty.gt(0) ? varianceQty.div(plannedQty).mul(100) : null

      plannedTotal = plannedTotal.add(plannedQty)
      actualTotal = actualTotal.add(actual.qty)
      overConsumedTotal = overConsumedTotal.add(overConsumedQty)
      overConsumedValueTotal = overConsumedValueTotal.add(overConsumedValueBase)
      rows.push({
        productionOrderId: order.id,
        productionOrderReference: order.reference,
        productionOrderHref: orderHref(order.id),
        status: order.status,
        scheduledAt: order.scheduledAt?.toISOString() ?? null,
        completedAt: order.completedAt?.toISOString() ?? null,
        warehouseCode: order.warehouse.code,
        outputSku: order.outputProduct.sku,
        outputProductName: order.outputProduct.name,
        componentProductId: item.component.id,
        componentSku: item.component.sku,
        componentName: item.component.name,
        stockUnit: item.component.stockUnit,
        plannedQty: quantity(plannedQty),
        actualQty: quantity(actual.qty),
        varianceQty: quantity(varianceQty),
        variancePct: variancePct ? percent(variancePct) : null,
        overConsumedQty: quantity(overConsumedQty),
        overConsumedValueBase: amount(overConsumedValueBase),
        orderYieldPct: orderYieldPct ? percent(orderYieldPct) : null,
        outcome: varianceOutcome(varianceQty),
      })
    }
  }

  rows.sort((a, b) => (
    (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '') ||
    a.productionOrderReference.localeCompare(b.productionOrderReference) ||
    a.componentSku.localeCompare(b.componentSku)
  ))

  return report(rows, filters, generatedAt, {
    plannedQty: quantity(plannedTotal),
    actualQty: quantity(actualTotal),
    varianceQty: quantity(actualTotal.sub(plannedTotal)),
    overConsumedQty: quantity(overConsumedTotal),
    overConsumedValueBase: amount(overConsumedValueTotal),
  }, [
    'Production variance includes assembly orders only; disassembly consumption is excluded from BOM variance rows.',
    'Date filters apply to completion date; in-progress orders without a completion date are shown only when no date window is selected.',
    'Over-consumed value is averaged across the consumed movement value; drill into FIFO cost entries for layer-exact costing.',
  ], options.paginate !== false)
}

export async function getWipReport(
  filters: ManufacturingAnalyticsFilters = {},
  options: ReportOptions = {},
  deps?: ManufacturingAnalyticsDeps,
): Promise<ManufacturingAnalyticsReport<WipReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const orders = await client.productionOrder.findMany({
    where: {
      status: ProductionOrderStatus.IN_PROGRESS,
    },
    orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }, { reference: 'asc' }],
    take: SOURCE_ROW_LIMIT + 1,
    select: {
      id: true,
      reference: true,
      orderType: true,
      status: true,
      qtyPlanned: true,
      qtyProduced: true,
      scheduledAt: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      warehouseId: true,
      outputProductId: true,
      componentSnapshot: true,
      outputProduct: { select: { sku: true, name: true, productComponents: { select: { componentId: true, qty: true } } } },
      warehouse: { select: { code: true, name: true } },
      manufacturingCostLines: { select: { amountBase: true } },
    },
  }) as WipProductionOrderRow[]
  if (orders.length > SOURCE_ROW_LIMIT) {
    throw new ManufacturingAnalyticsSourceLimitError(`WIP source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }

  const movements = await loadProductionOutMovements(client, orders.map((order) => order.id))
  const movementTotals = movementTotalsByOrder(movements)
  // Per-product consumed qty so reserved value covers only the not-yet-consumed
  // portion (an IN_PROGRESS order may have partially consumed) (scjz.31).
  const consumedByOrderProduct = movementTotalsByOrderAndProduct(movements)
  // Reservation requirements per order, used both to batch-load the relevant
  // cost layers and to value each reservation FIFO below.
  const reservedByOrder = new Map<string, Map<string, Prisma.Decimal>>()
  const costPairs = new Map<string, { productId: string; warehouseId: string }>()
  for (const order of orders) {
    const requirements = reservationRequirementsByProduct(order)
    reservedByOrder.set(order.id, requirements)
    for (const productId of requirements.keys()) {
      costPairs.set(costPairKey(productId, order.warehouseId), { productId, warehouseId: order.warehouseId })
    }
  }
  const layersByPair = await loadFifoCostLayersByPair(client, [...costPairs.values()])
  const rows: WipReportRow[] = []
  let manufacturingCostTotal = new Prisma.Decimal(0)
  let consumedComponentValueTotal = new Prisma.Decimal(0)
  let reservedComponentValueTotal = new Prisma.Decimal(0)
  let expectedOutputValueTotal = new Prisma.Decimal(0)

  for (const order of orders) {
    const manufacturingCostBase = order.manufacturingCostLines.reduce(
      (sum, line) => sum.add(toDecimal(line.amountBase)),
      new Prisma.Decimal(0),
    )
    const movementTotal = movementTotals.get(order.id) ?? { qty: new Prisma.Decimal(0), valueBase: new Prisma.Decimal(0) }
    const plannedQty = toDecimal(order.qtyPlanned)
    const producedQty = toDecimal(order.qtyProduced)

    // Value the reservation still to be consumed at the FIFO cost completion
    // will capitalise, so WIP reflects committed value before completion posts
    // PRODUCTION_OUT.
    let reservedComponentValueBase = new Prisma.Decimal(0)
    for (const [productId, requirementQty] of reservedByOrder.get(order.id) ?? []) {
      const consumedQty = consumedByOrderProduct.get(movementKey(order.id, productId))?.qty
        ?? new Prisma.Decimal(0)
      const remainingQty = Prisma.Decimal.max(new Prisma.Decimal(0), requirementQty.sub(consumedQty))
      reservedComponentValueBase = reservedComponentValueBase.add(
        consumeFifoReservation(layersByPair.get(costPairKey(productId, order.warehouseId)), remainingQty),
      )
    }

    const wipValueBase = manufacturingCostBase.add(movementTotal.valueBase).add(reservedComponentValueBase)
    const startDate = order.startedAt ?? order.createdAt
    const daysSinceStart = Prisma.Decimal.max(
      new Prisma.Decimal(0),
      elapsedDaysDecimal(startDate, generatedAt),
    )

    manufacturingCostTotal = manufacturingCostTotal.add(manufacturingCostBase)
    consumedComponentValueTotal = consumedComponentValueTotal.add(movementTotal.valueBase)
    reservedComponentValueTotal = reservedComponentValueTotal.add(reservedComponentValueBase)
    expectedOutputValueTotal = expectedOutputValueTotal.add(wipValueBase)
    rows.push({
      productionOrderId: order.id,
      productionOrderReference: order.reference,
      productionOrderHref: orderHref(order.id),
      status: order.status,
      startedAt: order.startedAt?.toISOString() ?? null,
      scheduledAt: order.scheduledAt?.toISOString() ?? null,
      daysSinceStart: roundQuantity(daysSinceStart, 1).toString(),
      warehouseCode: order.warehouse.code,
      outputSku: order.outputProduct.sku,
      outputProductName: order.outputProduct.name,
      plannedOutputQty: quantity(plannedQty),
      producedQty: quantity(producedQty),
      remainingOutputQty: quantity(Prisma.Decimal.max(plannedQty.sub(producedQty), new Prisma.Decimal(0))),
      manufacturingCostBase: amount(manufacturingCostBase),
      consumedComponentValueBase: amount(movementTotal.valueBase),
      reservedComponentValueBase: amount(reservedComponentValueBase),
      expectedOutputValueBase: amount(wipValueBase),
      wipValueBase: amount(wipValueBase),
      costLineCount: order.manufacturingCostLines.length,
    })
  }

  return report(rows, filters, generatedAt, {
    wipValueBase: amount(expectedOutputValueTotal),
    manufacturingCostBase: amount(manufacturingCostTotal),
    consumedComponentValueBase: amount(consumedComponentValueTotal),
    reservedComponentValueBase: amount(reservedComponentValueTotal),
    expectedOutputValueBase: amount(expectedOutputValueTotal),
  }, [
    'WIP is a current-state report of all IN_PROGRESS production orders; date filters are not applied.',
    'WIP value includes posted consumed component value, reserved not-yet-consumed component value at current cost, plus ManufacturingCostLine base totals.',
  ], options.paginate !== false)
}
