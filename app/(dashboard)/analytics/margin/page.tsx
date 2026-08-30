import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { requireRole } from '@/lib/auth/server'
import { boundSuffix, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import type { MarginReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadMarginAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Gross Margin' }

export default async function MarginAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadMarginAnalyticsReportForPage(filters)
  // o3d-kyey: `≤` = at most the true figure; `?` = a bound exists but its direction is not
  // established (a ratio moves its numerator and denominator together). See derived-figure-bound.ts.
  const bound = (value: string | undefined) => boundSuffix((value ?? 'exact') as DerivedFigureBound)
  const columns: Array<SalesAnalyticsColumn<MarginReportRow>> = [
    { key: 'product', label: 'Product', render: (row) => row.productId ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName} /> : `${row.sku} ${row.productName}`, footer: 'Totals' },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'lines', label: 'Lines', align: 'right', render: (row) => row.lineCount.toLocaleString() },
    { key: 'revenue', label: 'Revenue (net of credit)', align: 'right', render: (row) => `${row.revenueBase}${boundSuffix(row.revenueBaseBound)}`, footer: `${report.totals.revenueBase}${bound(report.totals.revenueBaseBound)}` },
    { key: 'cogs', label: 'COGS', align: 'right', render: (row) => row.cogsBase, footer: report.totals.cogsBase },
    { key: 'profit', label: 'Gross profit', align: 'right', render: (row) => `${row.grossProfitBase}${boundSuffix(row.grossProfitBaseBound)}`, footer: `${report.totals.grossProfitBase}${bound(report.totals.grossProfitBaseBound)}` },
    { key: 'margin', label: 'Margin', align: 'right', render: (row) => `${row.marginPct}%${boundSuffix(row.marginPctBound)}`, footer: `${report.totals.marginPct}%${bound(report.totals.marginPctBound)}` },
    { key: 'contribution', label: 'Contribution', align: 'right', render: (row) => `${row.contributionPct}%${boundSuffix(row.contributionPctBound)}` },
    { key: 'creditNet', label: 'Credit (net basis)', align: 'right', render: (row) => row.refundsNetBasis, footer: report.totals.refundsNetBasis },
    { key: 'creditGross', label: 'Credit (gross basis)', align: 'right', render: (row) => row.refundsGrossBasis, footer: report.totals.refundsGrossBasis },
    { key: 'creditUnknown', label: 'Credit (unproven basis)', align: 'right', render: (row) => row.refundsUnknownBasis, footer: report.totals.refundsUnknownBasis },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Gross Margin"
      description="SKU-level revenue net of the period’s net-basis credit against posted COGS, with the credit that could not be netted off stated beside the figures."
      reportKey="margin"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => row.productId ?? `${row.sku}:${index}`}
      columns={columns}
      summary={[
        { label: 'Revenue (net of credit)', value: `${report.totals.revenueBase}${bound(report.totals.revenueBaseBound)}` },
        { label: 'COGS', value: report.totals.cogsBase },
        { label: 'Gross profit', value: `${report.totals.grossProfitBase}${bound(report.totals.grossProfitBaseBound)}` },
        { label: 'Margin', value: `${report.totals.marginPct}%${bound(report.totals.marginPctBound)}` },
        // Credit that reached no product row. A zero here is the claim that all of it did.
        { label: 'Credit off-report', value: `${report.totals.refundsUnattributedBase ?? '0'} / ${report.totals.refundsOutsideReportBase ?? '0'}`, tone: 'warning' },
      ]}
      notices={report.notices}
    />
  )
}
