import Link from 'next/link'
import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import {
  getProductionVarianceReport,
  ManufacturingAnalyticsSourceLimitError,
  type ManufacturingAnalyticsReport,
  type ProductionVarianceReportRow,
} from '@/lib/domain/manufacturing/manufacturing-analytics'
import { requireManufacturingAnalyticsAccess } from '@/lib/security/manufacturing-analytics-page-access'
import {
  ManufacturingAnalyticsReportPage,
  type ManufacturingAnalyticsColumn,
} from '../_components/manufacturing-analytics-report'
import {
  manufacturingAnalyticsFiltersForUi,
  manufacturingAnalyticsFiltersFromSearch,
  type ManufacturingAnalyticsSearchParams,
} from '../_components/manufacturing-analytics-page-utils'

export const metadata: Metadata = { title: 'Production Variance' }

type Props = { searchParams: Promise<ManufacturingAnalyticsSearchParams> }

const columns: Array<ManufacturingAnalyticsColumn<ProductionVarianceReportRow>> = [
  {
    key: 'order',
    label: 'Production order',
    render: (row) => <Link href={row.productionOrderHref} className="font-medium text-primary hover:underline">{row.productionOrderReference}</Link>,
    footer: 'Totals',
  },
  { key: 'status', label: 'Status', render: (row) => row.status },
  { key: 'warehouse', label: 'Warehouse', render: (row) => row.warehouseCode },
  { key: 'output', label: 'Output', render: (row) => <span title={row.outputProductName}>{row.outputSku}</span> },
  {
    key: 'component',
    label: 'Component',
    render: (row) => <ProductLink productId={row.componentProductId} sku={row.componentSku} name={row.componentName} />,
  },
  { key: 'planned', label: 'Planned', align: 'right', render: (row) => `${row.plannedQty} ${row.stockUnit}` },
  { key: 'actual', label: 'Actual', align: 'right', render: (row) => `${row.actualQty} ${row.stockUnit}` },
  { key: 'variance', label: 'Variance', align: 'right', render: (row) => row.varianceQty },
  { key: 'variancePct', label: 'Variance %', align: 'right', render: (row) => row.variancePct ? `${row.variancePct}%` : '-' },
  { key: 'overConsumed', label: 'Over-consumed', align: 'right', render: (row) => row.overConsumedQty },
  { key: 'overConsumedValue', label: 'Over-consumed value', align: 'right', render: (row) => row.overConsumedValueBase },
  { key: 'yield', label: 'Order yield %', align: 'right', render: (row) => row.orderYieldPct ? `${row.orderYieldPct}%` : '-' },
]

export default async function ProductionVariancePage({ searchParams }: Props) {
  await requireManufacturingAnalyticsAccess()
  const filters = manufacturingAnalyticsFiltersFromSearch(await searchParams)
  let report: ManufacturingAnalyticsReport<ProductionVarianceReportRow>
  try {
    report = await getProductionVarianceReport(filters)
  } catch (error) {
    if (!(error instanceof ManufacturingAnalyticsSourceLimitError)) throw error
    report = {
      generatedAt: new Date().toISOString(),
      dateFrom: filters.dateFrom ?? null,
      dateTo: filters.dateTo ?? null,
      rows: [],
      pageInfo: { page: 1, pageSize: filters.pageSize ?? 100, totalRows: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      totals: {},
      notices: [error.message],
    }
  }
  return (
    <ManufacturingAnalyticsReportPage
      title="Production Variance"
      description="Planned BOM component demand versus actual PRODUCTION_OUT consumption for assembly production orders."
      reportKey="production-variance"
      filters={manufacturingAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productionOrderId}:${row.componentProductId}`}
      columns={columns}
      summary={[
        { label: 'Planned qty', value: report.totals.plannedQty ?? '0' },
        { label: 'Actual qty', value: report.totals.actualQty ?? '0' },
        { label: 'Variance qty', value: report.totals.varianceQty ?? '0', tone: report.totals.varianceQty === '0' ? 'default' : 'warning' },
        { label: 'Over-consumed value', value: report.totals.overConsumedValueBase ?? '0', tone: report.totals.overConsumedValueBase === '0' ? 'default' : 'warning' },
      ]}
      notices={report.notices}
    />
  )
}
