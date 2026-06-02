import type { Metadata } from 'next'
import {
  getNegativeStockReport,
  getStockPositionFilterOptions,
  type NegativeStockReportRow,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'
import { ProductLink } from '@/components/inventory/product-link'
import { requireStockPositionReportAccess } from '@/lib/security/stock-position-access'

export const metadata: Metadata = { title: 'Negative Stock' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function filtersFromSearch(searchParams: SearchParams): StockPositionFilters {
  return {
    dateFrom: one(searchParams.dateFrom),
    dateTo: one(searchParams.dateTo),
    warehouseId: one(searchParams.warehouseId),
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function isNegativeDecimalString(value: string): boolean {
  return value.trim().startsWith('-') && !value.startsWith('-0')
}

export default async function NegativeStockPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireStockPositionReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions] = await Promise.all([
    getNegativeStockReport(filters),
    getStockPositionFilterOptions(),
  ])
  const filtersForUi: StockPositionFilterValues = {
    dateFrom: filters.dateFrom ?? report.dateFrom,
    dateTo: filters.dateTo ?? report.dateTo,
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<NegativeStockReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'status', label: 'Status', render: (row) => row.status.replace('_', ' ') },
    { key: 'currentQty', label: 'Current qty', align: 'right', render: (row) => `${row.currentQty} ${row.stockUnit}` },
    { key: 'minimumQty', label: 'Minimum qty', align: 'right', render: (row) => row.minimumQty, footer: report.totals.minimumQty },
    { key: 'firstNegativeAt', label: 'First negative', render: (row) => row.firstNegativeAt?.slice(0, 10) ?? 'Current only' },
    { key: 'lastMovementAt', label: 'Last movement', render: (row) => row.lastMovementAt?.slice(0, 10) ?? 'None in range' },
    { key: 'movementCount', label: 'Movements', align: 'right', render: (row) => row.movementCount.toLocaleString() },
  ]

  return (
    <StockPositionReportPage
      title="Negative Stock"
      description="Product and warehouse pairs that are currently negative or went negative during the selected movement window."
      reportKey="negative-stock"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.warehouseId}`}
      columns={columns}
      summary={[
        { label: 'Current negative', value: report.totals.currentNegativeRows.toLocaleString(), tone: report.totals.currentNegativeRows > 0 ? 'danger' : 'default' },
        { label: 'Historical negative', value: report.totals.historicalNegativeRows.toLocaleString(), tone: report.totals.historicalNegativeRows > 0 ? 'warning' : 'default' },
        { label: 'Minimum qty', value: report.totals.minimumQty, tone: isNegativeDecimalString(report.totals.minimumQty) ? 'danger' : 'default' },
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      notices={!filters.dateFrom ? ['Showing the default 90-day movement window because no From date is selected.'] : []}
      dateMode="range"
    />
  )
}
