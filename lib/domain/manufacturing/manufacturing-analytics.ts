import { Prisma, ProductionOrderStatus, ProductionOrderType, StockMovementType } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DAY_MS = 24 * 60 * 60 * 1000
const QUANTITY_TOLERANCE = new Prisma.Decimal('0.0001')

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type ManufacturingAnalyticsClient = {
  productionOrder: FindManyDelegate
  stockMovement: FindManyDelegate
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
  scrapQty: string
  scrapValueBase: string
  yieldPct: string | null
  outcome: 'on_plan' | 'over_consumed' | 'under_consumed'
}

export type WipReportRow = {
  productionOrderId: string
  productionOrderReference: string
  productionOrderHref: string
  status: ProductionOrderStatus
  startedAt: string | null
  scheduledAt: string | null
  daysSinceStart: number
  warehouseCode: string
  outputSku: string
  outputProductName: string
  plannedOutputQty: string
  producedQty: string
  remainingOutputQty: string
  manufacturingCostBase: string
  consumedComponentValueBase: string
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
  manufacturingCostLines: Array<{ amountBase: DecimalInput }>
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

function clientFromDeps(deps?: ManufacturingAnalyticsDeps): ManufacturingAnalyticsClient {
  return (deps?.client ?? db) as unknown as ManufacturingAnalyticsClient
}

function nowFromDeps(deps?: ManufacturingAnalyticsDeps): Date {
  return deps?.now?.() ?? new Date()
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

function parseDateOnly(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return endOfDay ? endOfUtcDay(parsed) : startOfUtcDay(parsed)
}

function dateOnly(date: Date | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null
}

function dateWhere(filters: ManufacturingAnalyticsFilters): Record<string, unknown> {
  const dateFrom = parseDateOnly(filters.dateFrom)
  const dateTo = parseDateOnly(filters.dateTo, true)
  if (!dateFrom && !dateTo) return {}
  return {
    createdAt: {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lte: dateTo } : {}),
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
    dateFrom: dateOnly(parseDateOnly(filters.dateFrom)),
    dateTo: dateOnly(parseDateOnly(filters.dateTo, true)),
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
    throw new Error(`Manufacturing movement source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
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
      ...dateWhere(filters),
    },
    orderBy: [{ createdAt: 'desc' }, { reference: 'asc' }],
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
    throw new Error(`Production variance source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }

  const movements = await loadProductionOutMovements(client, orders.map((order) => order.id))
  const actualByOrderAndProduct = movementTotalsByOrderAndProduct(movements)
  const rows: ProductionVarianceReportRow[] = []
  let plannedTotal = new Prisma.Decimal(0)
  let actualTotal = new Prisma.Decimal(0)
  let scrapTotal = new Prisma.Decimal(0)
  let scrapValueTotal = new Prisma.Decimal(0)

  for (const order of orders) {
    const plannedOutputQty = toDecimal(order.qtyPlanned)
    const producedQty = toDecimal(order.qtyProduced)
    const yieldPct = plannedOutputQty.gt(0) ? producedQty.div(plannedOutputQty).mul(100) : null
    for (const item of order.bom.items) {
      const plannedQty = toDecimal(item.qty).mul(plannedOutputQty)
      const actual = actualByOrderAndProduct.get(movementKey(order.id, item.componentProductId)) ?? {
        qty: new Prisma.Decimal(0),
        valueBase: new Prisma.Decimal(0),
      }
      const varianceQty = actual.qty.sub(plannedQty)
      const scrapQty = Prisma.Decimal.max(varianceQty, new Prisma.Decimal(0))
      const scrapValueBase = scrapQty.gt(0) && actual.qty.gt(0)
        ? actual.valueBase.mul(scrapQty).div(actual.qty)
        : new Prisma.Decimal(0)
      const variancePct = plannedQty.gt(0) ? varianceQty.div(plannedQty).mul(100) : null

      plannedTotal = plannedTotal.add(plannedQty)
      actualTotal = actualTotal.add(actual.qty)
      scrapTotal = scrapTotal.add(scrapQty)
      scrapValueTotal = scrapValueTotal.add(scrapValueBase)
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
        scrapQty: quantity(scrapQty),
        scrapValueBase: amount(scrapValueBase),
        yieldPct: yieldPct ? percent(yieldPct) : null,
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
    scrapQty: quantity(scrapTotal),
    scrapValueBase: amount(scrapValueTotal),
  }, [
    'Production variance includes assembly orders only; disassembly consumption is excluded from BOM variance rows.',
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
      ...dateWhere(filters),
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
      outputProduct: { select: { sku: true, name: true } },
      warehouse: { select: { code: true, name: true } },
      manufacturingCostLines: { select: { amountBase: true } },
    },
  }) as WipProductionOrderRow[]
  if (orders.length > SOURCE_ROW_LIMIT) {
    throw new Error(`WIP source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  }

  const movements = await loadProductionOutMovements(client, orders.map((order) => order.id))
  const movementTotals = movementTotalsByOrder(movements)
  const rows: WipReportRow[] = []
  let manufacturingCostTotal = new Prisma.Decimal(0)
  let consumedComponentValueTotal = new Prisma.Decimal(0)
  let expectedOutputValueTotal = new Prisma.Decimal(0)

  for (const order of orders) {
    const manufacturingCostBase = order.manufacturingCostLines.reduce(
      (sum, line) => sum.add(toDecimal(line.amountBase)),
      new Prisma.Decimal(0),
    )
    const movementTotal = movementTotals.get(order.id) ?? { qty: new Prisma.Decimal(0), valueBase: new Prisma.Decimal(0) }
    const expectedOutputValueBase = manufacturingCostBase.add(movementTotal.valueBase)
    const startDate = order.startedAt ?? order.createdAt
    const daysSinceStart = Math.max(0, Math.floor((generatedAt.getTime() - startDate.getTime()) / DAY_MS))
    const plannedQty = toDecimal(order.qtyPlanned)
    const producedQty = toDecimal(order.qtyProduced)

    manufacturingCostTotal = manufacturingCostTotal.add(manufacturingCostBase)
    consumedComponentValueTotal = consumedComponentValueTotal.add(movementTotal.valueBase)
    expectedOutputValueTotal = expectedOutputValueTotal.add(expectedOutputValueBase)
    rows.push({
      productionOrderId: order.id,
      productionOrderReference: order.reference,
      productionOrderHref: orderHref(order.id),
      status: order.status,
      startedAt: order.startedAt?.toISOString() ?? null,
      scheduledAt: order.scheduledAt?.toISOString() ?? null,
      daysSinceStart,
      warehouseCode: order.warehouse.code,
      outputSku: order.outputProduct.sku,
      outputProductName: order.outputProduct.name,
      plannedOutputQty: quantity(plannedQty),
      producedQty: quantity(producedQty),
      remainingOutputQty: quantity(Prisma.Decimal.max(plannedQty.sub(producedQty), new Prisma.Decimal(0))),
      manufacturingCostBase: amount(manufacturingCostBase),
      consumedComponentValueBase: amount(movementTotal.valueBase),
      expectedOutputValueBase: amount(expectedOutputValueBase),
      wipValueBase: amount(manufacturingCostBase),
      costLineCount: order.manufacturingCostLines.length,
    })
  }

  return report(rows, filters, generatedAt, {
    wipValueBase: amount(manufacturingCostTotal),
    manufacturingCostBase: amount(manufacturingCostTotal),
    consumedComponentValueBase: amount(consumedComponentValueTotal),
    expectedOutputValueBase: amount(expectedOutputValueTotal),
  }, [
    'WIP value is calculated from ManufacturingCostLine base totals on IN_PROGRESS production orders.',
  ], options.paginate !== false)
}
