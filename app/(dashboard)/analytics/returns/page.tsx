import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { requireRole } from '@/lib/auth/server'
import { getReturnsByReasonReport, type ReturnsByReasonRow, type ReturnsReportRow } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { RETURNS_MIXED_BASIS_MARKER } from '@/lib/analytics/refund-figure-surfaces'
import { SalesAnalyticsReportPage, type SalesAnalyticsColumn } from '../_components/sales-analytics-report'
import { loadReturnsAnalyticsReportForPage, salesAnalyticsFiltersForUi, salesAnalyticsFiltersFromSearch, type SalesAnalyticsSearchParams } from '../_components/sales-analytics-page-utils'

export const metadata: Metadata = { title: 'Returns' }

export default async function ReturnsAnalyticsPage({ searchParams }: { searchParams: Promise<SalesAnalyticsSearchParams> }) {
  await requireRole('ADMIN', 'MANAGER', 'FINANCE')
  const filters = salesAnalyticsFiltersFromSearch(await searchParams)
  const [report, byReason] = await Promise.all([loadReturnsAnalyticsReportForPage(filters), getReturnsByReasonReport(filters)])
  const columns: Array<SalesAnalyticsColumn<ReturnsReportRow>> = [
    { key: 'product', label: 'Product', render: (row) => row.productId ? <ProductLink productId={row.productId} sku={row.sku} name={row.productName} /> : `${row.sku} ${row.productName}`, footer: 'Totals' },
    { key: 'customer', label: 'Customer', render: (row) => row.customerName },
    { key: 'reason', label: 'Reason', render: (row) => row.reason },
    { key: 'refunds', label: 'Refunds', align: 'right', render: (row) => row.refundCount.toLocaleString() },
    { key: 'returned', label: 'Returned', align: 'right', render: (row) => row.returnedQty, footer: report.totals.returnedQty },
    // o3d-iigc round 5: a null here is an ADMISSION that the row's credits are not all on one basis,
    // so it renders as the marker, never as a blank and never as a zero — a zero would read as "this
    // row returned nothing", the opposite of what is being said. The basis and the three per-basis
    // buckets sit beside it so the reader still sees exactly how much credit exists.
    { key: 'value', label: 'Refund value', align: 'right', render: (row) => row.refundValueBase ?? RETURNS_MIXED_BASIS_MARKER, footer: report.totals.refundValueBase },
    { key: 'basis', label: 'Basis', render: (row) => row.refundValueBasis },
    { key: 'valueNet', label: 'Net-basis credit', align: 'right', render: (row) => row.refundValueNetBasis, footer: report.totals.refundValueNetBasis },
    { key: 'valueGross', label: 'Gross-basis credit', align: 'right', render: (row) => row.refundValueGrossBasis, footer: report.totals.refundValueGrossBasis },
    { key: 'valueUnknown', label: 'Unproven-basis credit', align: 'right', render: (row) => row.refundValueUnknownBasis, footer: report.totals.refundValueUnknownBasis },
    { key: 'exchanged', label: 'Exchanged', align: 'right', render: (row) => row.exchangedQty, footer: report.totals.exchangedQty },
    { key: 'exchangedValue', label: 'Exchanged refund value', align: 'right', render: (row) => row.exchangedRefundValueBase ?? RETURNS_MIXED_BASIS_MARKER, footer: report.totals.exchangedRefundValueBase },
    { key: 'lostValue', label: 'Lost refund value', align: 'right', render: (row) => row.lostRefundValueBase ?? RETURNS_MIXED_BASIS_MARKER, footer: report.totals.lostRefundValueBase },
    { key: 'shipped', label: 'Shipped', align: 'right', render: (row) => row.shippedQty },
    { key: 'rate', label: 'Return rate', align: 'right', render: (row) => `${row.returnRatePct}%` },
    { key: 'rateExcl', label: 'Return rate excl. exchanges', align: 'right', render: (row) => `${row.returnRateExcludingExchangesPct}%` },
  ]

  const reasonColumns: Array<SalesAnalyticsColumn<ReturnsByReasonRow>> = [
    { key: 'reason', label: 'Return reason', render: (row) => row.reason },
    { key: 'refunds', label: 'Refunds', align: 'right', render: (row) => row.refundCount.toLocaleString() },
    { key: 'returned', label: 'Returned', align: 'right', render: (row) => row.returnedQty },
    { key: 'value', label: 'Refund value', align: 'right', render: (row) => row.refundValueBase ?? RETURNS_MIXED_BASIS_MARKER },
    { key: 'valueNet', label: 'Net-basis credit', align: 'right', render: (row) => row.refundValueNetBasis },
    { key: 'valueGross', label: 'Gross-basis credit', align: 'right', render: (row) => row.refundValueGrossBasis },
    { key: 'valueUnknown', label: 'Unproven-basis credit', align: 'right', render: (row) => row.refundValueUnknownBasis },
  ]

  return (
    <>
    <SalesAnalyticsReportPage
      title="Returns"
      description="Refund and returned-quantity analysis by SKU, customer, and reason, with return-rate context."
      reportKey="returns"
      filters={salesAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.productId ?? row.sku}:${row.customerName}:${row.reason}:${index}`}
      columns={columns}
      summary={[
        { label: 'Lost refund value (not exchanged)', value: report.totals.lostRefundValueBase, tone: 'warning' },
        { label: 'Exchanged refund value', value: report.totals.exchangedRefundValueBase },
        { label: 'Refund value (all credit)', value: report.totals.refundValueBase },
        { label: 'Net-basis credit', value: report.totals.refundValueNetBasis },
        { label: 'Gross-basis credit', value: report.totals.refundValueGrossBasis },
        { label: 'Unproven-basis credit', value: report.totals.refundValueUnknownBasis },
        { label: 'Returned qty', value: report.totals.returnedQty },
        { label: 'Exchanged qty', value: report.totals.exchangedQty },
        { label: 'Replacement qty', value: report.totals.replacementQty },
        { label: 'Rows', value: report.pageInfo.totalRows.toLocaleString() },
      ]}
      notices={report.notices}
    />
    <section className="mt-6 space-y-2" aria-label="Returns by reason">
      <h2 className="text-base font-semibold">By return reason</h2>
      <p className="text-sm text-muted-foreground">Refunds grouped by the structured return reason (Settings &gt; Inventory). Refunds with no reason are shown as Unspecified.</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {reasonColumns.map((c) => <th key={c.key} className={`py-1 pr-3 font-medium ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {byReason.rows.length === 0 && <tr><td colSpan={reasonColumns.length} className="py-3 text-muted-foreground">No refunds in this period.</td></tr>}
          {byReason.rows.map((row) => (
            <tr key={row.reasonId ?? 'unspecified'} className="border-t">
              {reasonColumns.map((c) => <td key={c.key} className={`py-1 pr-3 ${c.align === 'right' ? 'text-right font-mono' : ''}`}>{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
    </>
  )
}
