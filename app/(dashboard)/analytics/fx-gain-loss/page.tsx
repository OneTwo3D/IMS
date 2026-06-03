import { getFxGainLossReport, type FxGainLossReportRow } from '@/lib/domain/finance/finance-period-analytics'
import { FinanceAnalyticsReportPage, type FinanceAnalyticsColumn } from '../_components/finance-analytics-report'
import { financeAnalyticsFiltersForUi, financeAnalyticsFiltersFromSearch, type FinanceAnalyticsSearchParams } from '../_components/finance-analytics-page-utils'

type Props = { searchParams: Promise<FinanceAnalyticsSearchParams> }

const columns: Array<FinanceAnalyticsColumn<FxGainLossReportRow>> = [
  { key: 'side', label: 'Side', render: (row) => row.side },
  { key: 'reference', label: 'Reference', render: (row) => row.reference },
  { key: 'party', label: 'Party', render: (row) => row.partyName },
  { key: 'currency', label: 'Currency', render: (row) => row.currency },
  { key: 'paidAt', label: 'Paid', render: (row) => row.paidAt.slice(0, 10) },
  { key: 'foreign', label: 'Foreign amount', align: 'right', render: (row) => row.amountForeign },
  { key: 'bookedRate', label: 'Booked rate', align: 'right', render: (row) => row.bookedRateToBase },
  { key: 'settlementRate', label: 'Settlement rate', align: 'right', render: (row) => row.settlementRateToBase },
  { key: 'gainLoss', label: 'Gain/loss', align: 'right', render: (row) => row.gainLossBase },
  { key: 'account', label: 'FX account', render: (row) => row.fxGainLossAccount || 'Unconfigured' },
]

export default async function FxGainLossAnalyticsPage({ searchParams }: Props) {
  const filters = financeAnalyticsFiltersFromSearch(await searchParams)
  const report = await getFxGainLossReport(filters)
  return (
    <FinanceAnalyticsReportPage
      title="FX Gain/Loss"
      description="Realised FX gain and loss by settled receivable and payable transaction."
      reportKey="fx-gain-loss"
      filters={financeAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.side}:${row.documentId}:${index}`}
      columns={columns}
      summary={[
        { label: 'Net gain/loss', value: report.totals.gainLossBase ?? '0' },
        { label: 'Gains', value: report.totals.gainsBase ?? '0' },
        { label: 'Losses', value: report.totals.lossesBase ?? '0' },
        { label: 'Rows', value: report.totals.rowCount ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
