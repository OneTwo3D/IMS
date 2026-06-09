import { getPurchasePriceVarianceReport, type PurchasePriceVarianceReportRow } from '@/lib/domain/purchasing/purchasing-analytics'
import { PurchasingAnalyticsReportPage, type PurchasingAnalyticsColumn } from '../_components/purchasing-analytics-report'
import { loadPurchasingAnalyticsReportForPage, purchasingAnalyticsFiltersForUi, purchasingAnalyticsFiltersFromSearch, type PurchasingAnalyticsSearchParams } from '../_components/purchasing-analytics-page-utils'

type Props = {
  searchParams: Promise<PurchasingAnalyticsSearchParams>
}

const columns: Array<PurchasingAnalyticsColumn<PurchasePriceVarianceReportRow>> = [
  { key: 'sku', label: 'SKU', render: (row) => row.sku },
  { key: 'product', label: 'Product', render: (row) => row.productName },
  { key: 'supplier', label: 'Supplier', render: (row) => row.supplierName },
  { key: 'po', label: 'PO', render: (row) => row.poReference },
  { key: 'received', label: 'Received', render: (row) => row.receivedAt ?? 'Unknown' },
  { key: 'actual', label: 'Actual unit', align: 'right', render: (row) => row.actualLandedUnitCostBase },
  { key: 'reference', label: 'Reference unit', align: 'right', render: (row) => row.referenceUnitCostBase },
  { key: 'variance', label: 'Variance/unit', align: 'right', render: (row) => row.variancePerUnitBase },
  { key: 'total', label: 'Variance total', align: 'right', render: (row) => row.varianceTotalBase },
  { key: 'pct', label: 'Variance %', align: 'right', render: (row) => `${row.variancePct}%` },
]

export default async function PurchasePriceVarianceAnalyticsPage({ searchParams }: Props) {
  const filters = purchasingAnalyticsFiltersFromSearch(await searchParams)
  const report = await loadPurchasingAnalyticsReportForPage(filters, getPurchasePriceVarianceReport, { varianceTotalBase: '0', rowCount: '0' })
  return (
    <PurchasingAnalyticsReportPage
      title="Purchase Price Variance"
      description="Actual landed unit cost compared with the previous received PO line for the same supplier and SKU."
      reportKey="ppv"
      filters={purchasingAnalyticsFiltersForUi(filters)}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row, index) => `${row.supplierId}:${row.productId}:${row.poReference}:${index}`}
      columns={columns}
      summary={[
        { label: 'Variance total', value: report.totals.varianceTotalBase ?? '0', tone: 'warning' },
        { label: 'Rows', value: report.totals.rowCount ?? '0' },
      ]}
      notices={report.notices}
    />
  )
}
