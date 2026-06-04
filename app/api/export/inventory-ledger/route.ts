import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { csvBufferedStreamResponse } from '@/lib/csv'
import { db } from '@/lib/db'
import {
  getInventoryLedgerExportRowCount,
  getStockAdjustmentReport,
  getStockCountReport,
  getStockMovementLedgerReport,
  getStockTransferReport,
  type InventoryLedgerExportReportType,
  type InventoryLedgerFilters,
} from '@/lib/domain/inventory/inventory-ledger-reports'
import { inventoryLedgerApiAccessDenied } from '@/lib/security/inventory-ledger-access'

const INVENTORY_LEDGER_CSV_ROW_LIMIT = 100000

async function loadMpnByProductId(productIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(productIds.filter((id): id is string => Boolean(id))))
  if (ids.length === 0) return new Map()
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, mpn: true },
  })
  return new Map(products.map((product) => [product.id, product.mpn ?? '']))
}

function one(req: NextRequest, key: string): string | undefined {
  return req.nextUrl.searchParams.get(key) ?? undefined
}

function filtersFromRequest(req: NextRequest): InventoryLedgerFilters {
  return {
    dateFrom: one(req, 'dateFrom') ?? one(req, 'from'),
    dateTo: one(req, 'dateTo') ?? one(req, 'to'),
    warehouseId: one(req, 'warehouseId'),
    product: one(req, 'product'),
    type: one(req, 'type') as InventoryLedgerFilters['type'],
    status: one(req, 'status'),
    reference: one(req, 'reference'),
    minValue: one(req, 'minValue'),
  }
}

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  const denied = inventoryLedgerApiAccessDenied(session)
  if (denied) return denied

  const type = req.nextUrl.searchParams.get('report') ?? 'stock-movements'
  const date = new Date().toISOString().slice(0, 10)
  const filters = filtersFromRequest(req)

  if (!isInventoryLedgerExportReportType(type)) {
    return NextResponse.json({ error: 'Unknown inventory-ledger export type' }, { status: 400 })
  }
  const rowCount = await getInventoryLedgerExportRowCount(type, filters)
  if (rowCount > INVENTORY_LEDGER_CSV_ROW_LIMIT) {
    return NextResponse.json(
      { error: `Inventory ledger CSV exports are capped at ${INVENTORY_LEDGER_CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters and retry.` },
      { status: 413 },
    )
  }

  switch (type) {
    case 'stock-movements': {
      const report = await getStockMovementLedgerReport(filters, { paginate: false })
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        createdAt: row.createdAt,
        type: row.type,
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
        productName: row.productName,
        stockUnit: row.stockUnit,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        qty: row.qty,
        signedQty: row.signedQty,
        unitCostBase: row.unitCostBase ?? '',
        totalValueBase: row.totalValueBase,
        signedValueBase: row.signedValueBase,
        referenceType: row.referenceType ?? '',
        referenceId: row.referenceId ?? '',
        note: row.note ?? '',
        openingQty: report.totals.openingQty,
        movementQty: report.totals.movementQty,
        closingQty: report.totals.closingQty,
        openingValueBase: report.totals.openingValueBase,
        movementValueBase: report.totals.movementValueBase,
        closingValueBase: report.totals.closingValueBase,
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['createdAt', 'type', 'sku', 'mpn', 'productName', 'stockUnit', 'warehouseCode', 'warehouseName', 'qty', 'signedQty', 'unitCostBase', 'totalValueBase', 'signedValueBase', 'referenceType', 'referenceId', 'note', 'openingQty', 'movementQty', 'closingQty', 'openingValueBase', 'movementValueBase', 'closingValueBase', 'generatedAt'], `stock-movements-${date}.csv`)
    }

    case 'stock-adjustments': {
      const report = await getStockAdjustmentReport(filters, { paginate: false })
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        createdAt: row.createdAt,
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
        productName: row.productName,
        stockUnit: row.stockUnit,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        reasonName: row.reasonName,
        reasonMatched: row.reasonMatched,
        signedQty: row.signedQty,
        totalValueBase: row.totalValueBase,
        referenceType: row.referenceType ?? '',
        referenceId: row.referenceId ?? '',
        note: row.note ?? '',
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['createdAt', 'sku', 'mpn', 'productName', 'stockUnit', 'warehouseCode', 'warehouseName', 'reasonName', 'reasonMatched', 'signedQty', 'totalValueBase', 'referenceType', 'referenceId', 'note', 'generatedAt'], `stock-adjustments-${date}.csv`)
    }

    case 'transfers': {
      const report = await getStockTransferReport(filters, { paginate: false })
      const rows = report.rows.map((row) => ({
        reference: row.reference,
        status: row.status,
        fromWarehouseCode: row.fromWarehouseCode,
        fromWarehouseName: row.fromWarehouseName,
        toWarehouseCode: row.toWarehouseCode,
        toWarehouseName: row.toWarehouseName,
        dispatchedAt: row.dispatchedAt ?? '',
        completedAt: row.completedAt ?? '',
        daysInTransit: row.daysInTransit,
        overdue: row.overdue,
        requestedQty: row.requestedQty,
        receivedQty: row.receivedQty,
        driftQty: row.driftQty,
        movementOutQty: row.movementOutQty,
        movementInQty: row.movementInQty,
        movementValueBase: row.movementValueBase,
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['reference', 'status', 'fromWarehouseCode', 'fromWarehouseName', 'toWarehouseCode', 'toWarehouseName', 'dispatchedAt', 'completedAt', 'daysInTransit', 'overdue', 'requestedQty', 'receivedQty', 'driftQty', 'movementOutQty', 'movementInQty', 'movementValueBase', 'generatedAt'], `transfers-${date}.csv`)
    }

    case 'stock-counts': {
      const report = await getStockCountReport(filters, { paginate: false })
      const mpnByProductId = await loadMpnByProductId(report.rows.map((row) => row.productId))
      const rows = report.rows.map((row) => ({
        reference: row.reference,
        status: row.status,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        sku: row.sku,
        mpn: mpnByProductId.get(row.productId) ?? '',
        productId: row.productId,
        expectedQty: row.expectedQty,
        countedQty: row.countedQty ?? '',
        varianceQty: row.varianceQty,
        linkedAdjustmentValueBase: row.linkedAdjustmentValueBase ?? '',
        adjustmentEvidence: row.adjustmentEvidence,
        completedAt: row.completedAt ?? '',
        generatedAt: report.generatedAt,
      }))
      return csvBufferedStreamResponse(rows, ['reference', 'status', 'warehouseCode', 'warehouseName', 'sku', 'mpn', 'productId', 'expectedQty', 'countedQty', 'varianceQty', 'linkedAdjustmentValueBase', 'adjustmentEvidence', 'completedAt', 'generatedAt'], `stock-counts-${date}.csv`)
    }

    default:
      return NextResponse.json({ error: 'Unknown inventory-ledger export type' }, { status: 400 })
  }
}

function isInventoryLedgerExportReportType(value: string): value is InventoryLedgerExportReportType {
  return value === 'stock-movements' || value === 'stock-adjustments' || value === 'transfers' || value === 'stock-counts'
}
