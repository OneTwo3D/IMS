import type { Metadata } from 'next'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockCountReport,
  type InventoryLedgerFilters,
  type StockCountReportRow,
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

export const metadata: Metadata = { title: 'Stock Counts' }

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
    status: one(searchParams.status),
    reference: one(searchParams.reference),
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
    status: filters.status,
    reference: filters.reference,
    pageSize: String(filters.pageSize ?? 100),
  }
}

export default async function StockCountsReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireInventoryLedgerReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getStockCountReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryLedgerColumn<StockCountReportRow>> = [
    { key: 'reference', label: 'Count', render: (row) => <span className="font-medium">{row.reference}</span>, footer: 'Totals' },
    { key: 'status', label: 'Status', render: (row) => row.status },
    { key: 'warehouse', label: 'Warehouse', render: (row) => row.warehouseCode },
    { key: 'sku', label: 'SKU', render: (row) => row.sku },
    { key: 'expected', label: 'Book qty', align: 'right', render: (row) => row.expectedQty, footer: report.totals.expectedQty },
    { key: 'counted', label: 'Counted qty', align: 'right', render: (row) => row.countedQty ?? 'Open', footer: report.totals.countedQty },
    { key: 'variance', label: 'Variance', align: 'right', render: (row) => row.varianceQty, footer: report.totals.varianceQty },
    {
      key: 'value',
      label: `Adjustment value (${currency})`,
      align: 'right',
      render: (row) => row.linkedAdjustmentValueBase == null ? 'No evidence' : formatMoneyCode(Number(row.linkedAdjustmentValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.linkedAdjustmentValueBase), currency),
    },
    { key: 'completed', label: 'Completed', render: (row) => row.completedAt?.slice(0, 10) ?? 'Open' },
  ]

  return (
    <InventoryLedgerReportPage
      title="Stock Counts"
      description="Book versus counted quantity by SKU, with linked adjustment-movement value evidence where present."
      reportKey="stock-counts"
      filters={filtersForUi(filters)}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'Variance qty', value: report.totals.varianceQty, tone: Number(report.totals.varianceQty) !== 0 ? 'warning' : 'default' },
        { label: `Linked value (${currency})`, value: formatMoneyCode(Number(report.totals.linkedAdjustmentValueBase), currency) },
        { label: 'Missing evidence rows', value: report.totals.missingAdjustmentEvidenceRows.toLocaleString(), tone: report.totals.missingAdjustmentEvidenceRows > 0 ? 'warning' : 'default' },
        { label: 'Repeat-offender SKUs', value: report.totals.repeatOffenderSkus.toLocaleString() },
      ]}
      notices={[
        'StockCount rows are currently schema-level records; adjustment value evidence appears only when an ADJUSTMENT StockMovement references the count.',
      ]}
      statusKind="stock-count"
    />
  )
}
