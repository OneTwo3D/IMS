import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getCogsReport,
  inventoryCostingFiltersForUi,
  inventoryCostingFiltersFromSearch,
  type CogsReportRow,
  type InventoryCostingSearchParams,
} from '@/lib/domain/inventory/inventory-costing-reports'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
} from '@/lib/domain/inventory/stock-position-reports'
import { boundSuffix, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import { requireInventoryCostingReportAccess } from '@/lib/security/inventory-costing-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  InventoryCostingReportPage,
  type InventoryCostingColumn,
} from '../_components/inventory-costing-report'

export const metadata: Metadata = { title: 'COGS Report' }

/**
 * THE MARK IS APPENDED AFTER THE AMOUNT RENDERER, NEVER INSIDE IT (o3d-la3n r3, o3d-rv4a).
 *
 * `renderAmount` owns every branch about the AMOUNT — including this report's `Unmatched`, which is
 * what it prints where a dispatch could not be tied to a sales line. `mark` is a fact about the
 * producer's bound, so no branch the cell controls may suppress it: a figure the report withholds
 * still says whether the withholding sits inside a bounded period. Round 2 of o3d-la3n put a `show`
 * predicate around amount AND mark together and a row printed a bare em dash where `— ≥` was owed.
 *
 * `bound === null` is the producer saying there is no published figure here at all, so there is no
 * relation to state — distinct from `'exact'`, which is a claim that the figure IS the figure.
 */
function markFigure(renderAmount: () => string, bound: DerivedFigureBound | null): string {
  return `${renderAmount()}${bound == null ? '' : boundSuffix(bound)}`
}

export default async function CogsPage({ searchParams }: { searchParams: Promise<InventoryCostingSearchParams> }) {
  await requireInventoryCostingReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = inventoryCostingFiltersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getCogsReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const money = (value: string) => formatMoneyCode(Number(value), currency)
  const columns: Array<InventoryCostingColumn<CogsReportRow>> = [
    {
      key: 'group',
      label: 'Group',
      render: (row) => row.productId && row.sku
        ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName ?? row.groupLabel} />
        : <span className="font-medium">{row.groupLabel}</span>,
      footer: 'Totals',
    },
    { key: 'qty', label: 'Qty', align: 'right', render: (row) => row.qty, footer: report.totals.qty },
    {
      key: 'cogs',
      label: `COGS (${currency})`,
      align: 'right',
      render: (row) => money(row.cogsBase),
      footer: money(report.totals.cogsBase),
    },
    {
      key: 'revenue',
      label: `Revenue (${currency}, net of credit)`,
      align: 'right',
      render: (row) => markFigure(() => row.revenueBase == null ? 'Unmatched' : money(row.revenueBase), row.revenueBaseBound),
      footer: markFigure(() => money(report.totals.revenueBase), report.totals.revenueBaseBound),
    },
    {
      key: 'margin',
      label: `Margin (${currency})`,
      align: 'right',
      render: (row) => markFigure(() => row.grossMarginBase == null ? 'Unmatched' : money(row.grossMarginBase), row.grossMarginBaseBound),
      footer: markFigure(() => money(report.totals.grossMarginBase), report.totals.grossMarginBaseBound),
    },
    {
      key: 'marginPct',
      label: 'Margin %',
      align: 'right',
      render: (row) => markFigure(() => row.grossMarginPct == null ? 'Unmatched' : `${row.grossMarginPct}%`, row.grossMarginPctBound),
    },
    // The credit, on the basis it was recorded on. Three columns and never one sum: adding a NET to a
    // GROSS amount gives a figure on neither basis, and only the NET one was taken off revenue.
    { key: 'creditNet', label: `Credit (net basis, ${currency})`, align: 'right', render: (row) => money(row.refundsNetBasis), footer: money(report.totals.refundsNetBasis) },
    { key: 'creditGross', label: `Credit (gross basis, ${currency})`, align: 'right', render: (row) => money(row.refundsGrossBasis), footer: money(report.totals.refundsGrossBasis) },
    { key: 'creditUnknown', label: `Credit (unproven basis, ${currency})`, align: 'right', render: (row) => money(row.refundsUnknownBasis), footer: money(report.totals.refundsUnknownBasis) },
    { key: 'movements', label: 'Movements', align: 'right', render: (row) => row.movementCount },
  ]

  return (
    <InventoryCostingReportPage
      title="COGS Report"
      description="Cost of goods sold grouped by product, category, warehouse, customer, or channel. Revenue is the dispatch's ex-VAT sales-line revenue less the net-basis credit raised in the period, and is shown only where sales movement references match cleanly."
      reportKey="cogs"
      filters={inventoryCostingFiltersForUi({ ...filters, groupBy: report.groupBy })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.groupKey}
      columns={columns}
      summary={[
        { label: `COGS (${currency})`, value: money(report.totals.cogsBase) },
        { label: `GL COGS (${currency})`, value: report.totals.glBalanceBase == null ? 'Not captured' : money(report.totals.glBalanceBase) },
        { label: 'GL variance', value: report.totals.glVarianceBase == null ? 'Not captured' : money(report.totals.glVarianceBase) },
        { label: `Revenue (${currency}, net of credit)`, value: markFigure(() => money(report.totals.revenueBase), report.totals.revenueBaseBound) },
        { label: `Gross margin (${currency})`, value: markFigure(() => money(report.totals.grossMarginBase), report.totals.grossMarginBaseBound) },
        { label: 'Revenue matched rows', value: `${report.totals.revenueCapturedRows}/${report.pageInfo.totalRows}` },
        // Credit that reached no row, ON ITS BASIS — three amounts per case, for the reason the
        // per-row columns are three. A zero across all six is the claim that every credit reached a
        // row; anything else is why the period figures carry a mark.
        { label: 'Credit off-report — nothing to attribute to (net / gross / unproven)', value: `${money(report.totals.refundsUnattributedNetBasis)} / ${money(report.totals.refundsUnattributedGrossBasis)} / ${money(report.totals.refundsUnattributedUnknownBasis)}`, tone: 'warning' },
        { label: 'Credit off-report — no revenue row here (net / gross / unproven)', value: `${money(report.totals.refundsOutsideReportNetBasis)} / ${money(report.totals.refundsOutsideReportGrossBasis)} / ${money(report.totals.refundsOutsideReportUnknownBasis)}`, tone: 'warning' },
      ]}
      notices={report.notices}
      dateMode="period"
      showGroupBy
    />
  )
}
