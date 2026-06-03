import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/server'
import { getFulfillmentAnalyticsReport, type FulfillmentReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Fulfillment KPIs' }

export default async function FulfillmentAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await getFulfillmentAnalyticsReport(filters)
  const columns: Array<SalesAnalyticsColumn<FulfillmentReportRow>> = [
    { key: 'metric', label: 'Metric', render: (row) => row.metric },
    { key: 'value', label: 'Value', align: 'right', render: (row) => row.value },
    { key: 'numerator', label: 'Numerator', align: 'right', render: (row) => row.numerator },
    { key: 'denominator', label: 'Denominator', align: 'right', render: (row) => row.denominator },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Fulfillment KPIs"
      description="On-time shipping, fill rate, order-to-ship elapsed days, and partial-shipment rate from shipment timestamps."
      reportKey="fulfillment"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.metric}
      columns={columns}
      summary={[
        { label: 'Shipped orders', value: report.totals.shippedOrders },
        { label: 'Shipped qty', value: report.totals.shippedQty },
      ]}
      notices={report.notices}
    />
  )
}
