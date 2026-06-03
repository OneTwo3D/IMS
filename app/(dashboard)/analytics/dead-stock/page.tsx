import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import {
  getDeadStockReport,
  type DeadStockReportRow,
} from '@/lib/domain/inventory/inventory-health-reports'
import { requireStockPositionReportAccess } from '@/lib/security/stock-position-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'

export const metadata: Metadata = { title: 'Dead Stock' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function filtersFromSearch(searchParams: SearchParams): StockPositionFilters {
  return {
    asOf: one(searchParams.asOf),
    warehouseId: one(searchParams.warehouseId),
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    thresholdDays: positiveInteger(one(searchParams.thresholdDays)),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function daysSinceLastSale(row: DeadStockReportRow): string {
  return row.daysSinceLastSale == null ? 'Never sold' : `${row.daysSinceLastSale} days`
}

export default async function DeadStockPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireStockPositionReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getDeadStockReport(filters),
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
    thresholdDays: String(report.thresholdDays),
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<DeadStockReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'type', label: 'Type', render: (row) => row.productType },
    { key: 'lastSale', label: 'Last sale', render: (row) => row.lastSaleAt ? row.lastSaleAt.slice(0, 10) : 'Never' },
    { key: 'daysSinceLastSale', label: 'No-sales age', align: 'right', render: daysSinceLastSale },
    {
      key: 'qty',
      label: 'Qty',
      align: 'right',
      render: (row) => `${row.qty} ${row.stockUnit}`,
      footer: report.totals.qty,
    },
    {
      key: 'value',
      label: `Value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.valueBase), currency),
      footer: formatMoneyCode(Number(report.totals.valueBase), currency),
    },
  ]

  return (
    <StockPositionReportPage
      title="Dead Stock"
      description="Current stocked SKUs with no sale dispatch inside the selected no-sales threshold. Newly stocked never-sold SKUs are excluded until they age past the threshold."
      reportKey="dead-stock"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.warehouseId}`}
      columns={columns}
      summary={[
        { label: 'Dead-stock rows', value: report.pageInfo.totalRows.toLocaleString(), tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
        { label: 'Quantity', value: report.totals.qty },
        { label: `Value (${currency})`, value: formatMoneyCode(Number(report.totals.valueBase), currency), tone: Number(report.totals.valueBase) > 0 ? 'warning' : 'default' },
        { label: 'Never sold', value: report.totals.neverSoldRows.toLocaleString() },
        { label: 'Threshold', value: `${report.thresholdDays} days` },
      ]}
      notices={report.notices}
      dateMode="as-of"
      showIncludeZero={false}
      showThresholdDays
    />
  )
}
