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
import {
  boundSuffix,
  type BoundedFigureString,
  type DerivedFigureBound,
} from '@/lib/domain/sales/derived-figure-bound'
import { boundedFigureString } from '@/lib/domain/sales/refund-basis-analytics'
import { requireInventoryCostingReportAccess } from '@/lib/security/inventory-costing-access'
import { formatMoneyCodeExact } from '@/lib/utils'
import {
  InventoryCostingReportPage,
  type InventoryCostingColumn,
} from '../_components/inventory-costing-report'

export const metadata: Metadata = { title: 'COGS Report' }

/** What the report prints where a dispatch could not be tied to a sales line at all. */
const NO_AMOUNT = 'Unmatched'

/** Pennies for money, hundredths for the ratio — the precision every cell on this page renders at. */
const DISPLAY_PLACES = 2

/**
 * THE MARK IS APPENDED AFTER THE AMOUNT RENDERER, NEVER INSIDE IT (o3d-la3n r3, o3d-rv4a) — AND THE
 * AMOUNT REACHES THE RENDERER ALREADY ROUNDED TOWARD ITS BOUND (o3d-rv4a r2, Codex round 2 HIGH 3).
 *
 * `renderAmount` owns every branch about the AMOUNT. The `mark` is a fact about the producer's bound,
 * so no branch the cell controls may suppress it: a figure the report withholds still says whether the
 * withholding sits inside a bounded period. Round 2 of o3d-la3n put a `show` predicate around amount
 * AND mark together and a row printed a bare em dash where `— ≥` was owed, which is why the amount
 * renderer is passed IN and the mark concatenated here, below any branch a caller can reach.
 *
 * WHAT ROUND 2 OF THIS BRANCH ADDS IS THE ROUNDING, AND IT IS HERE FOR THE SAME STRUCTURAL REASON.
 * Every caller used to hand `money(row.revenueBase)` to this function, and `formatMoneyCode` is
 * `Intl.NumberFormat`, which rounds to the NEAREST penny — under a `≤`. For £100.004 of revenue
 * against £0.0001 of gross-basis credit the true figure is £100.0039167 at 20% VAT, and the cell
 * printed `£100.00 ≤`, a ceiling the truth exceeds. So the caller no longer gets the chance: it
 * receives a figure this function has already moved in the direction the relation allows (up for
 * `≤`, down for `≥`, nearest for the two verdicts that claim neither), and it has no way to obtain
 * the unrounded one.
 *
 * AND ROUND 3 KEEPS IT A DECIMAL STRING THE WHOLE WAY, BECAUSE THE FLOAT WAS THE SAME DEFECT ONE
 * LAYER OUT (Codex round 3 HIGH). Round 2 rounded with `roundBoundedAmountForDisplay`, which takes a
 * `number` — so the producer's decimal string was converted with `Number(...)` BEFORE the directed
 * rounding ran. Above 2^53 that conversion rounds to NEAREST and the representable doubles are
 * 0.015625 apart, wider than the penny being rounded to: the schema-valid `90071992547409.990000`
 * becomes 90071992547409.984375, and a ceiling applied to that prints …409.98 over a true
 * …409.989917. Directed rounding cannot repair a value that a conversion has already moved the wrong
 * way, so there is no conversion. `boundedFigureString` rounds the STRING at two places in the
 * direction the bound allows — the same helper, at the same single site, the producer used at six —
 * and `formatMoneyCodeExact` hands that string to `Intl.NumberFormat`, which reads a decimal string
 * exactly. `roundBoundedAmountForDisplay` is unchanged and still right for Product Profitability,
 * whose figures are `number`s on the wire and never had a decimal string to lose.
 *
 * `bound === null` is the producer saying there is no published figure here at all, so there is no
 * relation to state — distinct from `'exact'`, which is a claim that the figure IS the figure.
 *
 * `trailingZeros` is a rendering shape and nothing else: money goes through `Intl`, which prints two
 * decimals whatever it is handed, and the ratio keeps `decimalString`'s trimmed form. The DIRECTION is
 * decided above it, from the bound, and no caller can reach it.
 */
function markFigure(
  amount: BoundedFigureString | null,
  bound: DerivedFigureBound | null,
  renderAmount: (value: BoundedFigureString) => string,
  trailingZeros = true,
): string {
  const text = amount == null
    ? NO_AMOUNT
    : renderAmount(boundedFigureString(amount, bound ?? 'exact', DISPLAY_PLACES, trailingZeros))
  return `${text}${bound == null ? '' : boundSuffix(bound)}`
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
  // EVERY FIGURE ON THIS PAGE IS A DECIMAL STRING AND NONE OF THEM BECOMES A FLOAT (Codex r3 HIGH).
  // These columns carry no relation, so nearest rounding is the right rule for them — but `Number`
  // is not nearest-to-a-penny, it is nearest-to-a-double, and at 9e13 those are 1.5 pennies apart.
  // `Intl` reads the string exactly and rounds to the penny itself.
  const money = (value: string) => formatMoneyCodeExact(value, currency)
  /** The same formatter over a string the bound-preserving rounder has already placed. */
  const moneyOf = (value: BoundedFigureString) => formatMoneyCodeExact(value, currency)
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
      render: (row) => markFigure(row.revenueBase, row.revenueBaseBound, moneyOf),
      footer: markFigure(report.totals.revenueBase, report.totals.revenueBaseBound, moneyOf),
    },
    {
      key: 'margin',
      label: `Margin (${currency})`,
      align: 'right',
      render: (row) => markFigure(row.grossMarginBase, row.grossMarginBaseBound, moneyOf),
      footer: markFigure(report.totals.grossMarginBase, report.totals.grossMarginBaseBound, moneyOf),
    },
    {
      key: 'marginPct',
      label: 'Margin %',
      align: 'right',
      // The producer already rounded the ratio toward its own bound at two decimals, so this second
      // rounding at the same precision is a no-op — which is the point: a chain of bound-preserving
      // roundings is bound-preserving, and a nearest one anywhere in it is not.
      render: (row) => markFigure(row.grossMarginPct, row.grossMarginPctBound, (value) => `${value}%`, false),
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
        { label: `Revenue (${currency}, net of credit)`, value: markFigure(report.totals.revenueBase, report.totals.revenueBaseBound, moneyOf) },
        { label: `Gross margin (${currency})`, value: markFigure(report.totals.grossMarginBase, report.totals.grossMarginBaseBound, moneyOf) },
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
