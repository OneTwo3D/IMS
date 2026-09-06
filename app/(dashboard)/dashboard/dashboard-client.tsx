'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, ReferenceLine } from 'recharts'
import { TrendingUp, TrendingDown, Minus, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ProductLink } from '@/components/inventory/product-link'
import type { KpiSummary, ChartPoint, TopProduct, RecentOrder, IncomingPO, Period, CompareMode } from '@/app/actions/dashboard'
import { getDashboardData } from '@/app/actions/dashboard'
import { boundSuffix, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import { useBaseCurrency } from '@/components/providers/base-currency-provider'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { OnboardingBanner } from '@/components/layout/onboarding-banner'
import { formatCompactMoney, formatMoney } from '@/lib/utils'

type Props = {
  kpi: KpiSummary; chartData: ChartPoint[]; topProducts: TopProduct[]
  recentOrders: RecentOrder[]; incomingPOs: IncomingPO[]
  periodLabel: string; compLabel: string; initialPeriod: Period; initialCompare: CompareMode
  showOnboardingBanner?: boolean
}

/**
 * o3d-iigc round 4: THE DASHBOARD WAS THE FOURTH SURFACE. Rounds 1-3 marked the two KPI values that
 * are literally net sales and net sales less COGS, and left everything ELSE on this page — the
 * average order value in the Gross Sales card, the comparison period's net sales in the operational
 * tiles, both series of the Margin % chart, and the Cash Bridge bars — printing figures derived from
 * the same bounded net as if they were measurements. One page, one vocabulary, stated once here.
 */
const UPPER_BOUND_TITLE = 'Upper bound: some refunds in this period are on the gross basis or have no proven basis, so they are not subtracted from the net sales this figure is derived from'
const UPPER_BOUND_TITLE_COMP = 'Upper bound: some refunds in the comparison period are on the gross basis or have no proven basis, so they are not subtracted from the net sales this figure is derived from'
/**
 * Margin is a RATIO of two figures that BOTH move with the unsubtracted credit, so — unlike every
 * other figure on this page — a bounded net sales does not make it an upper bound. When the arithmetic
 * cannot establish the direction (marginFigureBound), the figure is published with the direction
 * withheld rather than with a `≤` the numbers do not support.
 */
const MARGIN_INDETERMINATE_TITLE = 'Direction not established: margin divides two figures that BOTH move with the refunds this period could not subtract, so the true margin may be either side of this one. The figure is shown; the relation is not claimed.'

/**
 * o3d-7jfq: A LINEAR FIGURE CAN BE INDETERMINATE TOO, FOR A DIFFERENT REASON FROM MARGIN'S.
 *
 * Net Sales, Profit, Avg Order and the two chart series were marked straight off
 * `refundBasisComplete` — a boolean, so the only things they could say were "exact" and `≤`. `≤`
 * needs the unsubtracted credit to be NON-NEGATIVE, and a period credited +120 on the gross basis
 * and −120 on it again has a signed bucket of zero and a true net that may be 120 ABOVE the
 * published one. `netSalesBoundCurrent` / `netSalesBound` are the producer's verdict over the
 * INTERVAL and carry the third case these could not express.
 */
const LINEAR_INDETERMINATE_TITLE = 'Direction not established: the credit this period could not subtract includes a NEGATIVE entry, so the true figure may be either side of this one. The figure is shown; the relation is not claimed.'
const LINEAR_INDETERMINATE_TITLE_COMP = 'Direction not established: the credit the comparison period could not subtract includes a NEGATIVE entry, so the true figure may be either side of this one. The figure is shown; the relation is not claimed.'

export function linearBoundTitle(bound: DerivedFigureBound, comparison = false): string | undefined {
  if (bound === 'exact') return undefined
  if (bound === 'indeterminate') return comparison ? LINEAR_INDETERMINATE_TITLE_COMP : LINEAR_INDETERMINATE_TITLE
  return comparison ? UPPER_BOUND_TITLE_COMP : UPPER_BOUND_TITLE
}

function boundTitle(bound: DerivedFigureBound, comparison = false): string | undefined {
  if (bound === 'exact') return undefined
  if (bound === 'indeterminate') return MARGIN_INDETERMINATE_TITLE
  return comparison ? UPPER_BOUND_TITLE_COMP : UPPER_BOUND_TITLE
}

/**
 * o3d-iigc round 4 (Codex finding 2): THE MARGIN % CHART'S TOOLTIP.
 *
 * The Net Sales chart's tooltip has said `≤` since round 1. The Margin % chart beside it — the same
 * bounded net, one bucket at a time — printed a bare percentage, and a chart tooltip is the ONLY
 * place a chart states a FIGURE rather than a shape, so it is exactly where the bound has to appear.
 *
 * The verdict is taken PER BUCKET from the point, not from the period: a period whose margin is a
 * sound upper bound can contain a day whose margin is indeterminate, and the reader is hovering the
 * day. Module-level and pure so it can be asserted directly against a real ChartPoint.
 */
export function marginChartTooltip(
  value: unknown,
  name: unknown,
  point: ChartPoint | undefined,
  periodLabel: string,
  compLabel: string,
): [string, string] {
  const isComp = name !== 'marginPct'
  const bound: DerivedFigureBound = point ? (isComp ? point.compMarginPctBound : point.marginPctBound) : 'exact'
  const pct = `${Number(value).toFixed(1)}%`
  const note = bound === 'upper'
    ? ' ≤ (upper bound — refunds not on the net basis are not subtracted)'
    : bound === 'indeterminate'
      ? ' ? (direction not established — the unsubtracted refunds move this ratio\u2019s numerator and denominator together)'
      : ''
  return [`${pct}${note}`, isComp ? compLabel : periodLabel]
}

/**
 * The Cash Bridge bars. o3d-iigc round 4: two of the six ARE the bounded figures — the bridge's Net
 * Sales bar is kpi.netSalesCurrent and its 'Margin' bar is kpi.profitCurrent, a MONEY profit rather
 * than the margin ratio, so that one is a genuine upper bound. Gross Sales, Discounts and COGS are
 * basis-independent, and the Refunds bar is the NET-basis credit that WAS subtracted, so those four
 * are never marked. Module-level and pure so the marked set is assertable.
 */
export function cashBridgeRows(kpi: KpiSummary): { name: string; value: number; fill: string; bound: DerivedFigureBound }[] {
  // o3d-7jfq: the RELATION, not a boolean. `!refundBasisCompleteCurrent` could only ever mean `≤`,
  // and these two bars are the figures whose unsubtracted credit may be negative.
  const bound = kpi.netSalesBoundCurrent
  return [
    { name: 'Gross Sales', value: kpi.grossSalesCurrent, fill: 'hsl(221, 83%, 53%)', bound: 'exact' },
    { name: 'Discounts', value: -kpi.discountsCurrent, fill: 'hsl(25, 95%, 53%)', bound: 'exact' },
    // o3d-iigc: NET-basis credits only — the bridge must balance to Net Sales, and the two buckets
    // it could not absorb are surfaced on the Net Sales card instead.
    { name: 'Refunds', value: -kpi.refundsCurrent, fill: 'hsl(0, 84%, 60%)', bound: 'exact' },
    { name: 'Net Sales', value: kpi.netSalesCurrent, fill: 'hsl(221, 83%, 63%)', bound },
    { name: 'COGS', value: -kpi.cogsCurrent, fill: 'hsl(0, 72%, 51%)', bound: 'exact' },
    { name: 'Margin', value: kpi.profitCurrent, fill: 'hsl(142, 71%, 45%)', bound },
  ]
}

/**
 * o3d-iigc round 5: THE BEST SELLERS ROW.
 *
 * A card has no refunds column beside it, so — as round 3 established for the summary cards — the
 * LOOSENESS goes in words rather than being left for the reader to find on another page. The
 * amount named here is the credit that was NOT subtracted, which is the whole width of the bound.
 *
 * The RANKING is called out too, and that is not decoration: this list is sorted by the very figure
 * being bounded, so an unplaced credit can hold a product above one whose figure is exact. A `≤` on
 * the number alone would leave a reader believing the ORDER was still a measurement.
 *
 * Module-level and pure so the marked set is assertable without mounting the page.
 */
export function bestSellerRevenueTitle(p: TopProduct, formatMoneyBase: (value: number) => string): string | undefined {
  if (p.netRevenueBound === 'exact') return undefined
  // o3d-7jfq: THE AMOUNT IS ONLY THE WIDTH UNDER AN `upper` VERDICT. `upper` comes back exactly
  // when no unplaced entry was negative, which is exactly when the two published buckets sum to the
  // width; under `indeterminate` that same sum is a cancelled figure, and printing "£0.00 of credit
  // … not subtracted" beside a figure that may be £120 out would be the defect wearing a number.
  if (p.netRevenueBound === 'indeterminate') {
    return 'Direction not established: some of the credit on this product that could not be subtracted is NEGATIVE, so the true figure may be either side of this one. The list order is by this figure, so the ranking carries the same uncertainty.'
  }
  const unplaced = formatMoneyBase(p.refundsGrossBasis + p.refundsUnknownBasis)
  return `Upper bound: ${unplaced} of credit on this product is on the gross basis or has no proven basis, so it is not subtracted from this ex-VAT figure. The list order is by this figure, so the ranking carries the same bound.`
}

/**
 * The margin beside it. Same ratio argument as everywhere else on this page: `refundBasisComplete`
 * being false does NOT make a ratio an upper bound, so the verdict comes from the row's own
 * marginPctBound and an indeterminate one is published with the RELATION withheld, not the figure.
 */
export function bestSellerMarginTitle(p: TopProduct): string | undefined {
  if (p.marginPctBound === 'exact') return undefined
  return p.marginPctBound === 'indeterminate' ? MARGIN_INDETERMINATE_TITLE : UPPER_BOUND_TITLE
}

function ChangeBadge({ current, previous, comparable = true, incomparableReason }: { current: number; previous: number; comparable?: boolean; incomparableReason?: string }) {
  // o3d-iigc: when either side of the comparison is an upper bound of unknown tightness, the SIGN
  // of the change is not established — a period whose credits are all legacy GROSS has more of
  // them withheld than one whose credits are all NET. A dash with the reason, not a direction.
  if (!comparable) return <span className="text-[11px] text-muted-foreground" title={incomparableReason}>—</span>
  if (previous === 0 && current === 0) return <span className="text-[11px] text-muted-foreground">—</span>
  if (previous === 0) return <span className="text-[11px] text-green-600 flex items-center gap-0.5"><TrendingUp className="h-3 w-3" />New</span>
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct === 0) return <span className="text-[11px] text-muted-foreground flex items-center gap-0.5"><Minus className="h-3 w-3" />0%</span>
  if (pct > 0) return <span className="text-[11px] text-green-600 flex items-center gap-0.5"><TrendingUp className="h-3 w-3" />+{pct}%</span>
  return <span className="text-[11px] text-destructive flex items-center gap-0.5"><TrendingDown className="h-3 w-3" />{pct}%</span>
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700', PENDING_PAYMENT: 'bg-yellow-100 text-yellow-700',
  ON_HOLD: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-blue-100 text-blue-700', ALLOCATED: 'bg-cyan-100 text-cyan-700',
  PICKING: 'bg-indigo-100 text-indigo-700', PACKING: 'bg-indigo-100 text-indigo-700',
  SHIPPED: 'bg-purple-100 text-purple-700', COMPLETED: 'bg-green-100 text-green-700',
  DELIVERED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-gray-100 text-gray-700',
  PO_SENT: 'bg-blue-100 text-blue-700', PARTIALLY_RECEIVED: 'bg-indigo-100 text-indigo-700',
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' }, { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' }, { value: 'this_quarter', label: 'This Quarter' },
  { value: 'this_year', label: 'This Year' }, { value: 'this_fy', label: 'Financial Year' },
  { value: 'last_7d', label: 'Last 7 Days' }, { value: 'last_30d', label: 'Last 30 Days' },
  { value: 'last_90d', label: 'Last 90 Days' }, { value: 'last_365d', label: 'Last 365 Days' },
  { value: 'custom', label: 'Custom Range' },
]

const COMPARE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: 'previous_period', label: 'vs Previous Period' },
  { value: 'previous_year', label: 'vs Previous Year' },
  { value: 'previous_fy', label: 'vs Previous FY' },
]

function MobileChartFrame({
  children,
}: {
  children: (width: number) => React.ReactNode
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    if (!node) return

    const update = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    update()

    const observer = new ResizeObserver(() => update())
    observer.observe(node)

    return () => observer.disconnect()
  }, [node])

  return (
    <div ref={setNode} className="min-h-56 w-full overflow-hidden">
      {width && width >= 200 ? children(width) : <div className="h-56 w-full rounded-md bg-muted/30" />}
    </div>
  )
}

function DesktopChartFrame({
  children,
  className = 'h-56 sm:h-56',
}: {
  children: (width: number) => React.ReactNode
  className?: string
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    if (!node) return

    const update = () => {
      const rect = node.getBoundingClientRect()
      setWidth(rect.width >= 200 && rect.height >= 200 ? Math.floor(rect.width) : null)
    }

    update()

    const observer = new ResizeObserver(() => update())
    observer.observe(node)

    return () => observer.disconnect()
  }, [node])

  return (
    <div ref={setNode} className={`${className} min-h-56 min-w-0`}>
      {width ? (
        children(width)
      ) : (
        <div className="h-full w-full rounded-md bg-muted/30" />
      )}
    </div>
  )
}

export function DashboardClient({ kpi: initKpi, chartData: initChart, topProducts: initTop, recentOrders, incomingPOs, periodLabel: initPL, compLabel: initCL, initialPeriod, initialCompare, showOnboardingBanner }: Props) {
  const formatDateTime = useFormatDateTime()
  const fmtDateShort = (iso: string) => formatDateTime(iso, { day: 'numeric', month: 'short' })
  const baseCurrency = useBaseCurrency()
  const fmtBase = (value: number) => formatCompactMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)
  const fmtBaseFull = (value: number) => formatMoney(value, baseCurrency.symbol, baseCurrency.symbolPosition)
  // o3d-iigc: a bucket that held refund value not on the net basis has an UPPER-BOUNDED netSales —
  // the unplaceable credit was left out rather than subtracted in the wrong unit. The bar cannot
  // show that, so the tooltip says it.
  const netSalesTooltipFormatter = (value: unknown, name: unknown, item?: { payload?: ChartPoint }): [string, string] => {
    const isComp = name !== 'netSales'
    const point = item?.payload
    // o3d-7jfq: three-valued, exactly as the margin tooltip beside it already is. A bucket whose
    // unsubtracted credit contains a negative entry has no ceiling, and the boolean this read
    // printed one anyway.
    const bound: DerivedFigureBound = point ? (isComp ? point.compNetSalesBound : point.netSalesBound) : 'exact'
    const amount = fmtBaseFull(Number(value))
    const note = bound === 'upper'
      ? ' ≤ (upper bound — refunds not on the net basis are not subtracted)'
      : bound === 'indeterminate'
        ? ' ? (direction not established — some credit this bucket could not subtract is negative)'
        : ''
    return [`${amount}${note}`, isComp ? compLabel : periodLabel]
  }
  const marginTooltipFormatter = (value: unknown, name: unknown, item?: { payload?: ChartPoint }): [string, string] =>
    marginChartTooltip(value, name, item?.payload, periodLabel, compLabel)
  const [isPending, startTransition] = useTransition()
  const [isNarrow, setIsNarrow] = useState<boolean | null>(null)
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [compare, setCompare] = useState<CompareMode>(initialCompare)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [kpi, setKpi] = useState(initKpi)
  const [chartData, setChartData] = useState(initChart)
  const [topProducts, setTopProducts] = useState(initTop)
  const [periodLabel, setPeriodLabel] = useState(initPL)
  const [compLabel, setCompLabel] = useState(initCL)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const sync = () => setIsNarrow(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  function refresh(p: Period, c: CompareMode, cf?: string, ct?: string) {
    startTransition(async () => {
      const d = await getDashboardData(p, c, cf, ct)
      setKpi(d.kpi); setChartData(d.chartData); setTopProducts(d.topProducts)
      setPeriodLabel(d.periodLabel); setCompLabel(d.compLabel)
    })
  }

  function handlePeriodChange(p: Period) { setPeriod(p); if (p !== 'custom') refresh(p, compare) }
  function handleCompareChange(c: CompareMode) { setCompare(c); refresh(period, c, period === 'custom' ? customFrom : undefined, period === 'custom' ? customTo : undefined) }
  function handleCustomApply() { if (customFrom && customTo) refresh('custom', compare, customFrom, customTo) }

  // Chart axis config
  const xInterval = chartData.length > 30 ? 4 : chartData.length > 14 ? 2 : 0
  const mobileXInterval = chartData.length > 14 ? 3 : chartData.length > 7 ? 1 : 0
  const xAngle = chartData.length > 14 ? -45 : 0
  const xAnchor = chartData.length > 14 ? 'end' as const : 'middle' as const
  const xHeight = chartData.length > 14 ? 50 : 30

  function renderResponsiveChart(render: (width: number) => React.ReactNode, className = 'h-56 sm:h-56') {
    return (
      <DesktopChartFrame className={className}>
        {render}
      </DesktopChartFrame>
    )
  }

  function renderChartPlaceholder() {
    return <div className="h-56 w-full rounded-md bg-muted/30" />
  }

  const bridge = cashBridgeRows(kpi)
  const bridgeTooltipFormatter = (value: unknown, _name: unknown, item?: { payload?: { bound?: DerivedFigureBound } }): [string, string] => {
    const amount = fmtBaseFull(Math.abs(Number(value)))
    const bound = item?.payload?.bound ?? 'exact'
    const note = bound === 'upper'
      ? ' ≤ (upper bound — refunds not on the net basis are not subtracted)'
      : bound === 'indeterminate'
        ? ' ? (direction not established — some credit this period could not subtract is negative)'
        : ''
    return [`${amount}${note}`, '']
  }

  return (
    <div className="space-y-4 md:space-y-5">
      {showOnboardingBanner && <OnboardingBanner />}
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl sm:text-2xl font-semibold">Dashboard</h1>
          {isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={period} onChange={(e) => handlePeriodChange(e.target.value as Period)} className="h-8 rounded-md border border-input bg-background px-2 text-xs flex-1 sm:flex-none min-w-0">
            {PERIOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={compare} onChange={(e) => handleCompareChange(e.target.value as CompareMode)} className="h-8 rounded-md border border-input bg-background px-2 text-xs flex-1 sm:flex-none min-w-0">
            {COMPARE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {period === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 text-xs flex-1 sm:w-36 sm:flex-none" />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 text-xs flex-1 sm:w-36 sm:flex-none" />
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleCustomApply}>Apply</Button>
            </div>
          )}
        </div>
      </div>

      {/* KPI cards — 2 cols mobile, 4 cols desktop */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Gross Sales</p>
            <ChangeBadge current={kpi.grossSalesCurrent} previous={kpi.grossSalesComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtBase(kpi.grossSalesCurrent)}</p>
          {/* o3d-iigc round 4: avgOrderValue is netSalesCurrent / orders (app/actions/dashboard.ts), so
              it inherits net sales' upper bound EXACTLY — the divisor is a basis-independent count.
              It sat unmarked on the one card nobody expects to be bounded. */}
          <p className={`text-[11px] mt-0.5 truncate ${kpi.netSalesBoundCurrent === 'exact' ? 'text-muted-foreground' : 'text-orange-600'}`} title={linearBoundTitle(kpi.netSalesBoundCurrent)}>{kpi.ordersCurrent} orders &middot; avg {fmtBaseFull(kpi.avgOrderValue)}{boundSuffix(kpi.netSalesBoundCurrent)}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Net Sales</p>
            <ChangeBadge
              current={kpi.netSalesCurrent} previous={kpi.netSalesComparison}
              comparable={kpi.refundBasisCompleteCurrent && kpi.refundBasisCompleteComparison}
              incomparableReason="One of these periods holds refunds on the gross basis or with no proven basis. Those are not subtracted from net sales, so each side is an upper bound and the direction of the change is not established."
            />
          </div>
          {/* o3d-iigc: when refundBasisCompleteCurrent is false this is an UPPER BOUND — refund value
              that is not on the net basis was left out of it rather than subtracted in the wrong unit. */}
          <p className={`text-xl sm:text-2xl font-bold mt-1 ${kpi.netSalesBoundCurrent === 'exact' ? '' : 'text-orange-600'}`} title={linearBoundTitle(kpi.netSalesBoundCurrent)}>{fmtBase(kpi.netSalesCurrent)}{boundSuffix(kpi.netSalesBoundCurrent)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{kpi.discountsCurrent > 0 ? `${fmtBase(kpi.discountsCurrent)} discounts` : 'No discounts'} &middot; {kpi.refundsCurrent > 0 ? `${fmtBase(kpi.refundsCurrent)} refunds` : 'No refunds'}</p>
          {!kpi.refundBasisCompleteCurrent && (
            <p className="text-[11px] text-orange-600 mt-0.5 truncate" title="Refund value that is not on the net basis. It is reported here rather than folded into net sales, because subtracting a VAT-inclusive credit from an ex-VAT sales figure removes the VAT twice, and an unstamped credit cannot be placed at all.">
              Not subtracted: {fmtBase(kpi.refundsGrossBasisCurrent)} gross-basis &middot; {fmtBase(kpi.refundsUnknownBasisCurrent)} basis unknown
            </p>
          )}
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">COGS</p>
            <ChangeBadge current={kpi.cogsCurrent} previous={kpi.cogsComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtBase(kpi.cogsCurrent)}</p>
          {/* o3d-iigc: profit is net sales less COGS, so it inherits net sales' upper bound. */}
          <p className={`text-[11px] mt-0.5 truncate ${kpi.netSalesBoundCurrent === 'exact' ? 'text-muted-foreground' : 'text-orange-600'}`} title={linearBoundTitle(kpi.netSalesBoundCurrent)}>Profit: {fmtBase(kpi.profitCurrent)}{boundSuffix(kpi.netSalesBoundCurrent)}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Margin %</p>
            <ChangeBadge
              current={kpi.marginCurrent} previous={kpi.marginComparison}
              comparable={kpi.refundBasisCompleteCurrent && kpi.refundBasisCompleteComparison}
              incomparableReason="Margin is derived from net sales, and one of these periods holds refunds that net sales cannot subtract, so the direction of the change is not established."
            />
          </div>
          {/* o3d-iigc round 4: margin is (net - COGS) / net. Rounds 1-3 marked it `≤` because net is
              upper-bounded — BUT THE UNSUBTRACTED CREDIT MOVES THE NUMERATOR AND THE DENOMINATOR
              TOGETHER, and with COGS above net the report's own `net > 0` guard puts the true margin
              at 0% while the published one is negative. 0% is not "at most -50%". The direction now
              comes from marginFigureBound, and where it is not established the mark says so instead
              of claiming a bound the arithmetic refuses. */}
          <p className={`text-xl sm:text-2xl font-bold mt-1 ${kpi.marginBoundCurrent === 'exact' ? '' : 'text-orange-600'}`} title={boundTitle(kpi.marginBoundCurrent)}>{kpi.marginCurrent}%{boundSuffix(kpi.marginBoundCurrent)}</p>
          <p className={`text-[11px] mt-0.5 truncate ${kpi.marginBoundComparison === 'exact' ? 'text-muted-foreground' : 'text-orange-600'}`} title={boundTitle(kpi.marginBoundComparison, true)}>Comp: {kpi.marginComparison}%{boundSuffix(kpi.marginBoundComparison)}</p>
        </Card>
      </div>

      {/* 3 Charts row — stack on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Net Sales — bar (current) + line (comparison) */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">Net Sales</h2>
          {isNarrow === null ? renderChartPlaceholder() : isNarrow ? (
            <MobileChartFrame>
              {(chartWidth) => (
                <BarChart width={chartWidth} height={224} data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={mobileXInterval} angle={0} textAnchor="middle" height={30} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={36} />
                  <Tooltip formatter={netSalesTooltipFormatter} contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="netSales" fill="hsl(221, 83%, 53%)" radius={[2, 2, 0, 0]} name="netSales" />
                  <Line type="monotone" dataKey="compNetSales" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compNetSales" />
                </BarChart>
              )}
            </MobileChartFrame>
          ) : renderResponsiveChart((chartWidth) => (
              <BarChart width={chartWidth} height={224} data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={xInterval} angle={xAngle} textAnchor={xAnchor} height={xHeight} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={40} />
                <Tooltip formatter={netSalesTooltipFormatter} contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="netSales" fill="hsl(221, 83%, 53%)" radius={[2, 2, 0, 0]} name="netSales" />
                <Line type="monotone" dataKey="compNetSales" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compNetSales" />
              </BarChart>
          ))}
        </Card>

        {/* COGS — multi-line (current + comparison) */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">COGS</h2>
          {isNarrow === null ? renderChartPlaceholder() : isNarrow ? (
            <MobileChartFrame>
              {(chartWidth) => (
                <LineChart width={chartWidth} height={224} data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={mobileXInterval} angle={0} textAnchor="middle" height={30} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={36} />
                  <Tooltip formatter={(value, name) => [fmtBaseFull(Number(value)), name === 'cogs' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
                  <Legend formatter={(v) => v === 'cogs' ? periodLabel : compLabel} wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="cogs" stroke="hsl(0, 72%, 51%)" strokeWidth={2} dot={{ r: 2 }} name="cogs" />
                  <Line type="monotone" dataKey="compCogs" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compCogs" />
                </LineChart>
              )}
            </MobileChartFrame>
          ) : renderResponsiveChart((chartWidth) => (
              <LineChart width={chartWidth} height={224} data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={xInterval} angle={xAngle} textAnchor={xAnchor} height={xHeight} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={40} />
                <Tooltip formatter={(value, name) => [fmtBaseFull(Number(value)), name === 'cogs' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
                <Legend formatter={(v) => v === 'cogs' ? periodLabel : compLabel} wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="cogs" stroke="hsl(0, 72%, 51%)" strokeWidth={2} dot={{ r: 2 }} name="cogs" />
                <Line type="monotone" dataKey="compCogs" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compCogs" />
              </LineChart>
          ))}
        </Card>

        {/* Margin % — line (current + comparison) */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">Margin %</h2>
          {isNarrow === null ? renderChartPlaceholder() : isNarrow ? (
            <MobileChartFrame>
              {(chartWidth) => (
                <LineChart width={chartWidth} height={224} data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={mobileXInterval} angle={0} textAnchor="middle" height={30} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}%`} width={36} domain={[0, 100]} />
                  <Tooltip formatter={marginTooltipFormatter} contentStyle={{ fontSize: 11 }} />
                  <Legend formatter={(v) => v === 'marginPct' ? periodLabel : compLabel} wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="marginPct" stroke="hsl(142, 71%, 45%)" strokeWidth={2} dot={{ r: 2 }} name="marginPct" />
                  <Line type="monotone" dataKey="compMarginPct" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compMarginPct" />
                </LineChart>
              )}
            </MobileChartFrame>
          ) : renderResponsiveChart((chartWidth) => (
              <LineChart width={chartWidth} height={224} data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={xInterval} angle={xAngle} textAnchor={xAnchor} height={xHeight} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}%`} width={40} domain={[0, 100]} />
                <Tooltip formatter={marginTooltipFormatter} contentStyle={{ fontSize: 11 }} />
                <Legend formatter={(v) => v === 'marginPct' ? periodLabel : compLabel} wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="marginPct" stroke="hsl(142, 71%, 45%)" strokeWidth={2} dot={{ r: 2 }} name="marginPct" />
                <Line type="monotone" dataKey="compMarginPct" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compMarginPct" />
              </LineChart>
          ))}
        </Card>
      </div>

      {/* Bottom row: Cash Bridge, Best Sellers, Incoming POs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Cash Bridge */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">Cash Bridge</h2>
          {isNarrow === null ? renderChartPlaceholder() : isNarrow ? (
            <MobileChartFrame>
              {(chartWidth) => (
                <BarChart width={chartWidth} height={224} data={bridge} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v < -1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={40} />
                  <Tooltip formatter={bridgeTooltipFormatter} contentStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="hsl(0, 0%, 70%)" />
                  <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                    {bridge.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              )}
            </MobileChartFrame>
          ) : renderResponsiveChart((chartWidth) => (
              <BarChart width={chartWidth} height={224} data={bridge} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v < -1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={45} />
                <Tooltip formatter={bridgeTooltipFormatter} contentStyle={{ fontSize: 11 }} />
                <ReferenceLine y={0} stroke="hsl(0, 0%, 70%)" />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {bridge.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Bar>
              </BarChart>
          ))}
        </Card>

        {/* Best Sellers */}
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">Best Sellers</h2>
            <Link href="/analytics/sales-stats" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <div className="space-y-2.5">
            {topProducts.slice(0, 5).map((p, i) => (
              <div key={p.productId} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                <div className="flex-1 min-w-0">
                  <ProductLink productId={p.productId} sku={p.sku} name={p.name} />
                  {/* netQty is qtySold less every credited unit. Quantity is basis-independent, so
                      it is EXACT and deliberately carries no marker. */}
                  <p className="text-[10px] text-muted-foreground">
                    {p.netQty} sold net{p.qtyRefunded > 0 ? ` (${p.qtySold} less ${p.qtyRefunded} returned)` : ''} &middot;{' '}
                    <span className={p.marginPctBound === 'exact' ? '' : 'text-orange-600'} title={bestSellerMarginTitle(p)}>
                      {p.marginPct}%{boundSuffix(p.marginPctBound)} margin
                    </span>
                  </p>
                </div>
                <span
                  className={`tabular-nums text-sm font-mono font-medium shrink-0 ${p.netRevenueBound === 'exact' ? '' : 'text-orange-600'}`}
                  title={bestSellerRevenueTitle(p, fmtBaseFull)}
                >{fmtBaseFull(p.netRevenue)}{boundSuffix(p.netRevenueBound)}</span>
              </div>
            ))}
            {topProducts.length === 0 && <p className="text-center text-sm text-muted-foreground py-6">No sales data.</p>}
          </div>
        </Card>

        {/* Incoming POs */}
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">Incoming POs</h2>
            <Link href="/purchase-orders" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <div className="space-y-2.5">
            {incomingPOs.map((po) => (
              <div key={po.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <Link href={`/purchase-orders/${po.id}`} className="text-xs font-mono font-medium hover:underline">{po.reference}</Link>
                  <p className="text-[10px] text-muted-foreground truncate">{po.supplierName} &middot; {po.lineCount} lines</p>
                </div>
                <div className="text-right shrink-0">
                  <span className="tabular-nums text-sm font-mono font-medium">{fmtBaseFull(po.totalBase)}</span>
                  <p className="text-[10px] text-muted-foreground">
                    {po.expectedDelivery ? (() => {
                      const daysAway = Math.round((new Date(po.expectedDelivery).getTime() - Date.now()) / 86400000)
                      return <span className={daysAway < 0 ? 'text-destructive' : daysAway <= 3 ? 'text-orange-600' : ''}>{fmtDateShort(po.expectedDelivery)}{daysAway < 0 ? ' (late)' : ''}</span>
                    })() : 'No ETA'}
                  </p>
                </div>
              </div>
            ))}
            {incomingPOs.length === 0 && <p className="text-center text-sm text-muted-foreground py-6">No incoming POs.</p>}
          </div>
        </Card>
      </div>

      {/* Operational KPIs row — 2 cols mobile, 3 cols sm, 6 cols lg */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Open Orders</p>
          <p className="text-lg font-bold">{kpi.pendingSalesOrders}</p>
          <p className="text-[10px] text-muted-foreground">{fmtBase(kpi.pendingSalesValue)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Open POs</p>
          <p className="text-lg font-bold">{kpi.openPurchaseOrders}</p>
          <p className="text-[10px] text-muted-foreground">{fmtBase(kpi.openPOValue)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Inventory Value</p>
          <p className="text-lg font-bold">{fmtBase(kpi.inventoryValue)}</p>
          <p className="text-[10px] text-muted-foreground">{kpi.activeProducts} active</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Low Stock</p>
          <p className="text-lg font-bold text-orange-600">{kpi.lowStockCount}</p>
          <p className="text-[10px] text-muted-foreground">{kpi.outOfStockCount} out of stock</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Shipping</p>
          <p className="text-lg font-bold">{fmtBase(kpi.shippingCurrent)}</p>
          <p className="text-[10px] text-muted-foreground">{periodLabel}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Comp. Orders</p>
          <p className="text-lg font-bold">{kpi.ordersComparison}</p>
          {/* o3d-iigc round 4: the SAME netSalesComparison the Margin card already treats as bounded
              eight lines above — printed here bare. The order COUNT is basis-independent and stays
              unmarked; the money beneath it is not. */}
          <p className={`text-[10px] ${kpi.netSalesBoundComparison === 'exact' ? 'text-muted-foreground' : 'text-orange-600'}`} title={linearBoundTitle(kpi.netSalesBoundComparison, true)}>{fmtBase(kpi.netSalesComparison)}{boundSuffix(kpi.netSalesBoundComparison)}</p>
        </Card>
      </div>

      {/* Recent orders */}
      <Card className="p-3 sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Recent Orders</h2>
          <Link href="/sales" className="text-xs text-primary hover:underline">View all</Link>
        </div>

        {/* Desktop table */}
        <div className="hidden md:block">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="py-1.5 text-xs">Order</TableHead>
                <TableHead className="py-1.5 text-xs">Customer</TableHead>
                <TableHead className="py-1.5 text-xs text-right">Total</TableHead>
                <TableHead className="py-1.5 text-xs">Status</TableHead>
                <TableHead className="py-1.5 text-xs">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentOrders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="py-1.5 font-mono text-xs"><Link href={`/sales/${o.id}`} className="hover:underline">{o.orderNumber}</Link></TableCell>
                  <TableCell className="py-1.5 text-xs">{o.customerName}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-xs font-mono">{fmtBaseFull(o.totalBase)}</TableCell>
                  <TableCell className="py-1.5"><span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-700'}`}>{o.status}</span></TableCell>
                  <TableCell className="py-1.5 text-xs text-muted-foreground">{fmtDateShort(o.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Mobile card list */}
        <div className="md:hidden divide-y">
          {recentOrders.map((o) => (
            <Link
              key={o.id}
              href={`/sales/${o.id}`}
              className="flex items-start justify-between gap-3 py-2.5 active:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium truncate">{o.orderNumber}</span>
                  <span className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-700'}`}>{o.status}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{o.customerName}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{fmtDateShort(o.createdAt)}</p>
              </div>
              <span className="tabular-nums text-sm font-mono font-medium shrink-0">{fmtBaseFull(o.totalBase)}</span>
            </Link>
          ))}
        </div>

        {recentOrders.length === 0 && <p className="text-center text-sm text-muted-foreground py-4">No orders yet.</p>}
      </Card>
    </div>
  )
}
