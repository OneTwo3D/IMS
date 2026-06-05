import { Prisma, StockCountStatus, StockMovementType, StockTransferStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const TRANSFER_OVERDUE_DAYS = 7

const ZERO = new Prisma.Decimal(0)
const STOCK_MOVEMENT_TYPES = new Set(Object.values(StockMovementType))
const STOCK_TRANSFER_STATUSES = new Set(Object.values(StockTransferStatus))
const STOCK_COUNT_STATUSES = new Set(Object.values(StockCountStatus))

const OUTBOUND_MOVEMENT_TYPES = new Set<StockMovementType>([
  'SALE_DISPATCH',
  'TRANSFER_OUT',
  'PURCHASE_REVERSAL',
  'PRODUCTION_OUT',
  'KIT_ASSEMBLY_OUT',
])

const INBOUND_MOVEMENT_TYPES = new Set<StockMovementType>([
  'PURCHASE_RECEIPT',
  'WMS_RECEIPT_RECONCILIATION',
  'RETURN_INBOUND',
  'TRANSFER_IN',
  'PRODUCTION_IN',
  'KIT_ASSEMBLY_IN',
  'OPENING_STOCK',
])

export type InventoryLedgerFilters = {
  dateFrom?: string
  dateTo?: string
  warehouseId?: string
  product?: string
  type?: StockMovementType
  status?: string
  reference?: string
  minValue?: string
  page?: number
  pageSize?: number
}

export type InventoryLedgerExportReportType = 'stock-movements' | 'stock-adjustments' | 'transfers' | 'stock-counts'

export type InventoryLedgerSearchParams = Record<string, string | string[] | undefined>
export type InventoryLedgerFilterUiValues = {
  dateFrom?: string
  dateTo?: string
  warehouseId?: string
  product?: string
  type?: string
  status?: string
  reference?: string
  minValue?: string
  pageSize?: string
}

type InventoryLedgerFilterParseOptions = {
  includeType?: boolean
  includeStatus?: boolean
  includeMinValue?: boolean
}

type InventoryLedgerReportClient = Pick<typeof db, 'stockMovement' | 'adjustmentReason' | 'product' | 'stockTransfer' | 'stockTransferLine' | 'stockCount' | 'stockCountLine'>

type InventoryLedgerReportOptions = {
  paginate?: boolean
  client?: InventoryLedgerReportClient
}

export type InventoryLedgerSummary = Array<{ label: string; value: string; tone?: 'default' | 'warning' | 'danger' }>

export type InventoryLedgerReportRow = {
  id: string
  createdAt: string
  type: StockMovementType
  productId: string
  sku: string
  productName: string
  stockUnit: string
  warehouseCode: string
  warehouseName: string
  direction: 'in' | 'out' | 'neutral'
  qty: string
  signedQty: string
  unitCostBase: string | null
  totalValueBase: string
  signedValueBase: string
  referenceType: string | null
  referenceId: string | null
  referenceLabel: string
  referenceHref: string | null
  note: string | null
}

export type InventoryLedgerReport = {
  rows: InventoryLedgerReportRow[]
  pageInfo: PageInfo
  dateFrom: string | null
  dateTo: string | null
  totals: {
    openingQty: string
    movementQty: string
    closingQty: string
    openingValueBase: string
    movementValueBase: string
    closingValueBase: string
  }
  generatedAt: string
}

export type StockAdjustmentReportRow = InventoryLedgerReportRow & {
  reasonName: string
  reasonMatched: boolean
}

export type StockAdjustmentReport = Omit<InventoryLedgerReport, 'rows'> & {
  rows: StockAdjustmentReportRow[]
  reasonSummary: Array<{ reasonName: string; count: number; qty: string; valueBase: string }>
  userSummary: Array<{ userName: string; count: number; valueBase: string; captured: boolean }>
  skuSummary: Array<{ sku: string; productName: string; count: number; qty: string; valueBase: string }>
}

export type StockTransferReportRow = {
  id: string
  reference: string
  status: StockTransferStatus
  fromWarehouseCode: string
  fromWarehouseName: string
  toWarehouseCode: string
  toWarehouseName: string
  dispatchedAt: string | null
  completedAt: string | null
  createdAt: string
  daysInTransit: number
  overdue: boolean
  lineCount: number
  requestedQty: string
  receivedQty: string
  driftQty: string
  movementOutQty: string
  movementInQty: string
  movementValueBase: string
  href: string
}

export type StockTransferReport = {
  rows: StockTransferReportRow[]
  pageInfo: PageInfo
  totals: {
    requestedQty: string
    receivedQty: string
    driftQty: string
    inTransitCount: number
    overdueCount: number
    movementValueBase: string
  }
  generatedAt: string
}

export type StockCountReportRow = {
  id: string
  countId: string
  reference: string
  status: StockCountStatus
  warehouseCode: string
  warehouseName: string
  sku: string
  productId: string
  expectedQty: string
  countedQty: string | null
  varianceQty: string
  linkedAdjustmentValueBase: string | null
  adjustmentEvidence: 'linked' | 'missing'
  completedAt: string | null
  createdAt: string
}

export type StockCountReport = {
  rows: StockCountReportRow[]
  pageInfo: PageInfo
  totals: {
    expectedQty: string
    countedQty: string
    varianceQty: string
    linkedAdjustmentValueBase: string
    missingAdjustmentEvidenceRows: number
    repeatOffenderSkus: number
  }
  repeatOffenders: Array<{ sku: string; count: number; varianceQty: string }>
  generatedAt: string
}

export type MovementEvidence = {
  type: StockMovementType
  qty: Decimal
  totalValueBase: Decimal | null
  fromWarehouseId: string | null
  toWarehouseId: string | null
}

function pageInfo(totalRows: number, page: number, pageSize: number): PageInfo {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  return {
    page: safePage,
    pageSize,
    totalRows,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPreviousPage: safePage > 1,
  }
}

function clampPage(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 1
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.floor(value!)))
}

function oneSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function inventoryLedgerFiltersFromSearch(
  searchParams: InventoryLedgerSearchParams,
  options: InventoryLedgerFilterParseOptions = {},
): InventoryLedgerFilters {
  return {
    dateFrom: oneSearchParam(searchParams.dateFrom),
    dateTo: oneSearchParam(searchParams.dateTo),
    warehouseId: oneSearchParam(searchParams.warehouseId),
    product: oneSearchParam(searchParams.product),
    type: options.includeType ? oneSearchParam(searchParams.type) as InventoryLedgerFilters['type'] : undefined,
    status: options.includeStatus ? oneSearchParam(searchParams.status) : undefined,
    reference: oneSearchParam(searchParams.reference),
    minValue: options.includeMinValue ? oneSearchParam(searchParams.minValue) : undefined,
    page: Number(oneSearchParam(searchParams.page) ?? 1),
    pageSize: Number(oneSearchParam(searchParams.pageSize) ?? 100),
  }
}

export function inventoryLedgerFiltersForUi(
  filters: InventoryLedgerFilters,
  options: InventoryLedgerFilterParseOptions = {},
): InventoryLedgerFilterUiValues {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    warehouseId: filters.warehouseId,
    product: filters.product,
    type: options.includeType ? filters.type : undefined,
    status: options.includeStatus ? filters.status : undefined,
    reference: filters.reference,
    minValue: options.includeMinValue ? filters.minValue : undefined,
    pageSize: String(filters.pageSize ?? 100),
  }
}

function parseDateOnly(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0, 0))
}

function endOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 23, 59, 59, 999))
}

function normalizeTextFilter(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 100) : undefined
}

function normalizeMovementType(value: StockMovementType | undefined): StockMovementType | undefined {
  return value && STOCK_MOVEMENT_TYPES.has(value) ? value : undefined
}

function normalizeTransferStatus(value: string | undefined): StockTransferStatus | undefined {
  return value && STOCK_TRANSFER_STATUSES.has(value as StockTransferStatus) ? value as StockTransferStatus : undefined
}

function normalizeCountStatus(value: string | undefined): StockCountStatus | undefined {
  return value && STOCK_COUNT_STATUSES.has(value as StockCountStatus) ? value as StockCountStatus : undefined
}

function decimalString(value: Decimal, places = 4): string {
  return roundQuantity(value, places).toString()
}

function moneyString(value: Decimal): string {
  return roundQuantity(value, 6).toString()
}

export function signedMovementQty(row: MovementEvidence): Decimal {
  const qty = toDecimal(row.qty)
  if (row.type === 'ADJUSTMENT') {
    if (row.fromWarehouseId && !row.toWarehouseId) return qty.negated()
    // If a defensive or migration row carries both sides, treat the destination
    // side as authoritative so the row stays visible in ledger totals.
    if (row.toWarehouseId) return qty
    return ZERO
  }
  if (OUTBOUND_MOVEMENT_TYPES.has(row.type)) return qty.negated()
  if (INBOUND_MOVEMENT_TYPES.has(row.type)) return qty
  return ZERO
}

export function signedMovementValue(row: MovementEvidence): Decimal {
  const value = row.totalValueBase == null ? ZERO : toDecimal(row.totalValueBase)
  const signedQty = signedMovementQty(row)
  if (signedQty.lt(0)) return value.negated()
  if (signedQty.gt(0)) return value
  return ZERO
}

export function movementDirection(row: MovementEvidence): 'in' | 'out' | 'neutral' {
  const signed = signedMovementQty(row)
  if (signed.gt(0)) return 'in'
  if (signed.lt(0)) return 'out'
  return 'neutral'
}

export function inventoryLedgerReferenceHref(referenceType: string | null, referenceId: string | null): string | null {
  if (!referenceType || !referenceId) return null
  switch (referenceType) {
    case 'PurchaseOrder':
      return `/purchase-orders/${referenceId}`
    case 'SalesOrder':
      return `/sales/${referenceId}`
    case 'StockTransfer':
      return null
    case 'ProductionOrder':
      return `/manufacturing/${referenceId}`
    case 'StockMovement':
      return null
    case 'StockCount':
      return null
    default:
      return null
  }
}

function dateRangeWhere(filters: Pick<InventoryLedgerFilters, 'dateFrom' | 'dateTo'>): Prisma.DateTimeFilter | undefined {
  const from = parseDateOnly(filters.dateFrom)
  const to = parseDateOnly(filters.dateTo)
  if (!from && !to) return undefined
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: endOfUtcDay(to) } : {}),
  }
}

function movementWhere(filters: InventoryLedgerFilters, dateOverride?: Prisma.DateTimeFilter): Prisma.StockMovementWhereInput {
  const and: Prisma.StockMovementWhereInput[] = []
  const product = normalizeTextFilter(filters.product)
  const reference = normalizeTextFilter(filters.reference)
  const type = normalizeMovementType(filters.type)
  const minValue = filters.minValue && Number.isFinite(Number(filters.minValue)) ? Number(filters.minValue) : null
  const createdAt = dateOverride ?? dateRangeWhere(filters)

  if (createdAt) and.push({ createdAt })
  if (filters.warehouseId) {
    and.push({ OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] })
  }
  if (product) {
    and.push({
      product: {
        OR: [
          { sku: { contains: product, mode: 'insensitive' } },
          { name: { contains: product, mode: 'insensitive' } },
        ],
      },
    })
  }
  if (type) and.push({ type })
  if (reference) {
    and.push({
      OR: [
        { referenceType: { contains: reference, mode: 'insensitive' } },
        { referenceId: { contains: reference, mode: 'insensitive' } },
        { note: { contains: reference, mode: 'insensitive' } },
      ],
    })
  }
  if (minValue != null && minValue >= 0) {
    and.push({ totalValueBase: { gte: minValue } })
  }

  return and.length ? { AND: and } : {}
}

function combineWhere(...parts: Prisma.StockMovementWhereInput[]): Prisma.StockMovementWhereInput {
  const filtered = parts.filter((part) => Object.keys(part).length > 0)
  if (filtered.length === 0) return {}
  if (filtered.length === 1) return filtered[0]!
  return { AND: filtered }
}

function positiveMovementWhere(where: Prisma.StockMovementWhereInput): Prisma.StockMovementWhereInput {
  return combineWhere(where, {
    OR: [
      { type: { in: [...INBOUND_MOVEMENT_TYPES] } },
      { type: 'ADJUSTMENT', toWarehouseId: { not: null } },
    ],
  })
}

function negativeMovementWhere(where: Prisma.StockMovementWhereInput): Prisma.StockMovementWhereInput {
  return combineWhere(where, {
    OR: [
      { type: { in: [...OUTBOUND_MOVEMENT_TYPES] } },
      { type: 'ADJUSTMENT', fromWarehouseId: { not: null }, toWarehouseId: null },
    ],
  })
}

async function movementTotals(
  client: InventoryLedgerReportClient,
  where: Prisma.StockMovementWhereInput,
): Promise<{ qty: Decimal; valueBase: Decimal }> {
  const [positive, negative] = await Promise.all([
    client.stockMovement.aggregate({
      where: positiveMovementWhere(where),
      _sum: { qty: true, totalValueBase: true },
    }),
    client.stockMovement.aggregate({
      where: negativeMovementWhere(where),
      _sum: { qty: true, totalValueBase: true },
    }),
  ])
  const positiveQty = positive._sum.qty == null ? ZERO : toDecimal(positive._sum.qty)
  const negativeQty = negative._sum.qty == null ? ZERO : toDecimal(negative._sum.qty)
  const positiveValue = positive._sum.totalValueBase == null ? ZERO : toDecimal(positive._sum.totalValueBase)
  const negativeValue = negative._sum.totalValueBase == null ? ZERO : toDecimal(negative._sum.totalValueBase)

  return {
    qty: positiveQty.sub(negativeQty),
    valueBase: positiveValue.sub(negativeValue),
  }
}

function movementWarehouse(row: {
  fromWarehouse: { code: string; name: string } | null
  toWarehouse: { code: string; name: string } | null
}): { code: string; name: string } {
  return row.toWarehouse ?? row.fromWarehouse ?? { code: 'N/A', name: 'No warehouse' }
}

function movementReferenceLabel(referenceType: string | null, referenceId: string | null): string {
  if (!referenceType && !referenceId) return 'Manual'
  if (!referenceType) return referenceId ?? 'Manual'
  if (!referenceId) return referenceType
  return `${referenceType} ${referenceId}`
}

function mapMovementRow(row: {
  id: string
  createdAt: Date
  type: StockMovementType
  productId: string
  product: { sku: string; name: string; stockUnit: string }
  fromWarehouseId: string | null
  toWarehouseId: string | null
  fromWarehouse: { code: string; name: string } | null
  toWarehouse: { code: string; name: string } | null
  qty: Prisma.Decimal
  unitCostBase: Prisma.Decimal | null
  totalValueBase: Prisma.Decimal | null
  referenceType: string | null
  referenceId: string | null
  note: string | null
}): InventoryLedgerReportRow {
  const warehouse = movementWarehouse(row)
  const signedQty = signedMovementQty(row)
  const signedValue = signedMovementValue(row)
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    type: row.type,
    productId: row.productId,
    sku: row.product.sku,
    productName: row.product.name,
    stockUnit: row.product.stockUnit,
    warehouseCode: warehouse.code,
    warehouseName: warehouse.name,
    direction: movementDirection(row),
    qty: decimalString(toDecimal(row.qty)),
    signedQty: decimalString(signedQty),
    unitCostBase: row.unitCostBase == null ? null : moneyString(toDecimal(row.unitCostBase)),
    totalValueBase: moneyString(row.totalValueBase == null ? ZERO : toDecimal(row.totalValueBase)),
    signedValueBase: moneyString(signedValue),
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    referenceLabel: movementReferenceLabel(row.referenceType, row.referenceId),
    referenceHref: inventoryLedgerReferenceHref(row.referenceType, row.referenceId),
    note: row.note,
  }
}

async function getMovementRows(client: InventoryLedgerReportClient, filters: InventoryLedgerFilters, paginate: boolean) {
  const where = movementWhere(filters)
  const totalRows = await client.stockMovement.count({ where })
  const info = pageInfo(totalRows, clampPage(filters.page), clampPageSize(filters.pageSize))
  const rows = await client.stockMovement.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(paginate ? { skip: (info.page - 1) * info.pageSize, take: info.pageSize } : {}),
    include: {
      product: { select: { sku: true, name: true, stockUnit: true } },
      fromWarehouse: { select: { code: true, name: true } },
      toWarehouse: { select: { code: true, name: true } },
    },
  })
  return { rows, pageInfo: paginate ? info : pageInfo(totalRows, 1, Math.max(totalRows, 1)) }
}

export async function getStockMovementLedgerReport(
  filters: InventoryLedgerFilters,
  options: InventoryLedgerReportOptions = {},
): Promise<InventoryLedgerReport> {
  const paginate = options.paginate !== false
  const client = options.client ?? db
  const [{ rows, pageInfo: info }, movement] = await Promise.all([
    getMovementRows(client, filters, paginate),
    movementTotals(client, movementWhere(filters)),
  ])
  const from = parseDateOnly(filters.dateFrom)
  const opening = from
    ? await movementTotals(client, movementWhere(filters, { lt: from }))
    : { qty: ZERO, valueBase: ZERO }

  return {
    rows: rows.map(mapMovementRow),
    pageInfo: info,
    dateFrom: from?.toISOString().slice(0, 10) ?? null,
    dateTo: parseDateOnly(filters.dateTo)?.toISOString().slice(0, 10) ?? null,
    totals: {
      openingQty: decimalString(opening.qty),
      movementQty: decimalString(movement.qty),
      closingQty: decimalString(opening.qty.add(movement.qty)),
      openingValueBase: moneyString(opening.valueBase),
      movementValueBase: moneyString(movement.valueBase),
      closingValueBase: moneyString(opening.valueBase.add(movement.valueBase)),
    },
    generatedAt: new Date().toISOString(),
  }
}

export function matchAdjustmentReason(note: string | null, reasons: Array<{ name: string }>): { reasonName: string; matched: boolean } {
  const value = note?.trim()
  if (!value) return { reasonName: 'Uncategorised', matched: false }
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const reason = [...reasons]
    .sort((a, b) => b.name.length - a.name.length)
    .find((candidate) => new RegExp(`^${escaped(candidate.name)}\\b`, 'i').test(value))
  if (reason) return { reasonName: reason.name, matched: true }
  return { reasonName: value.split(':')[0]?.trim() || 'Uncategorised', matched: false }
}

export async function getStockAdjustmentReport(
  filters: InventoryLedgerFilters,
  options: InventoryLedgerReportOptions = {},
): Promise<StockAdjustmentReport> {
  const client = options.client ?? db
  const adjustmentFilters = { ...filters, type: 'ADJUSTMENT' as StockMovementType }
  const [ledger, reasons] = await Promise.all([
    getStockMovementLedgerReport(adjustmentFilters, options),
    client.adjustmentReason.findMany({ select: { name: true } }),
  ])
  const rows = ledger.rows.map((row) => {
    const reason = matchAdjustmentReason(row.note, reasons)
    return { ...row, reasonName: reason.reasonName, reasonMatched: reason.matched }
  })
  const [reasonSummary, skuSummary] = await Promise.all([
    getAdjustmentReasonSummary(client, adjustmentFilters, reasons),
    getAdjustmentSkuSummary(client, adjustmentFilters),
  ])

  const totalCount = await client.stockMovement.count({ where: movementWhere(adjustmentFilters) })

  return {
    ...ledger,
    rows,
    reasonSummary,
    userSummary: [{ userName: 'Not captured on StockMovement', count: totalCount, valueBase: ledger.totals.movementValueBase, captured: false }],
    skuSummary,
  }
}

async function getAdjustmentReasonSummary(
  client: InventoryLedgerReportClient,
  filters: InventoryLedgerFilters,
  reasons: Array<{ name: string }>,
): Promise<StockAdjustmentReport['reasonSummary']> {
  const grouped = await client.stockMovement.groupBy({
    by: ['note'],
    where: movementWhere(filters),
    _count: { _all: true },
    _sum: { qty: true, totalValueBase: true },
  })
  const totals = new Map<string, { count: number; qty: Decimal; valueBase: Decimal }>()
  for (const row of grouped) {
    const reason = matchAdjustmentReason(row.note, reasons)
    const current = totals.get(reason.reasonName) ?? { count: 0, qty: ZERO, valueBase: ZERO }
    current.count += row._count._all
    current.qty = current.qty.add(row._sum.qty == null ? ZERO : toDecimal(row._sum.qty))
    current.valueBase = current.valueBase.add(row._sum.totalValueBase == null ? ZERO : toDecimal(row._sum.totalValueBase))
    totals.set(reason.reasonName, current)
  }
  return [...totals.entries()]
    .map(([reasonName, value]) => ({ reasonName, count: value.count, qty: decimalString(value.qty), valueBase: moneyString(value.valueBase) }))
    .sort((a, b) => toDecimal(b.valueBase).cmp(toDecimal(a.valueBase)) || a.reasonName.localeCompare(b.reasonName))
    .slice(0, 10)
}

async function getAdjustmentSkuSummary(
  client: InventoryLedgerReportClient,
  filters: InventoryLedgerFilters,
): Promise<StockAdjustmentReport['skuSummary']> {
  const grouped = await client.stockMovement.groupBy({
    by: ['productId'],
    where: movementWhere(filters),
    _count: { _all: true },
    _sum: { qty: true, totalValueBase: true },
  })
  const products = await client.product.findMany({
    where: { id: { in: grouped.map((row) => row.productId) } },
    select: { id: true, sku: true, name: true },
  })
  const productById = new Map(products.map((product) => [product.id, product]))
  return grouped
    .map((row) => {
      const product = productById.get(row.productId)
      return {
        sku: product?.sku ?? row.productId,
        productName: product?.name ?? row.productId,
        count: row._count._all,
        qty: decimalString(row._sum.qty == null ? ZERO : toDecimal(row._sum.qty)),
        valueBase: moneyString(row._sum.totalValueBase == null ? ZERO : toDecimal(row._sum.totalValueBase)),
      }
    })
    .sort((a, b) => toDecimal(b.valueBase).cmp(toDecimal(a.valueBase)) || a.sku.localeCompare(b.sku))
    .slice(0, 10)
}

function transferWhere(filters: InventoryLedgerFilters, statusOverride?: Prisma.EnumStockTransferStatusFilter): Prisma.StockTransferWhereInput {
  const and: Prisma.StockTransferWhereInput[] = []
  const createdAt = dateRangeWhere(filters)
  const product = normalizeTextFilter(filters.product)
  const reference = normalizeTextFilter(filters.reference)
  const status = normalizeTransferStatus(filters.status)
  if (createdAt) and.push({ createdAt })
  if (filters.warehouseId) and.push({ OR: [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }] })
  if (product) {
    and.push({
      lines: {
        some: {
          OR: [
            { sku: { contains: product, mode: 'insensitive' } },
            { productName: { contains: product, mode: 'insensitive' } },
          ],
        },
      },
    })
  }
  if (reference) and.push({ reference: { contains: reference, mode: 'insensitive' } })
  if (statusOverride) and.push({ status: statusOverride })
  else if (status) and.push({ status })
  return and.length ? { AND: and } : {}
}

export async function getStockTransferReport(
  filters: InventoryLedgerFilters,
  options: InventoryLedgerReportOptions & { now?: Date } = {},
): Promise<StockTransferReport> {
  const paginate = options.paginate !== false
  const client = options.client ?? db
  const now = options.now ?? new Date()
  const where = transferWhere(filters)
  const totalRows = await client.stockTransfer.count({ where })
  const info = pageInfo(totalRows, clampPage(filters.page), clampPageSize(filters.pageSize))
  const transfers = await client.stockTransfer.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(paginate ? { skip: (info.page - 1) * info.pageSize, take: info.pageSize } : {}),
    include: {
      fromWarehouse: { select: { code: true, name: true } },
      toWarehouse: { select: { code: true, name: true } },
      lines: { select: { qty: true, qtyReceived: true, sku: true, productName: true } },
    },
  })
  const ids = transfers.map((transfer) => transfer.id)
  const allFilteredTransferIds = await client.stockTransfer.findMany({
    where,
    select: { id: true },
  })
  const allIds = allFilteredTransferIds.map((transfer) => transfer.id)
  const movements = ids.length
    ? await client.stockMovement.findMany({
        where: { referenceType: 'StockTransfer', referenceId: { in: ids } },
        select: { referenceId: true, type: true, qty: true, totalValueBase: true, fromWarehouseId: true, toWarehouseId: true },
      })
    : []
  const [allTransferLines, allMovements] = await Promise.all([
    client.stockTransferLine.findMany({
      where: { transfer: where },
      select: { qty: true, qtyReceived: true },
    }),
    allIds.length
      ? client.stockMovement.findMany({
          where: { referenceType: 'StockTransfer', referenceId: { in: allIds } },
          select: { totalValueBase: true },
        })
      : Promise.resolve([]),
  ])
  const movementByTransfer = new Map<string, { outQty: Decimal; inQty: Decimal; valueBase: Decimal }>()
  for (const movement of movements) {
    if (!movement.referenceId) continue
    const current = movementByTransfer.get(movement.referenceId) ?? { outQty: ZERO, inQty: ZERO, valueBase: ZERO }
    if (movement.type === 'TRANSFER_OUT') current.outQty = current.outQty.add(toDecimal(movement.qty))
    if (movement.type === 'TRANSFER_IN') current.inQty = current.inQty.add(toDecimal(movement.qty))
    current.valueBase = current.valueBase.add(movement.totalValueBase == null ? ZERO : toDecimal(movement.totalValueBase))
    movementByTransfer.set(movement.referenceId, current)
  }

  const rows = transfers.map((transfer): StockTransferReportRow => {
    const requestedQty = transfer.lines.reduce((sum, line) => sum.add(toDecimal(line.qty)), ZERO)
    const receivedQty = transfer.lines.reduce((sum, line) => sum.add(toDecimal(line.qtyReceived)), ZERO)
    const movement = movementByTransfer.get(transfer.id) ?? { outQty: ZERO, inQty: ZERO, valueBase: ZERO }
    const start = transfer.dispatchedAt ?? transfer.createdAt
    const end = transfer.completedAt ?? now
    const daysInTransit = transfer.status === 'DRAFT' ? 0 : Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000))
    const overdue = transfer.status === 'IN_TRANSIT' && daysInTransit > TRANSFER_OVERDUE_DAYS
    return {
      id: transfer.id,
      reference: transfer.reference,
      status: transfer.status,
      fromWarehouseCode: transfer.fromWarehouse.code,
      fromWarehouseName: transfer.fromWarehouse.name,
      toWarehouseCode: transfer.toWarehouse.code,
      toWarehouseName: transfer.toWarehouse.name,
      dispatchedAt: transfer.dispatchedAt?.toISOString() ?? null,
      completedAt: transfer.completedAt?.toISOString() ?? null,
      createdAt: transfer.createdAt.toISOString(),
      daysInTransit,
      overdue,
      lineCount: transfer.lines.length,
      requestedQty: decimalString(requestedQty),
      receivedQty: decimalString(receivedQty),
      driftQty: decimalString(requestedQty.sub(receivedQty)),
      movementOutQty: decimalString(movement.outQty),
      movementInQty: decimalString(movement.inQty),
      movementValueBase: moneyString(movement.valueBase),
      href: `/stock-control/transfers?reference=${encodeURIComponent(transfer.reference)}`,
    }
  })

  const totalRequested = allTransferLines.reduce((sum, row) => sum.add(toDecimal(row.qty)), ZERO)
  const totalReceived = allTransferLines.reduce((sum, row) => sum.add(toDecimal(row.qtyReceived)), ZERO)
  const totalValue = allMovements.reduce((sum, row) => sum.add(row.totalValueBase == null ? ZERO : toDecimal(row.totalValueBase)), ZERO)
  const inTransitCount = await client.stockTransfer.count({ where: transferWhere(filters, { in: ['DRAFT', 'IN_TRANSIT'] }) })
  return {
    rows,
    pageInfo: paginate ? info : pageInfo(totalRows, 1, Math.max(totalRows, 1)),
    totals: {
      requestedQty: decimalString(totalRequested),
      receivedQty: decimalString(totalReceived),
      driftQty: decimalString(totalRequested.sub(totalReceived)),
      inTransitCount,
      overdueCount: rows.filter((row) => row.overdue).length,
      movementValueBase: moneyString(totalValue),
    },
    generatedAt: new Date().toISOString(),
  }
}

function stockCountWhere(filters: InventoryLedgerFilters): Prisma.StockCountWhereInput {
  const and: Prisma.StockCountWhereInput[] = []
  const createdAt = dateRangeWhere(filters)
  const product = normalizeTextFilter(filters.product)
  const reference = normalizeTextFilter(filters.reference)
  const status = normalizeCountStatus(filters.status)
  if (createdAt) and.push({ createdAt })
  if (filters.warehouseId) and.push({ warehouseId: filters.warehouseId })
  if (status) and.push({ status })
  if (reference) and.push({ reference: { contains: reference, mode: 'insensitive' } })
  if (product) and.push({ lines: { some: { sku: { contains: product, mode: 'insensitive' } } } })
  return and.length ? { AND: and } : {}
}

function stockCountLineWhere(filters: InventoryLedgerFilters): Prisma.StockCountLineWhereInput {
  const product = normalizeTextFilter(filters.product)
  return {
    count: stockCountWhere(filters),
    ...(product ? { sku: { contains: product, mode: 'insensitive' } } : {}),
  }
}

export async function getInventoryLedgerExportRowCount(
  reportType: InventoryLedgerExportReportType,
  filters: InventoryLedgerFilters,
  client: InventoryLedgerReportClient = db,
): Promise<number> {
  switch (reportType) {
    case 'stock-movements':
      return client.stockMovement.count({ where: movementWhere(filters) })
    case 'stock-adjustments':
      return client.stockMovement.count({ where: movementWhere({ ...filters, type: 'ADJUSTMENT' }) })
    case 'transfers':
      return client.stockTransfer.count({ where: transferWhere(filters) })
    case 'stock-counts':
      return client.stockCountLine.count({ where: stockCountLineWhere(filters) })
  }
}

export async function getStockCountReport(
  filters: InventoryLedgerFilters,
  options: InventoryLedgerReportOptions = {},
): Promise<StockCountReport> {
  const paginate = options.paginate !== false
  const client = options.client ?? db
  const where = stockCountLineWhere(filters)
  const totalRows = await client.stockCountLine.count({ where })
  const info = pageInfo(totalRows, clampPage(filters.page), clampPageSize(filters.pageSize))
  const [lines, totalsAggregate, repeatGroups] = await Promise.all([
    client.stockCountLine.findMany({
      where,
      orderBy: [{ count: { createdAt: 'desc' } }, { countId: 'desc' }, { sku: 'asc' }, { id: 'asc' }],
      ...(paginate ? { skip: (info.page - 1) * info.pageSize, take: info.pageSize } : {}),
      include: {
        count: {
          include: {
            warehouse: { select: { code: true, name: true } },
          },
        },
      },
    }),
    client.stockCountLine.aggregate({
      where,
      _sum: { expectedQty: true, countedQty: true, variance: true },
    }),
    client.stockCountLine.groupBy({
      by: ['sku'],
      where: combineStockCountLineWhere(where, { variance: { not: 0 } }),
      _count: { _all: true },
      _sum: { variance: true },
    }),
  ])
  const countIds = [...new Set(lines.map((line) => line.countId))]
  const movements = countIds.length
    ? await client.stockMovement.findMany({
        where: { referenceType: 'StockCount', referenceId: { in: countIds }, type: 'ADJUSTMENT' },
        select: { referenceId: true, productId: true, totalValueBase: true },
      })
    : []
  const movementValueByCountProduct = new Map<string, Decimal>()
  for (const movement of movements) {
    if (!movement.referenceId) continue
    const key = `${movement.referenceId}:${movement.productId}`
    movementValueByCountProduct.set(key, (movementValueByCountProduct.get(key) ?? ZERO).add(movement.totalValueBase == null ? ZERO : toDecimal(movement.totalValueBase)))
  }

  const rows = lines.map((line): StockCountReportRow => {
    const count = line.count
    const counted = line.countedQty == null ? null : toDecimal(line.countedQty)
    const variance = line.variance == null
      ? counted == null ? ZERO : counted.sub(toDecimal(line.expectedQty))
      : toDecimal(line.variance)
    const movementValue = movementValueByCountProduct.get(`${count.id}:${line.productId}`) ?? null
    return {
      id: line.id,
      countId: count.id,
      reference: count.reference,
      status: count.status,
      warehouseCode: count.warehouse.code,
      warehouseName: count.warehouse.name,
      sku: line.sku,
      productId: line.productId,
      expectedQty: decimalString(toDecimal(line.expectedQty)),
      countedQty: counted == null ? null : decimalString(counted),
      varianceQty: decimalString(variance),
      linkedAdjustmentValueBase: movementValue == null ? null : moneyString(movementValue),
      adjustmentEvidence: movementValue == null ? 'missing' : 'linked',
      completedAt: count.completedAt?.toISOString() ?? null,
      createdAt: count.createdAt.toISOString(),
    }
  })
  const linkedValue = rows.reduce((sum, row) => sum.add(row.linkedAdjustmentValueBase == null ? ZERO : toDecimal(row.linkedAdjustmentValueBase)), ZERO)
  const missingAdjustmentEvidenceRows = rows.filter((row) => row.adjustmentEvidence === 'missing' && !toDecimal(row.varianceQty).eq(0)).length

  return {
    rows,
    pageInfo: paginate ? info : pageInfo(totalRows, 1, Math.max(totalRows, 1)),
    totals: {
      expectedQty: decimalString(totalsAggregate._sum.expectedQty == null ? ZERO : toDecimal(totalsAggregate._sum.expectedQty)),
      countedQty: decimalString(totalsAggregate._sum.countedQty == null ? ZERO : toDecimal(totalsAggregate._sum.countedQty)),
      varianceQty: decimalString(totalsAggregate._sum.variance == null ? ZERO : toDecimal(totalsAggregate._sum.variance)),
      linkedAdjustmentValueBase: moneyString(linkedValue),
      missingAdjustmentEvidenceRows,
      repeatOffenderSkus: repeatGroups.length,
    },
    repeatOffenders: repeatGroups
      .map((row) => ({ sku: row.sku, count: row._count._all, varianceQty: decimalString(row._sum.variance == null ? ZERO : toDecimal(row._sum.variance)) }))
      .sort((a, b) => b.count - a.count || toDecimal(b.varianceQty).abs().cmp(toDecimal(a.varianceQty).abs()) || a.sku.localeCompare(b.sku))
      .slice(0, 10),
    generatedAt: new Date().toISOString(),
  }
}

function combineStockCountLineWhere(...parts: Prisma.StockCountLineWhereInput[]): Prisma.StockCountLineWhereInput {
  const filtered = parts.filter((part) => Object.keys(part).length > 0)
  if (filtered.length === 0) return {}
  if (filtered.length === 1) return filtered[0]!
  return { AND: filtered }
}
