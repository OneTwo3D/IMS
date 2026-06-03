import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import {
  emptyDeadStockReportForSourceLimit,
  getDeadStockReport,
  InventoryHealthSourceLimitError,
  type DeadStockReportRow,
} from '@/lib/domain/inventory/inventory-health-reports'
import { requireStockPositionReportAccess } from '@/lib/security/stock-position-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'
import { decimalStringPositive } from '../_components/report-utils'

export const metadata: Metadata = { title: 'Dead Stock' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value: string | undefined): { value: number | undefined; notice: string | null } {
  if (value == null || value.trim() === '') return { value: undefined, notice: null }
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0) return { value: parsed, notice: null }
  return { value: undefined, notice: `Threshold value "${value}" was invalid; using 90 days.` }
}

function filtersFromSearch(searchParams: SearchParams): { filters: StockPositionFilters; thresholdNotice: string | null } {
  const threshold = positiveInteger(one(searchParams.thresholdDays))
  return {
    filters: {
      asOf: one(searchParams.asOf),
      warehouseId: one(searchParams.warehouseId),
      categoryId: one(searchParams.categoryId),
      supplierId: one(searchParams.supplierId),
      productType: one(searchParams.productType) as StockPositionFilters['productType'],
      thresholdDays: threshold.value,
      page: Number(one(searchParams.page) ?? 1),
      pageSize: Number(one(searchParams.pageSize) ?? 100),
    },
    thresholdNotice: threshold.notice,
  }
}

function daysSinceLastSale(row: DeadStockReportRow): string {
  return row.daysSinceLastSale == null ? 'No sales in window' : `${row.daysSinceLastSale} days`
}

export default async function DeadStockPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireStockPositionReportAccess()
  const resolvedSearchParams = await searchParams
  const { filters, thresholdNotice } = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getDeadStockReport(filters).catch((error: unknown) => {
      if (error instanceof InventoryHealthSourceLimitError) return emptyDeadStockReportForSourceLimit(filters, error)
      throw error
    }),
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
    { key: 'lastSale', label: 'Last sale in window', render: (row) => row.lastSaleAt ? row.lastSaleAt.slice(0, 10) : 'None' },
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
        { label: `Value (${currency})`, value: formatMoneyCode(Number(report.totals.valueBase), currency), tone: decimalStringPositive(report.totals.valueBase) ? 'warning' : 'default' },
        { label: 'Never sold', value: report.totals.neverSoldRows.toLocaleString() },
        { label: 'Threshold', value: `${report.thresholdDays} days` },
      ]}
      notices={thresholdNotice ? [thresholdNotice, ...report.notices] : report.notices}
      dateMode="as-of"
      showIncludeZero={false}
      showThresholdDays
    />
  )
}
