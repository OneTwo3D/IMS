import type { CurrencySummaryReportRow } from '@/lib/domain/finance/finance-period-analytics'
import { requireFinanceAnalyticsAccess } from '@/lib/security/finance-analytics-page-access'
import { FinanceAnalyticsReportPage, type FinanceAnalyticsColumn } from '../_components/finance-analytics-report'
import { financeAnalyticsFiltersForUi, financeAnalyticsFiltersFromSearch, loadCurrencySummaryReportForPage, type FinanceAnalyticsSearchParams } from '../_components/finance-analytics-page-utils'

type Props = { searchParams: Promise<FinanceAnalyticsSearchParams> }

const columns: Array<FinanceAnalyticsColumn<CurrencySummaryReportRow>> = [
  { key: 'currency', label: 'Currency', render: (row) => row.currency },
  { key: 'salesCount', label: 'Sales docs', align: 'right', render: (row) => row.salesDocumentCount },
  { key: 'salesForeign', label: 'Sales foreign', align: 'right', render: (row) => row.salesForeign },
  { key: 'salesBase', label: 'Sales base', align: 'right', render: (row) => row.salesBase },
  { key: 'arForeign', label: 'AR foreign', align: 'right', render: (row) => row.arOutstandingForeign },
  { key: 'arBase', label: 'AR base', align: 'right', render: (row) => row.arOutstandingBase },
  { key: 'purchaseCount', label: 'Purchase docs', align: 'right', render: (row) => row.purchaseDocumentCount },
  { key: 'purchasesForeign', label: 'Purchases foreign', align: 'right', render: (row) => row.purchasesForeign },
  { key: 'purchasesBase', label: 'Purchases base', align: 'right', render: (row) => row.purchasesBase },
  { key: 'apForeign', label: 'AP foreign', align: 'right', render: (row) => row.apOutstandingForeign },
  { key: 'apBase', label: 'AP base', align: 'right', render: (row) => row.apOutstandingBase },
]

export default async function CurrencySummaryAnalyticsPage({ searchParams }: Props) {
  await requireFinanceAnalyticsAccess()
  const filters = financeAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadCurrencySummaryReportForPage(filters)
  return (
    <FinanceAnalyticsReportPage
      title="Currency Summary"
      description="Sales, purchases, AR and AP grouped by document currency with foreign and base-equivalent totals."
      reportKey="currency-summary"
      filters={financeAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.currency}
      columns={columns}
      summary={[
        { label: 'Sales base', value: report.totals.salesBase ?? '0' },
        { label: 'AR base', value: report.totals.arOutstandingBase ?? '0' },
        { label: 'Purchases base', value: report.totals.purchasesBase ?? '0' },
        { label: 'AP base', value: report.totals.apOutstandingBase ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
