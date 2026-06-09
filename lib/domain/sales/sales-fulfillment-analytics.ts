import {
  ActivityEntityType,
  Prisma,
  SalesOrderStatus,
  ShipmentStatus,
  StockMovementType,
} from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly, defaultUtcDateWindow, parseDateOnly, startOfUtcDay } from '@/lib/domain/math/date-window'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { DEFAULT_BASE_CURRENCY, getBaseCurrencyCode } from '@/lib/base-currency'
import { SourceScanTooLargeError, assertSourceLimit } from '@/lib/security/source-scan-error'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DEFAULT_PERIOD_DAYS = 30
const ACTIVE_ORDER_STATUSES = Object.values(SalesOrderStatus).filter((status) => status !== SalesOrderStatus.CANCELLED)

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type SalesFulfillmentAnalyticsClient = {
  salesOrder: FindManyDelegate
  salesOrderRefund: FindManyDelegate
  salesOrderRefundLine: FindManyDelegate
  cogsEntry: FindManyDelegate
  stockMovement: FindManyDelegate
  shipment: FindManyDelegate
  activityLog: FindManyDelegate
}

export type SalesFulfillmentAnalyticsDeps = {
  client?: SalesFulfillmentAnalyticsClient
  now?: () => Date
  baseCurrency?: () => Promise<string>
  paginate?: boolean
}

export type SalesAnalyticsGroupBy = 'product' | 'category' | 'customer' | 'channel'
export type SalesCurrencyMode = 'base' | 'foreign'

export type SalesAnalyticsFilters = {
  dateFrom?: string
  dateTo?: string
  groupBy?: SalesAnalyticsGroupBy
  currencyMode?: SalesCurrencyMode
  page?: number
  pageSize?: number
}

export type SalesAnalyticsReport<Row> = {
  generatedAt: string
  dateFrom: string
  dateTo: string
  rows: Row[]
  pageInfo: PageInfo
  totals: Record<string, string>
  notices: string[]
}

export type SalesReportRow = {
  key: string
  label: string
  groupBy: SalesAnalyticsGroupBy
  currency: string
  orderCount: number
  lineCount: number
  revenue: string
  tax: string
  shipping: string
  discount: string
}

export type CustomerReportRow = {
  customerId: string | null
  customerName: string
  customerEmail: string | null
  orderCount: number
  revenueBase: string
  grossProfitBase: string
  arExposureBase: string
  shareOfRevenuePct: string
}

export type MarginReportRow = {
  productId: string | null
  sku: string
  productName: string
  categoryName: string | null
  lineCount: number
  revenueBase: string
  cogsBase: string
  grossProfitBase: string
  marginPct: string
  contributionPct: string
}

export type ReturnsReportRow = {
  productId: string | null
  sku: string
  productName: string
  customerName: string
  reason: string
  refundCount: number
  returnedQty: string
  refundValueBase: string
  shippedQty: string
  returnRatePct: string
}

export type FulfillmentReportRow = {
  metric: string
  value: string
  numerator: string
  denominator: string
}

export type ThroughputReportRow = {
  date: string
  userName: string
  orderCount: number
  shipmentCount: number
  lineCount: number
}

type SalesOrderLineRow = {
  id: string
  productId: string | null
  sku: string | null
  description: string
  qty: DecimalInput
  totalForeign: DecimalInput
  totalBase: DecimalInput
  taxForeign: DecimalInput
  taxBase: DecimalInput
  discountAmount: DecimalInput
  product: {
    id: string
    sku: string
    name: string
    category: { name: string } | null
  } | null
}

type SalesOrderRow = {
  id: string
  status: SalesOrderStatus
  currency: string
  customerId: string | null
  customerName: string | null
  customerEmail: string | null
  createdAt: Date
  expectedDelivery: Date | null
  paidAt: Date | null
  totalForeign: DecimalInput
  totalBase: DecimalInput
  taxForeign: DecimalInput
  taxBase: DecimalInput
  shippingForeign: DecimalInput
  shippingBase: DecimalInput
  discountAmount: DecimalInput
  lines: SalesOrderLineRow[]
  shoppingLinks: Array<{ connector: string }>
}

type CogsEntryRow = {
  id: string
  totalCostBase: DecimalInput
  movement: {
    referenceType: string | null
    referenceId: string | null
    productId: string
    createdAt: Date
    product: {
      sku: string
      name: string
      category: { name: string } | null
    }
  }
}

type RefundLineRow = {
  id: string
  refundId: string
  productId: string | null
  description: string
  qty: DecimalInput
  totalBase: DecimalInput
  product: { id: string; sku: string; name: string } | null
  refund: {
    id: string
    reason: string | null
    totalBase: DecimalInput
    refundedAt: Date
    order: {
      customerName: string | null
      lines: Array<{ productId: string | null; qty: DecimalInput }>
    }
  }
}

type ShipmentRow = {
  id: string
  orderId: string
  status: ShipmentStatus
  shippedAt: Date | null
  createdAt: Date
  updatedAt: Date
  lines: Array<{ lineId: string; qty: DecimalInput }>
  order: {
    id: string
    createdAt: Date
    expectedDelivery: Date | null
    lines: Array<{ id: string; qty: DecimalInput }>
  }
}

type ActivityLogRow = {
  userId: string | null
  createdAt: Date
  metadata: Prisma.JsonValue | null
  user: { name: string } | null
}

function clientFromDeps(deps?: SalesFulfillmentAnalyticsDeps): SalesFulfillmentAnalyticsClient {
  return (deps?.client ?? db) as unknown as SalesFulfillmentAnalyticsClient
}

function nowFromDeps(deps?: SalesFulfillmentAnalyticsDeps): Date {
  return deps?.now?.() ?? new Date()
}

async function baseCurrencyFromDeps(deps?: SalesFulfillmentAnalyticsDeps): Promise<string> {
  if (deps?.baseCurrency) return deps.baseCurrency()
  return deps?.client ? DEFAULT_BASE_CURRENCY : getBaseCurrencyCode()
}

function period(filters: SalesAnalyticsFilters, now: Date): { dateFrom: Date; dateTo: Date } {
  const { dateFrom: defaultFrom, dateTo: defaultTo } = defaultUtcDateWindow(now, DEFAULT_PERIOD_DAYS)
  const dateTo = parseDateOnly(filters.dateTo, defaultTo, { endOfDay: true })
  const dateFrom = parseDateOnly(filters.dateFrom, defaultFrom)
  return dateFrom.getTime() <= dateTo.getTime()
    ? { dateFrom, dateTo }
    : { dateFrom: startOfUtcDay(dateTo), dateTo }
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

export function emptySalesAnalyticsReportForSourceLimit<Row>(
  filters: SalesAnalyticsFilters,
  error: SourceScanTooLargeError,
  totals: Record<string, string>,
  now = new Date(),
): SalesAnalyticsReport<Row> {
  const window = period(filters, now)
  const pageSize = clampPageSize(filters.pageSize)
  return {
    generatedAt: now.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: [],
    pageInfo: pageInfo(0, filters.page, pageSize),
    totals,
    notices: [error.message],
  }
}

function paginate<T>(rows: T[], filters: SalesAnalyticsFilters, enabled = true): { rows: T[]; pageInfo: PageInfo } {
  const pageSize = clampPageSize(filters.pageSize)
  const info = pageInfo(rows.length, filters.page, pageSize)
  if (!enabled) return { rows, pageInfo: { ...info, page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false } }
  const start = (info.page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), pageInfo: info }
}

function moneyString(value: DecimalInput, currency = DEFAULT_BASE_CURRENCY): string {
  return roundMoney(value, currency).toString()
}

function qtyString(value: DecimalInput): string {
  return roundQuantity(value, 4).toString()
}

function pctString(numerator: DecimalInput, denominator: DecimalInput): string {
  const den = toDecimal(denominator)
  if (den.lte(0)) return '0'
  return roundQuantity(toDecimal(numerator).div(den).mul(100), 2).toString()
}

function channel(order: Pick<SalesOrderRow, 'shoppingLinks'>): string {
  return order.shoppingLinks[0]?.connector ?? 'manual'
}

function customerName(order: Pick<SalesOrderRow, 'customerName' | 'customerEmail' | 'customerId'>): string {
  return order.customerName ?? order.customerEmail ?? order.customerId ?? 'Unknown customer'
}

function groupBy(filters: SalesAnalyticsFilters): SalesAnalyticsGroupBy {
  const value = filters.groupBy
  return value === 'category' || value === 'customer' || value === 'channel' ? value : 'product'
}

function currencyMode(filters: SalesAnalyticsFilters): SalesCurrencyMode {
  return filters.currencyMode === 'foreign' ? 'foreign' : 'base'
}

async function loadSalesOrders(client: SalesFulfillmentAnalyticsClient, filters: SalesAnalyticsFilters, window: { dateFrom: Date; dateTo: Date }): Promise<SalesOrderRow[]> {
  return client.salesOrder.findMany({
    where: {
      status: { in: ACTIVE_ORDER_STATUSES },
      createdAt: { gte: window.dateFrom, lte: window.dateTo },
      archived: false,
    },
    select: {
      id: true,
      status: true,
      currency: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
      expectedDelivery: true,
      paidAt: true,
      totalForeign: true,
      totalBase: true,
      taxForeign: true,
      taxBase: true,
      shippingForeign: true,
      shippingBase: true,
      discountAmount: true,
      lines: {
        select: {
          id: true,
          productId: true,
          sku: true,
          description: true,
          qty: true,
          totalForeign: true,
          totalBase: true,
          taxForeign: true,
          taxBase: true,
          discountAmount: true,
          product: { select: { id: true, sku: true, name: true, category: { select: { name: true } } } },
        },
      },
      shoppingLinks: { select: { connector: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
    take: SOURCE_ROW_LIMIT + 1,
  }) as Promise<SalesOrderRow[]>
}

async function loadSalesOrdersByIds(client: SalesFulfillmentAnalyticsClient, orderIds: string[]): Promise<SalesOrderRow[]> {
  if (orderIds.length === 0) return []
  assertSourceLimit(orderIds.length, SOURCE_ROW_LIMIT, 'Sales analytics source orders')
  return client.salesOrder.findMany({
    where: {
      id: { in: [...new Set(orderIds)] },
      archived: false,
    },
    select: {
      id: true,
      status: true,
      currency: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
      expectedDelivery: true,
      paidAt: true,
      totalForeign: true,
      totalBase: true,
      taxForeign: true,
      taxBase: true,
      shippingForeign: true,
      shippingBase: true,
      discountAmount: true,
      lines: {
        select: {
          id: true,
          productId: true,
          sku: true,
          description: true,
          qty: true,
          totalForeign: true,
          totalBase: true,
          taxForeign: true,
          taxBase: true,
          discountAmount: true,
          product: { select: { id: true, sku: true, name: true, category: { select: { name: true } } } },
        },
      },
      shoppingLinks: { select: { connector: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  }) as Promise<SalesOrderRow[]>
}

function orderLineTotal(order: SalesOrderRow, mode: SalesCurrencyMode): Prisma.Decimal {
  return order.lines.reduce((sum, line) => sum.add(toDecimal(mode === 'foreign' ? line.totalForeign : line.totalBase)), new Prisma.Decimal(0))
}

function allocatedOrderAmount(orderAmount: DecimalInput, lineAmount: DecimalInput, lineTotal: DecimalInput, fallbackShare: Prisma.Decimal): Prisma.Decimal {
  const total = toDecimal(lineTotal)
  if (total.gt(0)) return toDecimal(orderAmount).mul(toDecimal(lineAmount)).div(total)
  return toDecimal(orderAmount).mul(fallbackShare)
}

export async function getSalesAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<SalesReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const rowsByKey = new Map<string, SalesReportRow & { revenueDecimal: Prisma.Decimal; taxDecimal: Prisma.Decimal; shippingDecimal: Prisma.Decimal; discountDecimal: Prisma.Decimal; orderIds: Set<string> }>()
  const orders = await loadSalesOrders(client, filters, window)
  assertSourceLimit(orders.length, SOURCE_ROW_LIMIT, 'Sales analytics source orders')
  const grouping = groupBy(filters)
  const mode = currencyMode(filters)

  for (const order of orders) {
    if (grouping === 'customer' || grouping === 'channel') {
      const currencyKey = mode === 'foreign' ? `:${order.currency}` : ''
      const key = grouping === 'customer'
        ? `${order.customerId ?? (order.customerEmail ? `guest-email:${order.customerEmail.toLowerCase()}` : `guest-name:${customerName(order)}`)}${currencyKey}`
        : `${channel(order)}${currencyKey}`
      const label = grouping === 'customer' ? customerName(order) : channel(order)
      const current = rowsByKey.get(key) ?? {
        key,
        label,
        groupBy: grouping,
        currency: mode === 'foreign' ? order.currency : baseCurrency,
        orderCount: 0,
        lineCount: 0,
        revenue: '0',
        tax: '0',
        shipping: '0',
        discount: '0',
        revenueDecimal: new Prisma.Decimal(0),
        taxDecimal: new Prisma.Decimal(0),
        shippingDecimal: new Prisma.Decimal(0),
        discountDecimal: new Prisma.Decimal(0),
        orderIds: new Set<string>(),
      }
      current.orderIds.add(order.id)
      current.orderCount = current.orderIds.size
      current.lineCount += order.lines.length
      current.revenueDecimal = current.revenueDecimal.add(toDecimal(mode === 'foreign' ? order.totalForeign : order.totalBase))
      current.taxDecimal = current.taxDecimal.add(toDecimal(mode === 'foreign' ? order.taxForeign : order.taxBase))
      current.shippingDecimal = current.shippingDecimal.add(toDecimal(mode === 'foreign' ? order.shippingForeign : order.shippingBase))
      current.discountDecimal = current.discountDecimal.add(toDecimal(order.discountAmount))
      current.currency = current.currency === (mode === 'foreign' ? order.currency : baseCurrency) ? current.currency : 'Multiple'
      rowsByKey.set(key, current)
      continue
    }

    const lineTotal = orderLineTotal(order, mode)
    const fallbackShare = order.lines.length > 0 ? new Prisma.Decimal(1).div(order.lines.length) : new Prisma.Decimal(0)
    for (const line of order.lines) {
      const currencyKey = mode === 'foreign' ? `:${order.currency}` : ''
      const key = `${grouping === 'category' ? (line.product?.category?.name ?? 'Uncategorised') : (line.productId ?? `sku:${line.sku ?? line.description}`)}${currencyKey}`
      const label = grouping === 'category' ? key : `${line.sku ?? line.product?.sku ?? 'No SKU'} ${line.product?.name ?? line.description}`.trim()
      const lineAmount = mode === 'foreign' ? line.totalForeign : line.totalBase
      const current = rowsByKey.get(key) ?? {
        key,
        label,
        groupBy: grouping,
        currency: mode === 'foreign' ? order.currency : baseCurrency,
        orderCount: 0,
        lineCount: 0,
        revenue: '0',
        tax: '0',
        shipping: '0',
        discount: '0',
        revenueDecimal: new Prisma.Decimal(0),
        taxDecimal: new Prisma.Decimal(0),
        shippingDecimal: new Prisma.Decimal(0),
        discountDecimal: new Prisma.Decimal(0),
        orderIds: new Set<string>(),
      }
      current.orderIds.add(order.id)
      current.orderCount = current.orderIds.size
      current.lineCount += 1
      current.revenueDecimal = current.revenueDecimal.add(allocatedOrderAmount(mode === 'foreign' ? order.totalForeign : order.totalBase, lineAmount, lineTotal, fallbackShare))
      current.taxDecimal = current.taxDecimal.add(allocatedOrderAmount(mode === 'foreign' ? order.taxForeign : order.taxBase, lineAmount, lineTotal, fallbackShare))
      current.shippingDecimal = current.shippingDecimal.add(allocatedOrderAmount(mode === 'foreign' ? order.shippingForeign : order.shippingBase, lineAmount, lineTotal, fallbackShare))
      current.discountDecimal = current.discountDecimal.add(toDecimal(line.discountAmount))
      current.currency = current.currency === (mode === 'foreign' ? order.currency : baseCurrency) ? current.currency : 'Multiple'
      rowsByKey.set(key, current)
    }
  }

  const rows = [...rowsByKey.values()]
    .map((row) => ({
      key: row.key,
      label: row.label,
      groupBy: row.groupBy,
      currency: row.currency,
      orderCount: row.orderCount,
      lineCount: row.lineCount,
      revenue: moneyString(row.revenueDecimal, row.currency === 'Multiple' ? baseCurrency : row.currency),
      tax: moneyString(row.taxDecimal, row.currency === 'Multiple' ? baseCurrency : row.currency),
      shipping: moneyString(row.shippingDecimal, row.currency === 'Multiple' ? baseCurrency : row.currency),
      discount: moneyString(row.discountDecimal, row.currency === 'Multiple' ? baseCurrency : row.currency),
    }))
    .sort((a, b) => toDecimal(b.revenue).cmp(a.revenue) || a.label.localeCompare(b.label))

  const totals = [...rowsByKey.values()].reduce(
    (total, row) => ({
      revenue: total.revenue.add(row.revenueDecimal),
      tax: total.tax.add(row.taxDecimal),
      shipping: total.shipping.add(row.shippingDecimal),
      discount: total.discount.add(row.discountDecimal),
    }),
    { revenue: new Prisma.Decimal(0), tax: new Prisma.Decimal(0), shipping: new Prisma.Decimal(0), discount: new Prisma.Decimal(0) },
  )
  const paged = paginate(rows, filters, deps?.paginate !== false)

  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      revenue: moneyString(totals.revenue, baseCurrency),
      tax: moneyString(totals.tax, baseCurrency),
      shipping: moneyString(totals.shipping, baseCurrency),
      discount: moneyString(totals.discount, baseCurrency),
    },
    notices: [
      'Sales totals exclude cancelled orders. Product/category views allocate order-level totals across lines by line value so grand totals reconcile to SalesOrder totals.',
      mode === 'foreign' ? 'Foreign-currency product/category rows are split by original order currency; customer/channel rows show Multiple when a group contains more than one original currency.' : `Base-currency rows use ${baseCurrency} amounts recorded on the order.`,
    ],
  }
}

async function loadCogsByOrder(client: SalesFulfillmentAnalyticsClient, window: { dateFrom: Date; dateTo: Date }): Promise<Map<string, Prisma.Decimal>> {
  const rows = await client.cogsEntry.findMany({
    where: {
      movement: {
        type: StockMovementType.SALE_DISPATCH,
        createdAt: { gte: window.dateFrom, lte: window.dateTo },
        referenceType: 'SalesOrder',
        referenceId: { not: null },
      },
    },
    select: {
      totalCostBase: true,
      movement: { select: { referenceId: true } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as Array<{ totalCostBase: DecimalInput; movement: { referenceId: string | null } }>
  assertSourceLimit(rows.length, SOURCE_ROW_LIMIT, 'Sales COGS source rows')
  const byOrder = new Map<string, Prisma.Decimal>()
  for (const row of rows) {
    if (!row.movement.referenceId) continue
    byOrder.set(row.movement.referenceId, (byOrder.get(row.movement.referenceId) ?? new Prisma.Decimal(0)).add(toDecimal(row.totalCostBase)))
  }
  return byOrder
}

export async function getCustomerAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<CustomerReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const [orders, cogsByOrder] = await Promise.all([
    loadSalesOrders(client, filters, window),
    loadCogsByOrder(client, window),
  ])
  assertSourceLimit(orders.length, SOURCE_ROW_LIMIT, 'Customer analytics source orders')
  const totalRevenue = orders.reduce((sum, order) => sum.add(toDecimal(order.totalBase)), new Prisma.Decimal(0))
  const groups = new Map<string, CustomerReportRow & { revenue: Prisma.Decimal; grossProfit: Prisma.Decimal; arExposure: Prisma.Decimal; orderIds: Set<string> }>()
  for (const order of orders) {
    const key = order.customerId ?? (order.customerEmail ? `guest-email:${order.customerEmail.toLowerCase()}` : `guest-name:${customerName(order)}`)
    const cogs = cogsByOrder.get(order.id) ?? new Prisma.Decimal(0)
    const current = groups.get(key) ?? {
      customerId: order.customerId,
      customerName: customerName(order),
      customerEmail: order.customerEmail,
      orderCount: 0,
      revenueBase: '0',
      grossProfitBase: '0',
      arExposureBase: '0',
      shareOfRevenuePct: '0',
      revenue: new Prisma.Decimal(0),
      grossProfit: new Prisma.Decimal(0),
      arExposure: new Prisma.Decimal(0),
      orderIds: new Set<string>(),
    }
    current.orderIds.add(order.id)
    current.orderCount = current.orderIds.size
    current.revenue = current.revenue.add(toDecimal(order.totalBase))
    current.grossProfit = current.grossProfit.add(toDecimal(order.totalBase).sub(cogs))
    if (!order.paidAt) current.arExposure = current.arExposure.add(toDecimal(order.totalBase))
    groups.set(key, current)
  }
  const rows = [...groups.values()]
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      orderCount: row.orderCount,
      revenueBase: moneyString(row.revenue, baseCurrency),
      grossProfitBase: moneyString(row.grossProfit, baseCurrency),
      arExposureBase: moneyString(row.arExposure, baseCurrency),
      shareOfRevenuePct: pctString(row.revenue, totalRevenue),
    }))
    .sort((a, b) => toDecimal(b.revenueBase).cmp(a.revenueBase) || a.customerName.localeCompare(b.customerName))
  const paged = paginate(rows, filters, deps?.paginate !== false)
  const grossProfit = [...groups.values()].reduce((sum, row) => sum.add(row.grossProfit), new Prisma.Decimal(0))
  const arExposure = [...groups.values()].reduce((sum, row) => sum.add(row.arExposure), new Prisma.Decimal(0))
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      revenueBase: moneyString(totalRevenue, baseCurrency),
      grossProfitBase: moneyString(grossProfit, baseCurrency),
      arExposureBase: moneyString(arExposure, baseCurrency),
    },
    notices: ['AR exposure is unpaid sales-order totalBase for the selected period. COGS comes from CogsEntry rows linked to SALE_DISPATCH movements.'],
  }
}

export async function getMarginAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<MarginReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const cogsRows = await client.cogsEntry.findMany({
    where: { createdAt: { gte: window.dateFrom, lte: window.dateTo }, movement: { type: StockMovementType.SALE_DISPATCH } },
    select: {
      id: true,
      totalCostBase: true,
      movement: {
        select: {
          referenceType: true,
          referenceId: true,
          productId: true,
          createdAt: true,
          product: { select: { sku: true, name: true, category: { select: { name: true } } } },
        },
      },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as CogsEntryRow[]
  assertSourceLimit(cogsRows.length, SOURCE_ROW_LIMIT, 'Margin analytics COGS source rows')
  const cogsOrderIds = cogsRows
    .map((row) => row.movement.referenceType === 'SalesOrder' ? row.movement.referenceId : null)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const cogsProductIds = new Set(cogsRows.map((row) => row.movement.productId))
  const orders = await loadSalesOrdersByIds(client, cogsOrderIds)
  const groups = new Map<string, MarginReportRow & { revenue: Prisma.Decimal; cogs: Prisma.Decimal; lineIds: Set<string> }>()
  for (const order of orders) {
    for (const line of order.lines) {
      if (!line.productId || !cogsProductIds.has(line.productId)) continue
      const key = line.productId ?? `sku:${line.sku ?? line.description}`
      const current = groups.get(key) ?? {
        productId: line.productId,
        sku: line.sku ?? line.product?.sku ?? 'No SKU',
        productName: line.product?.name ?? line.description,
        categoryName: line.product?.category?.name ?? null,
        lineCount: 0,
        revenueBase: '0',
        cogsBase: '0',
        grossProfitBase: '0',
        marginPct: '0',
        contributionPct: '0',
        revenue: new Prisma.Decimal(0),
        cogs: new Prisma.Decimal(0),
        lineIds: new Set<string>(),
      }
      current.lineIds.add(line.id)
      current.lineCount = current.lineIds.size
      current.revenue = current.revenue.add(toDecimal(line.totalBase))
      groups.set(key, current)
    }
  }
  for (const row of cogsRows) {
    const key = row.movement.productId
    const current = groups.get(key) ?? {
      productId: key,
      sku: row.movement.product.sku,
      productName: row.movement.product.name,
      categoryName: row.movement.product.category?.name ?? null,
      lineCount: 0,
      revenueBase: '0',
      cogsBase: '0',
      grossProfitBase: '0',
      marginPct: '0',
      contributionPct: '0',
      revenue: new Prisma.Decimal(0),
      cogs: new Prisma.Decimal(0),
      lineIds: new Set<string>(),
    }
    current.cogs = current.cogs.add(toDecimal(row.totalCostBase))
    groups.set(key, current)
  }
  const totalGrossProfit = [...groups.values()].reduce((sum, row) => sum.add(row.revenue.sub(row.cogs)), new Prisma.Decimal(0))
  const rows = [...groups.values()]
    .map((row) => {
      const grossProfit = row.revenue.sub(row.cogs)
      return {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        categoryName: row.categoryName,
        lineCount: row.lineCount,
        revenueBase: moneyString(row.revenue, baseCurrency),
        cogsBase: moneyString(row.cogs, baseCurrency),
        grossProfitBase: moneyString(grossProfit, baseCurrency),
        marginPct: pctString(grossProfit, row.revenue),
        contributionPct: pctString(grossProfit, totalGrossProfit),
      }
    })
    .sort((a, b) => toDecimal(b.grossProfitBase).cmp(a.grossProfitBase) || a.sku.localeCompare(b.sku))
  const paged = paginate(rows, filters, deps?.paginate !== false)
  const totalRevenue = [...groups.values()].reduce((sum, row) => sum.add(row.revenue), new Prisma.Decimal(0))
  const totalCogs = [...groups.values()].reduce((sum, row) => sum.add(row.cogs), new Prisma.Decimal(0))
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      revenueBase: moneyString(totalRevenue, baseCurrency),
      cogsBase: moneyString(totalCogs, baseCurrency),
      grossProfitBase: moneyString(totalGrossProfit, baseCurrency),
      marginPct: pctString(totalGrossProfit, totalRevenue),
    },
    notices: [
      'Gross margin is anchored to CogsEntry.createdAt, matches the inventory COGS report period semantics, and uses source SalesOrderLine revenue without recalculating FIFO.',
      'Margin rows are product-level buckets: COGS is grouped by movement productId and revenue is grouped from sales-order lines for COGS-linked orders. Duplicate SKU lines share the same product bucket; this report is not line-level COGS attribution.',
    ],
  }
}

export async function getReturnsAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<ReturnsReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const baseCurrency = await baseCurrencyFromDeps(deps)
  const window = period(filters, generatedAt)
  const [refundLines, shippedMovements] = await Promise.all([
    client.salesOrderRefundLine.findMany({
      where: { refund: { refundedAt: { gte: window.dateFrom, lte: window.dateTo } } },
      select: {
        id: true,
        refundId: true,
        productId: true,
        description: true,
        qty: true,
        totalBase: true,
        product: { select: { id: true, sku: true, name: true } },
        refund: {
          select: {
            id: true,
            reason: true,
            totalBase: true,
            refundedAt: true,
            order: { select: { customerName: true, lines: { select: { productId: true, qty: true } } } },
          },
        },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<RefundLineRow[]>,
    client.stockMovement.findMany({
      where: {
        type: StockMovementType.SALE_DISPATCH,
        createdAt: { gte: window.dateFrom, lte: window.dateTo },
      },
      select: { productId: true, qty: true },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<Array<{ productId: string; qty: DecimalInput }>>,
  ])
  assertSourceLimit(Math.max(refundLines.length, shippedMovements.length), SOURCE_ROW_LIMIT, 'Returns analytics source rows')
  const shippedByProduct = new Map<string, Prisma.Decimal>()
  for (const movement of shippedMovements) {
    shippedByProduct.set(movement.productId, (shippedByProduct.get(movement.productId) ?? new Prisma.Decimal(0)).add(toDecimal(movement.qty)))
  }
  const groups = new Map<string, ReturnsReportRow & { refundIds: Set<string>; returned: Prisma.Decimal; refundValue: Prisma.Decimal }>()
  for (const line of refundLines) {
    const productKey = line.productId ?? `desc:${line.description}`
    const reason = line.refund.reason ?? 'Unspecified'
    const customer = line.refund.order.customerName ?? 'Unknown customer'
    const key = `${productKey}:${customer}:${reason}`
    const current = groups.get(key) ?? {
      productId: line.productId,
      sku: line.product?.sku ?? 'No SKU',
      productName: line.product?.name ?? line.description,
      customerName: customer,
      reason,
      refundCount: 0,
      returnedQty: '0',
      refundValueBase: '0',
      shippedQty: '0',
      returnRatePct: '0',
      refundIds: new Set<string>(),
      returned: new Prisma.Decimal(0),
      refundValue: new Prisma.Decimal(0),
    }
    current.refundIds.add(line.refundId)
    current.refundCount = current.refundIds.size
    current.returned = current.returned.add(toDecimal(line.qty))
    current.refundValue = current.refundValue.add(toDecimal(line.totalBase))
    groups.set(key, current)
  }
  const rows = [...groups.values()]
    .map((row) => {
      const shippedQty = row.productId ? shippedByProduct.get(row.productId) ?? new Prisma.Decimal(0) : new Prisma.Decimal(0)
      return {
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        customerName: row.customerName,
        reason: row.reason,
        refundCount: row.refundCount,
        returnedQty: qtyString(row.returned),
        refundValueBase: moneyString(row.refundValue, baseCurrency),
        shippedQty: qtyString(shippedQty),
        returnRatePct: pctString(row.returned, shippedQty),
      }
    })
    .sort((a, b) => toDecimal(b.refundValueBase).cmp(a.refundValueBase) || a.sku.localeCompare(b.sku))
  const paged = paginate(rows, filters, deps?.paginate !== false)
  const totalReturned = [...groups.values()].reduce((sum, row) => sum.add(row.returned), new Prisma.Decimal(0))
  const totalRefund = [...groups.values()].reduce((sum, row) => sum.add(row.refundValue), new Prisma.Decimal(0))
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      returnedQty: qtyString(totalReturned),
      refundValueBase: moneyString(totalRefund, baseCurrency),
    },
    notices: ['Returns analysis uses SalesOrderRefundLine values and compares returned quantity with SALE_DISPATCH quantity in the same period. Return rate is a same-period returned ÷ same-period dispatched metric, not an order-cohort return rate.'],
  }
}

export async function getFulfillmentAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<FulfillmentReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const window = period(filters, generatedAt)
  const shipments = await client.shipment.findMany({
    where: {
      status: ShipmentStatus.SHIPPED,
      shippedAt: { gte: window.dateFrom, lte: window.dateTo },
    },
    select: {
      id: true,
      orderId: true,
      status: true,
      shippedAt: true,
      createdAt: true,
      updatedAt: true,
      lines: { select: { lineId: true, qty: true } },
      order: { select: { id: true, createdAt: true, expectedDelivery: true, lines: { select: { id: true, qty: true } } } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as ShipmentRow[]
  assertSourceLimit(shipments.length, SOURCE_ROW_LIMIT, 'Fulfillment analytics source rows')
  const orders = new Map<string, { order: ShipmentRow['order']; shipments: ShipmentRow[] }>()
  for (const shipment of shipments) {
    const current = orders.get(shipment.orderId) ?? { order: shipment.order, shipments: [] }
    current.shipments.push(shipment)
    orders.set(shipment.orderId, current)
  }
  let onTime = 0
  let shippedOrders = 0
  let partialOrders = 0
  let orderedQty = new Prisma.Decimal(0)
  let shippedQty = new Prisma.Decimal(0)
  let totalDays = new Prisma.Decimal(0)
  const lateOutliers: Array<{ orderId: string; lateDays: Prisma.Decimal }> = []
  for (const group of orders.values()) {
    const firstShipped = group.shipments.map((shipment) => shipment.shippedAt).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0]
    if (!firstShipped) continue
    shippedOrders += 1
    if (group.order.expectedDelivery && firstShipped.getTime() <= group.order.expectedDelivery.getTime()) onTime += 1
    if (group.order.expectedDelivery && firstShipped.getTime() > group.order.expectedDelivery.getTime()) {
      lateOutliers.push({
        orderId: group.order.id,
        lateDays: new Prisma.Decimal(firstShipped.getTime() - group.order.expectedDelivery.getTime()).div(86_400_000),
      })
    }
    const orderQty = group.order.lines.reduce((sum, line) => sum.add(toDecimal(line.qty)), new Prisma.Decimal(0))
    const shipmentQty = group.shipments.flatMap((shipment) => shipment.lines).reduce((sum, line) => sum.add(toDecimal(line.qty)), new Prisma.Decimal(0))
    orderedQty = orderedQty.add(orderQty)
    shippedQty = shippedQty.add(shipmentQty)
    if (group.shipments.length > 1 || shipmentQty.lt(orderQty)) partialOrders += 1
    totalDays = totalDays.add(new Prisma.Decimal(firstShipped.getTime() - group.order.createdAt.getTime()).div(86_400_000))
  }
  const avgDays = shippedOrders > 0 ? totalDays.div(shippedOrders) : new Prisma.Decimal(0)
  const rows: FulfillmentReportRow[] = [
    { metric: 'On-time ship rate', value: `${pctString(onTime, shippedOrders)}%`, numerator: String(onTime), denominator: String(shippedOrders) },
    { metric: 'Fill rate', value: `${pctString(shippedQty, orderedQty)}%`, numerator: qtyString(shippedQty), denominator: qtyString(orderedQty) },
    { metric: 'Average order-to-ship days', value: roundQuantity(avgDays, 2).toString(), numerator: roundQuantity(totalDays, 2).toString(), denominator: String(shippedOrders) },
    { metric: 'Partial ship rate', value: `${pctString(partialOrders, shippedOrders)}%`, numerator: String(partialOrders), denominator: String(shippedOrders) },
  ]
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows,
    pageInfo: pageInfo(rows.length, 1, rows.length || 1),
    totals: {
      shippedOrders: String(shippedOrders),
      shippedQty: qtyString(shippedQty),
    },
    notices: [
      'Fulfillment metrics use Shipment.shippedAt and ShipmentLine quantity; SalesOrder dates are used only for elapsed-day and expected-delivery comparisons.',
      ...(lateOutliers.length > 0
        ? [`Slowest late shipments: ${lateOutliers.sort((a, b) => b.lateDays.cmp(a.lateDays)).slice(0, 5).map((row) => `${row.orderId} (${roundQuantity(row.lateDays, 2)} days late)`).join(', ')}.`]
        : []),
    ],
  }
}

function activityShipmentId(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, Prisma.JsonValue>).shipmentId
  return typeof value === 'string' ? value : null
}

export async function getThroughputAnalyticsReport(filters: SalesAnalyticsFilters = {}, deps?: SalesFulfillmentAnalyticsDeps): Promise<SalesAnalyticsReport<ThroughputReportRow>> {
  const client = clientFromDeps(deps)
  const generatedAt = nowFromDeps(deps)
  const window = period(filters, generatedAt)
  const [activities, shipments, pendingShipments] = await Promise.all([
    client.activityLog.findMany({
      where: {
        entityType: ActivityEntityType.SALES_ORDER,
        action: 'shipment_status_changed',
        createdAt: { gte: window.dateFrom, lte: window.dateTo },
      },
      select: {
        userId: true,
        createdAt: true,
        metadata: true,
        user: { select: { name: true } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<ActivityLogRow[]>,
    client.shipment.findMany({
      where: { shippedAt: { gte: window.dateFrom, lte: window.dateTo } },
      select: { id: true, orderId: true, lines: { select: { lineId: true, qty: true } } },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<Array<{ id: string; orderId: string; lines: Array<{ lineId: string; qty: DecimalInput }> }>>,
    client.shipment.findMany({
      where: { status: { in: [ShipmentStatus.PENDING, ShipmentStatus.PICKING, ShipmentStatus.PACKED] } },
      select: { id: true },
    }) as Promise<Array<{ id: string }>>,
  ])
  assertSourceLimit(Math.max(activities.length, shipments.length), SOURCE_ROW_LIMIT, 'Throughput analytics source rows')
  const shipmentById = new Map(shipments.map((shipment) => [shipment.id, shipment]))
  const groups = new Map<string, ThroughputReportRow & { orderIds: Set<string>; shipmentIds: Set<string>; lineIds: Set<string> }>()
  for (const activity of activities) {
    const shipmentId = activityShipmentId(activity.metadata)
    const shipment = shipmentId ? shipmentById.get(shipmentId) : undefined
    const date = dateOnly(activity.createdAt)
    const userName = activity.user?.name ?? 'System'
    const key = `${date}:${activity.userId ?? 'system'}`
    const current = groups.get(key) ?? {
      date,
      userName,
      orderCount: 0,
      shipmentCount: 0,
      lineCount: 0,
      orderIds: new Set<string>(),
      shipmentIds: new Set<string>(),
      lineIds: new Set<string>(),
    }
    if (shipment) {
      current.orderIds.add(shipment.orderId)
      current.shipmentIds.add(shipment.id)
      for (const line of shipment.lines) current.lineIds.add(line.lineId)
    }
    current.orderCount = current.orderIds.size
    current.shipmentCount = current.shipmentIds.size
    current.lineCount = current.lineIds.size
    groups.set(key, current)
  }
  const rows = [...groups.values()]
    .map((row) => ({
      date: row.date,
      userName: row.userName,
      orderCount: row.orderCount,
      shipmentCount: row.shipmentCount,
      lineCount: row.lineCount,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.userName.localeCompare(b.userName))
  const paged = paginate(rows, filters, deps?.paginate !== false)
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals: {
      orders: String(rows.reduce((sum, row) => sum + row.orderCount, 0)),
      shipments: String(rows.reduce((sum, row) => sum + row.shipmentCount, 0)),
      lines: String(rows.reduce((sum, row) => sum + row.lineCount, 0)),
      queueDepth: String(pendingShipments.length),
    },
    notices: ['Throughput uses shipment_status_changed ActivityLog rows linked to Shipment metadata. Current queue depth is exposed only in totals because it is a live snapshot, not a historical per-day value.'],
  }
}
