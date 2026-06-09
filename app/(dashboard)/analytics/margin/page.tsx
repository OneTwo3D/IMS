import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { requireRole } from '@/lib/auth/server'
import { getMarginAnalyticsReport, type MarginReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadSalesAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Gross Margin' }

export default async function MarginAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadSalesAnalyticsReportForPage(filters, getMarginAnalyticsReport, { revenueBase: '0', cogsBase: '0', grossProfitBase: '0', marginPct: '0' })
  const columns: Array<SalesAnalyticsColumn<MarginReportRow>> = [
    { key: 'product', label: 'Product', render: (row) => row.productId ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName} /> : `${row.sku} ${row.productName}`, footer: 'Totals' },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'lines', label: 'Lines', align: 'right', render: (row) => row.lineCount.toLocaleString() },
    { key: 'revenue', label: 'Revenue', align: 'right', render: (row) => row.revenueBase, footer: report.totals.revenueBase },
    { key: 'cogs', label: 'COGS', align: 'right', render: (row) => row.cogsBase, footer: report.totals.cogsBase },
    { key: 'profit', label: 'Gross profit', align: 'right', render: (row) => row.grossProfitBase, footer: report.totals.grossProfitBase },
    { key: 'margin', label: 'Margin', align: 'right', render: (row) => `${row.marginPct}%`, footer: `${report.totals.marginPct}%` },
    { key: 'contribution', label: 'Contribution', align: 'right', render: (row) => `${row.contributionPct}%` },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Gross Margin"
      description="SKU-level revenue and COGS from posted COGS entries, highlighting margin contribution and erosion."
      reportKey="margin"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => row.productId ?? `${row.sku}:${index}`}
      columns={columns}
      summary={[
        { label: 'Revenue', value: report.totals.revenueBase },
        { label: 'COGS', value: report.totals.cogsBase },
        { label: 'Gross profit', value: report.totals.grossProfitBase },
        { label: 'Margin', value: `${report.totals.marginPct}%` },
      ]}
      notices={report.notices}
    />
  )
}
