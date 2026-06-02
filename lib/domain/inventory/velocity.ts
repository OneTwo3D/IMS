import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_ABC_A_CUTOFF = new Prisma.Decimal('0.8')
const DEFAULT_ABC_B_CUTOFF = new Prisma.Decimal('0.95')
const DEFAULT_AGING_BUCKETS: AgingBucketDefinition[] = [
  { label: '0-30', maxDays: 30 },
  { label: '31-60', maxDays: 60 },
  { label: '61-90', maxDays: 90 },
  { label: '90+', maxDays: null },
]

export type VelocityWindow = {
  dateFrom: string | Date
  dateTo: string | Date
}

export type VelocitySaleInput = {
  productId: string
  sku: string
  productName: string
  categoryName?: string | null
  supplierNames?: string[]
  qty: DecimalInput
  cogsBase?: DecimalInput
  revenueBase?: DecimalInput
  occurredAt: string | Date
}

export type DailyVelocityRow = {
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  supplierNames: string[]
  qtySold: string
  cogsBase: string
  revenueBase: string
  dailyQtyVelocity: string
  dailyCogsVelocity: string
  firstSaleAt: string | null
  lastSaleAt: string | null
}

export type VelocityQuartile = 'fast' | 'upper_mid' | 'lower_mid' | 'slow' | 'no_sales'

export type VelocityRankingRow = DailyVelocityRow & {
  rank: number
  quartile: VelocityQuartile
}

export type AbcBasis = 'cogs' | 'revenue'
export type AbcClass = 'A' | 'B' | 'C'

export type AbcOptions = {
  basis?: AbcBasis
  aCutoff?: DecimalInput
  bCutoff?: DecimalInput
}

export type AbcAnalysisRow = DailyVelocityRow & {
  abcClass: AbcClass
  basisValue: string
  contributionPct: string
  cumulativePct: string
}

export type InventoryPositionInput = {
  productId: string
  sku: string
  productName: string
  categoryName?: string | null
  supplierNames?: string[]
  qty: DecimalInput
  valueBase: DecimalInput
  firstStockedAt?: string | Date | null
}

export type DeadStockOptions = {
  asOf: string | Date
  thresholdDays: number
  excludeNeverSoldNewerThanThreshold?: boolean
}

export type DeadStockRow = {
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  supplierNames: string[]
  qty: string
  valueBase: string
  daysSinceLastSale: number | null
  lastSaleAt: string | null
  firstStockedAt: string | null
}

export type TurnoverInput = {
  cogsBase: DecimalInput
  averageInventoryValueBase: DecimalInput
  periodDays: number
}

export type TurnoverResult = {
  turnoverRatio: string | null
  daysInventoryOutstanding: string | null
}

export type AgingBucketDefinition = {
  label: string
  maxDays: number | null
}

export type AgingLayerInput = {
  productId: string
  sku: string
  productName: string
  categoryName?: string | null
  supplierNames?: string[]
  qty: DecimalInput
  valueBase: DecimalInput
  receivedAt: string | Date
}

export type AgingBucketRow = {
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  supplierNames: string[]
  bucket: string
  minAgeDays: number
  maxAgeDays: number | null
  qty: string
  valueBase: string
}

type MutableVelocityRow = {
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  supplierNames: string[]
  qtySold: Decimal
  cogsBase: Decimal
  revenueBase: Decimal
  firstSaleAt: Date | null
  lastSaleAt: Date | null
}

type MutableAgingRow = {
  productId: string
  sku: string
  productName: string
  categoryName: string | null
  supplierNames: string[]
  bucket: string
  minAgeDays: number
  maxAgeDays: number | null
  qty: Decimal
  valueBase: Decimal
}

function normalizeDate(value: string | Date, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label}: ${String(value)}`)
  }
  return date
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY_MS))
}

export function normalizeVelocityWindow(window: VelocityWindow): { dateFrom: Date; dateTo: Date; days: number } {
  const dateFrom = normalizeDate(window.dateFrom, 'dateFrom')
  const dateTo = normalizeDate(window.dateTo, 'dateTo')
  if (dateTo.getTime() < dateFrom.getTime()) {
    throw new Error('dateTo must be on or after dateFrom')
  }

  return {
    dateFrom,
    dateTo,
    days: Math.max(1, Math.ceil((dateTo.getTime() - dateFrom.getTime()) / DAY_MS)),
  }
}

export function calculateDailyVelocity(sales: VelocitySaleInput[], window: VelocityWindow): DailyVelocityRow[] {
  const { dateFrom, dateTo, days } = normalizeVelocityWindow(window)
  const rows = new Map<string, MutableVelocityRow>()

  for (const sale of sales) {
    const occurredAt = normalizeDate(sale.occurredAt, 'occurredAt')
    if (occurredAt.getTime() < dateFrom.getTime() || occurredAt.getTime() > dateTo.getTime()) continue

    const current = rows.get(sale.productId) ?? {
      productId: sale.productId,
      sku: sale.sku,
      productName: sale.productName,
      categoryName: sale.categoryName ?? null,
      supplierNames: sale.supplierNames ?? [],
      qtySold: new Prisma.Decimal(0),
      cogsBase: new Prisma.Decimal(0),
      revenueBase: new Prisma.Decimal(0),
      firstSaleAt: null,
      lastSaleAt: null,
    }
    current.qtySold = current.qtySold.add(toDecimal(sale.qty).abs())
    current.cogsBase = current.cogsBase.add(toDecimal(sale.cogsBase).abs())
    current.revenueBase = current.revenueBase.add(toDecimal(sale.revenueBase).abs())
    current.firstSaleAt = !current.firstSaleAt || occurredAt.getTime() < current.firstSaleAt.getTime()
      ? occurredAt
      : current.firstSaleAt
    current.lastSaleAt = !current.lastSaleAt || occurredAt.getTime() > current.lastSaleAt.getTime()
      ? occurredAt
      : current.lastSaleAt
    rows.set(sale.productId, current)
  }

  return [...rows.values()]
    .map((row) => ({
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      categoryName: row.categoryName,
      supplierNames: row.supplierNames,
      qtySold: roundQuantity(row.qtySold, 4).toString(),
      cogsBase: roundQuantity(row.cogsBase, 6).toString(),
      revenueBase: roundQuantity(row.revenueBase, 6).toString(),
      dailyQtyVelocity: roundQuantity(row.qtySold.div(days), 6).toString(),
      dailyCogsVelocity: roundQuantity(row.cogsBase.div(days), 6).toString(),
      firstSaleAt: iso(row.firstSaleAt),
      lastSaleAt: iso(row.lastSaleAt),
    }))
    .sort((a, b) => b.dailyQtyVelocity.localeCompare(a.dailyQtyVelocity, undefined, { numeric: true }) || a.sku.localeCompare(b.sku))
}

export function classifyVelocityQuartiles(rows: DailyVelocityRow[]): VelocityRankingRow[] {
  const ranked = [...rows].sort((a, b) => toDecimal(b.dailyQtyVelocity).cmp(toDecimal(a.dailyQtyVelocity)) || a.sku.localeCompare(b.sku))
  const activeCount = ranked.filter((row) => toDecimal(row.dailyQtyVelocity).gt(0)).length
  return ranked.map((row, index) => {
    const velocity = toDecimal(row.dailyQtyVelocity)
    let quartile: VelocityQuartile = 'no_sales'
    if (velocity.gt(0) && activeCount > 0) {
      const percentile = (index + 1) / activeCount
      quartile = percentile <= 0.25 ? 'fast' : percentile <= 0.5 ? 'upper_mid' : percentile <= 0.75 ? 'lower_mid' : 'slow'
    }
    return { ...row, rank: index + 1, quartile }
  })
}

export function calculateAbcAnalysis(rows: DailyVelocityRow[], options: AbcOptions = {}): AbcAnalysisRow[] {
  const basis = options.basis ?? 'cogs'
  const aCutoff = toDecimal(options.aCutoff ?? DEFAULT_ABC_A_CUTOFF)
  const bCutoff = toDecimal(options.bCutoff ?? DEFAULT_ABC_B_CUTOFF)
  if (aCutoff.lte(0) || bCutoff.lte(aCutoff) || bCutoff.gt(1)) {
    throw new Error('ABC cutoffs must satisfy 0 < A < B <= 1')
  }

  const valueFor = (row: DailyVelocityRow) => toDecimal(basis === 'cogs' ? row.cogsBase : row.revenueBase)
  const sorted = [...rows].sort((a, b) => valueFor(b).cmp(valueFor(a)) || a.sku.localeCompare(b.sku))
  const total = sorted.reduce((sum, row) => sum.add(valueFor(row)), new Prisma.Decimal(0))
  let cumulative = new Prisma.Decimal(0)

  return sorted.map((row) => {
    const basisValue = valueFor(row)
    const contribution = total.gt(0) ? basisValue.div(total) : new Prisma.Decimal(0)
    cumulative = cumulative.add(contribution)
    const abcClass: AbcClass = cumulative.lte(aCutoff) ? 'A' : cumulative.lte(bCutoff) ? 'B' : 'C'
    return {
      ...row,
      abcClass,
      basisValue: roundQuantity(basisValue, 6).toString(),
      contributionPct: roundQuantity(contribution.mul(100), 4).toString(),
      cumulativePct: roundQuantity(Prisma.Decimal.min(cumulative, 1).mul(100), 4).toString(),
    }
  })
}

export function calculateDeadStock(
  positions: InventoryPositionInput[],
  velocityRows: DailyVelocityRow[],
  options: DeadStockOptions,
): DeadStockRow[] {
  if (!Number.isInteger(options.thresholdDays) || options.thresholdDays <= 0) {
    throw new Error('thresholdDays must be a positive integer')
  }

  const asOf = normalizeDate(options.asOf, 'asOf')
  const velocityByProduct = new Map(velocityRows.map((row) => [row.productId, row]))
  const excludeNew = options.excludeNeverSoldNewerThanThreshold ?? true

  return positions.flatMap((position) => {
    const qty = toDecimal(position.qty)
    if (qty.lte(0)) return []

    const velocity = velocityByProduct.get(position.productId)
    const lastSaleAt = velocity?.lastSaleAt ? normalizeDate(velocity.lastSaleAt, 'lastSaleAt') : null
    const firstStockedAt = position.firstStockedAt ? normalizeDate(position.firstStockedAt, 'firstStockedAt') : null
    const daysSinceLastSale = lastSaleAt ? daysBetween(lastSaleAt, asOf) : null
    if (daysSinceLastSale != null && daysSinceLastSale < options.thresholdDays) return []
    if (daysSinceLastSale == null && excludeNew && firstStockedAt && daysBetween(firstStockedAt, asOf) < options.thresholdDays) return []

    return [{
      productId: position.productId,
      sku: position.sku,
      productName: position.productName,
      categoryName: position.categoryName ?? null,
      supplierNames: position.supplierNames ?? [],
      qty: roundQuantity(qty, 4).toString(),
      valueBase: roundQuantity(position.valueBase, 6).toString(),
      daysSinceLastSale,
      lastSaleAt: iso(lastSaleAt),
      firstStockedAt: iso(firstStockedAt),
    }]
  }).sort((a, b) => toDecimal(b.valueBase).cmp(toDecimal(a.valueBase)) || a.sku.localeCompare(b.sku))
}

export function calculateInventoryTurnover(input: TurnoverInput): TurnoverResult {
  if (!Number.isInteger(input.periodDays) || input.periodDays <= 0) {
    throw new Error('periodDays must be a positive integer')
  }

  const cogsBase = toDecimal(input.cogsBase)
  const averageInventoryValueBase = toDecimal(input.averageInventoryValueBase)
  if (averageInventoryValueBase.lte(0)) {
    return { turnoverRatio: null, daysInventoryOutstanding: null }
  }

  const turnoverRatio = cogsBase.div(averageInventoryValueBase)
  return {
    turnoverRatio: roundQuantity(turnoverRatio, 6).toString(),
    daysInventoryOutstanding: turnoverRatio.gt(0)
      ? roundQuantity(new Prisma.Decimal(input.periodDays).div(turnoverRatio), 2).toString()
      : null,
  }
}

export function bucketInventoryAging(
  layers: AgingLayerInput[],
  asOfInput: string | Date,
  buckets: AgingBucketDefinition[] = DEFAULT_AGING_BUCKETS,
): AgingBucketRow[] {
  const asOf = normalizeDate(asOfInput, 'asOf')
  const normalizedBuckets = buckets.map((bucket, index) => ({
    ...bucket,
    minAgeDays: index === 0 ? 0 : (buckets[index - 1]?.maxDays ?? 0) + 1,
  }))
  const rows = new Map<string, MutableAgingRow>()

  for (const layer of layers) {
    const qty = toDecimal(layer.qty)
    if (qty.lte(0)) continue

    const receivedAt = normalizeDate(layer.receivedAt, 'receivedAt')
    const ageDays = daysBetween(receivedAt, asOf)
    const bucket = normalizedBuckets.find((candidate) => candidate.maxDays == null || ageDays <= candidate.maxDays)
      ?? normalizedBuckets[normalizedBuckets.length - 1]
    if (!bucket) throw new Error('At least one aging bucket is required')

    const key = `${layer.productId}:${bucket.label}`
    const current = rows.get(key) ?? {
      productId: layer.productId,
      sku: layer.sku,
      productName: layer.productName,
      categoryName: layer.categoryName ?? null,
      supplierNames: layer.supplierNames ?? [],
      bucket: bucket.label,
      minAgeDays: bucket.minAgeDays,
      maxAgeDays: bucket.maxDays,
      qty: new Prisma.Decimal(0),
      valueBase: new Prisma.Decimal(0),
    }
    current.qty = current.qty.add(qty)
    current.valueBase = current.valueBase.add(toDecimal(layer.valueBase))
    rows.set(key, current)
  }

  return [...rows.values()]
    .map((row) => ({
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      categoryName: row.categoryName,
      supplierNames: row.supplierNames,
      bucket: row.bucket,
      minAgeDays: row.minAgeDays,
      maxAgeDays: row.maxAgeDays,
      qty: roundQuantity(row.qty, 4).toString(),
      valueBase: roundQuantity(row.valueBase, 6).toString(),
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku) || a.minAgeDays - b.minAgeDays)
}
