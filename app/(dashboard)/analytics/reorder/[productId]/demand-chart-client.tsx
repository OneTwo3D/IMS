'use client'

import { useEffect, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import type { ReorderDemandChart } from '@/lib/domain/inventory/reorder-demand-chart'

// Raw hsl() strings, as the dashboard charts use. Chosen to stay distinguishable in light and dark.
const COLORS = {
  actual: 'hsl(221, 83%, 53%)',
  projected: 'hsl(221, 60%, 78%)',
  inbound: 'hsl(142, 71%, 38%)',
  stock: 'hsl(262, 70%, 55%)',
  safety: 'hsl(25, 95%, 48%)',
  reorder: 'hsl(43, 96%, 45%)',
  receipt: 'hsl(190, 80%, 38%)',
  shortage: 'hsl(0, 84%, 50%)',
  today: 'hsl(0, 0%, 45%)',
}

const CHART_HEIGHT = 380

/**
 * Fixed-width frame, the dashboard's convention (MobileChartFrame / DesktopChartFrame in
 * dashboard-client.tsx): the width is measured with a ResizeObserver and handed to the chart, and no chart
 * is mounted until the container has a real width. The dashboard deliberately does not use
 * ResponsiveContainer, which sizes once at mount and can render a 0 x 0 chart inside a not-yet-laid-out
 * flex/grid parent, so this page follows suit.
 */
function ChartFrame({ children }: { children: (width: number) => React.ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    if (!node) return
    const update = () => {
      const rect = node.getBoundingClientRect()
      setWidth(rect.width >= 200 ? Math.floor(rect.width) : null)
    }
    update()
    const observer = new ResizeObserver(() => update())
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return (
    <div ref={setNode} className="min-w-0 w-full overflow-hidden" style={{ minHeight: CHART_HEIGHT }}>
      {width ? children(width) : <div className="w-full rounded-md bg-muted/30" style={{ height: CHART_HEIGHT }} />}
    </div>
  )
}

function shortDate(iso: string): string {
  return iso.slice(5) // MM-DD; the axis title says weeks start on Monday and the table has full dates
}

export function DemandChartClient({ chart, summary }: { chart: ReorderDemandChart; summary: string }) {
  const unit = chart.stockUnit
  const weekKeys = new Set(chart.weeks.map((week) => week.weekStart))
  const receiptWeek = chart.weeks.find((week) => week.requiredReceiptQty != null)?.weekStart
  const currentWeek = chart.weeks.find((week) => week.isCurrentWeek)?.weekStart
  return (
    <figure aria-label={`Demand chart for ${chart.sku}`} className="space-y-2">
      <ChartFrame>
        {(width) => (
          <div role="img" aria-label={summary}>
            <ComposedChart width={width} height={CHART_HEIGHT} data={chart.weeks} margin={{ top: 16, right: 16, left: 8, bottom: 28 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 80%)" />
              <XAxis dataKey="weekStart" tickFormatter={shortDate} tick={{ fontSize: 11 }} interval="preserveStartEnd" label={{ value: 'Week starting (Monday, UTC)', position: 'insideBottom', offset: -18, fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} width={56} label={{ value: `Units (${unit})`, angle: -90, position: 'insideLeft', fontSize: 12 }} />
              <Tooltip />
              <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="actualDemandQty" name="Actual demand" fill={COLORS.actual} isAnimationActive={false} />
              <Bar dataKey="projectedDemandQty" name="Projected demand (flat average)" fill={COLORS.projected} stroke={COLORS.actual} strokeDasharray="3 2" isAnimationActive={false} />
              <Bar dataKey="inboundQty" name="Inbound PO arrivals" fill={COLORS.inbound} isAnimationActive={false} />
              <Bar dataKey="requiredReceiptQty" name="Required receipt (suggested qty)" fill={COLORS.receipt} isAnimationActive={false} />
              <Line type="monotone" dataKey="stockPositionQty" name="Projected available stock" stroke={COLORS.stock} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
              <ReferenceLine y={chart.safetyStockQty} stroke={COLORS.safety} strokeDasharray="6 3" label={{ value: `Safety stock ${chart.safetyStockQty}`, position: 'insideTopLeft', fontSize: 11, fill: COLORS.safety }} />
              <ReferenceLine y={chart.reorderPoint} stroke={COLORS.reorder} strokeDasharray="2 3" label={{ value: `Reorder point ${chart.reorderPoint}`, position: 'insideBottomLeft', fontSize: 11, fill: COLORS.reorder }} />
              {receiptWeek ? <ReferenceLine x={receiptWeek} stroke={COLORS.receipt} strokeWidth={2} label={{ value: 'Required receipt', position: 'top', fontSize: 11, fill: COLORS.receipt }} /> : null}
              {chart.latestPoWeekStart && weekKeys.has(chart.latestPoWeekStart) ? <ReferenceLine x={chart.latestPoWeekStart} stroke={COLORS.receipt} strokeDasharray="4 3" label={{ value: 'Latest PO date', position: 'insideTop', fontSize: 11, fill: COLORS.receipt }} /> : null}
              {chart.firstShortageWeekStart ? <ReferenceLine x={chart.firstShortageWeekStart} stroke={COLORS.shortage} strokeWidth={2} label={{ value: 'First shortage', position: 'top', fontSize: 11, fill: COLORS.shortage }} /> : null}
              {currentWeek ? <ReferenceLine x={currentWeek} stroke={COLORS.today} strokeDasharray="1 3" label={{ value: 'Today', position: 'insideBottomRight', fontSize: 11, fill: COLORS.today }} /> : null}
            </ComposedChart>
          </div>
        )}
      </ChartFrame>
      <figcaption className="text-xs text-muted-foreground">
        Read-only. Bars are weekly units; the purple line is projected available stock at the end of each week. Adjust the demand window and weeks of supply on Reorder Planning.
      </figcaption>
    </figure>
  )
}
