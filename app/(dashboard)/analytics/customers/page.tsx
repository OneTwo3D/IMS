import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/server'
import { getCustomerAnalyticsReport, type CustomerReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadSalesAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Customer Mix' }

export default async function CustomerAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadSalesAnalyticsReportForPage(filters, getCustomerAnalyticsReport, { revenueBase: '0', grossProfitBase: '0', arExposureBase: '0' })
  const columns: Array<SalesAnalyticsColumn<CustomerReportRow>> = [
    { key: 'customer', label: 'Customer', render: (row) => row.customerName, footer: 'Totals' },
    { key: 'email', label: 'Email', render: (row) => row.customerEmail ?? '' },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.orderCount.toLocaleString() },
    { key: 'revenue', label: 'Revenue', align: 'right', render: (row) => row.revenueBase, footer: report.totals.revenueBase },
    { key: 'profit', label: 'Gross profit', align: 'right', render: (row) => row.grossProfitBase, footer: report.totals.grossProfitBase },
    { key: 'ar', label: 'AR exposure', align: 'right', render: (row) => row.arExposureBase, footer: report.totals.arExposureBase },
    { key: 'share', label: 'Share', align: 'right', render: (row) => `${row.shareOfRevenuePct}%` },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Customer Mix"
      description="Top customers by revenue, gross profit, unpaid AR exposure, and share of selected-period sales."
      reportKey="customers"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => row.customerId ?? `${row.customerName}:${index}`}
      columns={columns}
      summary={[
        { label: 'Revenue', value: report.totals.revenueBase },
        { label: 'Gross profit', value: report.totals.grossProfitBase },
        { label: 'AR exposure', value: report.totals.arExposureBase, tone: 'warning' },
        { label: 'Customers', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      notices={report.notices}
    />
  )
}
