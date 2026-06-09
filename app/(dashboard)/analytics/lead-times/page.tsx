import type { LeadTimeReportRow } from '@/lib/domain/purchasing/purchasing-analytics'
import { PurchasingAnalyticsReportPage, type PurchasingAnalyticsColumn } from '../_components/purchasing-analytics-report'
import { loadLeadTimeReportForPage, purchasingAnalyticsFiltersForUi, purchasingAnalyticsFiltersFromSearch, type PurchasingAnalyticsSearchParams } from '../_components/purchasing-analytics-page-utils'

type Props = {
  searchParams: Promise<PurchasingAnalyticsSearchParams>
}

const columns: Array<PurchasingAnalyticsColumn<LeadTimeReportRow>> = [
  { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
  { key: 'sku', label: 'SKU', render: (row) => row.sku },
  { key: 'product', label: 'Product', render: (row) => row.productName },
  { key: 'receipts', label: 'Receipts', align: 'right', render: (row) => row.receiptCount },
  { key: 'avg', label: 'Avg days', align: 'right', render: (row) => row.averageLeadTimeDays },
  { key: 'p50', label: 'P50 days', align: 'right', render: (row) => row.p50LeadTimeDays },
  { key: 'p95', label: 'P95 days', align: 'right', render: (row) => row.p95LeadTimeDays },
  { key: 'configured', label: 'Configured days', align: 'right', render: (row) => row.configuredLeadTimeDays || 'Unset' },
  { key: 'latest', label: 'Latest receipt', render: (row) => row.latestReceiptAt.slice(0, 10) },
]

export default async function LeadTimeAnalyticsPage({ searchParams }: Props) {
  const filters = purchasingAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadLeadTimeReportForPage(filters)
  return (
    <PurchasingAnalyticsReportPage
      title="Lead Times"
      description="Observed receipt lead-time distribution per supplier and SKU, including P50/P95 values used to tune replenishment planning."
      reportKey="lead-times"
      filters={purchasingAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.supplierId}:${row.productId}`}
      columns={columns}
      summary={[
        { label: 'Supplier/SKU pairs', value: report.totals.supplierSkuPairs ?? '0' },
        { label: 'Max P95 days', value: report.totals.maxP95LeadTimeDays ?? '0', tone: Number(report.totals.maxP95LeadTimeDays ?? 0) > 30 ? 'warning' : 'default' },
      ]}
      notices={report.notices}
    />
  )
}
