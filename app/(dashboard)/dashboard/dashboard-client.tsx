'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell, ReferenceLine } from 'recharts'
import { TrendingUp, TrendingDown, Minus, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ProductLink } from '@/components/inventory/product-link'
import type { KpiSummary, ChartPoint, TopProduct, RecentOrder, IncomingPO, Period, CompareMode } from '@/app/actions/dashboard'
import { getDashboardData } from '@/app/actions/dashboard'

type Props = {
  kpi: KpiSummary; chartData: ChartPoint[]; topProducts: TopProduct[]
  recentOrders: RecentOrder[]; incomingPOs: IncomingPO[]
  periodLabel: string; compLabel: string; initialPeriod: Period; initialCompare: CompareMode
}

function fmtGbp(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `£${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1_000) return `£${(v / 1_000).toFixed(1)}K`
  return `£${v.toFixed(2)}`
}
function fmtGbpFull(v: number): string { return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function fmtDateShort(iso: string): string { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }

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
  PARTIALLY_REFUNDED: 'bg-orange-100 text-orange-700', REFUNDED: 'bg-red-100 text-red-700',
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

export function DashboardClient({ kpi: initKpi, chartData: initChart, topProducts: initTop, recentOrders, incomingPOs, periodLabel: initPL, compLabel: initCL, initialPeriod, initialCompare }: Props) {
  const [isPending, startTransition] = useTransition()
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [compare, setCompare] = useState<CompareMode>(initialCompare)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [kpi, setKpi] = useState(initKpi)
  const [chartData, setChartData] = useState(initChart)
  const [topProducts, setTopProducts] = useState(initTop)
  const [periodLabel, setPeriodLabel] = useState(initPL)
  const [compLabel, setCompLabel] = useState(initCL)

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
  const xAngle = chartData.length > 14 ? -45 : 0
  const xAnchor = chartData.length > 14 ? 'end' as const : 'middle' as const
  const xHeight = chartData.length > 14 ? 50 : 30

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
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtGbp(kpi.grossSalesCurrent)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{kpi.ordersCurrent} orders &middot; avg {fmtGbpFull(kpi.avgOrderValue)}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Net Sales</p>
            <ChangeBadge current={kpi.netSalesCurrent} previous={kpi.netSalesComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtGbp(kpi.netSalesCurrent)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{kpi.discountsCurrent > 0 ? `${fmtGbp(kpi.discountsCurrent)} discounts` : 'No discounts'} &middot; {kpi.refundsCurrent > 0 ? `${fmtGbp(kpi.refundsCurrent)} refunds` : 'No refunds'}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">COGS</p>
            <ChangeBadge current={kpi.cogsCurrent} previous={kpi.cogsComparison} />
          </div>
          <p className="text-xl sm:text-2xl font-bold mt-1">{fmtGbp(kpi.cogsCurrent)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">Profit: {fmtGbp(kpi.profitCurrent)}</p>
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
          <div className="h-48 sm:h-56 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={xInterval} angle={xAngle} textAnchor={xAnchor} height={xHeight} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={40} />
                <Tooltip formatter={(value, name) => [fmtGbpFull(Number(value)), name === 'netSales' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="netSales" fill="hsl(221, 83%, 53%)" radius={[2, 2, 0, 0]} name="netSales" />
                <Line type="monotone" dataKey="compNetSales" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compNetSales" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* COGS — multi-line (current + comparison) */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">COGS</h2>
          <div className="h-48 sm:h-56 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={xInterval} angle={xAngle} textAnchor={xAnchor} height={xHeight} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={40} />
                <Tooltip formatter={(value, name) => [fmtGbpFull(Number(value)), name === 'cogs' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
                <Legend formatter={(v) => v === 'cogs' ? periodLabel : compLabel} />
                <Line type="monotone" dataKey="cogs" stroke="hsl(0, 72%, 51%)" strokeWidth={2} dot={{ r: 2 }} name="cogs" />
                <Line type="monotone" dataKey="compCogs" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compCogs" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Margin % — line (current + comparison) */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">Margin %</h2>
          <div className="h-48 sm:h-56 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={xInterval} angle={xAngle} textAnchor={xAnchor} height={xHeight} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}%`} width={40} domain={[0, 100]} />
                <Tooltip formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name === 'marginPct' ? periodLabel : compLabel]} contentStyle={{ fontSize: 11 }} />
                <Legend formatter={(v) => v === 'marginPct' ? periodLabel : compLabel} />
                <Line type="monotone" dataKey="marginPct" stroke="hsl(142, 71%, 45%)" strokeWidth={2} dot={{ r: 2 }} name="marginPct" />
                <Line type="monotone" dataKey="compMarginPct" stroke="hsl(0, 0%, 65%)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} name="compMarginPct" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Bottom row: Cash Bridge, Best Sellers, Incoming POs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Cash Bridge */}
        <Card className="p-3 sm:p-4">
          <h2 className="text-sm font-semibold mb-2">Cash Bridge</h2>
          <div className="h-48 sm:h-56 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bridge} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v < -1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} width={45} />
                <Tooltip formatter={(value) => [fmtGbpFull(Math.abs(Number(value))), '']} contentStyle={{ fontSize: 11 }} />
                <ReferenceLine y={0} stroke="hsl(0, 0%, 70%)" />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {bridge.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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
                <span className="tabular-nums text-sm font-mono font-medium shrink-0">{fmtGbpFull(p.netRevenue)}</span>
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
                  <span className="tabular-nums text-sm font-mono font-medium">{fmtGbpFull(po.totalGbp)}</span>
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
          <p className="text-[10px] text-muted-foreground">{fmtGbp(kpi.pendingSalesValue)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Open POs</p>
          <p className="text-lg font-bold">{kpi.openPurchaseOrders}</p>
          <p className="text-[10px] text-muted-foreground">{fmtGbp(kpi.openPOValue)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Inventory Value</p>
          <p className="text-lg font-bold">{fmtGbp(kpi.inventoryValue)}</p>
          <p className="text-[10px] text-muted-foreground">{kpi.activeProducts} active</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Low Stock</p>
          <p className="text-lg font-bold text-orange-600">{kpi.lowStockCount}</p>
          <p className="text-[10px] text-muted-foreground">{kpi.outOfStockCount} out of stock</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Shipping</p>
          <p className="text-lg font-bold">{fmtGbp(kpi.shippingCurrent)}</p>
          <p className="text-[10px] text-muted-foreground">{periodLabel}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] text-muted-foreground">Comp. Orders</p>
          <p className="text-lg font-bold">{kpi.ordersComparison}</p>
          <p className="text-[10px] text-muted-foreground">{fmtGbp(kpi.netSalesComparison)}</p>
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
                  <TableCell className="py-1.5 text-right tabular-nums text-xs font-mono">{fmtGbpFull(o.totalGbp)}</TableCell>
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
              <span className="tabular-nums text-sm font-mono font-medium shrink-0">{fmtGbpFull(o.totalGbp)}</span>
            </Link>
          ))}
        </div>

        {recentOrders.length === 0 && <p className="text-center text-sm text-muted-foreground py-4">No orders yet.</p>}
      </Card>
    </div>
  )
}
