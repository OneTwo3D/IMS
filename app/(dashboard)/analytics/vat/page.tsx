import { getVatReport, type VatReportRow } from '@/lib/domain/finance/finance-period-analytics'
import { requireFinanceAnalyticsAccess } from '@/lib/security/finance-analytics-page-access'
import { FinanceAnalyticsReportPage, type FinanceAnalyticsColumn } from '../_components/finance-analytics-report'
import { financeAnalyticsFiltersForUi, financeAnalyticsFiltersFromSearch, type FinanceAnalyticsSearchParams } from '../_components/finance-analytics-page-utils'

type Props = { searchParams: Promise<FinanceAnalyticsSearchParams> }

const columns: Array<FinanceAnalyticsColumn<VatReportRow>> = [
  { key: 'jurisdiction', label: 'Jurisdiction', render: (row) => row.jurisdiction },
  { key: 'rate', label: 'Rate', render: (row) => row.taxRateName },
  { key: 'accounting', label: 'Accounting tax type', render: (row) => row.accountingTaxType ?? 'Unmapped' },
  { key: 'ratePct', label: 'Rate %', align: 'right', render: (row) => `${row.ratePct}%` },
  { key: 'lines', label: 'Lines', align: 'right', render: (row) => row.lineCount },
  { key: 'taxable', label: 'Taxable base', align: 'right', render: (row) => row.taxableBase },
  { key: 'tax', label: 'Tax base', align: 'right', render: (row) => row.taxBase },
]

export default async function VatAnalyticsPage({ searchParams }: Props) {
  await requireFinanceAnalyticsAccess()
  const filters = financeAnalyticsFiltersFromSearch(await searchParams)
  const report = await getVatReport(filters)
  return (
    <FinanceAnalyticsReportPage
      title="VAT"
      description="Output VAT by tax rate and jurisdiction for invoiced sales-order lines in the selected period."
      reportKey="vat"
      filters={financeAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.taxRateId ?? 'none'}:${row.jurisdiction}:${index}`}
      columns={columns}
      summary={[
        { label: 'Taxable base', value: report.totals.taxableBase ?? '0' },
        { label: 'VAT base', value: report.totals.taxBase ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
