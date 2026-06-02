import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  getStockAdjustmentReport,
  getStockCountReport,
  getStockMovementLedgerReport,
  getStockTransferReport,
  inventoryLedgerReferenceHref,
  matchAdjustmentReason,
  movementDirection,
  signedMovementQty,
  signedMovementValue,
} from '@/lib/domain/inventory/inventory-ledger-reports'

function movement(overrides: Partial<Parameters<typeof signedMovementQty>[0]>): Parameters<typeof signedMovementQty>[0] {
  return {
    type: 'PURCHASE_RECEIPT',
    qty: new Prisma.Decimal(5),
    totalValueBase: new Prisma.Decimal(12.5),
    fromWarehouseId: null,
    toWarehouseId: 'warehouse-1',
    ...overrides,
  }
}

test('signedMovementQty and signedMovementValue classify inbound and outbound movement evidence', () => {
  assert.equal(signedMovementQty(movement({ type: 'PURCHASE_RECEIPT' })).toString(), '5')
  assert.equal(signedMovementValue(movement({ type: 'PURCHASE_RECEIPT' })).toString(), '12.5')
  assert.equal(movementDirection(movement({ type: 'PURCHASE_RECEIPT' })), 'in')

  assert.equal(signedMovementQty(movement({ type: 'SALE_DISPATCH', fromWarehouseId: 'warehouse-1', toWarehouseId: null })).toString(), '-5')
  assert.equal(signedMovementValue(movement({ type: 'SALE_DISPATCH', fromWarehouseId: 'warehouse-1', toWarehouseId: null })).toString(), '-12.5')
  assert.equal(movementDirection(movement({ type: 'SALE_DISPATCH', fromWarehouseId: 'warehouse-1', toWarehouseId: null })), 'out')
})

test('signedMovementQty handles adjustment direction from populated warehouse side', () => {
  assert.equal(signedMovementQty(movement({ type: 'ADJUSTMENT', fromWarehouseId: null, toWarehouseId: 'warehouse-1' })).toString(), '5')
  assert.equal(signedMovementQty(movement({ type: 'ADJUSTMENT', fromWarehouseId: 'warehouse-1', toWarehouseId: null })).toString(), '-5')
  assert.equal(signedMovementQty(movement({ type: 'ADJUSTMENT', fromWarehouseId: 'warehouse-1', toWarehouseId: 'warehouse-2' })).toString(), '5')
})

test('matchAdjustmentReason prefers canonical adjustment reasons over note text', () => {
  const reasons = [{ name: 'Damaged stock' }, { name: 'Damaged' }]
  assert.deepEqual(matchAdjustmentReason('Damaged stock: crushed carton', reasons), {
    reasonName: 'Damaged stock',
    matched: true,
  })
  assert.deepEqual(matchAdjustmentReason('Cycle count correction', reasons), {
    reasonName: 'Cycle count correction',
    matched: false,
  })
  assert.deepEqual(matchAdjustmentReason(null, reasons), {
    reasonName: 'Uncategorised',
    matched: false,
  })
})

test('inventoryLedgerReferenceHref maps source references to drill-through URLs', () => {
  assert.equal(inventoryLedgerReferenceHref('PurchaseOrder', 'po-1'), '/purchase-orders/po-1')
  assert.equal(inventoryLedgerReferenceHref('SalesOrder', 'so-1'), '/sales/so-1')
  assert.equal(inventoryLedgerReferenceHref('ProductionOrder', 'mo-1'), '/manufacturing/mo-1')
  assert.equal(inventoryLedgerReferenceHref('StockTransfer', 'trf-1'), null)
  assert.equal(inventoryLedgerReferenceHref('Unknown', 'x'), null)
})

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where || Object.keys(where).length === 0) return true
  if (Array.isArray(where.AND) && !where.AND.every((part) => matchesWhere(row, part as Record<string, unknown>))) return false
  if (Array.isArray(where.OR) && !where.OR.some((part) => matchesWhere(row, part as Record<string, unknown>))) return false
  if (where.type) {
    if (typeof where.type === 'string' && row.type !== where.type) return false
    if (typeof where.type === 'object' && where.type !== null && 'in' in where.type && !((where.type as { in: string[] }).in.includes(row.type as string))) return false
  }
  if (where.createdAt && typeof where.createdAt === 'object') {
    const createdAt = row.createdAt as Date
    const filter = where.createdAt as { gte?: Date; lte?: Date; lt?: Date }
    if (filter.gte && createdAt < filter.gte) return false
    if (filter.lte && createdAt > filter.lte) return false
    if (filter.lt && createdAt >= filter.lt) return false
  }
  for (const field of ['fromWarehouseId', 'toWarehouseId', 'referenceType', 'referenceId']) {
    if (!(field in where)) continue
    const expected = where[field]
    if (expected && typeof expected === 'object' && 'not' in expected) {
      if (row[field] === (expected as { not: unknown }).not) return false
    } else if (row[field] !== expected) {
      return false
    }
  }
  return true
}

function movementClient(rows: Array<Record<string, unknown>>) {
  return {
    stockMovement: {
      async count(args: { where?: Record<string, unknown> }) {
        return rows.filter((row) => matchesWhere(row, args.where)).length
      },
      async findMany(args: { where?: Record<string, unknown>; skip?: number; take?: number; select?: Record<string, boolean> }) {
        const filtered = rows.filter((row) => matchesWhere(row, args.where))
        const sliced = args.take == null ? filtered : filtered.slice(args.skip ?? 0, (args.skip ?? 0) + args.take)
        const select = args.select
        if (select) {
          return sliced.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])))
        }
        return sliced
      },
      async aggregate(args: { where?: Record<string, unknown> }) {
        const filtered = rows.filter((row) => matchesWhere(row, args.where))
        return {
          _sum: {
            qty: filtered.reduce((sum, row) => sum.add(row.qty as Prisma.Decimal), new Prisma.Decimal(0)),
            totalValueBase: filtered.reduce((sum, row) => sum.add((row.totalValueBase as Prisma.Decimal | null) ?? 0), new Prisma.Decimal(0)),
          },
        }
      },
      async groupBy(args: { by: string[]; where?: Record<string, unknown> }) {
        const grouped = new Map<string, { row: Record<string, unknown>; count: number; qty: Prisma.Decimal; totalValueBase: Prisma.Decimal }>()
        for (const row of rows.filter((candidate) => matchesWhere(candidate, args.where))) {
          const key = args.by.map((field) => String(row[field])).join(':')
          const current = grouped.get(key) ?? { row, count: 0, qty: new Prisma.Decimal(0), totalValueBase: new Prisma.Decimal(0) }
          current.count += 1
          current.qty = current.qty.add(row.qty as Prisma.Decimal)
          current.totalValueBase = current.totalValueBase.add((row.totalValueBase as Prisma.Decimal | null) ?? 0)
          grouped.set(key, current)
        }
        return [...grouped.values()].map((group) => ({
          ...Object.fromEntries(args.by.map((field) => [field, group.row[field]])),
          _count: { _all: group.count },
          _sum: { qty: group.qty, totalValueBase: group.totalValueBase },
        }))
      },
    },
    adjustmentReason: { async findMany() { return [{ name: 'Damaged' }, { name: 'Cycle count' }] } },
    product: {
      async findMany() {
        return rows.map((row) => row.product).filter(Boolean).map((product) => product as { id: string; sku: string; name: string })
      },
    },
  }
}

test('getStockMovementLedgerReport reconciles opening plus movement to closing', async () => {
  const product = { id: 'p1', sku: 'SKU-1', name: 'Widget', stockUnit: 'ea' }
  const warehouse = { code: 'MAIN', name: 'Main' }
  const client = {
    ...movementClient([
      { id: 'm1', type: 'OPENING_STOCK', productId: 'p1', product, fromWarehouseId: null, toWarehouseId: 'w1', fromWarehouse: null, toWarehouse: warehouse, qty: new Prisma.Decimal(10), unitCostBase: new Prisma.Decimal(1), totalValueBase: new Prisma.Decimal(10), referenceType: null, referenceId: null, note: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'm2', type: 'SALE_DISPATCH', productId: 'p1', product, fromWarehouseId: 'w1', toWarehouseId: null, fromWarehouse: warehouse, toWarehouse: null, qty: new Prisma.Decimal(3), unitCostBase: new Prisma.Decimal(1), totalValueBase: new Prisma.Decimal(3), referenceType: 'SalesOrder', referenceId: 'so1', note: null, createdAt: new Date('2026-01-03T00:00:00Z') },
    ]),
  } as never

  const report = await getStockMovementLedgerReport({ dateFrom: '2026-01-02' }, { client })
  assert.equal(report.totals.openingQty, '10')
  assert.equal(report.totals.movementQty, '-3')
  assert.equal(report.totals.closingQty, '7')
})

test('getStockAdjustmentReport reason summary covers all filtered adjustments when display is paginated', async () => {
  const product = { id: 'p1', sku: 'SKU-1', name: 'Widget', stockUnit: 'ea' }
  const warehouse = { code: 'MAIN', name: 'Main' }
  const client = movementClient([
    { id: 'a1', type: 'ADJUSTMENT', productId: 'p1', product, fromWarehouseId: 'w1', toWarehouseId: null, fromWarehouse: warehouse, toWarehouse: null, qty: new Prisma.Decimal(1), unitCostBase: new Prisma.Decimal(2), totalValueBase: new Prisma.Decimal(2), referenceType: null, referenceId: null, note: 'Damaged - cracked', createdAt: new Date('2026-01-01T00:00:00Z') },
    { id: 'a2', type: 'ADJUSTMENT', productId: 'p1', product, fromWarehouseId: 'w1', toWarehouseId: null, fromWarehouse: warehouse, toWarehouse: null, qty: new Prisma.Decimal(2), unitCostBase: new Prisma.Decimal(2), totalValueBase: new Prisma.Decimal(4), referenceType: null, referenceId: null, note: 'Cycle count: short', createdAt: new Date('2026-01-02T00:00:00Z') },
  ]) as never

  const report = await getStockAdjustmentReport({ pageSize: 50 }, { client })
  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.reasonSummary.map((row) => row.reasonName).sort(), ['Cycle count', 'Damaged'])
})

test('getStockTransferReport totals use the full filtered transfer set, not the display page', async () => {
  const transfers = [
    { id: 't1', reference: 'TRF-1', status: 'IN_TRANSIT', fromWarehouse: { code: 'A', name: 'A' }, toWarehouse: { code: 'B', name: 'B' }, fromWarehouseId: 'a', toWarehouseId: 'b', dispatchedAt: new Date('2026-01-01T00:00:00Z'), completedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), lines: [{ qty: new Prisma.Decimal(10), qtyReceived: new Prisma.Decimal(0), sku: 'A', productName: 'A' }] },
    { id: 't2', reference: 'TRF-2', status: 'RECEIVED', fromWarehouse: { code: 'A', name: 'A' }, toWarehouse: { code: 'B', name: 'B' }, fromWarehouseId: 'a', toWarehouseId: 'b', dispatchedAt: new Date('2026-01-02T00:00:00Z'), completedAt: new Date('2026-01-03T00:00:00Z'), createdAt: new Date('2026-01-02T00:00:00Z'), lines: [{ qty: new Prisma.Decimal(20), qtyReceived: new Prisma.Decimal(20), sku: 'B', productName: 'B' }] },
  ]
  const client = {
    stockTransfer: {
      async count() { return transfers.length },
      async findMany(args: { skip?: number; take?: number; select?: Record<string, boolean> }) {
        if (args.select) return transfers.map((transfer) => ({ id: transfer.id }))
        return transfers.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? transfers.length))
      },
    },
    stockTransferLine: {
      async findMany() { return transfers.flatMap((transfer) => transfer.lines) },
    },
    stockMovement: {
      async findMany() { return [] },
    },
  } as never

  const report = await getStockTransferReport({ pageSize: 50 }, { client, now: new Date('2026-01-10T00:00:00Z') })
  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.requestedQty, '30')
  assert.equal(report.totals.receivedQty, '20')
})

test('getStockCountReport paginates stock count lines without loading whole count graphs', async () => {
  const lines = Array.from({ length: 150 }, (_, index) => ({
    id: `line-${index}`,
    countId: 'count-1',
    productId: `p-${index}`,
    sku: `SKU-${String(index).padStart(3, '0')}`,
    expectedQty: new Prisma.Decimal(10),
    countedQty: new Prisma.Decimal(9),
    variance: new Prisma.Decimal(-1),
    count: {
      id: 'count-1',
      reference: 'CNT-1',
      status: 'COMPLETED',
      completedAt: new Date('2026-01-02T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      warehouse: { code: 'MAIN', name: 'Main' },
    },
  }))
  const client = {
    stockCountLine: {
      async count() { return lines.length },
      async findMany(args: { skip?: number; take?: number }) {
        return lines.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? lines.length))
      },
      async aggregate() {
        return { _sum: { expectedQty: new Prisma.Decimal(1500), countedQty: new Prisma.Decimal(1350), variance: new Prisma.Decimal(-150) } }
      },
      async groupBy() {
        return lines.slice(0, 3).map((line) => ({ sku: line.sku, _count: { _all: 1 }, _sum: { variance: line.variance } }))
      },
    },
    stockMovement: { async findMany() { return [] } },
  } as never

  const report = await getStockCountReport({ pageSize: 50 }, { client })
  assert.equal(report.rows.length, 50)
  assert.equal(report.pageInfo.totalRows, 150)
  assert.equal(report.totals.varianceQty, '-150')
})
