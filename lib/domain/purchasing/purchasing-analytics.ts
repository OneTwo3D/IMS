import { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { DEFAULT_BASE_CURRENCY, getBaseCurrencyCode } from '@/lib/base-currency'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DEFAULT_PERIOD_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const OPEN_PURCHASE_ORDER_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.PO_SENT,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
  PurchaseOrderStatus.SHIPPED,
]

const RECEIVED_PURCHASE_ORDER_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.RECEIVED,
  PurchaseOrderStatus.CLOSED,
  PurchaseOrderStatus.INVOICED,
  PurchaseOrderStatus.PARTIALLY_RETURNED,
  PurchaseOrderStatus.RETURNED,
]

const RFQ_RESPONSE_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.QUOTE_RECEIVED,
  PurchaseOrderStatus.PO_SENT,
  PurchaseOrderStatus.SHIPPED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
  ...RECEIVED_PURCHASE_ORDER_STATUSES,
]

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type PurchasingAnalyticsClient = {
  purchaseOrder: FindManyDelegate
  purchaseOrderLine: FindManyDelegate
  purchaseReceipt: FindManyDelegate
  purchaseReturnLine: FindManyDelegate
  supplierProduct: FindManyDelegate
}

export type PurchasingAnalyticsDeps = {
  client?: PurchasingAnalyticsClient
  now?: () => Date
  baseCurrency?: () => Promise<string>
}

export type PurchasingAnalyticsFilters = {
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

export type PurchasingAnalyticsReport<Row> = {
  generatedAt: string
  dateFrom: string
  dateTo: string
  rows: Row[]
  pageInfo: PageInfo
  totals: Record<string, string>
  notices: string[]
}

export type OpenPurchaseOrderReportRow = {
  poId: string
  reference: string
  supplierId: string
  supplierName: string
  status: PurchaseOrderStatus
  poSentAt: string | null
  expectedDelivery: string | null
  overdue: boolean
  daysSinceSent: string
  outstandingQty: string
  outstandingValueBase: string
}

export type SupplierPerformanceReportRow = {
  supplierId: string
  supplierName: string
  receiptCount: number
  onTimeReceiptCount: number
  expectedReceiptCount: number
  onTimeRatePct: string
  orderedQty: string
  receivedQty: string
  qtyVariance: string
  qtyVariancePct: string
  returnedQty: string
  returnRatePct: string
  averageActualLeadTimeDays: string
  averageConfiguredLeadTimeDays: string
  averageRfqResponseDays: string
}

export type PurchasePriceVarianceReportRow = {
  supplierId: string
  supplierName: string
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  poReference: string
  receivedAt: string | null
  qty: string
  actualLandedUnitCostBase: string
  referenceUnitCostBase: string
  variancePerUnitBase: string
  varianceTotalBase: string
  variancePct: string
  referencePriceSource: 'prior_po' | 'none'
}

export type SpendReportRow = {
  period: string
  supplierId: string
  supplierName: string
  categoryName: string
  poCount: number
  spendBase: string
}

export type LeadTimeReportRow = {
  supplierId: string
  supplierName: string
  productId: string
  sku: string
  productName: string
  receiptCount: number
  averageLeadTimeDays: string
  p50LeadTimeDays: string
  p95LeadTimeDays: string
  configuredLeadTimeDays: string
  latestReceiptAt: string
}

type OpenPoRow = {
  id: string
  reference: string
  status: PurchaseOrderStatus
  poSentAt: Date | null
  expectedDelivery: Date | null
  createdAt: Date
  supplierId: string
  supplier: { name: string }
  lines: Array<{
    qty: DecimalInput
    qtyReceived: DecimalInput
    qtyReturned: DecimalInput
    unitCostBase: DecimalInput
    landedUnitCostBase?: DecimalInput
  }>
}

type ReceiptRow = {
  id: string
  receivedAt: Date
  po: {
    id: string
    reference: string
    supplierId: string
    expectedDelivery: Date | null
    poSentAt: Date | null
    createdAt: Date
    supplier: { name: string }
  }
  lines: Array<{
    poLineId: string
    qtyReceived: DecimalInput
    poLine: {
      qty: DecimalInput
      productId: string
      product: {
        sku: string
        name: string
        category: { name: string } | null
      }
    }
  }>
}

type ReturnLineRow = {
  qtyReturned: DecimalInput
  return: {
    returnedAt: Date
    po: {
      supplierId: string
      supplier: { name: string }
    }
  }
  poLine: {
    productId: string
  }
}

type SupplierProductRow = {
  supplierId: string
  productId: string
  leadTimeDays: number | null
}

type PurchaseOrderLineRow = {
  id: string
  productId: string
  qty: DecimalInput
  unitCostBase: DecimalInput
  landedUnitCostBase: DecimalInput
  totalBase: DecimalInput
  po: {
    reference: string
    supplierId: string
    poSentAt: Date | null
    receivedAt: Date | null
    createdAt: Date
    status: PurchaseOrderStatus
    supplier: { name: string }
  }
  product: {
    sku: string
    name: string
    category: { name: string } | null
  }
}

type SpendPurchaseOrderRow = {
  id: string
  reference: string
  supplierId: string
  receivedAt: Date | null
  totalBase: DecimalInput
  supplier: { name: string }
  lines: Array<{
    totalBase: DecimalInput
    product: { category: { name: string } | null }
  }>
}

function clientFromDeps(deps?: PurchasingAnalyticsDeps): PurchasingAnalyticsClient {
  return (deps?.client ?? db) as unknown as PurchasingAnalyticsClient
}

function nowFromDeps(deps?: PurchasingAnalyticsDeps): Date {
  return deps?.now?.() ?? new Date()
}

async function baseCurrencyFromDeps(deps?: PurchasingAnalyticsDeps): Promise<string> {
  if (deps?.baseCurrency) return deps.baseCurrency()
  return deps?.client ? DEFAULT_BASE_CURRENCY : getBaseCurrencyCode()
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

function subtractDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() - days)
  return next
}

function parseDateOnly(value: string | undefined, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return fallback
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return endOfDay ? endOfUtcDay(parsed) : startOfUtcDay(parsed)
}

function period(filters: PurchasingAnalyticsFilters, now: Date): { dateFrom: Date; dateTo: Date } {
  const defaultTo = endOfUtcDay(now)
  const defaultFrom = subtractDays(startOfUtcDay(now), DEFAULT_PERIOD_DAYS - 1)
  const dateTo = parseDateOnly(filters.dateTo, defaultTo, true)
  const dateFrom = parseDateOnly(filters.dateFrom, defaultFrom)
  return dateFrom.getTime() <= dateTo.getTime()
    ? { dateFrom, dateTo }
    : { dateFrom: startOfUtcDay(dateTo), dateTo }
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
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

function paginate<T>(rows: T[], filters: PurchasingAnalyticsFilters, enabled: boolean): { rows: T[]; pageInfo: PageInfo } {
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

function daysString(value: DecimalInput): string {
  return roundQuantity(value, 2).toString()
}

function pctString(numerator: DecimalInput, denominator: DecimalInput): string {
  const den = toDecimal(denominator)
  if (den.lte(0)) return '0'
  return roundQuantity(toDecimal(numerator).div(den).mul(100), 2).toString()
}

function daysBetween(start: Date, end: Date): Prisma.Decimal {
  return new Prisma.Decimal(end.getTime() - start.getTime()).div(DAY_MS)
}

function percentile(values: Prisma.Decimal[], percentileRank: number): Prisma.Decimal {
  if (values.length === 0) return new Prisma.Decimal(0)
  const sorted = [...values].sort((a, b) => a.cmp(b))
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1))
  return sorted[index] ?? new Prisma.Decimal(0)
}

function generatedReport<Row>(
  rows: Row[],
  filters: PurchasingAnalyticsFilters,
  window: { dateFrom: Date; dateTo: Date },
  generatedAt: Date,
  totals: Record<string, string>,
  notices: string[],
  paginateRows: boolean,
): PurchasingAnalyticsReport<Row> {
  const paged = paginate(rows, filters, paginateRows)
  return {
    generatedAt: generatedAt.toISOString(),
    dateFrom: dateOnly(window.dateFrom),
    dateTo: dateOnly(window.dateTo),
    rows: paged.rows,
    pageInfo: paged.pageInfo,
    totals,
    notices,
  }
}

export async function getOpenPurchaseOrdersReport(
  filters: PurchasingAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: PurchasingAnalyticsDeps } = {},
): Promise<PurchasingAnalyticsReport<OpenPurchaseOrderReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const orders = await client.purchaseOrder.findMany({
    where: {
      status: { in: OPEN_PURCHASE_ORDER_STATUSES },
      archived: false,
      OR: [
        { poSentAt: { gte: window.dateFrom, lte: window.dateTo } },
        { poSentAt: null, createdAt: { gte: window.dateFrom, lte: window.dateTo } },
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      poSentAt: true,
      expectedDelivery: true,
      createdAt: true,
      supplierId: true,
      supplier: { select: { name: true } },
      lines: {
        select: {
          qty: true,
          qtyReceived: true,
          qtyReturned: true,
          unitCostBase: true,
          landedUnitCostBase: true,
        },
      },
    },
    orderBy: [{ expectedDelivery: 'asc' }, { createdAt: 'asc' }],
    take: SOURCE_ROW_LIMIT + 1,
  }) as OpenPoRow[]
  if (orders.length > SOURCE_ROW_LIMIT) throw new Error(`Open purchase order source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)

  const rows = orders.map<OpenPurchaseOrderReportRow>((order) => {
    let outstandingQty = new Prisma.Decimal(0)
    let outstandingValueBase = new Prisma.Decimal(0)
    for (const line of order.lines) {
      const outstanding = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.qty).sub(toDecimal(line.qtyReceived)).sub(toDecimal(line.qtyReturned)))
      outstandingQty = outstandingQty.add(outstanding)
      const unitCost = line.landedUnitCostBase != null && toDecimal(line.landedUnitCostBase).gt(0)
        ? line.landedUnitCostBase
        : line.unitCostBase
      outstandingValueBase = outstandingValueBase.add(outstanding.mul(toDecimal(unitCost)))
    }
    const sentAt = order.poSentAt ?? order.createdAt
    return {
      poId: order.id,
      reference: order.reference,
      supplierId: order.supplierId,
      supplierName: order.supplier.name,
      status: order.status,
      poSentAt: order.poSentAt ? dateOnly(order.poSentAt) : null,
      expectedDelivery: order.expectedDelivery ? dateOnly(order.expectedDelivery) : null,
      overdue: Boolean(order.expectedDelivery && order.expectedDelivery.getTime() < startOfUtcDay(generatedAt).getTime() && outstandingQty.gt(0)),
      daysSinceSent: daysString(daysBetween(sentAt, generatedAt)),
      outstandingQty: qtyString(outstandingQty),
      outstandingValueBase: moneyString(outstandingValueBase, baseCurrency),
    }
  }).filter((row) => toDecimal(row.outstandingQty).gt(0))

  rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.expectedDelivery ?? '9999-12-31').localeCompare(b.expectedDelivery ?? '9999-12-31') || a.reference.localeCompare(b.reference))
  const totals = rows.reduce(
    (total, row) => ({
      outstandingQty: total.outstandingQty.add(row.outstandingQty),
      outstandingValueBase: total.outstandingValueBase.add(row.outstandingValueBase),
      overdue: total.overdue + (row.overdue ? 1 : 0),
    }),
    { outstandingQty: new Prisma.Decimal(0), outstandingValueBase: new Prisma.Decimal(0), overdue: 0 },
  )
  return generatedReport(rows, filters, window, generatedAt, {
    outstandingQty: qtyString(totals.outstandingQty),
    outstandingValueBase: moneyString(totals.outstandingValueBase, baseCurrency),
    overdue: String(totals.overdue),
  }, [
    'Open POs are PurchaseOrder.status in PO_SENT, PARTIALLY_RECEIVED, or SHIPPED, with poSentAt/createdAt inside the selected period; outstanding quantity nets qtyReceived and qtyReturned from PO lines and values open qty with landed unit cost when present.',
  ], options.paginate !== false)
}

async function loadReceipts(client: PurchasingAnalyticsClient, window: { dateFrom: Date; dateTo: Date }): Promise<ReceiptRow[]> {
  const receipts = await client.purchaseReceipt.findMany({
    where: { receivedAt: { gte: window.dateFrom, lte: window.dateTo } },
    select: {
      id: true,
      receivedAt: true,
      po: {
        select: {
          id: true,
          reference: true,
          supplierId: true,
          expectedDelivery: true,
          poSentAt: true,
          createdAt: true,
          supplier: { select: { name: true } },
        },
      },
      lines: {
        select: {
          poLineId: true,
          qtyReceived: true,
          poLine: {
            select: {
              qty: true,
              productId: true,
              product: { select: { sku: true, name: true, category: { select: { name: true } } } },
            },
          },
        },
      },
    },
    orderBy: { receivedAt: 'asc' },
    take: SOURCE_ROW_LIMIT + 1,
  }) as ReceiptRow[]
  if (receipts.length > SOURCE_ROW_LIMIT) throw new Error(`Purchase receipt source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  return receipts
}

export async function getSupplierPerformanceReport(
  filters: PurchasingAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: PurchasingAnalyticsDeps } = {},
): Promise<PurchasingAnalyticsReport<SupplierPerformanceReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const [receipts, returns, configuredLeadTimes, rfqOrders] = await Promise.all([
    loadReceipts(client, window),
    client.purchaseReturnLine.findMany({
      where: { return: { returnedAt: { gte: window.dateFrom, lte: window.dateTo } } },
      select: {
        qtyReturned: true,
        return: { select: { returnedAt: true, po: { select: { supplierId: true, supplier: { select: { name: true } } } } } },
        poLine: { select: { productId: true } },
      },
    }) as Promise<ReturnLineRow[]>,
    client.supplierProduct.findMany({
      where: { leadTimeDays: { not: null } },
      select: { supplierId: true, productId: true, leadTimeDays: true },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<SupplierProductRow[]>,
    client.purchaseOrder.findMany({
      where: {
        rfqSentAt: { not: null },
        updatedAt: { gte: window.dateFrom, lte: window.dateTo },
        status: { in: RFQ_RESPONSE_STATUSES },
      },
      select: {
        supplierId: true,
        rfqSentAt: true,
        updatedAt: true,
        supplier: { select: { name: true } },
      },
    }) as Promise<Array<{ supplierId: string; rfqSentAt: Date | null; updatedAt: Date; supplier: { name: string } }>>,
  ])

  type SupplierAccumulator = {
    supplierName: string
    receiptIds: Set<string>
    onTimeReceiptCount: number
    expectedReceiptCount: number
    orderedByLine: Map<string, Prisma.Decimal>
    receivedQty: Prisma.Decimal
    returnedQty: Prisma.Decimal
    leadTimes: Prisma.Decimal[]
    configuredLeadTimes: Prisma.Decimal[]
    rfqResponseDays: Prisma.Decimal[]
  }
  const bySupplier = new Map<string, SupplierAccumulator>()
  const ensure = (supplierId: string, supplierName: string): SupplierAccumulator => {
    let accumulator = bySupplier.get(supplierId)
    if (!accumulator) {
      accumulator = {
        supplierName,
        receiptIds: new Set<string>(),
        onTimeReceiptCount: 0,
        expectedReceiptCount: 0,
        orderedByLine: new Map<string, Prisma.Decimal>(),
        receivedQty: new Prisma.Decimal(0),
        returnedQty: new Prisma.Decimal(0),
        leadTimes: [],
        configuredLeadTimes: [],
        rfqResponseDays: [],
      }
      bySupplier.set(supplierId, accumulator)
    }
    return accumulator
  }

  for (const receipt of receipts) {
    const supplier = ensure(receipt.po.supplierId, receipt.po.supplier.name)
    if (!supplier.receiptIds.has(receipt.id)) {
      supplier.receiptIds.add(receipt.id)
      if (receipt.po.expectedDelivery) {
        supplier.expectedReceiptCount += 1
        if (receipt.receivedAt.getTime() <= receipt.po.expectedDelivery.getTime()) supplier.onTimeReceiptCount += 1
      }
      const sentAt = receipt.po.poSentAt ?? receipt.po.createdAt
      supplier.leadTimes.push(daysBetween(sentAt, receipt.receivedAt))
    }
    for (const line of receipt.lines) {
      supplier.orderedByLine.set(line.poLineId, toDecimal(line.poLine.qty))
      supplier.receivedQty = supplier.receivedQty.add(toDecimal(line.qtyReceived))
    }
  }
  for (const row of returns) {
    const supplier = ensure(row.return.po.supplierId, row.return.po.supplier.name)
    supplier.returnedQty = supplier.returnedQty.add(toDecimal(row.qtyReturned))
  }
  for (const row of configuredLeadTimes) {
    const supplier = bySupplier.get(row.supplierId)
    if (supplier && row.leadTimeDays != null) supplier.configuredLeadTimes.push(new Prisma.Decimal(row.leadTimeDays))
  }
  if (configuredLeadTimes.length > SOURCE_ROW_LIMIT) throw new Error(`Supplier-product source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  for (const order of rfqOrders) {
    if (!order.rfqSentAt) continue
    const supplier = ensure(order.supplierId, order.supplier.name)
    supplier.rfqResponseDays.push(daysBetween(order.rfqSentAt, order.updatedAt))
  }

  const rows = [...bySupplier.entries()].map<SupplierPerformanceReportRow>(([supplierId, supplier]) => {
    const orderedQty = [...supplier.orderedByLine.values()].reduce((total, qty) => total.add(qty), new Prisma.Decimal(0))
    const qtyVariance = supplier.receivedQty.sub(orderedQty)
    const averageLeadTime = supplier.leadTimes.length === 0
      ? new Prisma.Decimal(0)
      : supplier.leadTimes.reduce((total, value) => total.add(value), new Prisma.Decimal(0)).div(supplier.leadTimes.length)
    const averageConfiguredLeadTime = supplier.configuredLeadTimes.length === 0
      ? new Prisma.Decimal(0)
      : supplier.configuredLeadTimes.reduce((total, value) => total.add(value), new Prisma.Decimal(0)).div(supplier.configuredLeadTimes.length)
    const averageRfqResponse = supplier.rfqResponseDays.length === 0
      ? new Prisma.Decimal(0)
      : supplier.rfqResponseDays.reduce((total, value) => total.add(value), new Prisma.Decimal(0)).div(supplier.rfqResponseDays.length)
    return {
      supplierId,
      supplierName: supplier.supplierName,
      receiptCount: supplier.receiptIds.size,
      onTimeReceiptCount: supplier.onTimeReceiptCount,
      expectedReceiptCount: supplier.expectedReceiptCount,
      onTimeRatePct: pctString(supplier.onTimeReceiptCount, supplier.expectedReceiptCount),
      orderedQty: qtyString(orderedQty),
      receivedQty: qtyString(supplier.receivedQty),
      qtyVariance: qtyString(qtyVariance),
      qtyVariancePct: pctString(qtyVariance, orderedQty),
      returnedQty: qtyString(supplier.returnedQty),
      returnRatePct: pctString(supplier.returnedQty, supplier.receivedQty),
      averageActualLeadTimeDays: daysString(averageLeadTime),
      averageConfiguredLeadTimeDays: daysString(averageConfiguredLeadTime),
      averageRfqResponseDays: daysString(averageRfqResponse),
    }
  })
  rows.sort((a, b) => a.supplierName.localeCompare(b.supplierName))
  return generatedReport(rows, filters, window, generatedAt, {
    supplierCount: String(rows.length),
    receipts: String(rows.reduce((total, row) => total + row.receiptCount, 0)),
  }, [
    'On-time rate compares PurchaseReceipt.receivedAt with PurchaseOrder.expectedDelivery for receipts that have an expected date.',
    'RFQ response days use updatedAt for RFQs that reached QUOTE_RECEIVED or later because the schema does not store a dedicated quoteReceivedAt timestamp.',
  ], options.paginate !== false)
}

export async function getPurchasePriceVarianceReport(
  filters: PurchasingAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: PurchasingAnalyticsDeps } = {},
): Promise<PurchasingAnalyticsReport<PurchasePriceVarianceReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const lines = await client.purchaseOrderLine.findMany({
    where: {
      po: { status: { in: RECEIVED_PURCHASE_ORDER_STATUSES }, receivedAt: { lte: window.dateTo } },
    },
    select: {
      id: true,
      productId: true,
      qty: true,
      unitCostBase: true,
      landedUnitCostBase: true,
      totalBase: true,
      po: {
        select: {
          reference: true,
          supplierId: true,
          poSentAt: true,
          receivedAt: true,
          createdAt: true,
          status: true,
          supplier: { select: { name: true } },
        },
      },
      product: { select: { sku: true, name: true, category: { select: { name: true } } } },
    },
    orderBy: [{ po: { receivedAt: 'asc' } }, { po: { createdAt: 'asc' } }],
    take: SOURCE_ROW_LIMIT + 1,
  }) as PurchaseOrderLineRow[]
  if (lines.length > SOURCE_ROW_LIMIT) throw new Error(`PPV source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)

  const priorBySupplierProduct = new Map<string, Prisma.Decimal>()
  const rows: PurchasePriceVarianceReportRow[] = []
  for (const line of lines) {
    const receivedAt = line.po.receivedAt ?? line.po.createdAt
    const actual = toDecimal(line.landedUnitCostBase).gt(0) ? toDecimal(line.landedUnitCostBase) : toDecimal(line.unitCostBase)
    const key = `${line.po.supplierId}:${line.productId}`
    const prior = priorBySupplierProduct.get(key)
    if (receivedAt.getTime() >= window.dateFrom.getTime() && receivedAt.getTime() <= window.dateTo.getTime()) {
      const variancePerUnit = prior ? actual.sub(prior) : new Prisma.Decimal(0)
      rows.push({
        supplierId: line.po.supplierId,
        supplierName: line.po.supplier.name,
        productId: line.productId,
        sku: line.product.sku,
        productName: line.product.name,
        categoryName: line.product.category?.name ?? null,
        poReference: line.po.reference,
        receivedAt: line.po.receivedAt ? dateOnly(line.po.receivedAt) : null,
        qty: qtyString(line.qty),
        actualLandedUnitCostBase: moneyString(actual, baseCurrency),
        referenceUnitCostBase: prior ? moneyString(prior, baseCurrency) : '0',
        variancePerUnitBase: moneyString(variancePerUnit, baseCurrency),
        varianceTotalBase: moneyString(variancePerUnit.mul(toDecimal(line.qty)), baseCurrency),
        variancePct: prior ? pctString(variancePerUnit, prior) : '0',
        referencePriceSource: prior ? 'prior_po' : 'none',
      })
    }
    priorBySupplierProduct.set(key, actual)
  }
  rows.sort((a, b) => toDecimal(b.varianceTotalBase).abs().cmp(toDecimal(a.varianceTotalBase).abs()) || a.sku.localeCompare(b.sku))
  const totalVariance = rows.reduce((total, row) => total.add(row.varianceTotalBase), new Prisma.Decimal(0))
  return generatedReport(rows, filters, window, generatedAt, {
    varianceTotalBase: moneyString(totalVariance, baseCurrency),
    rowCount: String(rows.length),
  }, [
    'PPV reference price source is the previous received PO line for the same supplier and SKU in base currency; supplier_products.lastUnitCost is stored in supplier currency and is not used as a base-currency standard.',
  ], options.paginate !== false)
}

export async function getSpendReport(
  filters: PurchasingAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: PurchasingAnalyticsDeps } = {},
): Promise<PurchasingAnalyticsReport<SpendReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const orders = await client.purchaseOrder.findMany({
    where: {
      status: { in: RECEIVED_PURCHASE_ORDER_STATUSES },
      receivedAt: { gte: window.dateFrom, lte: window.dateTo },
      archived: false,
    },
    select: {
      id: true,
      reference: true,
      supplierId: true,
      receivedAt: true,
      totalBase: true,
      supplier: { select: { name: true } },
      lines: { select: { totalBase: true, product: { select: { category: { select: { name: true } } } } } },
    },
    orderBy: { receivedAt: 'asc' },
    take: SOURCE_ROW_LIMIT + 1,
  }) as SpendPurchaseOrderRow[]
  if (orders.length > SOURCE_ROW_LIMIT) throw new Error(`Spend source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)

  type SpendAccumulator = { poIds: Set<string>; spendBase: Prisma.Decimal }
  const byKey = new Map<string, SpendAccumulator & { period: string; supplierId: string; supplierName: string; categoryName: string }>()
  for (const order of orders) {
    const receivedAt = order.receivedAt ?? generatedAt
    const periodKey = monthKey(receivedAt)
    const lineTotal = order.lines.reduce((total, line) => total.add(toDecimal(line.totalBase)), new Prisma.Decimal(0))
    const allocationRows = order.lines.length === 0
      ? [{ categoryName: 'Uncategorised', amount: toDecimal(order.totalBase) }]
      : order.lines.map((line) => {
        const share = lineTotal.gt(0)
          ? toDecimal(line.totalBase).div(lineTotal)
          : new Prisma.Decimal(1).div(order.lines.length)
        return {
          categoryName: line.product.category?.name ?? 'Uncategorised',
          amount: toDecimal(order.totalBase).mul(share),
        }
      })
    for (const allocation of allocationRows) {
      const key = `${periodKey}:${order.supplierId}:${allocation.categoryName}`
      let row = byKey.get(key)
      if (!row) {
        row = { period: periodKey, supplierId: order.supplierId, supplierName: order.supplier.name, categoryName: allocation.categoryName, poIds: new Set(), spendBase: new Prisma.Decimal(0) }
        byKey.set(key, row)
      }
      row.poIds.add(order.id)
      row.spendBase = row.spendBase.add(allocation.amount)
    }
  }
  const rows = [...byKey.values()].map<SpendReportRow>((row) => ({
    period: row.period,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    categoryName: row.categoryName,
    poCount: row.poIds.size,
    spendBase: moneyString(row.spendBase, baseCurrency),
  }))
  rows.sort((a, b) => a.period.localeCompare(b.period) || a.supplierName.localeCompare(b.supplierName) || a.categoryName.localeCompare(b.categoryName))
  const spendBase = orders.reduce((total, order) => total.add(toDecimal(order.totalBase)), new Prisma.Decimal(0))
  return generatedReport(rows, filters, window, generatedAt, {
    spendBase: moneyString(spendBase, baseCurrency),
    poCount: String(orders.length),
  }, [
    'Spend totals are reconciled to SUM(PurchaseOrder.totalBase) for POs with receivedAt in the period and a received terminal status; category rows allocate each PO total across line categories by line totalBase share.',
  ], options.paginate !== false)
}

export async function getLeadTimeReport(
  filters: PurchasingAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: PurchasingAnalyticsDeps } = {},
): Promise<PurchasingAnalyticsReport<LeadTimeReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const receipts = await loadReceipts(client, window)
  const supplierProducts = await client.supplierProduct.findMany({
    where: { leadTimeDays: { not: null } },
    select: { supplierId: true, productId: true, leadTimeDays: true },
    take: SOURCE_ROW_LIMIT + 1,
  }) as SupplierProductRow[]
  if (supplierProducts.length > SOURCE_ROW_LIMIT) throw new Error(`Supplier-product source rows exceed ${SOURCE_ROW_LIMIT.toLocaleString()}; narrow the filters and retry.`)
  const configuredByKey = new Map(supplierProducts.map((row) => [`${row.supplierId}:${row.productId}`, row.leadTimeDays]))

  type LeadAccumulator = {
    supplierId: string
    supplierName: string
    productId: string
    sku: string
    productName: string
    leadTimes: Prisma.Decimal[]
    latestReceiptAt: Date
  }
  const byKey = new Map<string, LeadAccumulator>()
  for (const receipt of receipts) {
    const sentAt = receipt.po.poSentAt ?? receipt.po.createdAt
    for (const line of receipt.lines) {
      const product = line.poLine.product
      const key = `${receipt.po.supplierId}:${line.poLine.productId}`
      let row = byKey.get(key)
      if (!row) {
        row = {
          supplierId: receipt.po.supplierId,
          supplierName: receipt.po.supplier.name,
          productId: line.poLine.productId,
          sku: product.sku,
          productName: product.name,
          leadTimes: [],
          latestReceiptAt: receipt.receivedAt,
        }
        byKey.set(key, row)
      }
      row.leadTimes.push(daysBetween(sentAt, receipt.receivedAt))
      if (receipt.receivedAt.getTime() > row.latestReceiptAt.getTime()) row.latestReceiptAt = receipt.receivedAt
    }
  }
  const rows = [...byKey.values()].map<LeadTimeReportRow>((row) => {
    const average = row.leadTimes.reduce((total, value) => total.add(value), new Prisma.Decimal(0)).div(row.leadTimes.length)
    return {
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      receiptCount: row.leadTimes.length,
      averageLeadTimeDays: daysString(average),
      p50LeadTimeDays: daysString(percentile(row.leadTimes, 50)),
      p95LeadTimeDays: daysString(percentile(row.leadTimes, 95)),
      configuredLeadTimeDays: configuredByKey.get(`${row.supplierId}:${row.productId}`)?.toString() ?? '',
      latestReceiptAt: row.latestReceiptAt.toISOString(),
    }
  })
  rows.sort((a, b) => toDecimal(b.p95LeadTimeDays).cmp(a.p95LeadTimeDays) || a.supplierName.localeCompare(b.supplierName) || a.sku.localeCompare(b.sku))
  return generatedReport(rows, filters, window, generatedAt, {
    supplierSkuPairs: String(rows.length),
    maxP95LeadTimeDays: rows[0]?.p95LeadTimeDays ?? '0',
  }, [
    'Lead time is PurchaseReceipt.receivedAt minus PurchaseOrder.poSentAt, falling back to PO createdAt when poSentAt is absent.',
    'The Reorder Planning report uses observed P95 lead time for a supplier/product when SupplierProduct.leadTimeDays is not configured.',
  ], options.paginate !== false)
}

export async function getObservedLeadTimeP95BySupplierProduct(
  options: { client?: Pick<PurchasingAnalyticsClient, 'purchaseReceipt'>; now?: () => Date; dateFrom?: Date; dateTo?: Date } = {},
): Promise<Map<string, number>> {
  const client = (options.client ?? db) as unknown as Pick<PurchasingAnalyticsClient, 'purchaseReceipt'>
  const generatedAt = options.now?.() ?? new Date()
  const window = {
    dateFrom: options.dateFrom ?? subtractDays(startOfUtcDay(generatedAt), 365),
    dateTo: options.dateTo ?? endOfUtcDay(generatedAt),
  }
  const receipts = await loadReceipts(client as PurchasingAnalyticsClient, window)
  const byKey = new Map<string, Prisma.Decimal[]>()
  for (const receipt of receipts) {
    const sentAt = receipt.po.poSentAt ?? receipt.po.createdAt
    for (const line of receipt.lines) {
      const key = `${receipt.po.supplierId}:${line.poLine.productId}`
      const values = byKey.get(key) ?? []
      values.push(daysBetween(sentAt, receipt.receivedAt))
      byKey.set(key, values)
    }
  }
  return new Map([...byKey.entries()].map(([key, values]) => [key, Number(daysString(percentile(values, 95)))]))
}
