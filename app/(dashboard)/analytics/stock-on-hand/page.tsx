import type { Metadata } from 'next'
import {
  getStockOnHandReport,
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockOnHandReportRow,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'
import { ProductLink } from '@/components/inventory/product-link'
import { formatMoneyCode } from '@/lib/utils'
import { getOrganisation } from '@/app/actions/company'
import { requireStockPositionReportAccess } from '@/lib/security/stock-position-access'

export const metadata: Metadata = { title: 'Stock on Hand' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function filtersFromSearch(searchParams: SearchParams): StockPositionFilters {
  return {
    asOf: one(searchParams.asOf),
    warehouseId: one(searchParams.warehouseId),
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    includeZero: one(searchParams.includeZero) === '1',
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function isNegativeDecimalString(value: string): boolean {
  return value.trim().startsWith('-') && !value.startsWith('-0')
}

function reservationRowsCopy(count: number): string {
  return count === 1 ? '1 row' : `${count} rows`
}

function reservationRowsVerb(count: number): string {
  return count === 1 ? 'is' : 'are'
}

function reservationSnapshotsCopy(count: number): string {
  return count === 1 ? 'reservation snapshot' : 'reservation snapshots'
}

export default async function StockOnHandPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireStockPositionReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getStockOnHandReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const filtersForUi: StockPositionFilterValues = {
    asOf: filters.asOf,
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    includeZero: filters.includeZero,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<StockOnHandReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'type', label: 'Type', render: (row) => row.productType },
    { key: 'quantity', label: 'On hand', align: 'right', render: (row) => `${row.quantity} ${row.stockUnit}`, footer: report.totals.quantity },
    { key: 'reserved', label: 'Reserved', align: 'right', render: (row) => row.reservedQty, footer: report.totals.reservedQty },
    { key: 'available', label: 'Available', align: 'right', render: (row) => row.availableQty, footer: report.totals.availableQty },
    {
      key: 'unitCost',
      label: `Unit cost (${currency})`,
      align: 'right',
      render: (row) => row.unitCostBase == null ? 'Unvalued' : formatMoneyCode(Number(row.unitCostBase), currency, { minimumFractionDigits: 6, maximumFractionDigits: 6 }),
    },
    {
      key: 'value',
      label: `Value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.totalValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.totalValueBase), currency),
    },
  ]
  const notices = [
    report.reservedQtyScope === 'current'
      ? 'Reserved and available quantities use the current StockLevel reservation state.'
      : report.reservedQtyScope === 'snapshot'
        ? `Reserved and available quantities use reservation snapshots from ${report.reservationSnapshotDate}.`
        : report.reservedQtyScope === 'mixed_snapshot_current_missing'
          ? `Reservation snapshots cover ${reservationRowsCopy(report.reservationSnapshotCount)} for ${report.reservationSnapshotDate}; ${reservationRowsCopy(report.currentReservationFallbackCount)} fell back to current StockLevel reservations and are marked in the CSV export.`
          : `${reservationRowsCopy(report.missingReservationSnapshotCount)} ${reservationRowsVerb(report.missingReservationSnapshotCount)} missing ${reservationSnapshotsCopy(report.missingReservationSnapshotCount)} for ${report.reservationSnapshotDate}; those rows use current StockLevel reservations and are marked in the CSV export.`,
    // Reason-specific reliability notices so a revaluation / stock-cost-layer drift
    // cause is not misreported as missing value evidence (scjz.43/.44).
    (report.missingValueMovementCount > 0 || report.orphanWarehouseMovementCount > 0)
      ? 'This as-of value replay includes movements without value evidence or orphan warehouse movement rows.'
      : '',
    report.postAsOfRevaluationCount > 0
      ? 'This as-of value draws on a cost basis that was revalued after the as-of date, so it is not point-in-time accurate.'
      : '',
    report.currentValueDriftCount > 0
      ? 'Cost-layer quantities diverge from stock levels (orphan layers or stock/cost-layer desync).'
      : '',
  ].filter(Boolean)

  return (
    <StockPositionReportPage
      title="Stock on Hand"
      description="Current or as-of inventory quantity, reservation, availability and valuation by SKU and warehouse."
      reportKey="stock-on-hand"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.warehouseId}`}
      columns={columns}
      summary={[
        { label: 'On hand', value: report.totals.quantity },
        { label: 'Reserved', value: report.totals.reservedQty, tone: Number(report.totals.reservedQty) > 0 ? 'warning' : 'default' },
        { label: 'Available', value: report.totals.availableQty, tone: isNegativeDecimalString(report.totals.availableQty) ? 'danger' : 'default' },
        { label: `Value (${currency})`, value: formatMoneyCode(Number(report.totals.totalValueBase), currency) },
      ]}
      notices={notices}
      dateMode="as-of"
    />
  )
}
