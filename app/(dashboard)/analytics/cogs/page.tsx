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
import { roundExact, type ExactFigure, type ExactRoundable } from '@/lib/domain/math/exact-figure'
import {
  boundSuffix,
  type DerivedFigureBound,
} from '@/lib/domain/sales/derived-figure-bound'
import { requireInventoryCostingReportAccess } from '@/lib/security/inventory-costing-access'
import { formatMoneyCodeExact, moneyCodeFractionDigits } from '@/lib/utils'
import {
  InventoryCostingReportPage,
  type InventoryCostingColumn,
} from '../_components/inventory-costing-report'

export const metadata: Metadata = { title: 'COGS Report' }

/** What the report prints where a dispatch could not be tied to a sales line at all. */
const NO_AMOUNT = 'Unmatched'

/**
 * The margin % column's precision: the producer publishes the ratio at two decimals toward its own
 * bound (`boundedPctString`), and it is rendered as text, never through a currency formatter, so the
 * base currency has no say in it. Money columns use the currency's own digits instead — see below.
 */
const PERCENT_PLACES = 2

/** Quantities, at the four decimals this report has always shown them to, rounded to nearest. */
const QTY_PLACES = 4

/**
 * THE MARK IS APPENDED AFTER THE AMOUNT RENDERER, NEVER INSIDE IT (o3d-la3n r3, o3d-rv4a) — AND THIS
 * FUNCTION IS THE AMOUNT'S ONLY ROUNDING (o3d-rv4a r2–r5).
 *
 * `renderAmount` owns every branch about the AMOUNT. The `mark` is a fact about the producer's bound,
 * so no branch the cell controls may suppress it: a figure the report withholds still says whether the
 * withholding sits inside a bounded period (o3d-la3n r2 printed a bare em dash where `— ≥` was owed).
 *
 * THE ROUNDING, AS IT STANDS NOW. The producer publishes every figure as an `ExactFigure` or
 * `ExactRatio` (lib/domain/math/exact-figure.ts), unrounded. `roundExact` rounds the exact value ONCE,
 * to `places`, in the direction the bound allows (up under `≤`, down under `≥`, half-up otherwise), and
 * `renderAmount` then only formats: the money renderer (`formatMoneyCodeExact`) pins the currency's
 * digits and throws on a longer string rather than round it.
 *
 * WHY EACH PIECE EXISTS — one round of review each, every one a figure rounded twice:
 *   - r2: `Intl.NumberFormat` rounded a `≤` to the nearest penny — `£100.00 ≤` over a true £100.0039167.
 *   - r3: `Number(...)` rounded the producer's string to the nearest double before the ceiling ran —
 *     `…409.98 ≤` over a true 90071992547409.989917.
 *   - r4: a fixed two decimals, then `Intl` rounded again to the currency's own — `¥100 ≤` over 100.004.
 *   - r5: the producer rounded to six decimals and this function rounded that string again — £1.01
 *     over an exact 1.004999598 — and Prisma.Decimal's twenty-digit arithmetic dropped small parts of
 *     large figures before any ceiling was taken. Hence exact figures, and `places` here being the
 *     precision the renderer prints: `moneyCodeFractionDigits(currency)` for money, `PERCENT_PLACES`
 *     for the ratio, `QTY_PLACES` for quantities.
 *
 * `bound === null` is the producer saying there is no published figure here at all, so there is no
 * relation to state — distinct from `'exact'`, which is a claim that the figure IS the figure.
 *
 * `trailingZeros` is a rendering shape only; the DIRECTION is decided from the bound, and no caller
 * can reach it.
 */
function markFigure(
  amount: ExactRoundable | null,
  bound: DerivedFigureBound | null,
  renderAmount: (text: string) => string,
  places: number,
  trailingZeros = true,
): string {
  const text = amount == null
    ? NO_AMOUNT
    : renderAmount(roundExact(amount, places, bound ?? 'exact', { trailingZeros }))
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
  // EVERY FIGURE REACHES THIS PAGE UNROUNDED AND IS ROUNDED HERE EXACTLY ONCE (Codex r5 HIGH), to the
  // digits the base currency prints (Codex r4 HIGH: 0 for yen, 3 for dinars), never through a float
  // (Codex r3 HIGH). The plain money columns carry no relation, so they round to nearest. `Intl` then
  // prints the digits it is given and refuses any string it would have to round.
  const digits = moneyCodeFractionDigits(currency)
  const moneyText = (text: string) => formatMoneyCodeExact(text, currency, { fractionDigits: digits })
  const money = (value: ExactFigure) => moneyText(roundExact(value, digits, 'exact'))
  const markMoney = (amount: ExactFigure | null, bound: DerivedFigureBound | null) => markFigure(amount, bound, moneyText, digits)
  const quantity = (value: ExactFigure) => roundExact(value, QTY_PLACES, 'exact', { trailingZeros: false })
  const columns: Array<InventoryCostingColumn<CogsReportRow>> = [
    {
      key: 'group',
      label: 'Group',
      render: (row) => row.productId && row.sku
        ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName ?? row.groupLabel} />
        : <span className="font-medium">{row.groupLabel}</span>,
      footer: 'Totals',
    },
    { key: 'qty', label: 'Qty', align: 'right', render: (row) => quantity(row.qty), footer: quantity(report.totals.qty) },
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
      render: (row) => markMoney(row.revenueBase, row.revenueBaseBound),
      footer: markMoney(report.totals.revenueBase, report.totals.revenueBaseBound),
    },
    {
      key: 'margin',
      label: `Margin (${currency})`,
      align: 'right',
      render: (row) => markMoney(row.grossMarginBase, row.grossMarginBaseBound),
      footer: markMoney(report.totals.grossMarginBase, report.totals.grossMarginBaseBound),
    },
    {
      key: 'marginPct',
      label: 'Margin %',
      align: 'right',
      // The exact quotient, rounded once here toward the ratio's OWN bound (which is not the amounts').
      render: (row) => markFigure(row.grossMarginPct, row.grossMarginPctBound, (value) => `${value}%`, PERCENT_PLACES, false),
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
        { label: `Revenue (${currency}, net of credit)`, value: markMoney(report.totals.revenueBase, report.totals.revenueBaseBound) },
        { label: `Gross margin (${currency})`, value: markMoney(report.totals.grossMarginBase, report.totals.grossMarginBaseBound) },
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
