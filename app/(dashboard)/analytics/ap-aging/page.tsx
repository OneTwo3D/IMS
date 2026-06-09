import type { AgingReportRow } from '@/lib/domain/finance/finance-period-analytics'
import { requireFinanceAnalyticsAccess } from '@/lib/security/finance-analytics-page-access'
import { FinanceAnalyticsReportPage, type FinanceAnalyticsColumn } from '../_components/finance-analytics-report'
import { financeAnalyticsFiltersForUi, financeAnalyticsFiltersFromSearch, loadApAgingReportForPage, type FinanceAnalyticsSearchParams } from '../_components/finance-analytics-page-utils'

type Props = { searchParams: Promise<FinanceAnalyticsSearchParams> }

const columns: Array<FinanceAnalyticsColumn<AgingReportRow>> = [
  { key: 'supplier', label: 'Supplier', render: (row) => row.partyName },
  { key: 'contact', label: 'Contact', render: (row) => row.contact ?? '' },
  { key: 'docs', label: 'Docs', align: 'right', render: (row) => row.documentCount },
  { key: 'current', label: 'Current', align: 'right', render: (row) => row.current },
  { key: 'bucket1', label: '1-30', align: 'right', render: (row) => row.bucket1 },
  { key: 'bucket2', label: '31-60', align: 'right', render: (row) => row.bucket2 },
  { key: 'bucket3', label: '61-90', align: 'right', render: (row) => row.bucket3 },
  { key: 'bucket4', label: '90+', align: 'right', render: (row) => row.bucket4 },
  { key: 'outstanding', label: 'Outstanding', align: 'right', render: (row) => row.outstandingBase },
]

export default async function ApAgingAnalyticsPage({ searchParams }: Props) {
  await requireFinanceAnalyticsAccess()
  const filters = financeAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadApAgingReportForPage(filters)
  return (
    <FinanceAnalyticsReportPage
      title="AP Aging"
      description="Outstanding supplier invoice balances by configurable aging bucket."
      reportKey="ap-aging"
      filters={financeAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.partyId ?? row.partyName}:${index}`}
      columns={columns}
      summary={[
        { label: 'Outstanding', value: report.totals.outstandingBase ?? '0', tone: Number(report.totals.outstandingBase ?? 0) > 0 ? 'warning' : 'default' },
        { label: 'Bucket 1 days', value: report.totals.bucket1Days ?? '30' },
        { label: 'Bucket 2 days', value: report.totals.bucket2Days ?? '60' },
        { label: 'Bucket 3 days', value: report.totals.bucket3Days ?? '90' },
      ]}
      notices={report.notices}
      showAgingBuckets
    />
  )
}
