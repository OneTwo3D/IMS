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

function ChangeBadge({ current, previous }: { current: number; previous: number }) {
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

  // Cash bridge data
  const bridge = [
    { name: 'Gross Sales', value: kpi.grossSalesCurrent, fill: 'hsl(221, 83%, 53%)' },
    { name: 'Discounts', value: -kpi.discountsCurrent, fill: 'hsl(25, 95%, 53%)' },
    { name: 'Refunds', value: -kpi.refundsCurrent, fill: 'hsl(0, 84%, 60%)' },
    { name: 'Net Sales', value: kpi.netSalesCurrent, fill: 'hsl(221, 83%, 63%)' },
    { name: 'COGS', value: -kpi.cogsCurrent, fill: 'hsl(0, 72%, 51%)' },
    { name: 'Margin', value: kpi.profitCurrent, fill: 'hsl(142, 71%, 45%)' },
  ]

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
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{kpi.ordersCurrent} orders &middot; avg {fmtBaseFull(kpi.avgOrderValue)}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Net Sales</p>
            <ChangeBadge current={kpi.netSalesCurrent} previous={kpi.netSalesComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtBase(kpi.netSalesCurrent)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{kpi.discountsCurrent > 0 ? `${fmtBase(kpi.discountsCurrent)} discounts` : 'No discounts'} &middot; {kpi.refundsCurrent > 0 ? `${fmtBase(kpi.refundsCurrent)} refunds` : 'No refunds'}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">COGS</p>
            <ChangeBadge current={kpi.cogsCurrent} previous={kpi.cogsComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtBase(kpi.cogsCurrent)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">Profit: {fmtBase(kpi.profitCurrent)}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Margin %</p>
            <ChangeBadge current={kpi.marginCurrent} previous={kpi.marginComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{kpi.marginCurrent}%</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">Comp: {kpi.marginComparison}%</p>
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
                  <Tooltip formatter={(value, name) => [fmtBaseFull(Number(value)), name === 'netSales' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
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
                <Tooltip formatter={(value, name) => [fmtBaseFull(Number(value)), name === 'netSales' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
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
                  <Tooltip formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name === 'marginPct' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
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
                <Tooltip formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name === 'marginPct' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
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
                  <Tooltip formatter={(value) => [fmtBaseFull(Math.abs(Number(value))), '']} contentStyle={{ fontSize: 11 }} />
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
                <Tooltip formatter={(value) => [fmtBaseFull(Math.abs(Number(value))), '']} contentStyle={{ fontSize: 11 }} />
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
                  <p className="text-[10px] text-muted-foreground">{p.qtySold} sold &middot; {p.marginPct}% margin</p>
                </div>
                <span className="tabular-nums text-sm font-mono font-medium shrink-0">{fmtBaseFull(p.netRevenue)}</span>
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
          <p className="text-[10px] text-muted-foreground">{fmtBase(kpi.netSalesComparison)}</p>
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
