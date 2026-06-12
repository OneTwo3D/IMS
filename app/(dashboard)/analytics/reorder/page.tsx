import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import {
  emptyReorderReportForSourceLimit,
  getReorderReport,
  type ReorderReportRow,
} from '@/lib/domain/inventory/replenishment-reports'
import { ReorderActionsToolbar } from './reorder-actions-client'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
  type StockPositionFilters,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireReplenishmentReportAccess } from '@/lib/security/replenishment-report-page-access'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
import {
  StockPositionReportPage,
  type StockPositionColumn,
  type StockPositionFilterValues,
} from '../_components/stock-position-report'

export const metadata: Metadata = { title: 'Reorder Planning' }

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
    warehouseId: one(searchParams.warehouseId),
    categoryId: one(searchParams.categoryId),
    supplierId: one(searchParams.supplierId),
    productType: one(searchParams.productType) as StockPositionFilters['productType'],
    thresholdDays: positiveInteger(one(searchParams.thresholdDays)),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function urgencyLabel(urgency: ReorderReportRow['urgency']): string {
  return urgency === 'critical' ? 'Critical' : urgency === 'reorder' ? 'Reorder' : 'Watch'
}

export default async function ReorderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireReplenishmentReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions] = await Promise.all([
    getReorderReport(filters).catch((error: unknown) => {
      if (isSourceScanTooLargeError(error)) return emptyReorderReportForSourceLimit(filters, error)
      throw error
    }),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
  ])
  const filtersForUi: StockPositionFilterValues = {
    warehouseId: filters.warehouseId,
    categoryId: filters.categoryId,
    supplierId: filters.supplierId,
    productType: filters.productType,
    thresholdDays: filters.thresholdDays == null ? undefined : String(filters.thresholdDays),
    pageSize: String(filters.pageSize ?? 100),
  }
  const columns: Array<StockPositionColumn<ReorderReportRow>> = [
    {
      key: 'sku',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'supplier', label: 'Supplier / source', render: (row) => row.supplierName ?? 'Unassigned' },
    { key: 'neededFor', label: 'Needed for', render: (row) => row.neededFor.join(', ') },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'available', label: 'Available', align: 'right', render: (row) => `${row.availableQty} ${row.stockUnit}`, footer: report.totals.availableQty },
    { key: 'warehouseAvailability', label: 'Warehouse availability', render: (row) => row.warehouseAvailabilityBreakdown || 'None' },
    { key: 'inbound', label: 'Inbound PO', align: 'right', render: (row) => row.inboundOpenPoQty, footer: report.totals.inboundOpenPoQty },
    { key: 'demand', label: 'Daily demand', align: 'right', render: (row) => row.averageDailyDemand },
    { key: 'leadTime', label: 'Lead time', align: 'right', render: (row) => `${row.leadTimeDays} days` },
    { key: 'reorderPoint', label: 'Reorder point', align: 'right', render: (row) => row.reorderPoint },
    { key: 'suggested', label: 'Suggested qty', align: 'right', render: (row) => row.suggestedReorderQty, footer: report.totals.suggestedReorderQty },
    { key: 'urgency', label: 'Status', render: (row) => urgencyLabel(row.urgency) },
  ]

  const toolbarRows = report.rows.map((row) => ({ productId: row.productId, productType: row.productType }))
  return (
    <div className="space-y-3">
      <ReorderActionsToolbar rows={toolbarRows} />
    <StockPositionReportPage
      title="Reorder Planning"
      description="Demand-driven replenishment suggestions using sales velocity, supplier lead time, safety stock, available stock, and inbound open POs."
      reportKey="reorder"
      exportBasePath="/api/export/replenishment"
      filters={filtersForUi}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.productId}
      columns={columns}
      summary={[
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString(), tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
        { label: 'Available', value: report.totals.availableQty },
        { label: 'Inbound open PO', value: report.totals.inboundOpenPoQty },
        { label: 'Suggested reorder', value: report.totals.suggestedReorderQty, tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
      ]}
      notices={report.notices}
      dateMode="none"
      showIncludeZero={false}
      showDemandWindowDays
    />
    </div>
  )
}
