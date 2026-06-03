import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import {
  getComponentShortageReport,
  type ComponentShortageReportRow,
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

export const metadata: Metadata = { title: 'Component Shortages' }

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

export default async function ComponentShortagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireReplenishmentReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions] = await Promise.all([
    getComponentShortageReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
  ])
  const filtersForUi: StockPositionFilterValues = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<ComponentShortageReportRow>> = [
    {
      key: 'sku',
      label: 'Component',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => row.warehouseCode },
    { key: 'outputs', label: 'Needed for', render: (row) => row.outputProducts.slice(0, 3).join(', ') },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.productionOrderCount.toLocaleString() },
    { key: 'required', label: 'Required', align: 'right', render: (row) => row.requiredQty, footer: report.totals.requiredQty },
    { key: 'available', label: 'Available', align: 'right', render: (row) => row.availableQty, footer: report.totals.availableQty },
    { key: 'inbound', label: 'Inbound PO', align: 'right', render: (row) => row.inboundOpenPoQty, footer: report.totals.inboundOpenPoQty },
    { key: 'shortage', label: 'Shortage', align: 'right', render: (row) => `${row.shortageQty} ${row.stockUnit}`, footer: report.totals.shortageQty },
    { key: 'scheduled', label: 'Earliest scheduled', render: (row) => row.earliestScheduledAt?.slice(0, 10) ?? 'Unscheduled' },
  ]

  return (
    <StockPositionReportPage
      title="Component Shortages"
      description="BOM component shortfalls across draft and in-progress production orders, net of available stock and inbound open POs."
      reportKey="component-shortage"
      exportBasePath="/api/export/replenishment"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.warehouseId}`}
      columns={columns}
      summary={[
        { label: 'Components', value: report.pageInfo.totalRows.toLocaleString(), tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
        { label: 'Required', value: report.totals.requiredQty },
        { label: 'Available', value: report.totals.availableQty },
        { label: 'Shortage', value: report.totals.shortageQty, tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
      ]}
      notices={report.notices}
      dateMode="none"
      showIncludeZero={false}
    />
  )
}
