import type { Metadata } from 'next'
import Link from 'next/link'
import { businessDateOfIso } from '@/lib/business-date'
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
import { canViewStockValue } from '@/lib/security/stock-position-policy'
import { formatMoneyCode } from '@/lib/utils'
import {
  InventoryLedgerReportPage,
  type InventoryLedgerColumn,
} from '../_components/inventory-ledger-report'

export const metadata: Metadata = { title: 'Stock Movement Ledger' }

export default async function StockMovementsPage({ searchParams }: { searchParams: Promise<InventoryLedgerSearchParams> }) {
  const session = await requireInventoryLedgerReportAccess()
  // Value, unit cost and write-off value are cost figures: only inventory.prices roles get them, and the report omits them server-side otherwise.
  const costVisible = canViewStockValue(session.user.role)
  const resolvedSearchParams = await searchParams
  const filters = { ...inventoryLedgerFiltersFromSearch(resolvedSearchParams, { includeType: true, includeMinValue: costVisible }), includeCost: costVisible }
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
    { key: 'date', label: 'Date', render: (row) => businessDateOfIso(row.createdAt) },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'type', label: 'Type', render: (row) => row.type },
    { key: 'qty', label: 'Signed qty', align: 'right', render: (row) => `${row.signedQty} ${row.stockUnit}`, footer: report.totals.movementQty },
    ...(costVisible ? [{
      key: 'value',
      label: `Signed value (${currency})`,
      align: 'right' as const,
      render: (row: InventoryLedgerReportRow) => formatMoneyCode(Number(row.signedValueBase ?? '0'), currency),
      footer: formatMoneyCode(Number(report.totals.movementValueBase), currency),
    }] : []),
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
      filters={inventoryLedgerFiltersForUi(filters, { includeType: true, includeMinValue: costVisible })}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => row.id}
      columns={columns}
      summary={[
        { label: 'Opening qty', value: report.totals.openingQty },
        { label: 'Movement qty', value: report.totals.movementQty },
        { label: 'Closing qty', value: report.totals.closingQty },
        ...(costVisible ? [{ label: `Closing value (${currency})`, value: formatMoneyCode(Number(report.totals.closingValueBase ?? '0'), currency) }] : []),
      ]}
      notices={[
        'Opening + movement = closing is calculated from StockMovement evidence using the same active filters.',
      ]}
      showMovementType
      showMinValue={costVisible}
    />
  )
}
