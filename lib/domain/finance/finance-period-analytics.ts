import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import { computeRealisedFx, type FxSettlementSide } from '@/lib/accounting-fx'
import { getAccountingSettings } from '@/lib/accounting'
import { db } from '@/lib/db'
import { roundMoney, roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'

const BASE_CURRENCY = 'GBP'
const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const DEFAULT_PERIOD_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

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

type SalesOrderLineTaxRow = {
  taxRateId: string | null
  taxForeign: DecimalInput
  taxBase: DecimalInput
  totalBase: DecimalInput
  order: {
    shippingAddress: unknown
  }
  taxRate: {
    name: string
    rate: DecimalInput
    accountingTaxType: string | null
    countryCode: string | null
  } | null
}

type SalesOrderAgingRow = {
  id: string
  customerId: string | null
  customerName: string | null
  customerEmail: string | null
  createdAt: Date
  invoicedAt: Date | null
  paidAt: Date | null
  totalBase: DecimalInput
  payments: Array<{ amount: DecimalInput; paidAt: Date; refundId: string | null }>
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

function period(filters: FinanceAnalyticsFilters, now: Date): { dateFrom: Date; dateTo: Date } {
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

function moneyString(value: DecimalInput): string {
  return roundMoney(value, BASE_CURRENCY).toString()
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
  return typeof country === 'string' && country.trim() ? country.trim().toUpperCase() : 'Unknown'
}

function bucketConfig(filters: FinanceAnalyticsFilters): [number, number, number] {
  const b1 = Number.isInteger(filters.bucket1Days) && (filters.bucket1Days ?? 0) > 0 ? filters.bucket1Days as number : 30
  const b2 = Number.isInteger(filters.bucket2Days) && (filters.bucket2Days ?? 0) > b1 ? filters.bucket2Days as number : 60
  const b3 = Number.isInteger(filters.bucket3Days) && (filters.bucket3Days ?? 0) > b2 ? filters.bucket3Days as number : 90
  return [b1, b2, b3]
}

function ageDays(asOf: Date, dueDate: Date): number {
  return Math.max(0, Math.floor((startOfUtcDay(asOf).getTime() - startOfUtcDay(dueDate).getTime()) / DAY_MS))
}

function bucketAmount(age: number, amount: Prisma.Decimal, buckets: [number, number, number]) {
  if (age <= 0) return { current: amount, bucket1: new Prisma.Decimal(0), bucket2: new Prisma.Decimal(0), bucket3: new Prisma.Decimal(0), bucket4: new Prisma.Decimal(0) }
  if (age <= buckets[0]) return { current: new Prisma.Decimal(0), bucket1: amount, bucket2: new Prisma.Decimal(0), bucket3: new Prisma.Decimal(0), bucket4: new Prisma.Decimal(0) }
  if (age <= buckets[1]) return { current: new Prisma.Decimal(0), bucket1: new Prisma.Decimal(0), bucket2: amount, bucket3: new Prisma.Decimal(0), bucket4: new Prisma.Decimal(0) }
  if (age <= buckets[2]) return { current: new Prisma.Decimal(0), bucket1: new Prisma.Decimal(0), bucket2: new Prisma.Decimal(0), bucket3: amount, bucket4: new Prisma.Decimal(0) }
  return { current: new Prisma.Decimal(0), bucket1: new Prisma.Decimal(0), bucket2: new Prisma.Decimal(0), bucket3: new Prisma.Decimal(0), bucket4: amount }
}

function latestRateToBase(rates: FxRateRow[], currency: string, asOf: Date, fallback: DecimalInput): Prisma.Decimal {
  if (currency === BASE_CURRENCY) return new Prisma.Decimal(1)
  const match = rates
    .filter((row) => row.toCurrency === currency && row.fetchedAt.getTime() <= asOf.getTime())
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
  const window = period(filters, generatedAt)
  const lines = await client.salesOrderLine.findMany({
    where: {
      order: {
        invoicedAt: { gte: window.dateFrom, lte: window.dateTo },
        status: { not: SalesOrderStatus.CANCELLED },
        archived: false,
      },
    },
    select: {
      taxRateId: true,
      taxForeign: true,
      taxBase: true,
      totalBase: true,
      order: { select: { shippingAddress: true } },
      taxRate: { select: { name: true, rate: true, accountingTaxType: true, countryCode: true } },
    },
  }) as SalesOrderLineTaxRow[]

  type Accumulator = {
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
  for (const line of lines) {
    const jurisdiction = line.taxRate?.countryCode ?? countryFromShippingAddress(line.order.shippingAddress)
    const ratePct = pctString(line.taxRate?.rate ?? 0)
    const key = `${line.taxRateId ?? 'none'}:${jurisdiction}`
    let row = byKey.get(key)
    if (!row) {
      row = {
        taxRateId: line.taxRateId,
        taxRateName: line.taxRate?.name ?? 'No tax rate',
        accountingTaxType: line.taxRate?.accountingTaxType ?? null,
        jurisdiction,
        ratePct,
        lineCount: 0,
        taxableBase: new Prisma.Decimal(0),
        taxBase: new Prisma.Decimal(0),
      }
      byKey.set(key, row)
    }
    row.lineCount += 1
    row.taxableBase = row.taxableBase.add(toDecimal(line.totalBase))
    row.taxBase = row.taxBase.add(toDecimal(line.taxBase))
  }
  const rows = [...byKey.values()].map<VatReportRow>((row) => ({
    taxRateId: row.taxRateId,
    taxRateName: row.taxRateName,
    accountingTaxType: row.accountingTaxType,
    jurisdiction: row.jurisdiction,
    ratePct: row.ratePct,
    lineCount: row.lineCount,
    taxableBase: moneyString(row.taxableBase),
    taxBase: moneyString(row.taxBase),
  }))
  rows.sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.taxRateName.localeCompare(b.taxRateName))
  const totals = rows.reduce((total, row) => ({
    taxableBase: total.taxableBase.add(row.taxableBase),
    taxBase: total.taxBase.add(row.taxBase),
  }), { taxableBase: new Prisma.Decimal(0), taxBase: new Prisma.Decimal(0) })
  return report(rows, filters, window, generatedAt, {
    taxableBase: moneyString(totals.taxableBase),
    taxBase: moneyString(totals.taxBase),
  }, [
    'VAT totals use SalesOrderLine.taxBase for sales orders invoiced in the period; cancelled and archived sales orders are excluded.',
    'Jurisdiction uses TaxRate.countryCode when configured, otherwise the sales order shipping address country.',
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
): AgingReportRow[] {
  return [...accumulators.values()].map((row) => ({
    partyId: row.partyId,
    partyName: row.partyName,
    contact: row.contact,
    documentCount: row.documentIds.size,
    current: moneyString(row.current),
    bucket1: moneyString(row.bucket1),
    bucket2: moneyString(row.bucket2),
    bucket3: moneyString(row.bucket3),
    bucket4: moneyString(row.bucket4),
    outstandingBase: moneyString(row.outstandingBase),
    lastPaymentDate: row.lastPaymentDate ? dateOnly(row.lastPaymentDate) : null,
  })).sort((a, b) => toDecimal(b.outstandingBase).cmp(toDecimal(a.outstandingBase)) || a.partyName.localeCompare(b.partyName))
}

export async function getArAgingReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<AgingReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const buckets = bucketConfig(filters)
  const orders = await client.salesOrder.findMany({
    where: {
      status: { not: SalesOrderStatus.CANCELLED },
      archived: false,
      OR: [{ paidAt: null }, { payments: { some: { refundId: null } } }],
    },
    select: {
      id: true,
      customerId: true,
      customerName: true,
      customerEmail: true,
      createdAt: true,
      invoicedAt: true,
      paidAt: true,
      totalBase: true,
      payments: { select: { amount: true, paidAt: true, refundId: true } },
    },
  }) as SalesOrderAgingRow[]

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
      .filter((payment) => payment.refundId == null)
      .reduce((total, payment) => total.add(toDecimal(payment.amount)), new Prisma.Decimal(0))
    const outstanding = Prisma.Decimal.max(new Prisma.Decimal(0), toDecimal(order.totalBase).sub(paidBase))
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
    const dueDate = order.invoicedAt ?? order.createdAt
    const bucket = bucketAmount(ageDays(generatedAt, dueDate), outstanding, buckets)
    row.current = row.current.add(bucket.current)
    row.bucket1 = row.bucket1.add(bucket.bucket1)
    row.bucket2 = row.bucket2.add(bucket.bucket2)
    row.bucket3 = row.bucket3.add(bucket.bucket3)
    row.bucket4 = row.bucket4.add(bucket.bucket4)
    row.outstandingBase = row.outstandingBase.add(outstanding)
    row.documentIds.add(order.id)
    const lastPayment = order.payments.filter((payment) => payment.refundId == null).sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())[0]
    if (lastPayment && (!row.lastPaymentDate || lastPayment.paidAt.getTime() > row.lastPaymentDate.getTime())) row.lastPaymentDate = lastPayment.paidAt
  }
  const rows = agingRowsFromAccumulators(byCustomer)
  const outstandingBase = rows.reduce((total, row) => total.add(row.outstandingBase), new Prisma.Decimal(0))
  return report(rows, filters, window, generatedAt, {
    outstandingBase: moneyString(outstandingBase),
    bucket1Days: String(buckets[0]),
    bucket2Days: String(buckets[1]),
    bucket3Days: String(buckets[2]),
  }, [
    'AR aging outstanding balance is SalesOrder.totalBase minus non-refund Payment.amount rows; due date is invoicedAt when present, otherwise createdAt.',
    `Bucket boundaries are configurable through bucket1Days/bucket2Days/bucket3Days and currently use ${buckets[0]}/${buckets[1]}/${buckets[2]} days.`,
  ], options.paginate !== false)
}

export async function getApAgingReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<AgingReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const buckets = bucketConfig(filters)
  const invoices = await client.purchaseInvoice.findMany({
    where: { paidAt: null },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      paidAt: true,
      totalBase: true,
      po: { select: { supplierId: true, supplier: { select: { name: true, email: true } } } },
    },
  }) as PurchaseInvoiceAgingRow[]
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
    const bucket = bucketAmount(ageDays(generatedAt, dueDate), outstanding, buckets)
    row.current = row.current.add(bucket.current)
    row.bucket1 = row.bucket1.add(bucket.bucket1)
    row.bucket2 = row.bucket2.add(bucket.bucket2)
    row.bucket3 = row.bucket3.add(bucket.bucket3)
    row.bucket4 = row.bucket4.add(bucket.bucket4)
    row.outstandingBase = row.outstandingBase.add(outstanding)
    row.documentIds.add(invoice.id)
  }
  const rows = agingRowsFromAccumulators(bySupplier)
  const outstandingBase = rows.reduce((total, row) => total.add(row.outstandingBase), new Prisma.Decimal(0))
  return report(rows, filters, window, generatedAt, {
    outstandingBase: moneyString(outstandingBase),
    bucket1Days: String(buckets[0]),
    bucket2Days: String(buckets[1]),
    bucket3Days: String(buckets[2]),
  }, [
    'AP aging treats PurchaseInvoice.totalBase as fully outstanding until PurchaseInvoice.paidAt is set because the schema does not store partial supplier payments.',
    `Bucket boundaries are configurable through bucket1Days/bucket2Days/bucket3Days and currently use ${buckets[0]}/${buckets[1]}/${buckets[2]} days.`,
  ], options.paginate !== false)
}

async function loadFxRates(client: FinanceAnalyticsClient, window: { dateTo: Date }): Promise<FxRateRow[]> {
  return client.fxRate.findMany({
    where: { fetchedAt: { lte: window.dateTo } },
    select: { toCurrency: true, rate: true, fetchedAt: true },
    orderBy: { fetchedAt: 'desc' },
  }) as Promise<FxRateRow[]>
}

export async function getFxGainLossReport(
  filters: FinanceAnalyticsFilters = {},
  options: { paginate?: boolean; deps?: FinanceAnalyticsDeps } = {},
): Promise<FinanceAnalyticsReport<FxGainLossReportRow>> {
  const client = clientFromDeps(options.deps)
  const generatedAt = nowFromDeps(options.deps)
  const window = period(filters, generatedAt)
  const settings = options.deps?.accountingSettings ? await options.deps.accountingSettings() : await getAccountingSettings()
  const [payments, purchaseInvoices, fxRates] = await Promise.all([
    client.payment.findMany({
      where: {
        refundId: null,
        currency: { not: BASE_CURRENCY },
        paidAt: { gte: window.dateFrom, lte: window.dateTo },
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
    }) as Promise<SalesPaymentFxRow[]>,
    client.purchaseInvoice.findMany({
      where: {
        paidAt: { gte: window.dateFrom, lte: window.dateTo },
        po: { currency: { not: BASE_CURRENCY } },
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
    }) as Promise<PurchaseInvoiceFxRow[]>,
    loadFxRates(client, window),
  ])

  const rows: FxGainLossReportRow[] = []
  for (const payment of payments) {
    const settlementRate = latestRateToBase(fxRates, payment.currency, payment.paidAt, payment.order.fxRateToBase)
    const result = computeRealisedFx({
      side: 'receivable',
      amountForeign: toDecimal(payment.amount).abs().toNumber(),
      bookedRateToBase: toDecimal(payment.order.fxRateToBase).toNumber(),
      settlementRateToBase: settlementRate.toNumber(),
    })
    rows.push({
      side: 'receivable',
      documentId: payment.order.id,
      reference: payment.order.invoiceNumber ?? payment.order.orderNumber ?? payment.order.id,
      partyName: payment.order.customerName ?? payment.order.customerEmail ?? 'Unknown customer',
      currency: payment.currency,
      paidAt: payment.paidAt.toISOString(),
      amountForeign: qtyString(toDecimal(payment.amount).abs()),
      bookedRateToBase: qtyString(payment.order.fxRateToBase),
      settlementRateToBase: qtyString(settlementRate),
      bookedBase: moneyString(result.bookedBase),
      settlementBase: moneyString(result.settlementBase),
      gainLossBase: moneyString(result.gainLossBase),
      outcome: result.outcome,
      controlAccount: settings.accountsReceivableAccount,
      fxGainLossAccount: settings.realisedFxGainLossAccount,
    })
  }
  for (const invoice of purchaseInvoices) {
    if (!invoice.paidAt) continue
    const settlementRate = latestRateToBase(fxRates, invoice.po.currency, invoice.paidAt, invoice.fxRateToBase)
    const result = computeRealisedFx({
      side: 'payable',
      amountForeign: toDecimal(invoice.totalForeign).abs().toNumber(),
      bookedRateToBase: toDecimal(invoice.fxRateToBase).toNumber(),
      settlementRateToBase: settlementRate.toNumber(),
    })
    rows.push({
      side: 'payable',
      documentId: invoice.id,
      reference: invoice.invoiceNumber ?? invoice.po.reference,
      partyName: invoice.po.supplier.name,
      currency: invoice.po.currency,
      paidAt: invoice.paidAt.toISOString(),
      amountForeign: qtyString(toDecimal(invoice.totalForeign).abs()),
      bookedRateToBase: qtyString(invoice.fxRateToBase),
      settlementRateToBase: qtyString(settlementRate),
      bookedBase: moneyString(result.bookedBase),
      settlementBase: moneyString(result.settlementBase),
      gainLossBase: moneyString(result.gainLossBase),
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
    gainLossBase: moneyString(totals.gainLossBase),
    gainsBase: moneyString(totals.gainsBase),
    lossesBase: moneyString(totals.lossesBase),
    rowCount: String(rows.length),
  }, [
    'FX gain/loss uses IMS FxRate semantics where rate means 1 GBP = foreign currency; base value is foreign amount divided by the rate, matching the Xero realised-FX posting helper.',
    'Settlement rate is the latest FxRate row on or before paidAt, falling back to the document booking rate when no settlement rate exists.',
    `Rows surface the configured realised FX account (${settings.realisedFxGainLossAccount || 'not configured'}) plus the AR/AP control account used by the Xero journal path.`,
  ], options.paginate !== false)
}
