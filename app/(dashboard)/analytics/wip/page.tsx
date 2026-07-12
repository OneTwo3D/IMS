import Link from 'next/link'
import type { Metadata } from 'next'
import {
  getWipReport,
  ManufacturingAnalyticsSourceLimitError,
  type ManufacturingAnalyticsReport,
  type WipReportRow,
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

export const metadata: Metadata = { title: 'WIP' }

type Props = { searchParams: Promise<ManufacturingAnalyticsSearchParams> }

const columns: Array<ManufacturingAnalyticsColumn<WipReportRow>> = [
  {
    key: 'order',
    label: 'Production order',
    render: (row) => <Link href={row.productionOrderHref} className="font-medium text-primary hover:underline">{row.productionOrderReference}</Link>,
    footer: 'Totals',
  },
  { key: 'warehouse', label: 'Warehouse', render: (row) => row.warehouseCode },
  { key: 'output', label: 'Output', render: (row) => <span title={row.outputProductName}>{row.outputSku}</span> },
  { key: 'started', label: 'Started', render: (row) => row.startedAt?.slice(0, 10) ?? 'Not started' },
  { key: 'days', label: 'Days', align: 'right', render: (row) => row.daysSinceStart },
  { key: 'planned', label: 'Planned', align: 'right', render: (row) => row.plannedOutputQty },
  { key: 'produced', label: 'Produced', align: 'right', render: (row) => row.producedQty },
  { key: 'remaining', label: 'Remaining', align: 'right', render: (row) => row.remainingOutputQty },
  { key: 'costLines', label: 'Cost lines', align: 'right', render: (row) => row.costLineCount },
  { key: 'manufacturingCost', label: 'Manufacturing cost', align: 'right', render: (row) => row.manufacturingCostBase },
  { key: 'consumedValue', label: 'Consumed value', align: 'right', render: (row) => row.consumedComponentValueBase },
  { key: 'expectedOutput', label: 'Expected output value', align: 'right', render: (row) => row.expectedOutputValueBase },
  { key: 'wipValue', label: 'WIP value', align: 'right', render: (row) => row.wipValueBase },
]

export default async function WipPage({ searchParams }: Props) {
  await requireManufacturingAnalyticsAccess()
  const filters = manufacturingAnalyticsFiltersFromSearch(await searchParams)
  const reportFilters = { page: filters.page, pageSize: filters.pageSize }
  let report: ManufacturingAnalyticsReport<WipReportRow>
  try {
    report = await getWipReport(reportFilters)
  } catch (error) {
    if (!(error instanceof ManufacturingAnalyticsSourceLimitError)) throw error
    report = {
      generatedAt: new Date().toISOString(),
      dateFrom: null,
      dateTo: null,
      rows: [],
      pageInfo: { page: 1, pageSize: filters.pageSize ?? 100, totalRows: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      totals: {},
      notices: [error.message],
    }
  }
  return (
    <ManufacturingAnalyticsReportPage
      title="WIP"
      description="Current in-progress production orders with WIP value from posted component consumption plus manufacturing cost-line base totals."
      reportKey="wip"
      filters={manufacturingAnalyticsFiltersForUi(reportFilters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.productionOrderId}
      columns={columns}
      summary={[
        { label: 'Open orders', value: report.pageInfo.totalRows.toLocaleString(), tone: report.pageInfo.totalRows > 0 ? 'warning' : 'default' },
        { label: 'WIP value', value: report.totals.wipValueBase ?? '0' },
        { label: 'Consumed value', value: report.totals.consumedComponentValueBase ?? '0' },
        { label: 'Expected output value', value: report.totals.expectedOutputValueBase ?? '0' },
      ]}
      notices={report.notices}
      showDateFilters={false}
    />
  )
}
