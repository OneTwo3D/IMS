import type { SupplierPerformanceReportRow } from '@/lib/domain/purchasing/purchasing-analytics'
import { PurchasingAnalyticsReportPage, type PurchasingAnalyticsColumn } from '../_components/purchasing-analytics-report'
import { loadSupplierPerformanceReportForPage, purchasingAnalyticsFiltersForUi, purchasingAnalyticsFiltersFromSearch, type PurchasingAnalyticsSearchParams } from '../_components/purchasing-analytics-page-utils'

type Props = {
  searchParams: Promise<PurchasingAnalyticsSearchParams>
}

const columns: Array<PurchasingAnalyticsColumn<SupplierPerformanceReportRow>> = [
  { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
  { key: 'receipts', label: 'Receipts', align: 'right', render: (row) => row.receiptCount },
  { key: 'onTime', label: 'On-time', align: 'right', render: (row) => `${row.onTimeRatePct}%` },
  { key: 'ordered', label: 'Ordered qty', align: 'right', render: (row) => row.orderedQty },
  { key: 'received', label: 'Received qty', align: 'right', render: (row) => row.receivedQty },
  { key: 'variance', label: 'Qty variance', align: 'right', render: (row) => row.qtyVariance },
  { key: 'returns', label: 'Return rate', align: 'right', render: (row) => `${row.returnRatePct}%` },
  { key: 'actualLead', label: 'Actual lead days', align: 'right', render: (row) => row.averageActualLeadTimeDays },
  { key: 'configuredLead', label: 'Configured lead days', align: 'right', render: (row) => row.averageConfiguredLeadTimeDays || '0' },
  { key: 'rfq', label: 'RFQ response days', align: 'right', render: (row) => row.averageRfqResponseDays },
]

export default async function SupplierPerformanceAnalyticsPage({ searchParams }: Props) {
  const filters = purchasingAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadSupplierPerformanceReportForPage(filters)
  return (
    <PurchasingAnalyticsReportPage
      title="Supplier Performance"
      description="Supplier delivery reliability, quantity variance, return rate, lead time, and RFQ response indicators."
      reportKey="supplier-performance"
      filters={purchasingAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.supplierId}
      columns={columns}
      summary={[
        { label: 'Suppliers', value: report.totals.supplierCount ?? '0' },
        { label: 'Receipts', value: report.totals.receipts ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
