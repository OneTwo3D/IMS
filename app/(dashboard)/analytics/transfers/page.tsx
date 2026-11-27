import type { Metadata } from 'next'
import Link from 'next/link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockTransferReport,
  inventoryLedgerFiltersForUi,
  inventoryLedgerFiltersFromSearch,
  type InventoryLedgerSearchParams,
  type StockTransferReportRow,
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

export const metadata: Metadata = { title: 'Stock Transfers' }

export default async function TransfersReportPage({ searchParams }: { searchParams: Promise<InventoryLedgerSearchParams> }) {
  const session = await requireInventoryLedgerReportAccess()
  // Value, unit cost and write-off value are cost figures: only inventory.prices roles get them, and the report omits them server-side otherwise.
  const costVisible = canViewStockValue(session.user.role)
  const resolvedSearchParams = await searchParams
  const filters = { ...inventoryLedgerFiltersFromSearch(resolvedSearchParams, { includeStatus: true }), includeCost: costVisible }
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
    ...(costVisible ? [{
      key: 'value',
      label: `Movement value (${currency})`,
      align: 'right' as const,
      render: (row: StockTransferReportRow) => formatMoneyCode(Number(row.movementValueBase ?? '0'), currency),
      footer: formatMoneyCode(Number(report.totals.movementValueBase), currency),
    }] : []),
  ]

  return (
    <InventoryLedgerReportPage
      title="Stock Transfers"
      description="Transfer document status with sent/received quantity, days in transit and movement-value reconciliation."
      reportKey="transfers"
      filters={inventoryLedgerFiltersForUi(filters, { includeStatus: true })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'In transit', value: report.totals.inTransitCount.toLocaleString(), tone: report.totals.inTransitCount > 0 ? 'warning' : 'default' },
        { label: 'Overdue', value: report.totals.overdueCount.toLocaleString(), tone: report.totals.overdueCount > 0 ? 'danger' : 'default' },
        { label: 'Drift qty', value: report.totals.driftQty, tone: Number(report.totals.driftQty) !== 0 ? 'warning' : 'default' },
        ...(costVisible ? [{ label: `Movement value (${currency})`, value: formatMoneyCode(Number(report.totals.movementValueBase ?? '0'), currency) }] : []),
      ]}
      notices={[
        'The in-transit total is counted from StockTransfer.status in DRAFT or IN_TRANSIT using the active filters.',
      ]}
      statusKind="transfer"
    />
  )
}
