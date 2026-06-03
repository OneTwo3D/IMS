import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import {
  getBackorderDemandReport,
  type BackorderDemandReportRow,
} from '@/lib/domain/inventory/replenishment-reports'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireReplenishmentReportAccess } from '@/lib/security/replenishment-report-access'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'

export const metadata: Metadata = { title: 'Backorders' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function filtersFromSearch(searchParams: SearchParams): StockPositionFilters {
  return {
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

export default async function BackorderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireReplenishmentReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions] = await Promise.all([
    getBackorderDemandReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
  ])
  const filtersForUi: StockPositionFilterValues = {
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<BackorderDemandReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'suppliers', label: 'Suppliers', render: (row) => row.supplierNames.join(', ') || 'Unassigned' },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.orderCount.toLocaleString() },
    { key: 'ordered', label: 'Ordered', align: 'right', render: (row) => row.orderedQty, footer: report.totals.orderedQty },
    { key: 'committed', label: 'Committed', align: 'right', render: (row) => row.committedQty, footer: report.totals.committedQty },
    { key: 'allocated', label: 'Allocated', align: 'right', render: (row) => row.allocatedQty, footer: report.totals.allocatedQty },
    { key: 'backorder', label: 'Backorder', align: 'right', render: (row) => `${row.backorderQty} ${row.stockUnit}`, footer: report.totals.backorderQty },
    { key: 'inbound', label: 'Inbound PO', align: 'right', render: (row) => row.inboundOpenPoQty },
    { key: 'fill', label: 'Projected fill', render: (row) => row.projectedFillDate ?? 'No inbound PO' },
  ]

  return (
    <StockPositionReportPage
      title="Backorders"
      description="Sales demand that is not covered by committed shipments or current allocations, aggregated by SKU."
      reportKey="backorder"
      exportBasePath="/api/export/replenishment"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.productId}
      columns={columns}
      summary={[
        { label: 'Products', value: report.pageInfo.totalRows.toLocaleString(), tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
        { label: 'Ordered', value: report.totals.orderedQty },
        { label: 'Allocated', value: report.totals.allocatedQty },
        { label: 'Backorder', value: report.totals.backorderQty, tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
      ]}
      notices={report.notices}
      dateMode="none"
      showIncludeZero={false}
    />
  )
}
