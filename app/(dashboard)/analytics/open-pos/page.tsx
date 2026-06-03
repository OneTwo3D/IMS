import { getOpenPurchaseOrdersReport, type OpenPurchaseOrderReportRow } from '@/lib/domain/purchasing/purchasing-analytics'
import { PurchasingAnalyticsReportPage, type PurchasingAnalyticsColumn } from '../_components/purchasing-analytics-report'
import { purchasingAnalyticsFiltersForUi, purchasingAnalyticsFiltersFromSearch, type PurchasingAnalyticsSearchParams } from '../_components/purchasing-analytics-page-utils'

type Props = {
  searchParams: Promise<PurchasingAnalyticsSearchParams>
}

const columns: Array<PurchasingAnalyticsColumn<OpenPurchaseOrderReportRow>> = [
  { key: 'reference', label: 'PO', render: (row) => row.reference },
  { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
  { key: 'status', label: 'Status', render: (row) => row.status.replaceAll('_', ' ') },
  { key: 'expected', label: 'Expected', render: (row) => row.expectedDelivery ?? 'Unscheduled' },
  { key: 'overdue', label: 'Overdue', render: (row) => row.overdue ? 'Yes' : 'No' },
  { key: 'days', label: 'Days sent', align: 'right', render: (row) => row.daysSinceSent },
  { key: 'qty', label: 'Outstanding qty', align: 'right', render: (row) => row.outstandingQty },
  { key: 'value', label: 'Outstanding value', align: 'right', render: (row) => row.outstandingValueBase },
]

export default async function OpenPurchaseOrdersAnalyticsPage({ searchParams }: Props) {
  const filters = purchasingAnalyticsFiltersFromSearch(await searchParams)
  const report = await getOpenPurchaseOrdersReport(filters)
  return (
    <PurchasingAnalyticsReportPage
      title="Open Purchase Orders"
      description="Outstanding purchase orders by supplier, expected delivery, overdue state, remaining quantity, and remaining base value."
      reportKey="open-pos"
      filters={purchasingAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.poId}
      columns={columns}
      summary={[
        { label: 'Outstanding value', value: report.totals.outstandingValueBase ?? '0' },
        { label: 'Outstanding qty', value: report.totals.outstandingQty ?? '0' },
        { label: 'Overdue POs', value: report.totals.overdue ?? '0', tone: Number(report.totals.overdue ?? 0) > 0 ? 'warning' : 'default' },
      ]}
      notices={report.notices}
    />
  )
}
