import type { Metadata } from 'next'
import Link from 'next/link'
import { requireRole } from '@/lib/auth/server'
import {
  getStockAllocationReport,
  getStockPositionFilterOptions,
  type StockAllocationReportRow,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'
import { ProductLink } from '@/components/inventory/product-link'

export const metadata: Metadata = { title: 'Stock Allocations' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function filtersFromSearch(searchParams: SearchParams): StockPositionFilters {
  return {
    warehouseId: one(searchParams.warehouseId),
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function sourceLabel(source: StockAllocationReportRow['source']): string {
  switch (source) {
    case 'sales_order':
      return 'Sales order'
    case 'stock_transfer':
      return 'Transfer'
    case 'production_order':
      return 'Production'
    default:
      return 'Other'
  }
}

export default async function StockAllocationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE')
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions] = await Promise.all([
    getStockAllocationReport(filters),
    getStockPositionFilterOptions(),
  ])
  const filtersForUi: StockPositionFilterValues = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<StockAllocationReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'source', label: 'Source', render: (row) => sourceLabel(row.source) },
    {
      key: 'reference',
      label: 'Reference',
      render: (row) => row.referenceHref
        ? <Link href={row.referenceHref} className="font-medium text-primary hover:underline">{row.referenceLabel}</Link>
        : row.referenceLabel,
    },
    { key: 'expected', label: 'Expected clear', render: (row) => row.expectedDate?.slice(0, 10) ?? 'Undated' },
    { key: 'ageBucket', label: 'Age bucket', render: (row) => row.ageBucket.replaceAll('_', ' ') },
    { key: 'reserved', label: 'Reserved', align: 'right', render: (row) => `${row.reservedQty} ${row.stockUnit}`, footer: report.totals.reservedQty },
    { key: 'stockLevelReserved', label: 'StockLevel reserved', align: 'right', render: (row) => row.stockLevelReservedQty, footer: report.totals.stockLevelReservedQty },
    { key: 'drift', label: 'Drift', align: 'right', render: (row) => row.driftQty, footer: report.totals.driftQty },
  ]

  return (
    <StockPositionReportPage
      title="Stock Allocations"
      description="Reserved stock by source document, with unattributed balances shown when source rows do not reconcile to StockLevel.reservedQty."
      reportKey="stock-allocations"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      columns={columns}
      summary={[
        { label: 'Reserved', value: report.totals.reservedQty },
        { label: 'StockLevel reserved', value: report.totals.stockLevelReservedQty },
        { label: 'Drift', value: report.totals.driftQty, tone: Number(report.totals.driftQty) !== 0 ? 'danger' : 'default' },
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      dateMode="none"
    />
  )
}
