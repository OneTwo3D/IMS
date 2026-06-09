import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import { computeRealisedFx, type FxSettlementSide } from '@/lib/accounting-fx'
import { getAccountingSettings } from '@/lib/accounting'
import { DEFAULT_BASE_CURRENCY, getBaseCurrencyCode } from '@/lib/base-currency'
import { db } from '@/lib/db'
import { roundMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly, defaultUtcDateWindow, exclusiveEndOfUtcDay, parseDateOnly, startOfUtcDay, utcCalendarDayDelta } from '@/lib/domain/math/date-window'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'
import { SourceScanTooLargeError, assertSourceLimit } from '@/lib/security/source-scan-error'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const SOURCE_ROW_LIMIT = 50000
const DEFAULT_PERIOD_DAYS = 30

type FindManyDelegate = {
  findMany(args?: unknown): Promise<unknown[]>
}

export type FinanceAnalyticsClient = {
  salesOrder: FindManyDelegate
  salesOrderLine: FindManyDelegate
  payment: FindManyDelegate
  purchaseInvoice: FindManyDelegate
  fxRate: FindManyDelegate
}

export type FinanceAnalyticsDeps = {
  client?: FinanceAnalyticsClient
  now?: () => Date
  accountingSettings?: () => Promise<{ accountsReceivableAccount: string; accountsPayableAccount: string; realisedFxGainLossAccount: string }>
  baseCurrency?: () => Promise<string>
}

export type FinanceAnalyticsFilters = {
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
  bucket1Days?: number
  bucket2Days?: number
  bucket3Days?: number
}

export type FinanceAnalyticsReport<Row> = {
  generatedAt: string
  dateFrom: string
  dateTo: string
  rows: Row[]
  pageInfo: PageInfo
  totals: Record<string, string>
  notices: string[]
}

export type VatReportRow = {
  side: 'sales' | 'purchases'
  taxRateId: string | null
  taxRateName: string
  accountingTaxType: string | null
  jurisdiction: string
  ratePct: string
  lineCount: number
  taxableBase: string
  taxBase: string
}

export type AgingReportRow = {
  partyId: string | null
  partyName: string
  contact: string | null
  documentCount: number
  current: string
  bucket1: string
  bucket2: string
  bucket3: string
  bucket4: string
  outstandingBase: string
  lastPaymentDate: string | null
}

export type FxGainLossReportRow = {
  side: FxSettlementSide
  settlementId: string
  documentId: string
  reference: string
  partyName: string
  currency: string
  paidAt: string
  amountForeign: string
  bookedRateToBase: string
  settlementRateToBase: string
  bookedBase: string
  settlementBase: string
  gainLossBase: string
  outcome: 'gain' | 'loss' | 'none'
  controlAccount: string
  fxGainLossAccount: string
}

export type CurrencySummaryReportRow = {
  currency: string
  salesDocumentCount: number
  salesForeign: string
  salesBase: string
  arOutstandingForeign: string
  arOutstandingBase: string
  purchaseDocumentCount: number
  purchasesForeign: string
  purchasesBase: string
  apOutstandingForeign: string
  apOutstandingBase: string
}

type SalesOrderLineTaxRow = {
  taxRateId: string | null
  taxForeign: DecimalInput
  taxBase: DecimalInput
  totalBase: DecimalInput
  order: {
    shippingAddress: unknown
    pricesIncludeVat: boolean
  }
  taxRate: {
    name: string
    rate: DecimalInput
    accountingTaxType: string | null
    countryCode: string | null
  } | null
}

type PurchaseInvoiceTaxRow = {
  invoiceDate: Date
  lines: Array<{
    qtyBilled: DecimalInput
    totalBase: DecimalInput
    poLine: {
      qty: DecimalInput
      taxRateId: string | null
      taxBase: DecimalInput
      taxRate: {
        name: string
        rate: DecimalInput
        accountingTaxType: string | null
        countryCode: string | null
      } | null
    } | null
  }>
  po: {
    supplier: {
      country: string | null
    } | null
  }
}

type SalesOrderAgingRow = {
  id: string
  customerId: string | null
  customerName: string | null
  customerEmail: string | null
  createdAt: Date
  invoicedAt: Date | null
  paymentDueAt: Date | null
  paidAt: Date | null
  totalBase: DecimalInput
  payments: Array<{ amount: DecimalInput; paidAt: Date; refundId: string | null }>
}

type SalesOrderCurrencyRow = {
  id: string
  currency: string
  totalForeign: DecimalInput
  totalBase: DecimalInput
  paidAt: Date | null
  payments: Array<{ amount: DecimalInput; currency: string; paidAt: Date; refundId: string | null }>
}

type PurchaseInvoiceAgingRow = {
  id: string
  invoiceNumber: string | null
  invoiceDate: Date
  dueDate: Date | null
  paidAt: Date | null
  totalBase: DecimalInput
  po: {
    supplierId: string
    supplier: { name: string; email: string | null }
  }
}

type PurchaseInvoiceCurrencyRow = {
  id: string
  paidAt: Date | null
  totalForeign: DecimalInput
  totalBase: DecimalInput
  po: { currency: string }
}

type SalesPaymentFxRow = {
  id: string
  amount: DecimalInput
  currency: string
  paidAt: Date
  refundId: string | null
  order: {
    id: string
    orderNumber: string | null
    invoiceNumber: string | null
    currency: string
    fxRateToBase: DecimalInput
    customerName: string | null
    customerEmail: string | null
  }
}

type PurchaseInvoiceFxRow = {
  id: string
  invoiceNumber: string | null
  invoiceDate: Date
  paidAt: Date | null
  totalForeign: DecimalInput
  fxRateToBase: DecimalInput
  po: {
    reference: string
    currency: string
    supplier: { name: string }
  }
}

type FxRateRow = {
  fromCurrency: string
  toCurrency: string
  rate: DecimalInput
  fetchedAt: Date
}

function clientFromDeps(deps?: FinanceAnalyticsDeps): FinanceAnalyticsClient {
  return (deps?.client ?? db) as unknown as FinanceAnalyticsClient
}

function nowFromDeps(deps?: FinanceAnalyticsDeps): Date {
  return deps?.now?.() ?? new Date()
}

async function baseCurrencyFromDeps(deps?: FinanceAnalyticsDeps): Promise<string> {
  if (deps?.baseCurrency) return deps.baseCurrency()
  return deps?.client ? DEFAULT_BASE_CURRENCY : getBaseCurrencyCode()
}

function period(filters: FinanceAnalyticsFilters, now: Date): { dateFrom: Date; dateTo: Date; dateToExclusive: Date } {
  const { dateFrom: defaultFrom, dateTo: defaultTo } = defaultUtcDateWindow(now, DEFAULT_PERIOD_DAYS)
  const dateTo = parseDateOnly(filters.dateTo, defaultTo, { endOfDay: true })
  const dateFrom = parseDateOnly(filters.dateFrom, defaultFrom)
  return dateFrom.getTime() <= dateTo.getTime()
    ? { dateFrom, dateTo, dateToExclusive: exclusiveEndOfUtcDay(dateTo) }
    : { dateFrom: startOfUtcDay(dateTo), dateTo, dateToExclusive: exclusiveEndOfUtcDay(dateTo) }
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

export function emptyFinanceAnalyticsReportForSourceLimit<Row>(
  filters: FinanceAnalyticsFilters,
  error: SourceScanTooLargeError,
  totals: Record<string, string>,
  now = new Date(),
): FinanceAnalyticsReport<Row> {
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

function paginate<T>(rows: T[], filters: FinanceAnalyticsFilters, enabled: boolean): { rows: T[]; pageInfo: PageInfo } {
  const pageSize = clampPageSize(filters.pageSize)
  const info = pageInfo(rows.length, filters.page, pageSize)
  if (!enabled) return { rows, pageInfo: { ...info, page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false } }
  const start = (info.page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), pageInfo: info }
}

function report<Row>(
  rows: Row[],
  filters: FinanceAnalyticsFilters,
  window: { dateFrom: Date; dateTo: Date },
  generatedAt: Date,
  totals: Record<string, string>,
  notices: string[],
  paginateRows: boolean,
): FinanceAnalyticsReport<Row> {
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

function moneyString(value: DecimalInput, currency = DEFAULT_BASE_CURRENCY): string {
  return roundMoney(value, currency).toString()
}

function qtyString(value: DecimalInput): string {
  return roundQuantity(value, 4).toString()
}

function pctString(value: DecimalInput): string {
  return roundQuantity(toDecimal(value).mul(100), 2).toString()
}

function countryFromShippingAddress(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Unknown'
  const record = value as Record<string, unknown>
  const country = record.country ?? record.countryCode ?? record.shippingCountry
  if (typeof country !== 'string' || !country.trim()) return 'Unknown'
  const normalized = country.trim().toUpperCase()
  const aliases: Record<string, string> = {
    UK: 'GB',
    GBR: 'GB',
    GREAT_BRITAIN: 'GB',
    'GREAT BRITAIN': 'GB',
    UNITED_KINGDOM: 'GB',
    'UNITED KINGDOM': 'GB',
  }
  return aliases[normalized] ?? normalized
}

function bucketConfig(filters: FinanceAnalyticsFilters): { buckets: [number, number, number]; notices: string[] } {
  const notices: string[] = []
  const b1 = Number.isInteger(filters.bucket1Days) && (filters.bucket1Days ?? 0) > 0 ? filters.bucket1Days as number : 30
  if (filters.bucket1Days != null && b1 !== filters.bucket1Days) notices.push('Invalid bucket1Days was ignored; bucket 1 must be a positive integer.')
  const b2 = Number.isInteger(filters.bucket2Days) && (filters.bucket2Days ?? 0) > b1 ? filters.bucket2Days as number : 60
  if (filters.bucket2Days != null && b2 !== filters.bucket2Days) notices.push('Invalid bucket2Days was ignored; bucket 2 must be greater than bucket 1.')
  const b3 = Number.isInteger(filters.bucket3Days) && (filters.bucket3Days ?? 0) > b2 ? filters.bucket3Days as number : 90
  if (filters.bucket3Days != null && b3 !== filters.bucket3Days) notices.push('Invalid bucket3Days was ignored; bucket 3 must be greater than bucket 2.')
  return { buckets: [b1, b2, b3], notices }
}

function ageDays(asOf: Date, dueDate: Date): number {
  return utcCalendarDayDelta(dueDate, asOf)
}

function bucketAmount(age: number, amount: Prisma.Decimal, buckets: [number, number, number]) {
  if (age <= 0) return { current: amount, bucket1: new Prisma.Decimal(0), bucket2: new Prisma.Decimal(0), bucket3: new Prisma.Decimal(0), bucket4: new Prisma.Decimal(0) }
  if (age <= buckets[0]) return { current: new Prisma.Decimal(0), bucket1: amount, bucket2: new Prisma.Decimal(0), bucket3: new Prisma.Decimal(0), bucket4: new Prisma.Decimal(0) }
  if (age <= buckets[1]) return { current: new Prisma.Decimal(0), bucket1: new Prisma.Decimal(0), bucket2: amount, bucket3: new Prisma.Decimal(0), bucket4: new Prisma.Decimal(0) }
  if (age <= buckets[2]) return { current: new Prisma.Decimal(0), bucket1: new Prisma.Decimal(0), bucket2: new Prisma.Decimal(0), bucket3: amount, bucket4: new Prisma.Decimal(0) }
  return { current: new Prisma.Decimal(0), bucket1: new Prisma.Decimal(0), bucket2: new Prisma.Decimal(0), bucket3: new Prisma.Decimal(0), bucket4: amount }
}

function latestRateToBase(rates: FxRateRow[], baseCurrency: string, currency: string, asOf: Date, fallback: DecimalInput): Prisma.Decimal {
  if (currency === baseCurrency) return new Prisma.Decimal(1)
  const match = rates
    .filter((row) => row.fromCurrency === baseCurrency && row.toCurrency === currency && row.fetchedAt.getTime() <= asOf.getTime())
    .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0]
  const value = match ? toDecimal(match.rate) : toDecimal(fallback)
  return value.gt(0) ? value : new Prisma.Decimal(1)
}

export async function getVatReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<VatReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const [salesLines, purchaseInvoices] = await Promise.all([
    client.salesOrderLine.findMany({
      where: {
        order: {
          invoicedAt: { gte: window.dateFrom, lt: window.dateToExclusive },
          status: { not: SalesOrderStatus.CANCELLED },
          archived: false,
        },
      },
      select: {
        taxRateId: true,
        taxForeign: true,
        taxBase: true,
        totalBase: true,
        order: { select: { shippingAddress: true, pricesIncludeVat: true } },
        taxRate: { select: { name: true, rate: true, accountingTaxType: true, countryCode: true } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<SalesOrderLineTaxRow[]>,
    client.purchaseInvoice.findMany({
      where: {
        invoiceDate: { gte: window.dateFrom, lt: window.dateToExclusive },
      },
      select: {
        invoiceDate: true,
        lines: {
          select: {
            qtyBilled: true,
            totalBase: true,
            poLine: {
              select: {
                qty: true,
                taxRateId: true,
                taxBase: true,
                taxRate: { select: { name: true, rate: true, accountingTaxType: true, countryCode: true } },
              },
            },
          },
        },
        po: { select: { supplier: { select: { country: true } } } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<PurchaseInvoiceTaxRow[]>,
  ])
  const purchaseLineCount = purchaseInvoices.reduce((sum, invoice) => sum + invoice.lines.length, 0)
  assertSourceLimit(salesLines.length + purchaseLineCount, SOURCE_ROW_LIMIT, 'VAT report source rows')

  type Accumulator = {
    side: 'sales' | 'purchases'
    taxRateId: string | null
    taxRateName: string
    accountingTaxType: string | null
    jurisdiction: string
    ratePct: string
    lineCount: number
    taxableBase: Prisma.Decimal
    taxBase: Prisma.Decimal
  }
  const byKey = new Map<string, Accumulator>()

  const getOrCreateRow = (params: {
    side: 'sales' | 'purchases'
    taxRateId: string | null
    taxRateName: string
    accountingTaxType: string | null
    jurisdiction: string
    ratePct: string
  }) => {
    const key = `${params.side}:${params.taxRateId ?? 'none'}:${params.jurisdiction}`
    let row = byKey.get(key)
    if (!row) {
      row = {
        ...params,
        lineCount: 0,
        taxableBase: new Prisma.Decimal(0),
        taxBase: new Prisma.Decimal(0),
      }
      byKey.set(key, row)
    }
    return row
  }

  for (const line of salesLines) {
    const jurisdiction = line.taxRate?.countryCode ?? countryFromShippingAddress(line.order.shippingAddress)
    const ratePct = pctString(line.taxRate?.rate ?? 0)
    const row = getOrCreateRow({
      side: 'sales',
      taxRateId: line.taxRateId,
      taxRateName: line.taxRate?.name ?? 'No tax rate',
      accountingTaxType: line.taxRate?.accountingTaxType ?? null,
      jurisdiction,
      ratePct,
    })
    row.lineCount += 1
    const taxableBase = line.order.pricesIncludeVat
      ? Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(line.totalBase).sub(toDecimal(line.taxBase)))
      : toDecimal(line.totalBase)
    row.taxableBase = row.taxableBase.add(taxableBase)
    row.taxBase = row.taxBase.add(toDecimal(line.taxBase))
  }

  for (const invoice of purchaseInvoices) {
    for (const line of invoice.lines) {
      const taxRate = line.poLine?.taxRate ?? null
      const poLineQty = toDecimal(line.poLine?.qty)
      const ratio = poLineQty.gt(0) ? toDecimal(line.qtyBilled).div(poLineQty) : new Prisma.Decimal(0)
      const taxBase = line.poLine ? toDecimal(line.poLine.taxBase).mul(ratio) : new Prisma.Decimal(0)
      const jurisdiction = taxRate?.countryCode ?? invoice.po.supplier?.country?.trim().toUpperCase() ?? 'Unknown'
      const row = getOrCreateRow({
        side: 'purchases',
        taxRateId: line.poLine?.taxRateId ?? null,
        taxRateName: taxRate?.name ?? 'No tax rate',
        accountingTaxType: taxRate?.accountingTaxType ?? null,
        jurisdiction,
        ratePct: pctString(taxRate?.rate ?? 0),
      })
      row.lineCount += 1
      row.taxableBase = row.taxableBase.add(toDecimal(line.totalBase))
      row.taxBase = row.taxBase.add(taxBase)
    }
  }

  const rows = [...byKey.values()].map<VatReportRow>((row) => ({
    side: row.side,
    taxRateId: row.taxRateId,
    taxRateName: row.taxRateName,
    accountingTaxType: row.accountingTaxType,
    jurisdiction: row.jurisdiction,
    ratePct: row.ratePct,
    lineCount: row.lineCount,
    taxableBase: moneyString(row.taxableBase, baseCurrency),
    taxBase: moneyString(row.taxBase, baseCurrency),
  }))
  rows.sort((a, b) => a.side.localeCompare(b.side) || a.jurisdiction.localeCompare(b.jurisdiction) || a.taxRateName.localeCompare(b.taxRateName))
  const totals = rows.reduce((total, row) => ({
    taxableBase: total.taxableBase.add(row.taxableBase),
    salesTaxBase: row.side === 'sales' ? total.salesTaxBase.add(row.taxBase) : total.salesTaxBase,
    purchaseTaxBase: row.side === 'purchases' ? total.purchaseTaxBase.add(row.taxBase) : total.purchaseTaxBase,
  }), { taxableBase: new Prisma.Decimal(0), salesTaxBase: new Prisma.Decimal(0), purchaseTaxBase: new Prisma.Decimal(0) })
  const netTaxBase = totals.salesTaxBase.sub(totals.purchaseTaxBase)
  return report(rows, filters, window, generatedAt, {
    taxableBase: moneyString(totals.taxableBase, baseCurrency),
    salesTaxBase: moneyString(totals.salesTaxBase, baseCurrency),
    purchaseTaxBase: moneyString(totals.purchaseTaxBase, baseCurrency),
    taxBase: moneyString(netTaxBase, baseCurrency),
  }, [
    'VAT totals use SalesOrderLine.taxBase for invoiced sales and proportional PurchaseOrderLine.taxBase for purchase invoice lines in the period; taxable base subtracts tax for tax-inclusive sales orders. Cancelled and archived sales orders are excluded.',
    'Jurisdiction uses TaxRate.countryCode when configured, otherwise the sales shipping country or supplier country.',
  ], options.paginate !== false)
}

function agingRowsFromAccumulators(
  accumulators: Map<string, {
    partyId: string | null
    partyName: string
    contact: string | null
    documentIds: Set<string>
    current: Prisma.Decimal
    bucket1: Prisma.Decimal
    bucket2: Prisma.Decimal
    bucket3: Prisma.Decimal
    bucket4: Prisma.Decimal
    outstandingBase: Prisma.Decimal
    lastPaymentDate: Date | null
  }>,
  baseCurrency: string,
): AgingReportRow[] {
  return [...accumulators.values()].map((row) => ({
    partyId: row.partyId,
    partyName: row.partyName,
    contact: row.contact,
    documentCount: row.documentIds.size,
    current: moneyString(row.current, baseCurrency),
    bucket1: moneyString(row.bucket1, baseCurrency),
    bucket2: moneyString(row.bucket2, baseCurrency),
    bucket3: moneyString(row.bucket3, baseCurrency),
    bucket4: moneyString(row.bucket4, baseCurrency),
    outstandingBase: moneyString(row.outstandingBase, baseCurrency),
    lastPaymentDate: row.lastPaymentDate ? dateOnly(row.lastPaymentDate) : null,
  })).sort((a, b) => toDecimal(b.outstandingBase).cmp(toDecimal(a.outstandingBase)) || a.partyName.localeCompare(b.partyName))
}

export async function getArAgingReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<AgingReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const bucketResult = bucketConfig(filters)
  const buckets = bucketResult.buckets
  const asOf = window.dateTo
  const asOfExclusive = window.dateToExclusive
  const orders = await client.salesOrder.findMany({
    where: {
      status: { not: SalesOrderStatus.CANCELLED },
      archived: false,
      OR: [
        { invoicedAt: { lt: asOfExclusive } },
        { invoicedAt: null, createdAt: { lt: asOfExclusive } },
      ],
      AND: [{ OR: [{ paidAt: null }, { paidAt: { gte: asOfExclusive } }, { payments: { some: { refundId: null, paidAt: { lt: asOfExclusive } } } }] }],
    },
    select: {
      id: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
      invoicedAt: true,
      paymentDueAt: true,
      paidAt: true,
      totalBase: true,
      payments: { select: { amount: true, paidAt: true, refundId: true } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as SalesOrderAgingRow[]
  assertSourceLimit(orders.length, SOURCE_ROW_LIMIT, 'AR aging source rows')

  const byCustomer = new Map<string, {
    partyId: string | null
    partyName: string
    contact: string | null
    documentIds: Set<string>
    current: Prisma.Decimal
    bucket1: Prisma.Decimal
    bucket2: Prisma.Decimal
    bucket3: Prisma.Decimal
    bucket4: Prisma.Decimal
    outstandingBase: Prisma.Decimal
    lastPaymentDate: Date | null
  }>()
  for (const order of orders) {
    const paidBase = order.payments
      .filter((payment) => payment.refundId == null && payment.paidAt.getTime() < asOfExclusive.getTime())
      .reduce((total, payment) => total.add(toDecimal(payment.amount)), new Prisma.Decimal(0))
    const refundedBase = order.payments
      .filter((payment) => payment.refundId != null && payment.paidAt.getTime() < asOfExclusive.getTime())
      .reduce((total, payment) => total.add(toDecimal(payment.amount).abs()), new Prisma.Decimal(0))
    const rawOutstanding = toDecimal(order.totalBase).sub(paidBase).sub(refundedBase)
    const outstanding = Prisma.Decimal.max(new Prisma.Decimal(0), rawOutstanding)
    if (outstanding.lte(0)) continue
    const key = order.customerId ?? order.customerEmail ?? order.customerName ?? 'unknown'
    let row = byCustomer.get(key)
    if (!row) {
      row = {
        partyId: order.customerId,
        partyName: order.customerName ?? order.customerEmail ?? 'Unknown customer',
        contact: order.customerEmail,
        documentIds: new Set(),
        current: new Prisma.Decimal(0),
        bucket1: new Prisma.Decimal(0),
        bucket2: new Prisma.Decimal(0),
        bucket3: new Prisma.Decimal(0),
        bucket4: new Prisma.Decimal(0),
        outstandingBase: new Prisma.Decimal(0),
        lastPaymentDate: null,
      }
      byCustomer.set(key, row)
    }
    const dueDate = order.paymentDueAt ?? order.invoicedAt ?? order.createdAt
    const bucket = bucketAmount(ageDays(asOf, dueDate), outstanding, buckets)
    row.current = row.current.add(bucket.current)
    row.bucket1 = row.bucket1.add(bucket.bucket1)
    row.bucket2 = row.bucket2.add(bucket.bucket2)
    row.bucket3 = row.bucket3.add(bucket.bucket3)
    row.bucket4 = row.bucket4.add(bucket.bucket4)
    row.outstandingBase = row.outstandingBase.add(outstanding)
    row.documentIds.add(order.id)
    const lastPayment = order.payments.filter((payment) => payment.refundId == null && payment.paidAt.getTime() < asOfExclusive.getTime()).sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())[0]
    if (lastPayment && (!row.lastPaymentDate || lastPayment.paidAt.getTime() > row.lastPaymentDate.getTime())) row.lastPaymentDate = lastPayment.paidAt
  }
  const rows = agingRowsFromAccumulators(byCustomer, baseCurrency)
  const outstandingBase = rows.reduce((total, row) => total.add(row.outstandingBase), new Prisma.Decimal(0))
  const creditBalanceBase = orders.reduce((total, order) => {
    const paidBase = order.payments
      .filter((payment) => payment.refundId == null && payment.paidAt.getTime() < asOfExclusive.getTime())
      .reduce((sum, payment) => sum.add(toDecimal(payment.amount)), new Prisma.Decimal(0))
    const refundedBase = order.payments
      .filter((payment) => payment.refundId != null && payment.paidAt.getTime() < asOfExclusive.getTime())
      .reduce((sum, payment) => sum.add(toDecimal(payment.amount).abs()), new Prisma.Decimal(0))
    const rawOutstanding = toDecimal(order.totalBase).sub(paidBase).sub(refundedBase)
    return rawOutstanding.lt(0) ? total.add(rawOutstanding.abs()) : total
  }, new Prisma.Decimal(0))
  return report(rows, filters, window, generatedAt, {
    outstandingBase: moneyString(outstandingBase, baseCurrency),
    creditBalanceBase: moneyString(creditBalanceBase, baseCurrency),
    bucket1Days: String(buckets[0]),
    bucket2Days: String(buckets[1]),
    bucket3Days: String(buckets[2]),
  }, [
    `AR aging is as of ${dateOnly(asOf)}. Outstanding balance is SalesOrder.totalBase minus non-refund payments and refund payments paid on or before that date; due date is paymentDueAt, falling back to invoicedAt and then createdAt.`,
    'Customer credit balances are excluded from aging buckets and surfaced in totals.creditBalanceBase.',
    `Bucket boundaries are configurable through bucket1Days/bucket2Days/bucket3Days and currently use ${buckets[0]}/${buckets[1]}/${buckets[2]} days.`,
    ...bucketResult.notices,
  ], options.paginate !== false)
}

export async function getApAgingReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<AgingReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const bucketResult = bucketConfig(filters)
  const buckets = bucketResult.buckets
  const asOf = window.dateTo
  const asOfExclusive = window.dateToExclusive
  const invoices = await client.purchaseInvoice.findMany({
    where: {
      invoiceDate: { lt: asOfExclusive },
      OR: [{ paidAt: null }, { paidAt: { gte: asOfExclusive } }],
    },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      paidAt: true,
      totalBase: true,
      po: { select: { supplierId: true, supplier: { select: { name: true, email: true } } } },
    },
    take: SOURCE_ROW_LIMIT + 1,
  }) as PurchaseInvoiceAgingRow[]
  assertSourceLimit(invoices.length, SOURCE_ROW_LIMIT, 'AP aging source rows')
  const bySupplier = new Map<string, {
    partyId: string | null
    partyName: string
    contact: string | null
    documentIds: Set<string>
    current: Prisma.Decimal
    bucket1: Prisma.Decimal
    bucket2: Prisma.Decimal
    bucket3: Prisma.Decimal
    bucket4: Prisma.Decimal
    outstandingBase: Prisma.Decimal
    lastPaymentDate: Date | null
  }>()
  for (const invoice of invoices) {
    const outstanding = toDecimal(invoice.totalBase)
    if (outstanding.lte(0)) continue
    const key = invoice.po.supplierId
    let row = bySupplier.get(key)
    if (!row) {
      row = {
        partyId: invoice.po.supplierId,
        partyName: invoice.po.supplier.name,
        contact: invoice.po.supplier.email,
        documentIds: new Set(),
        current: new Prisma.Decimal(0),
        bucket1: new Prisma.Decimal(0),
        bucket2: new Prisma.Decimal(0),
        bucket3: new Prisma.Decimal(0),
        bucket4: new Prisma.Decimal(0),
        outstandingBase: new Prisma.Decimal(0),
        lastPaymentDate: null,
      }
      bySupplier.set(key, row)
    }
    const dueDate = invoice.dueDate ?? invoice.invoiceDate
    const bucket = bucketAmount(ageDays(asOf, dueDate), outstanding, buckets)
    row.current = row.current.add(bucket.current)
    row.bucket1 = row.bucket1.add(bucket.bucket1)
    row.bucket2 = row.bucket2.add(bucket.bucket2)
    row.bucket3 = row.bucket3.add(bucket.bucket3)
    row.bucket4 = row.bucket4.add(bucket.bucket4)
    row.outstandingBase = row.outstandingBase.add(outstanding)
    row.documentIds.add(invoice.id)
  }
  const rows = agingRowsFromAccumulators(bySupplier, baseCurrency)
  const outstandingBase = rows.reduce((total, row) => total.add(row.outstandingBase), new Prisma.Decimal(0))
  return report(rows, filters, window, generatedAt, {
    outstandingBase: moneyString(outstandingBase, baseCurrency),
    bucket1Days: String(buckets[0]),
    bucket2Days: String(buckets[1]),
    bucket3Days: String(buckets[2]),
  }, [
    `AP aging is as of ${dateOnly(asOf)} and treats PurchaseInvoice.totalBase as fully outstanding until PurchaseInvoice.paidAt is set because the schema does not store partial supplier payments.`,
    `Bucket boundaries are configurable through bucket1Days/bucket2Days/bucket3Days and currently use ${buckets[0]}/${buckets[1]}/${buckets[2]} days.`,
    ...bucketResult.notices,
  ], options.paginate !== false)
}

export async function getCurrencySummaryReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<CurrencySummaryReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const [salesOrders, purchaseInvoices] = await Promise.all([
    client.salesOrder.findMany({
      where: {
        status: { not: SalesOrderStatus.CANCELLED },
        archived: false,
        invoicedAt: { gte: window.dateFrom, lt: window.dateToExclusive },
      },
      select: {
        id: true,
        currency: true,
        totalForeign: true,
        totalBase: true,
        paidAt: true,
        payments: { select: { amount: true, currency: true, paidAt: true, refundId: true } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<SalesOrderCurrencyRow[]>,
    client.purchaseInvoice.findMany({
      where: {
        invoiceDate: { gte: window.dateFrom, lt: window.dateToExclusive },
      },
      select: {
        id: true,
        paidAt: true,
        totalForeign: true,
        totalBase: true,
        po: { select: { currency: true } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<PurchaseInvoiceCurrencyRow[]>,
  ])
  assertSourceLimit(Math.max(salesOrders.length, purchaseInvoices.length), SOURCE_ROW_LIMIT, 'Currency summary source rows')

  const rowsByCurrency = new Map<string, {
    currency: string
    salesDocumentIds: Set<string>
    salesForeign: Prisma.Decimal
    salesBase: Prisma.Decimal
    arOutstandingForeign: Prisma.Decimal
    arOutstandingBase: Prisma.Decimal
    purchaseDocumentIds: Set<string>
    purchasesForeign: Prisma.Decimal
    purchasesBase: Prisma.Decimal
    apOutstandingForeign: Prisma.Decimal
    apOutstandingBase: Prisma.Decimal
  }>()

  const getRow = (currency: string) => {
    const normalized = currency.trim().toUpperCase() || baseCurrency
    let row = rowsByCurrency.get(normalized)
    if (!row) {
      row = {
        currency: normalized,
        salesDocumentIds: new Set(),
        salesForeign: new Prisma.Decimal(0),
        salesBase: new Prisma.Decimal(0),
        arOutstandingForeign: new Prisma.Decimal(0),
        arOutstandingBase: new Prisma.Decimal(0),
        purchaseDocumentIds: new Set(),
        purchasesForeign: new Prisma.Decimal(0),
        purchasesBase: new Prisma.Decimal(0),
        apOutstandingForeign: new Prisma.Decimal(0),
        apOutstandingBase: new Prisma.Decimal(0),
      }
      rowsByCurrency.set(normalized, row)
    }
    return row
  }

  for (const order of salesOrders) {
    const row = getRow(order.currency)
    row.salesDocumentIds.add(order.id)
    const totalForeign = toDecimal(order.totalForeign)
    const totalBase = toDecimal(order.totalBase)
    row.salesForeign = row.salesForeign.add(totalForeign)
    row.salesBase = row.salesBase.add(totalBase)
    const paidForeign = order.payments
      .filter((payment) => payment.refundId == null && payment.currency === row.currency)
      .reduce((sum, payment) => sum.add(toDecimal(payment.amount)), new Prisma.Decimal(0))
    const outstandingForeign = Prisma.Decimal.max(new Prisma.Decimal(0), totalForeign.sub(paidForeign))
    if (!order.paidAt && outstandingForeign.gt(0)) {
      row.arOutstandingForeign = row.arOutstandingForeign.add(outstandingForeign)
      row.arOutstandingBase = row.arOutstandingBase.add(
        totalForeign.gt(0) ? totalBase.mul(outstandingForeign).div(totalForeign) : new Prisma.Decimal(0),
      )
    }
  }

  for (const invoice of purchaseInvoices) {
    const row = getRow(invoice.po.currency)
    row.purchaseDocumentIds.add(invoice.id)
    const totalForeign = toDecimal(invoice.totalForeign)
    const totalBase = toDecimal(invoice.totalBase)
    row.purchasesForeign = row.purchasesForeign.add(totalForeign)
    row.purchasesBase = row.purchasesBase.add(totalBase)
    if (!invoice.paidAt) {
      row.apOutstandingForeign = row.apOutstandingForeign.add(totalForeign)
      row.apOutstandingBase = row.apOutstandingBase.add(totalBase)
    }
  }

  const rows = [...rowsByCurrency.values()].map<CurrencySummaryReportRow>((row) => ({
    currency: row.currency,
    salesDocumentCount: row.salesDocumentIds.size,
    salesForeign: moneyString(row.salesForeign, row.currency),
    salesBase: moneyString(row.salesBase, baseCurrency),
    arOutstandingForeign: moneyString(row.arOutstandingForeign, row.currency),
    arOutstandingBase: moneyString(row.arOutstandingBase, baseCurrency),
    purchaseDocumentCount: row.purchaseDocumentIds.size,
    purchasesForeign: moneyString(row.purchasesForeign, row.currency),
    purchasesBase: moneyString(row.purchasesBase, baseCurrency),
    apOutstandingForeign: moneyString(row.apOutstandingForeign, row.currency),
    apOutstandingBase: moneyString(row.apOutstandingBase, baseCurrency),
  })).sort((a, b) => a.currency.localeCompare(b.currency))

  const totals = rows.reduce((total, row) => ({
    salesBase: total.salesBase.add(row.salesBase),
    arOutstandingBase: total.arOutstandingBase.add(row.arOutstandingBase),
    purchasesBase: total.purchasesBase.add(row.purchasesBase),
    apOutstandingBase: total.apOutstandingBase.add(row.apOutstandingBase),
  }), {
    salesBase: new Prisma.Decimal(0),
    arOutstandingBase: new Prisma.Decimal(0),
    purchasesBase: new Prisma.Decimal(0),
    apOutstandingBase: new Prisma.Decimal(0),
  })

  return report(rows, filters, window, generatedAt, {
    salesBase: moneyString(totals.salesBase, baseCurrency),
    arOutstandingBase: moneyString(totals.arOutstandingBase, baseCurrency),
    purchasesBase: moneyString(totals.purchasesBase, baseCurrency),
    apOutstandingBase: moneyString(totals.apOutstandingBase, baseCurrency),
  }, [
    'Currency summary groups invoiced sales orders and purchase invoices by their document currency, preserving foreign-currency totals alongside base equivalents.',
    'AR outstanding is estimated per sales order from same-currency non-refund payments; AP outstanding is full invoice value until PurchaseInvoice.paidAt because supplier partial payments are not modelled.',
  ], options.paginate !== false)
}

async function loadFxRates(client: FinanceAnalyticsClient, baseCurrency: string, window: { dateToExclusive: Date }): Promise<FxRateRow[]> {
  return client.fxRate.findMany({
    where: { fromCurrency: baseCurrency, fetchedAt: { lt: window.dateToExclusive } },
    select: { fromCurrency: true, toCurrency: true, rate: true, fetchedAt: true },
    orderBy: { fetchedAt: 'desc' },
    take: SOURCE_ROW_LIMIT + 1,
  }) as Promise<FxRateRow[]>
}

export async function getFxGainLossReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<FxGainLossReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const baseCurrency = await baseCurrencyFromDeps(options.deps)
  const settings = options.deps?.accountingSettings ? await options.deps.accountingSettings() : await getAccountingSettings()
  const [payments, purchaseInvoices, fxRates] = await Promise.all([
    client.payment.findMany({
      where: {
        refundId: null,
        currency: { not: baseCurrency },
        paidAt: { gte: window.dateFrom, lt: window.dateToExclusive },
      },
      select: {
        id: true,
        amount: true,
        currency: true,
        paidAt: true,
        refundId: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            invoiceNumber: true,
            currency: true,
            fxRateToBase: true,
            customerName: true,
            customerEmail: true,
          },
        },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<SalesPaymentFxRow[]>,
    client.purchaseInvoice.findMany({
      where: {
        paidAt: { gte: window.dateFrom, lt: window.dateToExclusive },
        po: { currency: { not: baseCurrency } },
      },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        paidAt: true,
        totalForeign: true,
        fxRateToBase: true,
        po: { select: { reference: true, currency: true, supplier: { select: { name: true } } } },
      },
      take: SOURCE_ROW_LIMIT + 1,
    }) as Promise<PurchaseInvoiceFxRow[]>,
    loadFxRates(client, baseCurrency, window),
  ])
  assertSourceLimit(Math.max(payments.length, purchaseInvoices.length, fxRates.length), SOURCE_ROW_LIMIT, 'FX gain/loss source rows')

  const rows: FxGainLossReportRow[] = []
  for (const payment of payments) {
    const settlementRate = latestRateToBase(fxRates, baseCurrency, payment.currency, payment.paidAt, payment.order.fxRateToBase)
    const result = computeRealisedFx({
      side: 'receivable',
      amountForeign: toDecimal(payment.amount).abs().toNumber(),
      bookedRateToBase: toDecimal(payment.order.fxRateToBase).toNumber(),
      settlementRateToBase: settlementRate.toNumber(),
    })
    rows.push({
      side: 'receivable',
      settlementId: payment.id,
      documentId: payment.order.id,
      reference: payment.order.invoiceNumber ?? payment.order.orderNumber ?? payment.order.id,
      partyName: payment.order.customerName ?? payment.order.customerEmail ?? 'Unknown customer',
      currency: payment.currency,
      paidAt: payment.paidAt.toISOString(),
      amountForeign: qtyString(toDecimal(payment.amount).abs()),
      bookedRateToBase: qtyString(payment.order.fxRateToBase),
      settlementRateToBase: qtyString(settlementRate),
      bookedBase: moneyString(result.bookedBase, baseCurrency),
      settlementBase: moneyString(result.settlementBase, baseCurrency),
      gainLossBase: moneyString(result.gainLossBase, baseCurrency),
      outcome: result.outcome,
      controlAccount: settings.accountsReceivableAccount,
      fxGainLossAccount: settings.realisedFxGainLossAccount,
    })
  }
  for (const invoice of purchaseInvoices) {
    if (!invoice.paidAt) continue
    const settlementRate = latestRateToBase(fxRates, baseCurrency, invoice.po.currency, invoice.paidAt, invoice.fxRateToBase)
    const result = computeRealisedFx({
      side: 'payable',
      amountForeign: toDecimal(invoice.totalForeign).abs().toNumber(),
      bookedRateToBase: toDecimal(invoice.fxRateToBase).toNumber(),
      settlementRateToBase: settlementRate.toNumber(),
    })
    rows.push({
      side: 'payable',
      settlementId: invoice.id,
      documentId: invoice.id,
      reference: invoice.invoiceNumber ?? invoice.po.reference,
      partyName: invoice.po.supplier.name,
      currency: invoice.po.currency,
      paidAt: invoice.paidAt.toISOString(),
      amountForeign: qtyString(toDecimal(invoice.totalForeign).abs()),
      bookedRateToBase: qtyString(invoice.fxRateToBase),
      settlementRateToBase: qtyString(settlementRate),
      bookedBase: moneyString(result.bookedBase, baseCurrency),
      settlementBase: moneyString(result.settlementBase, baseCurrency),
      gainLossBase: moneyString(result.gainLossBase, baseCurrency),
      outcome: result.outcome,
      controlAccount: settings.accountsPayableAccount,
      fxGainLossAccount: settings.realisedFxGainLossAccount,
    })
  }
  rows.sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.reference.localeCompare(b.reference))
  const totals = rows.reduce((total, row) => {
    const value = toDecimal(row.gainLossBase)
    return {
      gainLossBase: total.gainLossBase.add(value),
      gainsBase: total.gainsBase.add(value.gt(0) ? value : 0),
      lossesBase: total.lossesBase.add(value.lt(0) ? value.abs() : 0),
    }
  }, { gainLossBase: new Prisma.Decimal(0), gainsBase: new Prisma.Decimal(0), lossesBase: new Prisma.Decimal(0) })
  return report(rows, filters, window, generatedAt, {
    gainLossBase: moneyString(totals.gainLossBase, baseCurrency),
    gainsBase: moneyString(totals.gainsBase, baseCurrency),
    lossesBase: moneyString(totals.lossesBase, baseCurrency),
    rowCount: String(rows.length),
  }, [
    `FX gain/loss uses IMS FxRate semantics where rate means 1 ${baseCurrency} = foreign currency; base value is foreign amount divided by the rate, matching the Xero realised-FX posting helper.`,
    'Receivable FX rows are one row per Payment.id so partial settlements keep their own paidAt settlement rate; purchase-invoice rows remain one row per paid invoice because supplier partial payments are not modelled.',
    'Base-currency settlements are excluded from FX rows because they have no FX exposure; rowCount is therefore foreign-currency settlement count, not total settlement count.',
    'Settlement rate is the latest FxRate row on or before paidAt, falling back to the document booking rate when no settlement rate exists.',
    `Rows surface the configured realised FX account (${settings.realisedFxGainLossAccount || 'not configured'}) plus the AR/AP control account used by the Xero journal path.`,
  ], options.paginate !== false)
}
