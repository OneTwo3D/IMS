import type { Metadata } from 'next'
import Link from 'next/link'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockAdjustmentReport,
  inventoryLedgerFiltersForUi,
  inventoryLedgerFiltersFromSearch,
  type InventoryLedgerSearchParams,
  type StockAdjustmentReportRow,
} from '@/lib/domain/inventory/inventory-ledger-reports'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireInventoryLedgerReportAccess } from '@/lib/security/inventory-ledger-access'
import { canViewStockValue } from '@/lib/security/stock-position-policy'
import { formatMoneyCode } from '@/lib/utils'
import {
  InventoryLedgerReportPage,
  type InventoryLedgerColumn,
} from '../_components/inventory-ledger-report'

export const metadata: Metadata = { title: 'Stock Adjustments' }

export default async function StockAdjustmentsPage({ searchParams }: { searchParams: Promise<InventoryLedgerSearchParams> }) {
  const session = await requireInventoryLedgerReportAccess()
  // Value, unit cost and write-off value are cost figures: only inventory.prices roles get them, and the report omits them server-side otherwise.
  const costVisible = canViewStockValue(session.user.role)
  const resolvedSearchParams = await searchParams
  const filters = { ...inventoryLedgerFiltersFromSearch(resolvedSearchParams, { includeMinValue: costVisible }), includeCost: costVisible }
  const [report, filterOptions, organisation] = await Promise.all([
    getStockAdjustmentReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryLedgerColumn<StockAdjustmentReportRow>> = [
    {
      key: 'product',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'date', label: 'Date', render: (row) => row.createdAt.slice(0, 10) },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'reason', label: 'Reason', render: (row) => row.reasonName },
    { key: 'qty', label: 'Signed qty', align: 'right', render: (row) => `${row.signedQty} ${row.stockUnit}`, footer: report.totals.movementQty },
    ...(costVisible ? [{
      key: 'value',
      label: `Write-off value (${currency})`,
      align: 'right' as const,
      render: (row: StockAdjustmentReportRow) => formatMoneyCode(Number(row.totalValueBase ?? '0'), currency),
      footer: formatMoneyCode(Number(report.totals.movementValueBase), currency),
    }] : []),
    {
      key: 'reference',
      label: 'Reference',
      render: (row) => row.referenceHref
        ? <Link href={row.referenceHref} className="font-medium text-primary hover:underline">{row.referenceLabel}</Link>
        : row.referenceLabel,
    },
  ]

  return (
    <InventoryLedgerReportPage
      title="Stock Adjustments"
      description="Adjustment movement audit with reason matching, SKU totals and finance write-off value."
      reportKey="stock-adjustments"
      filters={inventoryLedgerFiltersForUi(filters, { includeMinValue: costVisible })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'Adjustment rows', value: report.pageInfo.totalRows.toLocaleString() },
        { label: 'Signed qty', value: report.totals.movementQty },
        ...(costVisible ? [{ label: `Write-off value (${currency})`, value: formatMoneyCode(Number(report.totals.movementValueBase ?? '0'), currency) }] : []),
        { label: 'Top reason', value: report.reasonSummary[0]?.reasonName ?? 'None' },
      ]}
      notices={[
        'Adjustment reasons are matched from StockMovement.note because adjustment movements do not carry a reasonId column.',
        'StockMovement does not currently store the user that created each adjustment; user grouping is therefore marked as not captured.',
      ]}
      showMinValue={costVisible}
    />
  )
}
