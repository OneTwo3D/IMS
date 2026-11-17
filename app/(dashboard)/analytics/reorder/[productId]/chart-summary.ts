import type { ReorderDemandChart } from '@/lib/domain/inventory/reorder-demand-chart'

/** Plain-language description of the chart, used as its accessible name and the text fallback. */
export function summarizeDemandChart(chart: ReorderDemandChart): string[] {
  const unit = chart.stockUnit
  const lines = [
    `${chart.sku}: ${chart.openingQty} ${unit} available now, selling about ${chart.averageDailyDemand} ${unit} per day (a flat average). Safety stock ${chart.safetyStockQty}, reorder point ${chart.reorderPoint}, lead time ${chart.leadTimeDays} days.`,
  ]
  lines.push(
    chart.requiredReceiptDate
      ? `Required receipt: ${chart.requiredReceiptDate}. Latest PO date: ${chart.latestPoDate}${chart.latestPoOverdue ? ' (overdue)' : ''}. Suggested order ${chart.suggestedReorderQty} ${unit}.`
      : 'No required receipt date: projected stock does not fall to safety stock in the horizon.',
  )
  lines.push(
    chart.firstShortageDate
      ? `First shortage (projected stock at or below zero): ${chart.firstShortageDate}.`
      : 'No shortage projected in the horizon.',
  )
  lines.push(
    chart.stockout.firstCoveredDate == null
      ? 'Stockouts cannot be shown: no daily inventory snapshot exists for this range.'
      : `Stockouts: ${chart.stockout.stockoutDays} day(s) with no on-hand stock, ${chart.stockout.unknownDays} day(s) unknown (no snapshot), over the days shown (snapshots since ${chart.stockout.firstCoveredDate}).`,
  )
  const arrivals = chart.weeks.filter((week) => week.inboundQty > 0)
  lines.push(
    arrivals.length > 0
      ? `Inbound purchase orders: ${arrivals.map((week) => `${week.inboundQty} ${unit} in the week of ${week.weekStart}`).join('; ')}.`
      : 'No dated inbound purchase orders in the chart range.',
  )
  return lines
}
