import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/server'
import { getSalesAnalyticsReport, type SalesReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadSalesAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Sales Analytics' }

export default async function SalesAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadSalesAnalyticsReportForPage(filters, getSalesAnalyticsReport, { revenue: '0', tax: '0', shipping: '0', discount: '0' })
  const columns: Array<SalesAnalyticsColumn<SalesReportRow>> = [
    { key: 'group', label: 'Group', render: (row) => row.label, footer: 'Totals' },
    { key: 'currency', label: 'Currency', render: (row) => row.currency },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.orderCount.toLocaleString() },
    { key: 'lines', label: 'Lines', align: 'right', render: (row) => row.lineCount.toLocaleString() },
    { key: 'revenue', label: 'Revenue', align: 'right', render: (row) => row.revenue, footer: report.totals.revenue },
    { key: 'tax', label: 'Tax', align: 'right', render: (row) => row.tax, footer: report.totals.tax },
    { key: 'shipping', label: 'Shipping', align: 'right', render: (row) => row.shipping, footer: report.totals.shipping },
    { key: 'discount', label: 'Discount', align: 'right', render: (row) => row.discount, footer: report.totals.discount },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Sales Analytics"
      description="Revenue, tax, shipping, and discount totals grouped by product, category, customer, or channel."
      reportKey="sales"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.key}
      columns={columns}
      summary={[
        { label: 'Revenue', value: report.totals.revenue },
        { label: 'Tax', value: report.totals.tax },
        { label: 'Shipping', value: report.totals.shipping },
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      notices={report.notices}
      showGroupBy
      showCurrencyMode
    />
  )
}
