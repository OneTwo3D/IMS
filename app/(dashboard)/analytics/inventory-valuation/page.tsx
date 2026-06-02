import type { Metadata } from 'next'
import { ProductLink } from '@/components/inventory/product-link'
import { getOrganisation } from '@/app/actions/company'
import {
  getInventoryValuationReport,
  inventoryCostingFiltersForUi,
  inventoryCostingFiltersFromSearch,
  type InventoryCostingSearchParams,
  type InventoryValuationReportRow,
} from '@/lib/domain/inventory/inventory-costing-reports'
import {
  getStockPositionFilterOptions,
  stockPositionSelectedFilterOptionInputs,
} from '@/lib/domain/inventory/stock-position-reports'
import { requireInventoryCostingReportAccess } from '@/lib/security/inventory-costing-access'
import { formatMoneyCode } from '@/lib/utils'
import {
  InventoryCostingReportPage,
  type InventoryCostingColumn,
} from '../_components/inventory-costing-report'

export const metadata: Metadata = { title: 'Inventory Valuation' }

export default async function InventoryValuationPage({ searchParams }: { searchParams: Promise<InventoryCostingSearchParams> }) {
  await requireInventoryCostingReportAccess()
  const resolvedSearchParams = await searchParams
  const filters = inventoryCostingFiltersFromSearch(resolvedSearchParams)
  const [report, filterOptions, organisation] = await Promise.all([
    getInventoryValuationReport(filters),
    getStockPositionFilterOptions(stockPositionSelectedFilterOptionInputs(filters)),
    getOrganisation(),
  ])
  const currency = organisation.baseCurrency
  const columns: Array<InventoryCostingColumn<InventoryValuationReportRow>> = [
    {
      key: 'product',
      label: 'Product',
      render: (row) => <ProductLink productId={row.productId} sku={row.sku} name={row.productName} />,
      footer: 'Totals',
    },
    { key: 'warehouse', label: 'Warehouse', render: (row) => <span className="font-medium">{row.warehouseCode}</span> },
    { key: 'category', label: 'Category', render: (row) => row.categoryName ?? 'Uncategorised' },
    { key: 'qty', label: 'Qty', align: 'right', render: (row) => `${row.qty} ${row.stockUnit}`, footer: report.totals.qty },
    {
      key: 'unitCost',
      label: `Unit cost (${currency})`,
      align: 'right',
      render: (row) => row.unitCostBase == null ? 'Unvalued' : formatMoneyCode(Number(row.unitCostBase), currency, { minimumFractionDigits: 6, maximumFractionDigits: 6 }),
    },
    {
      key: 'value',
      label: `Inventory value (${currency})`,
      align: 'right',
      render: (row) => formatMoneyCode(Number(row.totalValueBase), currency),
      footer: formatMoneyCode(Number(report.totals.totalValueBase), currency),
    },
    {
      key: 'gl',
      label: `GL variance (${currency})`,
      align: 'right',
      render: (row) => row.glVarianceBase == null ? 'Account-level' : formatMoneyCode(Number(row.glVarianceBase), currency),
      footer: report.totals.glVarianceBase == null ? 'Not captured' : formatMoneyCode(Number(report.totals.glVarianceBase), currency),
    },
  ]

  return (
    <InventoryCostingReportPage
      title="Inventory Valuation"
      description="As-of inventory quantity and value by SKU and warehouse, using inventory snapshot evidence and FIFO layer value."
      reportKey="inventory-valuation"
      filters={inventoryCostingFiltersForUi(filters)}
      filterOptions={filterOptions}
      pageInfo={report.pageInfo}
      rows={report.rows}
      rowKey={(row) => `${row.productId}:${row.warehouseId}`}
      columns={columns}
      summary={[
        { label: 'Quantity', value: report.totals.qty },
        { label: `Inventory value (${currency})`, value: formatMoneyCode(Number(report.totals.totalValueBase), currency) },
        { label: 'Source', value: report.source.replaceAll('_', ' ') },
        { label: 'GL variance', value: report.totals.glVarianceBase == null ? 'Not captured' : formatMoneyCode(Number(report.totals.glVarianceBase), currency) },
      ]}
      notices={report.notices}
      dateMode="as-of"
      showIncludeZero
    />
  )
}
