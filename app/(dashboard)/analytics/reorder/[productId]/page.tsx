import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getReorderDemandChart } from '@/lib/domain/inventory/reorder-demand-chart'
import { requireReplenishmentReportAccess } from '@/lib/security/replenishment-report-page-access'
import { isSourceScanTooLargeError } from '@/lib/security/source-scan-error'
import { currentParams } from '../../_components/report-utils'
import { chartFiltersFromSearch, chartWindowsFromSearch, type ChartSearchParams } from './chart-params'
import { summarizeDemandChart } from './chart-summary'
import { DemandChartClient } from './demand-chart-client'

export const metadata: Metadata = { title: 'Demand chart' }

const DASH = '—'

export default async function ReorderDemandChartPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>
  searchParams: Promise<ChartSearchParams>
}) {
  // Same gate as Reorder Planning. This page is read-only and fetches on the server.
  await requireReplenishmentReportAccess()
  const [{ productId }, resolvedSearchParams] = await Promise.all([params, searchParams])
  const filters = chartFiltersFromSearch(resolvedSearchParams)
  const windows = chartWindowsFromSearch(resolvedSearchParams)
  const chart = await getReorderDemandChart({ productId, filters, ...windows }).catch((error: unknown) => {
    if (isSourceScanTooLargeError(error)) return 'too-large' as const
    throw error
  })
  const backHref = `/analytics/reorder?${currentParams({ ...filters }).toString()}`
  const back = (
    <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Reorder Planning
    </Link>
  )
  if (chart === 'too-large') {
    return (
      <div className="space-y-3">
        {back}
        <p className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          The catalogue is too large to compute this chart under the current filters. Narrow the Reorder Planning filters (category or supplier) and open the chart again.
        </p>
      </div>
    )
  }
  if (!chart) notFound()

  const summaryLines = summarizeDemandChart(chart)
  return (
    <div className="space-y-4">
      {back}
      <div>
        <h1 className="text-2xl font-semibold">Demand chart: {chart.sku}</h1>
        <p className="text-sm text-muted-foreground">
          {chart.productName}
          {chart.warehouseName ? ` · ${chart.warehouseName}` : ' · All warehouses'}
          {` · history ${chart.historyFrom} to ${chart.historyTo}`}
        </p>
      </div>
      <div className="space-y-1 text-sm" data-testid="demand-chart-summary">
        {summaryLines.map((line) => <p key={line}>{line}</p>)}
      </div>
      {chart.hasHistory ? (
        <DemandChartClient chart={chart} summary={summaryLines.join(' ')} />
      ) : (
        <p role="status" className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          No sales history for {chart.sku} in the selected window ({chart.historyFrom} to {chart.historyTo}).
        </p>
      )}
      <details open={!chart.hasHistory} className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Chart data table</summary>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Week starting</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col" className="text-right">Actual demand</TableHead>
                <TableHead scope="col" className="text-right">Projected demand (flat average)</TableHead>
                <TableHead scope="col" className="text-right">Inbound PO</TableHead>
                <TableHead scope="col" className="text-right">Projected stock (end of week)</TableHead>
                <TableHead scope="col" className="text-right">On-hand (daily snapshot)</TableHead>
                <TableHead scope="col">Stock days (out / in / unknown)</TableHead>
                <TableHead scope="col" className="text-right">Required receipt qty</TableHead>
                <TableHead scope="col">Marker</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chart.weeks.map((week) => {
                const markers = [
                  week.isCurrentWeek ? 'Today' : null,
                  week.weekStart === chart.latestPoWeekStart ? `Latest PO date ${chart.latestPoDate}` : null,
                  week.requiredReceiptQty != null ? `Required receipt ${chart.requiredReceiptDate}` : null,
                  week.isFirstShortageWeek ? `First shortage ${chart.firstShortageDate}` : null,
                ].filter(Boolean)
                return (
                  <TableRow key={week.weekStart}>
                    <TableCell>{week.weekStart}</TableCell>
                    <TableCell>{week.kind === 'history' ? 'History' : 'Forecast'}</TableCell>
                    <TableCell className="text-right">{week.actualDemandQty ?? DASH}</TableCell>
                    <TableCell className="text-right">{week.projectedDemandQty ?? DASH}</TableCell>
                    <TableCell className="text-right">{week.inboundQty || DASH}</TableCell>
                    <TableCell className="text-right">{week.stockPositionQty ?? DASH}</TableCell>
                    <TableCell className="text-right">{week.historicalStockQty ?? DASH}</TableCell>
                    <TableCell>{week.stockState == null ? DASH : `${week.stockoutDays} / ${week.inStockDays} / ${week.unknownDays}${week.stockState === 'stockout' ? ' (stockout)' : week.stockState === 'unknown' ? ' (unknown)' : ''}`}</TableCell>
                    <TableCell className="text-right">{week.requiredReceiptQty ?? DASH}</TableCell>
                    <TableCell>{markers.join('; ') || DASH}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </details>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        {chart.notices.map((notice) => <li key={notice}>{notice}</li>)}
      </ul>
    </div>
  )
}
