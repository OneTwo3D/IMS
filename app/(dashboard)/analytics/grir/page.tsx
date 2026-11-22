import type { GrirReportRow } from '@/lib/domain/finance/finance-period-analytics'
import { requireFinanceAnalyticsAccess } from '@/lib/security/finance-analytics-page-access'
import { FinanceAnalyticsReportPage, type FinanceAnalyticsColumn } from '../_components/finance-analytics-report'
import { financeAnalyticsFiltersForUi, financeAnalyticsFiltersFromSearch, loadGrirReportForPage, type FinanceAnalyticsSearchParams } from '../_components/finance-analytics-page-utils'

type Props = { searchParams: Promise<FinanceAnalyticsSearchParams> }

const columns: Array<FinanceAnalyticsColumn<GrirReportRow>> = [
  { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
  { key: 'po', label: 'Purchase order', render: (row) => row.poReference },
  { key: 'status', label: 'Status', render: (row) => row.poStatus },
  { key: 'rnb', label: 'Received not billed', align: 'right', render: (row) => row.receivedNotBilledBase },
  { key: 'rnbQty', label: 'Qty', align: 'right', render: (row) => row.receivedNotBilledQty },
  { key: 'bnr', label: 'Billed not received', align: 'right', render: (row) => row.billedNotReceivedBase },
  { key: 'bnrQty', label: 'Qty', align: 'right', render: (row) => row.billedNotReceivedQty },
  { key: 'credits', label: 'Return credit notes', align: 'right', render: (row) => row.creditNotesBase },
  { key: 'net', label: 'Net GR/IR', align: 'right', render: (row) => row.netBase },
  { key: 'ppv', label: 'Price difference', align: 'right', render: (row) => row.priceVarianceBase },
  { key: 'fxv', label: 'FX difference', align: 'right', render: (row) => row.fxVarianceBase },
  { key: 'oldest', label: 'Oldest open', render: (row) => row.oldestOpenDate ?? '' },
  { key: 'age', label: 'Age (days)', align: 'right', render: (row) => row.ageDays },
]

export default async function GrirAnalyticsPage({ searchParams }: Props) {
  await requireFinanceAnalyticsAccess()
  const filters = financeAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadGrirReportForPage(filters)
  return (
    <FinanceAnalyticsReportPage
      title="GR/IR (goods received, not invoiced)"
      description="Open goods accrual by supplier and purchase order: received not billed, billed not received, with age."
      reportKey="grir"
      filters={financeAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.poId}:${index}`}
      columns={columns}
      summary={[
        { label: 'Received not billed', value: report.totals.receivedNotBilledBase ?? '0', tone: Number(report.totals.receivedNotBilledBase ?? 0) > 0 ? 'warning' : 'default' },
        { label: 'Billed not received', value: report.totals.billedNotReceivedBase ?? '0' },
        { label: 'Net GR/IR', value: report.totals.netBase ?? '0' },
        { label: 'Orders with a balance', value: report.totals.orderCount ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
