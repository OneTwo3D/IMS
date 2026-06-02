import type { Metadata } from 'next'
import Link from 'next/link'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockAdjustmentReport,
  type InventoryLedgerFilters,
  type StockAdjustmentReportRow,
} from '@/lib/domain/inventory/inventory-ledger-reports'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireInventoryLedgerReportAccess } from '@/lib/security/inventory-ledger-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  InventoryLedgerReportPage,
  type InventoryLedgerColumn,
  type InventoryLedgerFilterValues,
} from '../_components/inventory-ledger-report'

export const metadata: Metadata = { title: 'Stock Adjustments' }

type SearchParams = Record<string, string | string[] | undefined>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function filtersFromSearch(searchParams: SearchParams): InventoryLedgerFilters {
  return {
    dateFrom: one(searchParams.dateFrom),
    dateTo: one(searchParams.dateTo),
    warehouseId: one(searchParams.warehouseId),
    product: one(searchParams.product),
    reference: one(searchParams.reference),
    minValue: one(searchParams.minValue),
    page: Number(one(searchParams.page) ?? 1),
    pageSize: Number(one(searchParams.pageSize) ?? 100),
  }
}

function filtersForUi(filters: InventoryLedgerFilters): InventoryLedgerFilterValues {
  return {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    warehouseId: filters.warehouseId,
    product: filters.product,
    reference: filters.reference,
    minValue: filters.minValue,
    pageSize: String(filters.pageSize ?? 100),
  }
}

export default async function StockAdjustmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireInventoryLedgerReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
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
    {
      key: 'value',
      label: `Write-off value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.totalValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.movementValueBase), currency),
    },
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
      filters={filtersForUi(filters)}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'Adjustment rows', value: report.pageInfo.totalRows.toLocaleString() },
        { label: 'Signed qty', value: report.totals.movementQty },
        { label: `Write-off value (${currency})`, value: formatMoneyCode(Number(report.totals.movementValueBase), currency) },
        { label: 'Top reason', value: report.reasonSummary[0]?.reasonName ?? 'None' },
      ]}
      notices={[
        'Adjustment reasons are matched from StockMovement.note because adjustment movements do not carry a reasonId column.',
        'StockMovement does not currently store the user that created each adjustment; user grouping is therefore marked as not captured.',
      ]}
      showMinValue
    />
  )
}
