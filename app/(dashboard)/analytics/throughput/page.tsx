import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/server'
import { getThroughputAnalyticsReport, type ThroughputReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Throughput' }

export default async function ThroughputAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await getThroughputAnalyticsReport(filters)
  const columns: Array<SalesAnalyticsColumn<ThroughputReportRow>> = [
    { key: 'date', label: 'Date', render: (row) => row.date, footer: 'Totals' },
    { key: 'user', label: 'User', render: (row) => row.userName },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.orderCount.toLocaleString(), footer: report.totals.orders },
    { key: 'shipments', label: 'Shipments', align: 'right', render: (row) => row.shipmentCount.toLocaleString(), footer: report.totals.shipments },
    { key: 'lines', label: 'Lines', align: 'right', render: (row) => row.lineCount.toLocaleString(), footer: report.totals.lines },
    { key: 'queue', label: 'Current queue', align: 'right', render: (row) => row.queueDepth.toLocaleString(), footer: report.totals.queueDepth },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Throughput"
      description="Pick, pack, and ship throughput by day and operator from shipment activity logs."
      reportKey="throughput"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.date}:${row.userName}`}
      columns={columns}
      summary={[
        { label: 'Orders', value: report.totals.orders },
        { label: 'Shipments', value: report.totals.shipments },
        { label: 'Lines', value: report.totals.lines },
        { label: 'Current queue', value: report.totals.queueDepth, tone: 'warning' },
      ]}
      notices={report.notices}
    />
  )
}
