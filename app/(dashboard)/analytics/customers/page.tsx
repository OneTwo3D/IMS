import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/server'
import { boundSuffix, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import { INCONSISTENT_CELL_TEXT, WITHHELD_CELL_TEXT } from '@/lib/analytics/withheld-figure-cell'
import type { CustomerReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadCustomerAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Customer Mix' }

export default async function CustomerAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadCustomerAnalyticsReportForPage(filters)
  // o3d-kyey: the bound travels with every figure it qualifies, on the row AND in the footer, so a
  // reader cannot see the number without seeing what it is. `≤` means at most the true figure; `?`
  // means a bound exists but its direction is not established (see derived-figure-bound.ts).
  const bound = (value: string | undefined) => boundSuffix((value ?? 'exact') as DerivedFigureBound)
  const columns: Array<SalesAnalyticsColumn<CustomerReportRow>> = [
    { key: 'customer', label: 'Customer', render: (row) => row.customerName, footer: 'Totals' },
    { key: 'email', label: 'Email', render: (row) => row.customerEmail ?? '' },
    { key: 'orders', label: 'Orders', align: 'right', render: (row) => row.orderCount.toLocaleString() },
    { key: 'revenue', label: 'Revenue (invoiced)', align: 'right', render: (row) => row.revenueBase, footer: report.totals.revenueBase },
    { key: 'netRevenue', label: 'Net revenue', align: 'right', render: (row) => `${row.netRevenueBase}${boundSuffix(row.netRevenueBaseBound)}`, footer: `${report.totals.netRevenueBase}${bound(report.totals.netRevenueBaseBound)}` },
    { key: 'netRevenueExVat', label: 'Net revenue (ex VAT)', align: 'right', render: (row) => `${row.netRevenueExVatBase}${boundSuffix(row.netRevenueExVatBaseBound)}`, footer: report.totals.netRevenueExVatBase },
    // A WITHHELD FIGURE MUST NOT LOOK LIKE A MEASURED ZERO (o3d-8u4h): the word, not a dash, and
    // the reason is in the notices above the table rather than under a hover. o3d-7jfq round 2: the
    // notice names three causes and only one of them is repaired by a person, so the row says which
    // it is — a count in the summary cannot tell an operator WHICH customer to go and look at.
    { key: 'profit', label: 'Gross profit', align: 'right', render: (row) => row.grossProfitBase == null ? (row.costEvidence === 'inconsistent' ? INCONSISTENT_CELL_TEXT : WITHHELD_CELL_TEXT) : `${row.grossProfitBase}${boundSuffix(row.grossProfitBaseBound)}`, footer: `${report.totals.grossProfitBase}${bound(report.totals.grossProfitBaseBound)}` },
    { key: 'ar', label: 'AR exposure', align: 'right', render: (row) => `${row.arExposureBase}${boundSuffix(row.arExposureBaseBound)}`, footer: `${report.totals.arExposureBase}${bound(report.totals.arExposureBaseBound)}` },
    { key: 'share', label: 'Share', align: 'right', render: (row) => `${row.shareOfRevenuePct}%${boundSuffix(row.shareOfRevenuePctBound)}` },
    { key: 'creditNet', label: 'Credit (net basis)', align: 'right', render: (row) => row.refundsNetBasis, footer: report.totals.refundsNetBasis },
    { key: 'creditGross', label: 'Credit (gross basis)', align: 'right', render: (row) => row.refundsGrossBasis, footer: report.totals.refundsGrossBasis },
    { key: 'creditUnknown', label: 'Credit (unproven basis)', align: 'right', render: (row) => row.refundsUnknownBasis, footer: report.totals.refundsUnknownBasis },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Customer Mix"
      description="Top customers by net revenue, gross profit, unpaid AR exposure, and share of selected-period sales, with the credit that could not be netted off stated beside each figure."
      reportKey="customers"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => row.customerId ?? `${row.customerName}:${index}`}
      columns={columns}
      summary={[
        { label: 'Revenue (invoiced)', value: report.totals.revenueBase },
        { label: 'Net revenue', value: `${report.totals.netRevenueBase}${bound(report.totals.netRevenueBaseBound)}` },
        { label: 'Gross profit', value: `${report.totals.grossProfitBase}${bound(report.totals.grossProfitBaseBound)}` },
        { label: 'Costed customers', value: `${report.totals.costCapturedRows ?? '0'}/${report.pageInfo.totalRows.toLocaleString()}` },
        { label: 'AR exposure', value: `${report.totals.arExposureBase}${bound(report.totals.arExposureBaseBound)}`, tone: 'warning' },
        { label: 'Customers', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      notices={report.notices}
    />
  )
}
