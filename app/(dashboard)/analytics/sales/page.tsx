import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/server'
import { boundSuffix, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import type { SalesReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadSalesReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Sales Analytics' }

export default async function SalesAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadSalesReportForPage(filters)
  const bound = (value: string | undefined) => boundSuffix((value ?? 'exact') as DerivedFigureBound)
  const columns: Array<SalesAnalyticsColumn<SalesReportRow>> = [
    { key: 'group', label: 'Group', render: (row) => row.label, footer: 'Totals' },
    { key: 'currency', label: 'Currency', render: (row) => row.currency },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.orderCount.toLocaleString() },
    { key: 'lines', label: 'Lines', align: 'right', render: (row) => row.lineCount.toLocaleString() },
    { key: 'revenue', label: 'Revenue (invoiced)', align: 'right', render: (row) => row.revenue, footer: report.totals.revenue },
    // o3d-kyey: the refund-aware figure sits BESIDE the invoiced one rather than replacing it — this
    // report's contract is that its totals reconcile to SalesOrder totals, and a figure net of credit
    // notes cannot also do that. `≤` means at most the true figure.
    { key: 'netRevenue', label: 'Net revenue', align: 'right', render: (row) => `${row.netRevenue}${boundSuffix(row.netRevenueBound)}`, footer: `${report.totals.netRevenue}${bound(report.totals.netRevenueBound)}` },
    { key: 'tax', label: 'Tax', align: 'right', render: (row) => row.tax, footer: report.totals.tax },
    { key: 'shipping', label: 'Shipping', align: 'right', render: (row) => row.shipping, footer: report.totals.shipping },
    { key: 'discount', label: 'Discount', align: 'right', render: (row) => row.discount, footer: report.totals.discount },
    { key: 'creditGross', label: 'Credit (gross basis)', align: 'right', render: (row) => row.refundsGrossBasis, footer: report.totals.refundsGrossBasis },
    { key: 'creditNet', label: 'Credit (net basis)', align: 'right', render: (row) => row.refundsNetBasis, footer: report.totals.refundsNetBasis },
    { key: 'creditUnknown', label: 'Credit (unproven basis)', align: 'right', render: (row) => row.refundsUnknownBasis, footer: report.totals.refundsUnknownBasis },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Sales Analytics"
      description="Invoiced revenue, tax, shipping and discount grouped by product, category, customer or channel, with net revenue after same-basis credit beside them."
      reportKey="sales"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.key}
      columns={columns}
      summary={[
        { label: 'Revenue (invoiced)', value: report.totals.revenue },
        { label: 'Net revenue', value: `${report.totals.netRevenue}${bound(report.totals.netRevenueBound)}` },
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
