import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { requireRole } from '@/lib/auth/server'
import type { ReturnsReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadReturnsAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Returns' }

export default async function ReturnsAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadReturnsAnalyticsReportForPage(filters)
  const columns: Array<SalesAnalyticsColumn<ReturnsReportRow>> = [
    { key: 'product', label: 'Product', render: (row) => row.productId ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName} /> : `${row.sku} ${row.productName}`, footer: 'Totals' },
    { key: 'customer', label: 'Customer', render: (row) => row.customerName },
    { key: 'reason', label: 'Reason', render: (row) => row.reason },
    { key: 'refunds', label: 'Refunds', align: 'right', render: (row) => row.refundCount.toLocaleString() },
    { key: 'returned', label: 'Returned', align: 'right', render: (row) => row.returnedQty, footer: report.totals.returnedQty },
    { key: 'value', label: 'Refund value', align: 'right', render: (row) => row.refundValueBase, footer: report.totals.refundValueBase },
    { key: 'shipped', label: 'Shipped', align: 'right', render: (row) => row.shippedQty },
    { key: 'rate', label: 'Return rate', align: 'right', render: (row) => `${row.returnRatePct}%` },
  ]

  return (
    <SalesAnalyticsReportPage
      title="Returns"
      description="Refund and returned-quantity analysis by SKU, customer, and reason, with return-rate context."
      reportKey="returns"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.productId ?? row.sku}:${row.customerName}:${row.reason}:${index}`}
      columns={columns}
      summary={[
        { label: 'Refund value', value: report.totals.refundValueBase, tone: 'warning' },
        { label: 'Returned qty', value: report.totals.returnedQty },
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      notices={report.notices}
    />
  )
}
