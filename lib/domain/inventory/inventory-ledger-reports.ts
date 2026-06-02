import { Prisma, StockCountStatus, StockMovementType, StockTransferStatus } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import type { PageInfo } from '@/lib/domain/inventory/stock-position-reports'

const DEFAULT_PAGE_SIZE = 100
const MIN_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const MOVEMENT_TOTAL_PAGE_SIZE = 5000
const TRANSFER_OVERDUE_DAYS = 7

const ZERO = new Prisma.Decimal(0)
const STOCK_MOVEMENT_TYPES = new Set(Object.values(StockMovementType))
const STOCK_TRANSFER_STATUSES = new Set(Object.values(StockTransferStatus))
const STOCK_COUNT_STATUSES = new Set(Object.values(StockCountStatus))

const OUTBOUND_MOVEMENT_TYPES = new Set<StockMovementType>([
  'SALE_DISPATCH',
  'TRANSFER_OUT',
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
  userSummary: Array<{ userName: string; count: number; valueBase: string }>
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
    if (row.toWarehouseId && !row.fromWarehouseId) return qty
    return ZERO
  }
  if (OUTBOUND_MOVEMENT_TYPES.has(row.type)) return qty.negated()
  if (INBOUND_MOVEMENT_TYPES.has(row.type)) return qty
  return ZERO
}

export function signedMovementValue(row: MovementEvidence): Decimal {
  const value = row.totalValueBase == null ? ZERO : toDecimal(row.totalValueBase)
  if (signedMovementQty(row).lt(0)) return value.negated()
  if (signedMovementQty(row).gt(0)) return value
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
      return `/stock-control/transfers?reference=${encodeURIComponent(referenceId)}`
    case 'ProductionOrder':
      return `/manufacturing/${referenceId}`
    case 'StockMovement':
      return `/stock-control/stock-adjustments?movementId=${encodeURIComponent(referenceId)}`
    case 'StockCount':
      return `/analytics/stock-counts?reference=${encodeURIComponent(referenceId)}`
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

async function movementTotals(where: Prisma.StockMovementWhereInput): Promise<{ qty: Decimal; valueBase: Decimal }> {
  let qty = ZERO
  let valueBase = ZERO
  let cursor: { id: string } | undefined

  while (true) {
    const rows = await db.stockMovement.findMany({
      where,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor, skip: 1 } : {}),
      take: MOVEMENT_TOTAL_PAGE_SIZE,
      select: {
        id: true,
        type: true,
        qty: true,
        totalValueBase: true,
        fromWarehouseId: true,
        toWarehouseId: true,
      },
    })
    for (const row of rows) {
      qty = qty.add(signedMovementQty(row))
      valueBase = valueBase.add(signedMovementValue(row))
    }
    if (rows.length < MOVEMENT_TOTAL_PAGE_SIZE) break
    cursor = { id: rows[rows.length - 1]!.id }
  }

  return { qty, valueBase }
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

async function getMovementRows(filters: InventoryLedgerFilters, paginate: boolean) {
  const where = movementWhere(filters)
  const totalRows = await db.stockMovement.count({ where })
  const info = pageInfo(totalRows, clampPage(filters.page), clampPageSize(filters.pageSize))
  const rows = await db.stockMovement.findMany({
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
  options: { paginate?: boolean } = {},
): Promise<InventoryLedgerReport> {
  const paginate = options.paginate !== false
  const [{ rows, pageInfo: info }, movement] = await Promise.all([
    getMovementRows(filters, paginate),
    movementTotals(movementWhere(filters)),
  ])
  const from = parseDateOnly(filters.dateFrom)
  const opening = from
    ? await movementTotals(movementWhere(filters, { lt: from }))
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
  const reason = [...reasons]
    .sort((a, b) => b.name.length - a.name.length)
    .find((candidate) => value === candidate.name || value.startsWith(`${candidate.name}:`))
  if (reason) return { reasonName: reason.name, matched: true }
  return { reasonName: value.split(':')[0]?.trim() || 'Uncategorised', matched: false }
}

export async function getStockAdjustmentReport(
  filters: InventoryLedgerFilters,
  options: { paginate?: boolean } = {},
): Promise<StockAdjustmentReport> {
  const adjustmentFilters = { ...filters, type: 'ADJUSTMENT' as StockMovementType }
  const [ledger, reasons] = await Promise.all([
    getStockMovementLedgerReport(adjustmentFilters, options),
    db.adjustmentReason.findMany({ select: { name: true } }),
  ])
  const rows = ledger.rows.map((row) => {
    const reason = matchAdjustmentReason(row.note, reasons)
    return { ...row, reasonName: reason.reasonName, reasonMatched: reason.matched }
  })
  const summaryRows = options.paginate === false ? rows : (await getStockMovementLedgerReport(adjustmentFilters, { paginate: false })).rows.map((row) => {
    const reason = matchAdjustmentReason(row.note, reasons)
    return { ...row, reasonName: reason.reasonName, reasonMatched: reason.matched }
  })

  const reasonSummary = summarizeAdjustments(summaryRows, (row) => row.reasonName)
    .map((row) => ({ reasonName: row.key, count: row.count, qty: row.qty, valueBase: row.valueBase }))
  const skuSummary = summarizeAdjustments(summaryRows, (row) => row.sku)
    .map((row) => ({ sku: row.key, productName: summaryRows.find((item) => item.sku === row.key)?.productName ?? row.key, count: row.count, qty: row.qty, valueBase: row.valueBase }))

  return {
    ...ledger,
    rows,
    reasonSummary,
    userSummary: [{ userName: 'Not captured on StockMovement', count: summaryRows.length, valueBase: ledger.totals.movementValueBase }],
    skuSummary,
  }
}

function summarizeAdjustments(rows: StockAdjustmentReportRow[], keyFor: (row: StockAdjustmentReportRow) => string): Array<{ key: string; count: number; qty: string; valueBase: string }> {
  const grouped = new Map<string, { count: number; qty: Decimal; valueBase: Decimal }>()
  for (const row of rows) {
    const key = keyFor(row)
    const current = grouped.get(key) ?? { count: 0, qty: ZERO, valueBase: ZERO }
    current.count += 1
    current.qty = current.qty.add(toDecimal(row.signedQty).abs())
    current.valueBase = current.valueBase.add(toDecimal(row.totalValueBase))
    grouped.set(key, current)
  }
  return [...grouped.entries()]
    .map(([key, value]) => ({ key, count: value.count, qty: decimalString(value.qty), valueBase: moneyString(value.valueBase) }))
    .sort((a, b) => Number(b.valueBase) - Number(a.valueBase))
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
  options: { paginate?: boolean; now?: Date } = {},
): Promise<StockTransferReport> {
  const paginate = options.paginate !== false
  const now = options.now ?? new Date()
  const where = transferWhere(filters)
  const totalRows = await db.stockTransfer.count({ where })
  const info = pageInfo(totalRows, clampPage(filters.page), clampPageSize(filters.pageSize))
  const transfers = await db.stockTransfer.findMany({
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
  const movements = ids.length
    ? await db.stockMovement.findMany({
        where: { referenceType: 'StockTransfer', referenceId: { in: ids } },
        select: { referenceId: true, type: true, qty: true, totalValueBase: true, fromWarehouseId: true, toWarehouseId: true },
      })
    : []
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

  const totalRequested = rows.reduce((sum, row) => sum.add(toDecimal(row.requestedQty)), ZERO)
  const totalReceived = rows.reduce((sum, row) => sum.add(toDecimal(row.receivedQty)), ZERO)
  const totalValue = rows.reduce((sum, row) => sum.add(toDecimal(row.movementValueBase)), ZERO)
  const inTransitCount = await db.stockTransfer.count({ where: transferWhere(filters, { in: ['DRAFT', 'IN_TRANSIT'] }) })
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

export async function getStockCountReport(
  filters: InventoryLedgerFilters,
  options: { paginate?: boolean } = {},
): Promise<StockCountReport> {
  const paginate = options.paginate !== false
  const counts = await db.stockCount.findMany({
    where: stockCountWhere(filters),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      warehouse: { select: { code: true, name: true } },
      lines: { orderBy: { sku: 'asc' } },
    },
  })
  const ids = counts.map((count) => count.id)
  const movements = ids.length
    ? await db.stockMovement.findMany({
        where: { referenceType: 'StockCount', referenceId: { in: ids }, type: 'ADJUSTMENT' },
        select: { referenceId: true, productId: true, totalValueBase: true },
      })
    : []
  const movementValueByCountProduct = new Map<string, Decimal>()
  for (const movement of movements) {
    if (!movement.referenceId) continue
    const key = `${movement.referenceId}:${movement.productId}`
    movementValueByCountProduct.set(key, (movementValueByCountProduct.get(key) ?? ZERO).add(movement.totalValueBase == null ? ZERO : toDecimal(movement.totalValueBase)))
  }

  const allRows = counts.flatMap((count) => count.lines.map((line): StockCountReportRow => {
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
  }))

  const info = pageInfo(allRows.length, clampPage(filters.page), clampPageSize(filters.pageSize))
  const rows = paginate ? allRows.slice((info.page - 1) * info.pageSize, info.page * info.pageSize) : allRows
  const repeat = new Map<string, { count: number; variance: Decimal }>()
  for (const row of allRows) {
    if (toDecimal(row.varianceQty).eq(0)) continue
    const current = repeat.get(row.sku) ?? { count: 0, variance: ZERO }
    current.count += 1
    current.variance = current.variance.add(toDecimal(row.varianceQty))
    repeat.set(row.sku, current)
  }
  const expected = allRows.reduce((sum, row) => sum.add(toDecimal(row.expectedQty)), ZERO)
  const counted = allRows.reduce((sum, row) => sum.add(row.countedQty == null ? ZERO : toDecimal(row.countedQty)), ZERO)
  const linkedValue = allRows.reduce((sum, row) => sum.add(row.linkedAdjustmentValueBase == null ? ZERO : toDecimal(row.linkedAdjustmentValueBase)), ZERO)

  return {
    rows,
    pageInfo: paginate ? info : pageInfo(allRows.length, 1, Math.max(allRows.length, 1)),
    totals: {
      expectedQty: decimalString(expected),
      countedQty: decimalString(counted),
      varianceQty: decimalString(counted.sub(expected)),
      linkedAdjustmentValueBase: moneyString(linkedValue),
      missingAdjustmentEvidenceRows: allRows.filter((row) => row.adjustmentEvidence === 'missing' && !toDecimal(row.varianceQty).eq(0)).length,
      repeatOffenderSkus: repeat.size,
    },
    repeatOffenders: [...repeat.entries()]
      .map(([sku, value]) => ({ sku, count: value.count, varianceQty: decimalString(value.variance) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    generatedAt: new Date().toISOString(),
  }
}
