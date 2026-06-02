import type { Metadata } from 'next'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import {
  getInventoryAgingReport,
  type InventoryAgingReportRow,
} from '@/lib/domain/inventory/inventory-health-reports'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import { requireStockPositionReportAccess } from '@/lib/security/stock-position-access'
import { formatMoneyCode } from '@/lib/utils'

export const metadata: Metadata = { title: 'Inventory Aging' }

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
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function ageLabel(row: InventoryAgingReportRow): string {
  return row.maxAgeDays == null
    ? `${row.minAgeDays}+ days`
    : `${row.minAgeDays}-${row.maxAgeDays} days`
}

export default async function InventoryAgingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireStockPositionReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getInventoryAgingReport(filters),
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
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<InventoryAgingReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'type', label: 'Type', render: (row) => row.productType },
    { key: 'bucket', label: 'Age bucket', render: (row) => `${row.bucket} (${ageLabel(row)})` },
    { key: 'source', label: 'Source', render: (row) => row.source === 'kit_component' ? 'KIT components' : 'Cost layers' },
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
      title="Inventory Aging"
      description="Open FIFO cost-layer quantity and value bucketed by receipt age as of the selected UTC date."
      reportKey="inventory-aging"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.productName}:${row.warehouseId}:${row.source}:${row.bucket}`}
      columns={columns}
      summary={[
        { label: 'Aged rows', value: report.pageInfo.totalRows.toLocaleString() },
        { label: 'Quantity', value: report.totals.qty },
        { label: `Value (${currency})`, value: formatMoneyCode(Number(report.totals.valueBase), currency) },
        { label: 'KIT mode', value: report.kitAgingMode },
      ]}
      notices={report.notices}
      dateMode="as-of"
      showIncludeZero={false}
    />
  )
}
