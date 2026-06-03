import { getSpendReport, type SpendReportRow } from '@/lib/domain/purchasing/purchasing-analytics'
import { PurchasingAnalyticsReportPage, type PurchasingAnalyticsColumn } from '../_components/purchasing-analytics-report'
import { purchasingAnalyticsFiltersForUi, purchasingAnalyticsFiltersFromSearch, type PurchasingAnalyticsSearchParams } from '../_components/purchasing-analytics-page-utils'

type Props = {
  searchParams: Promise<PurchasingAnalyticsSearchParams>
}

const columns: Array<PurchasingAnalyticsColumn<SpendReportRow>> = [
  { key: 'period', label: 'Period', render: (row) => row.period },
  { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
  { key: 'category', label: 'Category', render: (row) => row.categoryName },
  { key: 'pos', label: 'POs', align: 'right', render: (row) => row.poCount },
  { key: 'spend', label: 'Spend', align: 'right', render: (row) => row.spendBase },
]

export default async function SpendAnalyticsPage({ searchParams }: Props) {
  const filters = purchasingAnalyticsFiltersFromSearch(await searchParams)
  const report = await getSpendReport(filters)
  return (
    <PurchasingAnalyticsReportPage
      title="Spend"
      description="Spend by supplier, product category, and month, reconciled to received purchase-order base totals."
      reportKey="spend"
      filters={purchasingAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.period}:${row.supplierId}:${row.categoryName}:${index}`}
      columns={columns}
      summary={[
        { label: 'Spend', value: report.totals.spendBase ?? '0' },
        { label: 'POs', value: report.totals.poCount ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
