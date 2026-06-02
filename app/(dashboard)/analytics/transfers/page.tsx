import type { Metadata } from 'next'
import Link from 'next/link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockTransferReport,
  type InventoryLedgerFilters,
  type StockTransferReportRow,
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

export const metadata: Metadata = { title: 'Stock Transfers' }

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

export default async function TransfersReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireInventoryLedgerReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = filtersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getStockTransferReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryLedgerColumn<StockTransferReportRow>> = [
    {
      key: 'reference',
      label: 'Reference',
      render: (row) => <Link href={row.href} className="font-medium text-primary hover:underline">{row.reference}</Link>,
      footer: 'Totals',
    },
    { key: 'status', label: 'Status', render: (row) => row.status },
    { key: 'from', label: 'From', render: (row) => row.fromWarehouseCode },
    { key: 'to', label: 'To', render: (row) => row.toWarehouseCode },
    { key: 'dispatched', label: 'Dispatched', render: (row) => row.dispatchedAt?.slice(0, 10) ?? 'Not dispatched' },
    { key: 'received', label: 'Received', render: (row) => row.completedAt?.slice(0, 10) ?? 'Open' },
    { key: 'days', label: 'Days', align: 'right', render: (row) => row.daysInTransit },
    { key: 'requested', label: 'Sent qty', align: 'right', render: (row) => row.requestedQty, footer: report.totals.requestedQty },
    { key: 'receivedQty', label: 'Received qty', align: 'right', render: (row) => row.receivedQty, footer: report.totals.receivedQty },
    { key: 'drift', label: 'Drift', align: 'right', render: (row) => row.driftQty, footer: report.totals.driftQty },
    {
      key: 'value',
      label: `Movement value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.movementValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.movementValueBase), currency),
    },
  ]

  return (
    <InventoryLedgerReportPage
      title="Stock Transfers"
      description="Transfer document status with sent/received quantity, days in transit and movement-value reconciliation."
      reportKey="transfers"
      filters={filtersForUi(filters)}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'In transit', value: report.totals.inTransitCount.toLocaleString(), tone: report.totals.inTransitCount > 0 ? 'warning' : 'default' },
        { label: 'Overdue', value: report.totals.overdueCount.toLocaleString(), tone: report.totals.overdueCount > 0 ? 'danger' : 'default' },
        { label: 'Drift qty', value: report.totals.driftQty, tone: Number(report.totals.driftQty) !== 0 ? 'warning' : 'default' },
        { label: `Movement value (${currency})`, value: formatMoneyCode(Number(report.totals.movementValueBase), currency) },
      ]}
      notices={[
        'The in-transit total is counted from StockTransfer.status in DRAFT or IN_TRANSIT using the active filters.',
      ]}
      statusKind="transfer"
    />
  )
}
