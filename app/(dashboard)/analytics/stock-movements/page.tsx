import type { Metadata } from 'next'
import Link from 'next/link'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getStockMovementLedgerReport,
  inventoryLedgerFiltersForUi,
  inventoryLedgerFiltersFromSearch,
  type InventoryLedgerReportRow,
  type InventoryLedgerSearchParams,
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
} from '../_components/inventory-ledger-report'

export const metadata: Metadata = { title: 'Stock Movement Ledger' }

export default async function StockMovementsPage({ searchParams }: { searchParams: Promise<InventoryLedgerSearchParams> }) {
  await requireInventoryLedgerReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = inventoryLedgerFiltersFromSearch(resolvedSearchParams, { includeType: true, includeMinValue: true })
  const [report, filterOptions, organisation] = await Promise.all([
    getStockMovementLedgerReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryLedgerColumn<InventoryLedgerReportRow>> = [
    {
      key: 'product',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'date', label: 'Date', render: (row) => row.createdAt.slice(0, 10) },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'type', label: 'Type', render: (row) => row.type },
    { key: 'qty', label: 'Signed qty', align: 'right', render: (row) => `${row.signedQty} ${row.stockUnit}`, footer: report.totals.movementQty },
    {
      key: 'value',
      label: `Signed value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.signedValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.movementValueBase), currency),
    },
    {
      key: 'reference',
      label: 'Reference',
      render: (row) => row.referenceHref
        ? <Link href={row.referenceHref} className="font-medium text-primary hover:underline">{row.referenceLabel}</Link>
        : row.referenceLabel,
    },
    { key: 'note', label: 'Note', render: (row) => row.note ?? '' },
  ]

  return (
    <InventoryLedgerReportPage
      title="Stock Movement Ledger"
      description="Full signed inventory ledger with opening and closing quantity/value reconciliation for the selected slice."
      reportKey="stock-movements"
      filters={inventoryLedgerFiltersForUi(filters, { includeType: true, includeMinValue: true })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'Opening qty', value: report.totals.openingQty },
        { label: 'Movement qty', value: report.totals.movementQty },
        { label: 'Closing qty', value: report.totals.closingQty },
        { label: `Closing value (${currency})`, value: formatMoneyCode(Number(report.totals.closingValueBase), currency) },
      ]}
      notices={[
        'Opening + movement = closing is calculated from StockMovement evidence using the same active filters.',
      ]}
      showMovementType
      showMinValue
    />
  )
}
